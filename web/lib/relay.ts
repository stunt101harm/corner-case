/**
 * relay.ts — typed fetch helpers for the Corner Case relay. Every read
 * surface of the app goes through these; the browser never talks to TxLINE.
 */

import { RELAY_URL } from "./constants";
import type { FixtureMeta, ScoreRecord, SettlementEntry, StatValidationJson } from "./types";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${RELAY_URL}${path}`, { cache: "no-store" });
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail || `relay ${path} → HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function getFixtures(): Promise<FixtureMeta[]> {
  return getJson<FixtureMeta[]>("/api/fixtures");
}

export function getSettlements(): Promise<SettlementEntry[]> {
  return getJson<SettlementEntry[]>("/api/settlements");
}

export function getSnapshot(fixtureId: number): Promise<ScoreRecord[]> {
  return getJson<ScoreRecord[]>(`/api/snapshot/${fixtureId}`);
}

export function getProof(fixtureId: number, seq: number, keys: number[]): Promise<StatValidationJson> {
  return getJson<StatValidationJson>(`/api/proof/${fixtureId}?seq=${seq}&keys=${keys.join(",")}`);
}

export async function requestFaucet(
  wallet: string,
): Promise<{ ok: boolean; signature: string; sol: number; usdc: number }> {
  const res = await fetch(`${RELAY_URL}/api/faucet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wallet }),
  });
  const body = (await res.json()) as { error?: string; ok?: boolean; signature?: string; sol?: number; usdc?: number };
  if (!res.ok || !body.ok) {
    throw new Error(body.error ?? `faucet → HTTP ${res.status}`);
  }
  return { ok: true, signature: body.signature ?? "", sol: body.sol ?? 0, usdc: body.usdc ?? 0 };
}

export function streamUrl(): string {
  return `${RELAY_URL}/api/stream`;
}

/** Live odds fan-out (all fixtures; the client filters by FixtureId). */
export function oddsStreamUrl(): string {
  return `${RELAY_URL}/api/odds-stream`;
}

export function replayUrl(fixtureId: number, speed: number | "max" = 30): string {
  return `${RELAY_URL}/api/replay/${fixtureId}?speed=${speed}`;
}

/**
 * Find the seq to prove at: the game_finalised record. Scans ALL snapshot
 * entries for StatusId 100 — the newest record of a finished match is a
 * StatusId-less "disconnected", so "latest record" would miss it.
 */
export function findFinalisedSeq(records: ScoreRecord[]): number | null {
  let seq: number | null = null;
  for (const r of records) {
    if (r.StatusId === 100 || r.Action === "game_finalised") {
      seq = seq === null ? r.Seq : Math.min(seq, r.Seq);
    }
  }
  return seq;
}
