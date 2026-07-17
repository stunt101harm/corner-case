/**
 * fixtures.ts — merge the relay's live fixtures snapshot with the hardcoded
 * metadata for the three fixtures the product story uses, and classify each
 * into the lifecycle the UI cares about.
 */

import { DEMO_FIXTURE_ID, KNOWN_FIXTURES, LIVE_WINDOW_MS } from "./constants";
import type { FixtureMeta } from "./types";

export type FixtureStatus = "upcoming" | "live" | "finished" | "demo";

export interface FixtureDisplay {
  fixtureId: number;
  home: string;
  away: string;
  kickoffMs: number;
  label?: string;
  status: FixtureStatus;
  finalScore?: string;
}

export function fixtureDisplay(fixtureId: number, metas: FixtureMeta[] = []): FixtureDisplay {
  const known = KNOWN_FIXTURES[fixtureId];
  const meta = metas.find((m) => m.FixtureId === fixtureId);
  // Live TxLINE names win when present; hardcoded meta covers relay downtime.
  const home = meta?.Participant1 ?? known?.home ?? `Fixture ${fixtureId}`;
  const away = meta?.Participant2 ?? known?.away ?? "";
  const kickoffMs = meta?.StartTime ?? known?.kickoffMs ?? 0;
  return {
    fixtureId,
    home,
    away,
    kickoffMs,
    label: known?.label,
    finalScore: known?.finalScore,
    status: classify(fixtureId, kickoffMs),
  };
}

function classify(fixtureId: number, kickoffMs: number): FixtureStatus {
  if (fixtureId === DEMO_FIXTURE_ID) return "demo";
  const now = Date.now();
  if (kickoffMs === 0) return "upcoming";
  if (now < kickoffMs) return "upcoming";
  if (now < kickoffMs + LIVE_WINDOW_MS) return "live";
  return "finished";
}

/**
 * True while one of OUR tournament fixtures could still go live — controls
 * the "tournament is over, run the demo" banner. Deliberately restricted to
 * the known World Cup fixtures: the TxLINE snapshot lists unrelated future
 * friendlies for months, which must not hide the banner from judges.
 */
export function anyLiveOrUpcoming(metas: FixtureMeta[]): boolean {
  for (const id of Object.keys(KNOWN_FIXTURES).map(Number)) {
    const d = fixtureDisplay(id, metas);
    if (d.status === "live" || d.status === "upcoming") return true;
  }
  return false;
}
