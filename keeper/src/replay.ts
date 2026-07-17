/**
 * replay.ts — re-emit a recorded .sse match file through the SAME
 * record-handling interface as the live stream (StreamHandlers), so the
 * settlement engine, relay and UI consume replayed matches through code paths
 * that are byte-for-byte identical to live ones. That equivalence is the
 * foundation of judge demo mode: "run demo match" is not a simulation of the
 * pipeline, it IS the pipeline fed from disk.
 *
 * Library:  replayFile(path, handlers, { speed })  → Promise<ReplayResult>
 * CLI:      npx tsx keeper/src/replay.ts [file] [--speed 30|max]
 *
 * Pacing: inter-record delays are the recorded Ts deltas divided by the speed
 * multiplier, with the effective speed floored so the WHOLE replay fits in
 * 5 minutes. That floor matters: recordings include pre-match coverage records
 * from days earlier (the semi recording spans 3.7 days of Ts), so a naive 30x
 * replay would sit silent for hours before kickoff.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseSseText,
  type ScoreRecord,
  type SseEvent,
  type StreamHandlers,
} from "./txline";
import { scoreline } from "./recorder";

export const DEFAULT_RECORDING = fileURLToPath(
  new URL("../../recordings/18241006-england-argentina-semi.sse", import.meta.url),
);

/** Hard cap on total replay wall-clock time (spec: whole replay ≤ 5 min). */
const MAX_REPLAY_WALL_MS = 5 * 60_000;

export interface ReplayOptions {
  /** Ts-compression multiplier, or "max" for as-fast-as-possible. Default 30. */
  speed?: number | "max";
  /** Override the 5-minute total-duration cap (tests use smaller values). */
  maxWallMs?: number;
  /** Abort mid-replay (e.g. user navigated away in demo mode). */
  signal?: AbortSignal;
}

export interface ReplayResult {
  records: number;
  /** The speed actually used after applying the total-duration cap. */
  effectiveSpeed: number;
  aborted: boolean;
}

/** Parse a recorded .sse file into records + their verbatim blocks. */
export function loadRecording(path: string): { record: ScoreRecord; raw: SseEvent }[] {
  const text = fs.readFileSync(path, "utf8");
  return parseSseText(text).map((raw) => ({
    record: JSON.parse(raw.data) as ScoreRecord,
    raw,
  }));
}

export async function replayFile(
  path: string,
  handlers: StreamHandlers,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const entries = loadRecording(path);
  if (entries.length === 0) {
    return { records: 0, effectiveSpeed: 0, aborted: false };
  }

  const requested = opts.speed ?? 30;
  const maxWallMs = opts.maxWallMs ?? MAX_REPLAY_WALL_MS;
  const spanMs = entries[entries.length - 1].record.Ts - entries[0].record.Ts;
  // Effective speed = the faster of (what was asked for) and (what the 5-min
  // cap requires). Infinity for "max" — the delay computation below yields 0.
  const effectiveSpeed =
    requested === "max" ? Infinity : Math.max(requested, spanMs / Math.max(1, maxWallMs));

  handlers.onStatus?.({ type: "open", detail: `replay ${path} @ ${fmtSpeed(effectiveSpeed)}` });

  let delivered = 0;
  let prevTs: number | null = null;
  for (const { record, raw } of entries) {
    if (opts.signal?.aborted) {
      handlers.onStatus?.({ type: "stopped", detail: "replay aborted" });
      return { records: delivered, effectiveSpeed, aborted: true };
    }
    if (prevTs !== null && Number.isFinite(effectiveSpeed)) {
      const delayMs = Math.max(0, (record.Ts - prevTs) / effectiveSpeed);
      if (delayMs > 0) await interruptibleSleep(delayMs, opts.signal);
    }
    prevTs = record.Ts;
    // Same delivery contract as the live stream: parse errors are impossible
    // here (loadRecording already parsed), handler errors must not stop the
    // match — mirroring streamScores' behavior exactly.
    try {
      handlers.onRecord(record, raw);
    } catch (err) {
      handlers.onStatus?.({ type: "error", detail: `onRecord threw: ${String(err)}` });
    }
    delivered++;
  }
  handlers.onStatus?.({ type: "closed", detail: "replay complete" });
  return { records: delivered, effectiveSpeed, aborted: false };
}

function fmtSpeed(speed: number): string {
  return Number.isFinite(speed) ? `${Math.round(speed)}x` : "max speed";
}

async function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// ---------------------------------------------------------------------------
// CLI: live ticker smoke test
// ---------------------------------------------------------------------------

const TICKER_ACTIONS = new Set([
  "kickoff",
  "goal",
  "corner",
  "yellow_card",
  "red_card",
  "penalty",
  "shot",
  "substitution",
  "halftime_finalised",
  "game_finalised",
]);

function minute(record: ScoreRecord): string {
  const secs = record.Clock?.Seconds;
  return secs === undefined ? "  --" : `${String(Math.floor(secs / 60)).padStart(3)}'`;
}

async function cli(): Promise<void> {
  const argv = process.argv.slice(2);
  let file = DEFAULT_RECORDING;
  let speed: number | "max" = 30;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--speed") {
      const v = argv[++i];
      speed = v === "max" ? "max" : Number(v);
      if (speed !== "max" && (!Number.isFinite(speed) || speed <= 0)) {
        console.error(`invalid --speed: ${v}`);
        process.exit(2);
      }
    } else if (!a.startsWith("--")) {
      file = a;
    } else {
      console.error(`unknown argument: ${a}\nusage: replay.ts [file.sse] [--speed <n>|max]`);
      process.exit(2);
    }
  }

  console.log(`replaying ${file}`);
  let last: ScoreRecord | null = null;
  const result = await replayFile(
    file,
    {
      onRecord: (record) => {
        last = record;
        if (TICKER_ACTIONS.has(record.Action)) {
          console.log(
            `  seq=${String(record.Seq).padStart(4)} ${minute(record)} ` +
              `${record.Action.padEnd(19)} ${scoreline(record)}`,
          );
        }
      },
      onStatus: (s) => console.log(`[replay] ${s.type}${s.detail ? ` — ${s.detail}` : ""}`),
    },
    { speed },
  );
  if (last !== null) {
    const rec = last as ScoreRecord;
    console.log(
      `done: ${result.records} records @ ${fmtSpeed(result.effectiveSpeed)}; ` +
        `final seq=${rec.Seq} action=${rec.Action} score ${scoreline(rec)}`,
    );
  }
}

// Run the CLI only when executed directly — importing replayFile as a library
// (settlement engine, relay, smoke tests) must not trigger a replay.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (invokedDirectly) {
  cli().catch((err) => {
    console.error(`replay failed: ${String(err)}`);
    process.exit(1);
  });
}
