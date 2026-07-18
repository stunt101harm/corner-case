/**
 * recorder.ts — unattended capture of live matches. This runs for hours during
 * real World Cup fixtures with nobody watching, so the design bias throughout
 * is: never crash, never lose an already-captured byte, always be able to
 * resume after a restart.
 *
 * Per tracked fixture it produces, under recordings/raw/ (gitignored):
 *   <id>.sse             — every raw SSE block for the fixture, verbatim,
 *                          append-only (same format as the committed semi
 *                          recording → directly replayable)
 *   <id>.snapshots.jsonl — 60s polls of /scores/snapshot (state-based
 *                          finalisation detection; a missed SSE event can
 *                          never strand a fixture)
 *   <id>.proofs.json     — stat-validation Merkle proofs fetched at the
 *                          finalised seq for the product's five key sets
 *   <id>.timing.json     — timestamps of finalisation vs first successful
 *                          proof fetch (measures TxLINE's proof/root lag,
 *                          which the settlement engine needs to know)
 */

import fs from "node:fs";
import path from "node:path";
import { sleep } from "./auth";
import {
  summariseSnapshot,
  type OddsRecord,
  type ScoreRecord,
  type SseEvent,
  type StatValidationResponse,
  type StreamHandle,
  type TxlineClient,
} from "./txline";
import type { FixtureRegistry, TrackedFixture } from "./state";

/**
 * The five proof key sets the product settles on (≤5 keys per request is a
 * verified API limit, so these are separate requests):
 *   [1,2]        total goals P1/P2        [7,8]      total corners P1/P2
 *   [1001,1002]  H1 goals P1/P2           [3005,3006] H2 reds P1/P2
 *   [3,4]        total yellows P1/P2
 */
export const PROOF_KEY_SETS: number[][] = [
  [1, 2],
  [7, 8],
  [1001, 1002],
  [3005, 3006],
  [3, 4],
];

/** 30s between proof attempts — proofs/roots can lag finalisation (unmeasured
 *  before Jul 18; measuring it is exactly what timing.json is for). */
const PROOF_RETRY_DELAY_MS = 30_000;
/** ~1h of attempts before giving up on a key set (devnet outages ran ~10min). */
const PROOF_MAX_ATTEMPTS = 120;

interface ProofFetchTiming {
  keys: number[];
  ok: boolean;
  attempts: number;
  atMs?: number;
  atIso?: string;
  latencyFromFinalisationMs?: number;
  lastError?: string;
}

interface TimingFile {
  fixtureId: number;
  finalisation?: {
    seq: number;
    /** Ts of the finalising record (TxLINE clock). */
    recordTs: number;
    /** When THIS process observed it (our clock) — the lag baseline. */
    observedAtMs: number;
    observedAtIso: string;
    source: "stream" | "snapshot" | "resume";
  };
  proofFetches: ProofFetchTiming[];
  firstProofOkAtMs?: number;
  firstProofOkIso?: string;
  /** observedAt(finalisation) → first successful proof fetch. */
  firstProofLatencyMs?: number;
}

interface ProofsFile {
  fixtureId: number;
  seq: number;
  /** keyed by keySet.join(",") */
  proofs: Record<string, { fetchedAtIso: string; validation: StatValidationResponse }>;
}

export interface RecorderOptions {
  client: TxlineClient;
  registry: FixtureRegistry;
  /** Explicit fixture IDs to track. */
  fixtureIds?: number[];
  /** Additionally track every fixture in this competition (e.g. 72 = World Cup). */
  competitionId?: number;
  outDir: string;
  snapshotIntervalMs?: number;
  log?: (msg: string) => void;
}

export class Recorder {
  private readonly client: TxlineClient;
  private readonly registry: FixtureRegistry;
  private readonly outDir: string;
  private readonly snapshotIntervalMs: number;
  private readonly log: (msg: string) => void;
  private readonly wantFixtureIds: number[];
  private readonly wantCompetitionId?: number;

