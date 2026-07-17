/**
 * state.ts — tracked-fixture registry: the single shared interface that BOTH
 * the live stream and the replay harness feed. Settlement logic downstream
 * (engine + relay) reads fixture state from here and never cares whether the
 * records came off the wire or off a recording — that equivalence is what
 * makes the replay-based demo honest.
 *
 * State-based, not edge-triggered: finalisation is a property of the state
 * (statusId 100 / finalisedSeq set), derived from ANY record that shows it —
 * live SSE event, 60s snapshot poll, or replay. A missed SSE event can never
 * strand a fixture in "still playing".
 *
 * Persists to keeper/state.json (throttled, atomic tmp+rename) so a restarted
 * recorder resumes knowing what it already saw — in particular which fixtures
 * were already finalised, so it does not re-fire finalisation side effects.
 */

import fs from "node:fs";
import path from "node:path";
import type { FixtureMeta, ScoreRecord } from "./txline";

export interface TrackedFixture {
  fixtureId: number;
  /** From /fixtures/snapshot when available (explicit IDs may lack it). */
  meta?: FixtureMeta;
  lastSeq: number;
  statusId?: number;
  lastAction?: string;
  lastTs?: number;
  /** Latest non-empty Score block. */
  score?: ScoreRecord["Score"];
  /** Latest non-empty Stats map. */
  stats?: Record<string, number>;
  /** Seq of the game_finalised record — the seq settlement proofs target. */
  finalisedSeq?: number;
  /** Ts (ms) of the game_finalised record. */
  finalisedTs?: number;
  updatedAt: number;
}

export interface ApplyResult {
  tracked: boolean;
  /** True exactly once per fixture: the record that first showed finalisation. */
  finalisedNow: boolean;
  /** Record was older than what we already had and was ignored. */
  stale: boolean;
}

interface PersistedState {
  version: 1;
  savedAt: number;
  fixtures: Record<string, TrackedFixture>;
}

const SAVE_THROTTLE_MS = 2_000;

export class FixtureRegistry {
  private fixtures = new Map<number, TrackedFixture>();
  private readonly persistPath?: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(opts: { persistPath?: string } = {}) {
    this.persistPath = opts.persistPath;
    if (this.persistPath && fs.existsSync(this.persistPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.persistPath, "utf8")) as PersistedState;
        for (const f of Object.values(raw.fixtures ?? {})) {
          this.fixtures.set(f.fixtureId, f);
        }
      } catch (err) {
        // A corrupt state file (e.g. power loss mid-write before we switched to
        // tmp+rename) must not brick the recorder — start fresh and say so.
        console.error(`[state] could not load ${this.persistPath}, starting fresh: ${String(err)}`);
      }
    }
  }

  track(fixtureId: number, meta?: FixtureMeta): TrackedFixture {
    let f = this.fixtures.get(fixtureId);
    if (!f) {
      f = { fixtureId, lastSeq: -1, updatedAt: Date.now() };
      this.fixtures.set(fixtureId, f);
      this.markDirty();
    }
    if (meta && !f.meta) {
      f.meta = meta;
      this.markDirty();
    }
    return f;
  }

  isTracked(fixtureId: number): boolean {
    return this.fixtures.has(fixtureId);
  }

  get(fixtureId: number): TrackedFixture | undefined {
    return this.fixtures.get(fixtureId);
  }

  all(): TrackedFixture[] {
    return [...this.fixtures.values()];
  }

  /**
   * Fold one score record into fixture state. Works identically for live
   * stream records, snapshot records and replayed records — that is the whole
   * point of this module.
   */
  applyRecord(record: ScoreRecord): ApplyResult {
    const f = this.fixtures.get(record.FixtureId);
    if (!f) return { tracked: false, finalisedNow: false, stale: false };
    // Seq is the authoritative order; reconnects and snapshot polls re-deliver
    // old records, which must not roll state backwards.
    if (record.Seq < f.lastSeq) return { tracked: true, finalisedNow: false, stale: true };

    f.lastSeq = record.Seq;
    f.lastAction = record.Action;
    f.lastTs = record.Ts;
    if (record.StatusId !== undefined) f.statusId = record.StatusId;
    if (record.Score && Object.keys(record.Score).length > 0) f.score = record.Score;
    if (record.Stats && Object.keys(record.Stats).length > 0) f.stats = record.Stats;
    f.updatedAt = Date.now();

    let finalisedNow = false;
    if ((record.StatusId === 100 || record.Action === "game_finalised") && f.finalisedSeq === undefined) {
      f.finalisedSeq = record.Seq;
      f.finalisedTs = record.Ts;
      finalisedNow = true;
    }
    this.markDirty();
    return { tracked: true, finalisedNow, stale: false };
  }

  /**
   * Fold a /scores/snapshot array (latest-record-per-action, mixed Seqs) into
   * state. Sorted ascending first so the per-record Seq guard sees them in
   * order and the highest-Seq facts win deterministically.
   */
  applySnapshot(fixtureId: number, records: ScoreRecord[]): ApplyResult {
    if (!this.fixtures.has(fixtureId)) return { tracked: false, finalisedNow: false, stale: false };
    let finalisedNow = false;
    for (const rec of [...records].sort((a, b) => a.Seq - b.Seq)) {
      if (rec.FixtureId !== fixtureId) continue; // defensive: never cross-pollinate fixtures
      if (this.applyRecord(rec).finalisedNow) finalisedNow = true;
    }
    return { tracked: true, finalisedNow, stale: false };
  }

  // -- persistence ----------------------------------------------------------

  private markDirty(): void {
    if (!this.persistPath) return;
    this.dirty = true;
    if (this.saveTimer) return; // trailing-edge throttle: one write per window
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, SAVE_THROTTLE_MS);
    // unref: a pending state save must never keep a finished process alive.
    this.saveTimer.unref?.();
  }

  private saveNow(): void {
    if (!this.persistPath || !this.dirty) return;
    this.dirty = false;
    const state: PersistedState = {
      version: 1,
      savedAt: Date.now(),
      fixtures: Object.fromEntries([...this.fixtures.entries()].map(([k, v]) => [String(k), v])),
    };
    try {
      // tmp + rename so a crash mid-write can never leave a half-written file.
      const tmp = `${this.persistPath}.tmp`;
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, this.persistPath);
    } catch (err) {
      this.dirty = true; // keep the data; the next throttle window retries
      console.error(`[state] save failed: ${String(err)}`);
    }
  }

  /** Force a synchronous save — call on shutdown. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveNow();
  }
}
