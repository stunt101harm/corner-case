/**
 * txline.ts — typed client over authedFetch for the TxLINE devnet API,
 * plus the SSE machinery shared by the live stream, the historical endpoint
 * (whose response body is SSE-formatted text), and the replay harness.
 *
 * Verified surface (spike, 2026-07-17):
 *   GET /fixtures/snapshot                      → FixtureMeta[]
 *   GET /scores/snapshot/{fixtureId}            → ScoreRecord[]  (see note below)
 *   GET /scores/historical/{fixtureId}          → SSE-formatted text, full match log
 *   GET /scores/stream  (Accept: text/event-stream) → live records, ALL fixtures
 *   GET /scores/stat-validation?fixtureId=&seq=&statKeys=  → Merkle proof JSON
 *
 * Note on /scores/snapshot: it does NOT return one merged state object — it
 * returns an array with the LATEST RECORD PER ACTION TYPE (verified live:
 * 18241006 → 37 records, one each for goal/corner/kickoff/…, mixed Seqs).
 * summariseSnapshot() reduces that to the current state a caller wants.
 */

import { TxlineAuth } from "./auth";

// ---------------------------------------------------------------------------
// Types (field names mirror the API exactly — no renaming, so recorded JSON,
// live JSON and these types never drift apart)
// ---------------------------------------------------------------------------

export interface FixtureMeta {
  Ts: number;
  /** Kickoff, epoch ms. */
  StartTime: number;
  Competition: string;
  CompetitionId: number;
  FixtureGroupId: number;
  Participant1Id: number;
  Participant1: string;
  Participant2Id: number;
  Participant2: string;
  FixtureId: number;
  Participant1IsHome: boolean;
  /** Numeric in /fixtures/snapshot, string ("scheduled") inside score records. */
  GameState: number | string;
}

export interface PeriodScore {
  Goals?: number;
  YellowCards?: number;
  RedCards?: number;
  Corners?: number;
}

export interface ParticipantScore {
  H1?: PeriodScore;
  HT?: PeriodScore;
  H2?: PeriodScore;
  Total?: PeriodScore;
}

export interface ScoreBoard {
  Participant1?: ParticipantScore;
  Participant2?: ParticipantScore;
}

export interface ScoreRecord {
  FixtureId: number;
  /** kickoff | goal | corner | yellow_card | shot | halftime_finalised | game_finalised | … */
  Action: string;
  Id: number;
  Ts: number;
  Seq: number;
  /** 3 = halftime finalised, 100 = game finalised (the settlement trigger). */
  StatusId?: number;
  GameState?: number | string;
  StartTime?: number;
  CompetitionId?: number;
  Clock?: { Running: boolean; Seconds: number };
  Score?: ScoreBoard;
  /** Stat key → value. Keys: 1/2 goals, 3/4 yellows, 5/6 reds, 7/8 corners (P1/P2); +1000 = H1, +3000 = H2. */
  Stats?: Record<string, number>;
  [key: string]: unknown;
}

export interface ProofNode {
  hash: number[];
  isRightSibling: boolean;
}

export interface StatLeaf {
  key: number;
  value: number;
  /** 100 on a leaf means the record it was proven at is final (check gate #2). */
  period: number;
}

export interface StatValidationResponse {
  ts: number;
  statsToProve: StatLeaf[];
  eventStatRoot: number[];
  summary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    eventStatsSubTreeRoot: number[];
  };
  statProofs: ProofNode[][];
  subTreeProof: ProofNode[];
  mainTreeProof: ProofNode[];
}

// ---------------------------------------------------------------------------
// SSE parsing — one incremental parser for live stream, historical bodies and
// recorded .sse files, so all three paths exercise identical code.
// ---------------------------------------------------------------------------

export interface SseEvent {
  /** Joined `data:` payload (multi-line data joined with \n per the SSE spec). */
  data: string;
  /** `id:` field if present — TxLINE sets id == Seq. */
  id?: string;
  /** `event:` field if present (TxLINE does not currently use named events). */
  event?: string;
  /**
   * The block's lines exactly as received (LF-normalized), each terminated
   * with \n, plus the blank separator line — appending consecutive `raw`
   * values reproduces the on-disk .sse format byte-for-byte.
   */
  raw: string;
}

