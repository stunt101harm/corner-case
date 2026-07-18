/**
 * replay.ts — Worker port of the relay's /api/replay: stream the bundled
 * recording as SSE with the exact pacing + event format of keeper/src/relay.ts
 * (which delegates to keeper/src/replay.ts). Key mirrored semantics:
 *
 *  - trim to the first "kickoff" record (recordings begin days before kickoff;
 *    untrimmed, the 5-min wall cap would compress the match to a flash);
 *  - effective speed = max(requested, span/5min) so the whole replay fits in
 *    5 minutes; "max" streams with no delays;
 *  - each record goes out as its verbatim recorded SSE block (data:/id: lines);
 *  - ": hb" comment heartbeats every 15s keep proxies from idling the stream;
 *  - a final `event: replay_done` carries {records, effectiveSpeed, aborted}.
 *
 * The recording is parsed ONCE at isolate startup (module scope) so per-request
 * CPU stays minimal.
 */

import semiRecording from "./assets/18241006-england-argentina-semi.sse";

const MAX_REPLAY_WALL_MS = 5 * 60_000;
const SSE_HEARTBEAT_MS = 15_000;

interface ReplayEntry {
  /** Record Ts (epoch ms) — drives pacing. */
  ts: number;
  /** The verbatim SSE block, LF-normalized, ending with the blank separator line. */
  raw: string;
}

/**
 * Minimal SSE-block parser for recorded files: reproduces keeper/src/txline.ts
 * SseParser's `raw` round-trip (each line + "\n", plus the trailing blank
 * line) and extracts Ts + Action from the data payload.
 */
function parseRecording(text: string): { entries: ReplayEntry[]; kickoffIdx: number } {
  const entries: ReplayEntry[] = [];
  let kickoffIdx = -1;
  let rawLines: string[] = [];
  let dataLines: string[] = [];

  const dispatch = (): void => {
    if (dataLines.length > 0) {
      const data = dataLines.join("\n");
      try {
        const record = JSON.parse(data) as { Ts: number; Action?: string };
        if (kickoffIdx === -1 && record.Action === "kickoff") kickoffIdx = entries.length;
        entries.push({ ts: record.Ts, raw: rawLines.map((l) => `${l}\n`).join("") + "\n" });
      } catch {
        // A malformed block in a recording is skipped, matching loadRecording's
        // JSON.parse contract (committed recordings contain none).
      }
    }
    rawLines = [];
    dataLines = [];
  };

  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line === "") {
      dispatch();
      continue;
    }
    rawLines.push(line);
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    if (field === "data") {
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      dataLines.push(value);
    }
  }
  dispatch(); // flush a trailing unterminated block

  return { entries, kickoffIdx };
}

const PARSED = parseRecording(semiRecording);
/** Trimmed to the kickoff record — same rule as relay.ts prepareReplayFile. */
const SEMI_ENTRIES: ReplayEntry[] =
  PARSED.kickoffIdx > 0 ? PARSED.entries.slice(PARSED.kickoffIdx) : PARSED.entries;

/** fixtureId → replay entries. Only the committed semi is bundled. */
export const RECORDINGS: Record<string, ReplayEntry[]> = {
  "18241006": SEMI_ENTRIES,
};

/**
 * Re-tag a raw SSE block with an `event:` name so replay clients can tell
 * odds blocks from score blocks on one connection (mirrors keeper/src/
 * replay.ts tagSseEvent). Existing event lines are dropped first.
 */
export function tagSseEvent(raw: string, name: string): string {
  const body = raw
    .split("\n")
    .filter((line) => !line.startsWith("event:"))
    .join("\n");
  return `event: ${name}\n${body}`;
}

/** Parse a recorded .odds.sse text into replay entries, pre-tagged
 *  `event: odds`. parseRecording works verbatim on odds files: each data
 *  block is JSON with a Ts, and no block has Action "kickoff". */
export function parseOddsRecording(text: string): ReplayEntry[] {
  return parseRecording(text).entries.map((e) => ({ ts: e.ts, raw: tagSseEvent(e.raw, "odds") }));
}