  private stream: StreamHandle | null = null;
  private oddsStream: StreamHandle | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Fixtures with a proof-fetch loop running or completed (once per run). */
  private proofRuns = new Set<number>();
  /**
   * Per-file promise chain: appends to the same file are serialized so raw
   * blocks land in arrival order even though fs appends are async.
   */
  private appendChains = new Map<string, Promise<void>>();
  /** Live counters for the heartbeat log line. */
  readonly counters = { records: 0, snapshots: 0, streamDrops: 0, oddsRecords: 0, oddsStreamDrops: 0 };

  constructor(opts: RecorderOptions) {
    this.client = opts.client;
    this.registry = opts.registry;
    this.outDir = opts.outDir;
    this.snapshotIntervalMs = opts.snapshotIntervalMs ?? 60_000;
    this.log = opts.log ?? ((msg) => console.log(msg));
    this.wantFixtureIds = opts.fixtureIds ?? [];
    this.wantCompetitionId = opts.competitionId;
  }

  async start(): Promise<void> {
    fs.mkdirSync(this.outDir, { recursive: true });
    await this.resolveTrackedFixtures();

    if (this.registry.all().length === 0) {
      throw new Error("no fixtures to track — pass fixture IDs or --competition");
    }

    // Restart resume: a fixture that finalised in a previous run but whose
    // proofs never completed (crash, outage) gets its proof loop re-kicked.
    for (const f of this.registry.all()) {
      if (f.finalisedSeq !== undefined) this.maybeStartProofFetch(f, "resume", Date.now());
    }

    this.stream = this.client.streamScores(
      {
        onRecord: (record, raw) => this.onStreamRecord(record, raw),
        onStatus: (s) => {
          if (s.type === "retry") this.counters.streamDrops++;
          // "connecting" every reconnect is noise; log the meaningful ones.
          if (s.type !== "connecting") {
            this.log(
              `[stream] ${s.type}${s.attempt !== undefined ? ` attempt=${s.attempt}` : ""}` +
                `${s.waitMs !== undefined ? ` wait=${Math.round(s.waitMs / 1000)}s` : ""}` +
                `${s.detail ? ` (${s.detail})` : ""}`,
            );
          }
        },
      },
      // Live matches emit records every few seconds; 90s of silence means the
      // socket is dead (or the laptop slept) — reconnect.
      { idleTimeoutMs: 90_000 },
    );

    // Odds capture is strictly additive decoration on top of the scores
    // recording — its consumer is separate and independently wrapped, so no
    // odds failure of any kind can touch the scores capture.
    this.startOddsStream();

    this.snapshotTimer = setInterval(() => {
      void this.pollSnapshots();
    }, this.snapshotIntervalMs);
    // First poll immediately: if a fixture finalised while we were down, we
    // want to know now, not in 60s.
    void this.pollSnapshots();

    this.log(
      `[recorder] tracking ${this.registry
        .all()
        .map((f) => this.describe(f))
        .join(", ")}`,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.stream?.stop();
    this.oddsStream?.stop();
    await this.stream?.done;
    // allSettled, not await: even a misbehaving odds loop cannot block the
    // scores flush below.
    await Promise.allSettled([this.oddsStream?.done ?? Promise.resolve()]);
    // Let in-flight file appends land before the process exits.
    await Promise.allSettled([...this.appendChains.values()]);
    this.registry.flush();
  }

  // -- fixture resolution ---------------------------------------------------

  private async resolveTrackedFixtures(): Promise<void> {
    for (const id of this.wantFixtureIds) this.registry.track(id);

    // Meta (team names, kickoff) comes from the fixtures snapshot. If the API
    // is mid-outage at startup we still proceed with explicit IDs — recording
    // must start on time even if devnet is having a moment; meta is cosmetic.
    try {
      const fixtures = await this.client.fixturesSnapshot();
      for (const meta of fixtures) {
        if (this.registry.isTracked(meta.FixtureId)) {
          this.registry.track(meta.FixtureId, meta);
        } else if (
          this.wantCompetitionId !== undefined &&
          meta.CompetitionId === this.wantCompetitionId
        ) {
          this.registry.track(meta.FixtureId, meta);
        }
      }
    } catch (err) {
      if (this.wantCompetitionId !== undefined && this.wantFixtureIds.length === 0) {
        // Competition-only mode cannot proceed without the snapshot.
        throw new Error(`fixtures snapshot unavailable, cannot resolve competition: ${String(err)}`);
      }
      this.log(`[recorder] WARN fixtures snapshot failed (continuing with explicit IDs): ${String(err)}`);
    }
  }

  private describe(f: TrackedFixture): string {
    return f.meta
      ? `${f.fixtureId} ${f.meta.Participant1} v ${f.meta.Participant2}`
      : String(f.fixtureId);
  }

  // -- stream path ----------------------------------------------------------

  private onStreamRecord(record: ScoreRecord, raw: SseEvent): void {
    if (!this.registry.isTracked(record.FixtureId)) return; // stream carries ALL live fixtures
    this.counters.records++;
    // Verbatim raw block first — capture must survive even if state logic throws.
    this.append(this.file(record.FixtureId, ".sse"), raw.raw);

    const result = this.registry.applyRecord(record);
    if (this.isNotable(record)) {
      this.log(`[${record.FixtureId}] seq=${record.Seq} ${record.Action} ${scoreline(record)}`);
    }
    if (result.finalisedNow) {
      this.onFinalised(record.FixtureId, "stream");
    }
  }

  private isNotable(record: ScoreRecord): boolean {
    return [
      "kickoff",
      "goal",
      "corner",
      "yellow_card",
      "red_card",
      "penalty",
      "halftime_finalised",
      "game_finalised",
    ].includes(record.Action);
  }

  // -- odds stream path (additive; must never affect scores capture) --------

  /**
   * Open the /odds/stream consumer and capture updates for tracked fixtures
   * verbatim to <id>.odds.sse — the same robustness contract as the scores
   * recording (append-only, arrival order, disk errors logged and swallowed),
   * but on its OWN upstream connection, its own files and its own counters.
   * Public so a verification harness can drive exactly this consumer against
   * a temp outDir without running the full recorder.
   */
  startOddsStream(): void {
    try {
      this.oddsStream = this.client.streamOdds(
        {
          onRecord: (record, raw) => this.onOddsRecord(record, raw),
          onStatus: (s) => {
            try {
              if (s.type === "retry") this.counters.oddsStreamDrops++;
              if (s.type !== "connecting") {
                this.log(
                  `[odds-stream] ${s.type}${s.attempt !== undefined ? ` attempt=${s.attempt}` : ""}` +
                    `${s.waitMs !== undefined ? ` wait=${Math.round(s.waitMs / 1000)}s` : ""}` +
                    `${s.detail ? ` (${s.detail})` : ""}`,
                );
              }
            } catch {
              // Even a broken log line must not surface into the stream loop.
            }
          },
        },
        // Odds heartbeats arrive every ~15s; 90s of silence means a dead socket.
        { idleTimeoutMs: 90_000 },
      );
    } catch (err) {
      // Belt and braces: streamOdds does not throw synchronously today, but if
      // it ever does, the scores recording must carry on regardless.
      this.log(`[recorder] odds stream failed to start (scores capture unaffected): ${String(err)}`);
    }
  }

  private onOddsRecord(record: OddsRecord, raw: SseEvent): void {
    try {
      if (!this.registry.isTracked(record.FixtureId)) return; // stream carries ALL fixtures
      this.counters.oddsRecords++;
      this.append(this.file(record.FixtureId, ".odds.sse"), raw.raw);
    } catch (err) {
      // streamOdds already guards onRecord, but this consumer must be
      // independently safe by construction.
      this.log(`[recorder] odds record handling failed (scores capture unaffected): ${String(err)}`);
    }
  }

  // -- snapshot polling path ------------------------------------------------

  private async pollSnapshots(): Promise<void> {
    for (const f of this.registry.all()) {
      if (this.stopped) return;
      // Once finalised AND proofs are on disk there is nothing left to learn.
      if (f.finalisedSeq !== undefined && this.proofsComplete(f.fixtureId)) continue;
      try {
        const records = await this.client.scoresSnapshot(f.fixtureId);
        this.counters.snapshots++;
        this.append(
          this.file(f.fixtureId, ".snapshots.jsonl"),
          `${JSON.stringify({ fetchedAtIso: new Date().toISOString(), summary: summariseSnapshot(records), records })}\n`,
        );
        const result = this.registry.applySnapshot(f.fixtureId, records);
        if (result.finalisedNow) {
          this.onFinalised(f.fixtureId, "snapshot");
        }
      } catch (err) {
        // 503 outages land here after authedFetch's own retries — log and let
        // the next 60s tick try again. Polling failures are routine, not fatal.
        this.log(`[${f.fixtureId}] snapshot poll failed: ${String(err)}`);
      }
    }
  }

  // -- finalisation → proofs + timing ---------------------------------------

  private onFinalised(fixtureId: number, source: "stream" | "snapshot"): void {
    const f = this.registry.get(fixtureId);
    if (!f || f.finalisedSeq === undefined) return;
    const observedAtMs = Date.now();
    // finalisedTs comes from the registry, which recorded it off the actual
    // game_finalised record — NOT off whatever record happened to trigger the
    // detection (a snapshot's freshest record is usually a later "disconnected").
    const recordTs = f.finalisedTs ?? 0;
    this.log(
      `[${fixtureId}] GAME FINALISED seq=${f.finalisedSeq} via ${source} ` +
        `(record Ts ${new Date(recordTs).toISOString()})`,
    );
    this.updateTiming(fixtureId, (t) => {
      t.finalisation ??= {
        seq: f.finalisedSeq!,
        recordTs,
        observedAtMs,
        observedAtIso: new Date(observedAtMs).toISOString(),
        source,
      };
    });
    this.maybeStartProofFetch(f, source, observedAtMs);
  }

  private maybeStartProofFetch(
    f: TrackedFixture,
    source: "stream" | "snapshot" | "resume",
    observedAtMs: number,
  ): void {
    if (this.proofRuns.has(f.fixtureId)) return;
    this.proofRuns.add(f.fixtureId);
    if (source === "resume") {
      if (this.proofsComplete(f.fixtureId)) return; // previous run already finished
      this.log(`[${f.fixtureId}] resuming proof fetch at seq=${f.finalisedSeq} after restart`);
      this.updateTiming(f.fixtureId, (t) => {
        t.finalisation ??= {
          seq: f.finalisedSeq!,
          recordTs: f.finalisedTs ?? 0,
          observedAtMs,
          observedAtIso: new Date(observedAtMs).toISOString(),
          source,
        };
      });
    }
    // Detached on purpose: proof fetching (with its retry loop) runs for
    // potentially an hour while the recorder keeps streaming other fixtures.
    void this.fetchProofs(f.fixtureId, f.finalisedSeq!).catch((err) => {
      this.log(`[${f.fixtureId}] proof fetch loop crashed (should not happen): ${String(err)}`);
    });
  }

  private async fetchProofs(fixtureId: number, seq: number): Promise<void> {
    const proofsPath = this.file(fixtureId, ".proofs.json");
    const existing = this.readJson<ProofsFile>(proofsPath) ?? { fixtureId, seq, proofs: {} };

    for (const keys of PROOF_KEY_SETS) {
      const keyId = keys.join(",");
      if (existing.proofs[keyId]) continue; // resumed run: keep what we have
      let attempts = 0;
      let lastError = "";
      while (!this.stopped && attempts < PROOF_MAX_ATTEMPTS) {
        attempts++;
        try {
          const validation = await this.client.statValidation(fixtureId, seq, keys);
          const atMs = Date.now();
          existing.proofs[keyId] = { fetchedAtIso: new Date(atMs).toISOString(), validation };
          this.writeJson(proofsPath, existing);
          this.updateTiming(fixtureId, (t) => {
            const finObserved = t.finalisation?.observedAtMs;
            t.proofFetches.push({
              keys,
              ok: true,
              attempts,
              atMs,
              atIso: new Date(atMs).toISOString(),
              latencyFromFinalisationMs: finObserved !== undefined ? atMs - finObserved : undefined,
            });
            if (t.firstProofOkAtMs === undefined) {
              t.firstProofOkAtMs = atMs;
              t.firstProofOkIso = new Date(atMs).toISOString();
              if (finObserved !== undefined) t.firstProofLatencyMs = atMs - finObserved;
            }
          });
          this.log(
            `[${fixtureId}] proof [${keyId}] OK at seq=${seq} (attempt ${attempts}): ` +
              existing.proofs[keyId].validation.statsToProve
                .map((s) => `${s.key}=${s.value}/p${s.period}`)
                .join(" "),
          );
          break;
        } catch (err) {
          lastError = String(err);
          this.log(`[${fixtureId}] proof [${keyId}] attempt ${attempts} failed: ${lastError}`);
          await sleep(PROOF_RETRY_DELAY_MS);
        }
      }
      if (!existing.proofs[keyId]) {
        this.updateTiming(fixtureId, (t) => {
          t.proofFetches.push({ keys, ok: false, attempts, lastError });
        });
        this.log(`[${fixtureId}] proof [${keyId}] GIVING UP after ${attempts} attempts`);
      }
    }
    this.log(
      `[${fixtureId}] proof fetch done: ${Object.keys(existing.proofs).length}/${PROOF_KEY_SETS.length} key sets on disk`,
    );
  }

  private proofsComplete(fixtureId: number): boolean {
    const file = this.readJson<ProofsFile>(this.file(fixtureId, ".proofs.json"));
    return file !== undefined && PROOF_KEY_SETS.every((keys) => file.proofs[keys.join(",")]);
  }

  // -- file plumbing --------------------------------------------------------

  private file(fixtureId: number, suffix: string): string {
    return path.join(this.outDir, `${fixtureId}${suffix}`);
  }

  private append(filePath: string, text: string): void {
    const prev = this.appendChains.get(filePath) ?? Promise.resolve();
    const next = prev
      .then(() => fs.promises.appendFile(filePath, text))
      .catch((err) => {
        // Disk trouble must not take the stream down; the data for THIS block
        // is lost but the recorder keeps running and keeps trying.
        this.log(`[recorder] append to ${filePath} failed: ${String(err)}`);
      });
    this.appendChains.set(filePath, next);
  }

  private readJson<T>(filePath: string): T | undefined {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  private writeJson(filePath: string, value: unknown): void {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, filePath);
  }

  private updateTiming(fixtureId: number, mutate: (t: TimingFile) => void): void {
    const timingPath = this.file(fixtureId, ".timing.json");
    const timing =
      this.readJson<TimingFile>(timingPath) ?? ({ fixtureId, proofFetches: [] } as TimingFile);
    mutate(timing);
    this.writeJson(timingPath, timing);
  }
}

/** "1-2" from a record's Score block, or "" when it has none. */
export function scoreline(record: ScoreRecord): string {
  const p1 = record.Score?.Participant1?.Total?.Goals ?? 0;
  const p2 = record.Score?.Participant2?.Total?.Goals ?? 0;
  return record.Score ? `${p1}-${p2}` : "";
}