export class SseParser {
  private tail = "";
  private dataLines: string[] = [];
  private id?: string;
  private event?: string;
  private rawLines: string[] = [];
  /** Comment lines (`: heartbeat`) seen so far — used as liveness signal. */
  commentCount = 0;

  /** Feed a chunk of text; returns every event completed within it. */
  push(chunk: string): SseEvent[] {
    const events: SseEvent[] = [];
    // The tail holds a possibly-incomplete final line between chunks.
    const lines = (this.tail + chunk).split(/\r\n|\n|\r/);
    this.tail = lines.pop() ?? "";
    for (const line of lines) {
      const ev = this.handleLine(line);
      if (ev) events.push(ev);
    }
    return events;
  }

  /**
   * Flush a trailing unterminated event. Recorded files (and a server that
   * closes mid-block) may end without the final blank line — without this,
   * the last record of a match would silently vanish.
   */
  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.tail !== "") {
      const ev = this.handleLine(this.tail);
      this.tail = "";
      if (ev) events.push(ev);
    }
    const ev = this.dispatch();
    if (ev) events.push(ev);
    return events;
  }

  private handleLine(line: string): SseEvent | null {
    if (line === "") return this.dispatch();
    this.rawLines.push(line);
    if (line.startsWith(":")) {
      this.commentCount++;
      return null;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1); // spec: strip ONE leading space
    switch (field) {
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        this.id = value;
        break;
      case "event":
        this.event = value;
        break;
      default:
        // "retry:" and unknown fields are ignored per the SSE spec.
        break;
    }
    return null;
  }

  private dispatch(): SseEvent | null {
    const hadContent = this.dataLines.length > 0;
    const ev: SseEvent | null = hadContent
      ? {
          data: this.dataLines.join("\n"),
          id: this.id,
          event: this.event,
          raw: this.rawLines.map((l) => `${l}\n`).join("") + "\n",
        }
      : null;
    this.dataLines = [];
    this.rawLines = [];
    this.id = undefined;
    this.event = undefined;
    return ev;
  }
}

/** Parse a complete SSE-formatted text (historical body, recorded file). */
export function parseSseText(text: string): SseEvent[] {
  const parser = new SseParser();
  return [...parser.push(text), ...parser.end()];
}

// ---------------------------------------------------------------------------
// Live stream consumer
// ---------------------------------------------------------------------------

export interface StreamStatus {
  type: "connecting" | "open" | "closed" | "retry" | "error" | "stopped";
  attempt?: number;
  waitMs?: number;
  detail?: string;
}

export interface StreamHandlers {
  /** Called once per parsed score record; `raw` is the verbatim SSE block. */
  onRecord: (record: ScoreRecord, raw: SseEvent) => void;
  onStatus?: (status: StreamStatus) => void;
}

export interface StreamHandle {
  stop(): void;
  /** Resolves when the loop has fully wound down after stop(). */
  done: Promise<void>;
}

export interface StreamOptions {
  /**
   * Abort + reconnect if the socket goes silent this long. This is the ONLY
   * reliable defense against laptop sleep/wake and silently-dead TCP
   * connections, which produce no error and no bytes — the stream just goes
   * quiet forever. 120s is comfortably above observed record cadence during
   * live matches; a spurious reconnect during a quiet spell is harmless.
   */
  idleTimeoutMs?: number;
  /** Resume hint for the first connection (Last-Event-ID header). */
  lastEventId?: string;
}

const MAX_BACKOFF_MS = 60_000;
const STABLE_CONNECTION_MS = 60_000;

/** Exponential backoff with jitter in [0.5x, 1x] so a fleet of reconnecting
 *  clients (or one client with several loops) never synchronizes into bursts. */
function jitteredBackoff(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempt);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