/**
 * fixtureId → odds replay entries, interleaved into /api/replay by Ts. None
 * are bundled yet: to add one, drop `<id>.odds.sse` into src/assets/, import
 * it like the semi recording, and register `parseOddsRecording(text)` here.
 * An absent entry leaves the replay byte-identical to the pre-odds behavior.
 */
export const ODDS_RECORDINGS: Record<string, ReplayEntry[]> = {};

/**
 * Merge score entries with odds entries by ts (mirrors keeper/src/replay.ts
 * interleaveOddsBlocks): score order is preserved exactly; odds outside the
 * scores' ts range are dropped — pre-kickoff quotes would re-expand the span
 * the kickoff trim removed, post-final ones would delay replay_done.
 */
function interleaveOdds(scores: ReplayEntry[], odds: ReplayEntry[]): ReplayEntry[] {
  if (scores.length === 0) return [...scores];
  const first = scores[0].ts;
  const last = scores[scores.length - 1].ts;
  const clamped = odds.filter((o) => o.ts >= first && o.ts <= last).sort((a, b) => a.ts - b.ts);
  const out: ReplayEntry[] = [];
  let j = 0;
  for (const s of scores) {
    while (j < clamped.length && clamped[j].ts < s.ts) out.push(clamped[j++]);
    out.push(s);
  }
  while (j < clamped.length) out.push(clamped[j++]);
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface ReplayHandle {
  response: Response;
  /** Must be passed to ctx.waitUntil — the pump outlives the fetch handler's return. */
  done: Promise<void>;
}

export function streamReplay(
  entries: ReplayEntry[],
  speed: number | "max",
  signal: AbortSignal,
  oddsEntries?: ReplayEntry[],
): ReplayHandle {
  // No odds (the only case in production until an odds asset is bundled) →
  // `entries` passes through untouched and the loop below is byte-identical
  // to the pre-odds behavior.
  if (oddsEntries && oddsEntries.length > 0) {
    entries = interleaveOdds(entries, oddsEntries);
  }
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const spanMs = entries.length > 0 ? entries[entries.length - 1].ts - entries[0].ts : 0;
  const effectiveSpeed =
    speed === "max" ? Infinity : Math.max(speed, spanMs / Math.max(1, MAX_REPLAY_WALL_MS));

  const done = (async () => {
    let aborted = false;
    let delivered = 0;
    let hb: ReturnType<typeof setInterval> | null = null;
    const write = (text: string): Promise<void> => writer.write(encoder.encode(text));
    try {
      await write(": connected\n\n");
      hb = setInterval(() => {
        writer.write(encoder.encode(": hb\n\n")).catch(() => {
          if (hb !== null) clearInterval(hb);
        });
      }, SSE_HEARTBEAT_MS);

      let prevTs: number | null = null;
      let pending = ""; // batch consecutive no-delay blocks into one write
      for (const entry of entries) {
        if (signal.aborted) {
          aborted = true;
          break;
        }
        if (prevTs !== null && Number.isFinite(effectiveSpeed)) {
          const delayMs = (entry.ts - prevTs) / effectiveSpeed;
          if (delayMs > 0) {
            if (pending) {
              await write(pending);
              pending = "";
            }
            await sleep(delayMs);
          }
        }
        prevTs = entry.ts;
        pending += entry.raw;
        delivered++;
      }
      if (pending && !aborted) await write(pending);
      if (!aborted) {
        // Explicit end-of-replay event so the UI can show "match complete";
        // shape matches replay.ts ReplayResult (Infinity serializes to null,
        // byte-identical to the local relay's output for speed=max).
        const result = { records: delivered, effectiveSpeed, aborted: false };
        await write(`event: replay_done\ndata: ${JSON.stringify(result)}\n\n`);
      }
    } catch {
      // Client went away mid-write — nothing to clean up beyond the stream.
    } finally {
      if (hb !== null) clearInterval(hb);
      await writer.close().catch(() => {});
    }
  })();

  return {
    response: new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    }),
    done,
  };
}