// ---------------------------------------------------------------------------
// Snapshot summarisation
// ---------------------------------------------------------------------------

export interface SnapshotSummary {
  maxSeq: number;
  /** StatusId of the highest-Seq record that carries one. */
  statusId?: number;
  /** True iff any record in the snapshot has StatusId 100 (game_finalised). */
  finalised: boolean;
  /** Seq of the game_finalised record, when finalised. */
  finalisedSeq?: number;
  /** The highest-Seq record overall (freshest clock/score/stats). */
  latest?: ScoreRecord;
}

/**
 * Reduce a /scores/snapshot array (latest-record-per-action) to current state.
 * Finalisation detection deliberately scans ALL records rather than trusting
 * the max-Seq one: the last record of a finished match is often a StatusId-less
 * "disconnected" (observed live on 18241006, Seq 963), so the max-Seq record
 * alone would hide the finalisation.
 */
export function summariseSnapshot(records: ScoreRecord[]): SnapshotSummary {
  const summary: SnapshotSummary = { maxSeq: -1, finalised: false };
  let statusSeq = -1;
  for (const rec of records) {
    if (rec.Seq > summary.maxSeq) {
      summary.maxSeq = rec.Seq;
      summary.latest = rec;
    }
    if (rec.StatusId !== undefined && rec.Seq > statusSeq) {
      statusSeq = rec.Seq;
      summary.statusId = rec.StatusId;
    }
    if (rec.StatusId === 100 || rec.Action === "game_finalised") {
      summary.finalised = true;
      summary.finalisedSeq =
        summary.finalisedSeq === undefined ? rec.Seq : Math.min(summary.finalisedSeq, rec.Seq);
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class TxlineClient {
  constructor(readonly auth: TxlineAuth) {}

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.auth.authedFetch(path);
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`GET ${path} → HTTP ${res.status}${body ? `: ${body}` : ""}`);
    }
    return (await res.json()) as T;
  }

  fixturesSnapshot(): Promise<FixtureMeta[]> {
    return this.getJson<FixtureMeta[]>("/fixtures/snapshot");
  }

  /** Current state of one fixture — array of latest-record-per-action. */
  scoresSnapshot(fixtureId: number): Promise<ScoreRecord[]> {
    return this.getJson<ScoreRecord[]>(`/scores/snapshot/${fixtureId}`);
  }

  /**
   * Full match log. The body is SSE-formatted TEXT (data:/id: lines), not a
   * stream and not JSON — undocumented but verified (id == Seq). ~1 MB for a
   * full match, hence the generous own timeout instead of the default 30s.
   */
  async historicalScores(fixtureId: number): Promise<ScoreRecord[]> {
    const res = await this.auth.authedFetch(`/scores/historical/${fixtureId}`, {
      noTimeout: true,
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      throw new Error(`GET /scores/historical/${fixtureId} → HTTP ${res.status}`);
    }
    const events = parseSseText(await res.text());
    return events.map((ev) => JSON.parse(ev.data) as ScoreRecord);
  }

  /** Merkle proof for up to 5 stat keys at a given seq. */
  statValidation(
    fixtureId: number,
    seq: number,
    statKeys: number[],
  ): Promise<StatValidationResponse> {
    if (statKeys.length < 1 || statKeys.length > 5) {
      // Verified API limit — a 6th key does not degrade gracefully server-side.
      throw new Error(`statValidation: 1–5 statKeys per request, got ${statKeys.length}`);
    }
    return this.getJson<StatValidationResponse>(
      `/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKeys.join(",")}`,
    );
  }

  /**
   * Live SSE consumer. Runs forever until stop(): connects, parses, delivers,
   * and on ANY termination (server close, network drop, idle watchdog, 5xx at
   * connect) reconnects with jittered exponential backoff. The backoff ladder
   * resets only after a connection that survived STABLE_CONNECTION_MS —
   * resetting on mere "open" would let a connect-then-immediately-die server
   * hammer us at full speed.
   */
  streamScores(handlers: StreamHandlers, opts: StreamOptions = {}): StreamHandle {
    const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
    let stopped = false;
    let controller: AbortController | null = null;
    let lastEventId = opts.lastEventId;

    const emitStatus = (status: StreamStatus): void => {
      try {
        handlers.onStatus?.(status);
      } catch {
        // A logging callback must never be able to kill the stream loop.
      }
    };

    const deliver = (ev: SseEvent): void => {
      if (ev.id !== undefined) lastEventId = ev.id;
      if (!ev.data) return;
      // Verified live: the stream sends `event: heartbeat` + `data: {"Ts":...}`
      // every ~15s. They keep the idle watchdog fed (bytes = activity) but are
      // not score records and must not reach consumers.
      if (ev.event === "heartbeat") return;
      let record: ScoreRecord;
      try {
        record = JSON.parse(ev.data) as ScoreRecord;
      } catch {
        emitStatus({ type: "error", detail: `unparseable data block: ${ev.data.slice(0, 120)}` });
        return;
      }
      if (typeof record.FixtureId !== "number") {
        // Unknown non-record payload — surface it (new server behavior is
        // exactly the kind of thing we want in the logs), but do not deliver.
        emitStatus({ type: "error", detail: `data block without FixtureId: ${ev.data.slice(0, 120)}` });
        return;
      }
      try {
        handlers.onRecord(record, ev);
      } catch (err) {
        // A consumer bug on one record must not tear down the whole stream.
        emitStatus({ type: "error", detail: `onRecord threw: ${String(err)}` });
      }
    };

    const done = (async () => {
      let attempt = 0;
      while (!stopped) {
        controller = new AbortController();
        const connectedAt = Date.now();
        try {
          emitStatus({ type: "connecting", attempt });
          const headers: Record<string, string> = { Accept: "text/event-stream" };
          // SSE resume convention; harmless if TxLINE ignores it (behavior
          // unmeasured as of Jul 17 — snapshot polling covers any gap anyway).
          if (lastEventId !== undefined) headers["Last-Event-ID"] = lastEventId;
          const res = await this.auth.authedFetch("/scores/stream", {
            headers,
            signal: controller.signal,
            noTimeout: true,
          });
          if (!res.ok || !res.body) {
            throw new Error(`stream connect → HTTP ${res.status}`);
          }
          emitStatus({ type: "open" });

          let lastActivity = Date.now();
          const ctl = controller;
          const watchdog = setInterval(() => {
            if (Date.now() - lastActivity > idleTimeoutMs) {
              ctl.abort(new Error(`idle ${idleTimeoutMs}ms — reconnecting`));
            }
          }, 5_000);
          watchdog.unref?.();

          const parser = new SseParser();
          const decoder = new TextDecoder();
          try {
            for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
              lastActivity = Date.now(); // any bytes (incl. heartbeats) count as life
              for (const ev of parser.push(decoder.decode(chunk, { stream: true }))) {
                deliver(ev);
              }
            }
            for (const ev of parser.end()) deliver(ev);
          } finally {
            clearInterval(watchdog);
          }
          emitStatus({ type: "closed", detail: "server ended stream" });
        } catch (err) {
          if (!stopped) emitStatus({ type: "closed", detail: String(err) });
        }
        if (stopped) break;
        if (Date.now() - connectedAt > STABLE_CONNECTION_MS) attempt = 0;
        const waitMs = jitteredBackoff(attempt++);
        emitStatus({ type: "retry", attempt, waitMs });
        await sleepUnlessStopped(waitMs, () => stopped);
      }
      emitStatus({ type: "stopped" });
    })();

    return {
      stop(): void {
        stopped = true;
        controller?.abort(new Error("stopped by caller"));
      },
      done,
    };
  }
}

/** Sleep in small slices so stop() takes effect promptly mid-backoff. */
async function sleepUnlessStopped(ms: number, isStopped: () => boolean): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !isStopped()) {
    await new Promise((r) => setTimeout(r, Math.min(500, deadline - Date.now())));
  }
}
