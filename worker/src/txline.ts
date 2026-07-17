/**
 * txline.ts — TxLINE auth + upstream helpers for the Worker port of the relay.
 *
 * Mirrors keeper/src/auth.ts semantics, adapted to a stateless runtime:
 *  - the guest JWT is cached in KV (~10 min TTL) instead of process memory;
 *  - 401 → renew once and retry (no multi-step backoff ladder — a Worker
 *    request must answer fast; KV serve-stale covers upstream outages).
 */

import type { Env } from "./env";

export const API_BASE = "https://txline-dev.txodds.com/api";
const JWT_URL = "https://txline-dev.txodds.com/auth/guest/start";

const JWT_KV_KEY = "txline:jwt";
const JWT_TTL_SECONDS = 600; // ~10 min — comfortably under observed JWT lifetime
const UPSTREAM_TIMEOUT_MS = 15_000;

export const FIXTURES_KV_KEY = "txline:fixtures";
export const UPSTREAM_AUTH_KV_KEY = "meta:upstreamAuth";
export const FIXTURES_FRESH_MS = 5 * 60_000;

/** Field names mirror the API exactly (same contract as keeper/src/txline.ts). */
export interface FixtureMeta {
  Ts: number;
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
  GameState: number | string;
}

/**
 * Served only if the Worker has NEVER reached TxLINE (KV empty + upstream
 * down). Copied verbatim from keeper/src/relay.ts.
 */
export const FALLBACK_FIXTURES: FixtureMeta[] = [
  {
    Ts: 0, StartTime: 1784142000000, Competition: "FIFA World Cup", CompetitionId: 72,
    FixtureGroupId: 10115573, Participant1Id: 1888, Participant1: "England",
    Participant2Id: 1489, Participant2: "Argentina", FixtureId: 18241006,
    Participant1IsHome: true, GameState: 100,
  },
  {
    Ts: 0, StartTime: 1784408400000, Competition: "FIFA World Cup", CompetitionId: 72,
    FixtureGroupId: 0, Participant1Id: 0, Participant1: "France",
    Participant2Id: 0, Participant2: "England", FixtureId: 18257865,
    Participant1IsHome: true, GameState: 0,
  },
  {
    Ts: 0, StartTime: 1784487600000, Competition: "FIFA World Cup", CompetitionId: 72,
    FixtureGroupId: 0, Participant1Id: 0, Participant1: "Spain",
    Participant2Id: 0, Participant2: "Argentina", FixtureId: 18257739,
    Participant1IsHome: true, GameState: 0,
  },
];

/** Guest JWT: KV-cached, force=true bypasses the cache after a 401. */
export async function getJwt(env: Env, force = false): Promise<string> {
  if (!force) {
    const cached = await env.KV.get(JWT_KV_KEY);
    if (cached) return cached;
  }
  const res = await fetch(JWT_URL, {
    method: "POST",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`guest/start returned HTTP ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("guest/start response has no token field");
  await env.KV.put(JWT_KV_KEY, body.token, { expirationTtl: JWT_TTL_SECONDS });
  return body.token;
}

export interface AuthedFetchOptions {
  /** Streaming callers (SSE) own the response lifetime — no per-attempt timeout. */
  noTimeout?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * fetch() against the TxLINE API with both auth headers; on 401 renew the
 * guest JWT once and retry. Returns the final Response (callers check .ok).
 */
export async function authedFetch(env: Env, path: string, opts: AuthedFetchOptions = {}): Promise<Response> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;

  const attempt = async (jwt: string): Promise<Response> =>
    fetch(url, {
      headers: {
        ...opts.headers,
        Authorization: `Bearer ${jwt}`,
        "X-Api-Token": env.TXLINE_API_TOKEN,
      },
      signal: opts.signal ?? (opts.noTimeout ? undefined : AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)),
    });

  let res = await attempt(await getJwt(env));
  if (res.status === 401) {
    await res.body?.cancel().catch(() => {});
    res = await attempt(await getJwt(env, true));
  }
  return res;
}

/** GET an upstream JSON endpoint; throws with a relay-style message on failure. */
export async function getUpstreamJson<T>(env: Env, path: string): Promise<T> {
  const res = await authedFetch(env, path);
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`GET ${path} → HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
  return (await res.json()) as T;
}

interface FixturesCacheEntry {
  at: number;
  data: FixtureMeta[];
}

export interface FixturesResult {
  fixtures: FixtureMeta[];
  /** "txline" (fresh or stale-but-real) | "fallback" (hardcoded 3). */
  source: "txline" | "fallback";
}

/**
 * Fixtures with the relay's serve-stale contract: fresh KV copy (≤5 min) →
 * serve; else refresh from TxLINE (recording success/failure in KV for
 * /api/health); on failure serve the stale KV copy forever; only a cold
 * KV + dead upstream yields the hardcoded fallback.
 */
export async function getFixtures(env: Env): Promise<FixturesResult> {
  const cached = (await env.KV.get(FIXTURES_KV_KEY, "json").catch(() => null)) as FixturesCacheEntry | null;
  if (cached && Date.now() - cached.at < FIXTURES_FRESH_MS) {
    return { fixtures: cached.data, source: "txline" };
  }
  try {
    const data = await getUpstreamJson<FixtureMeta[]>(env, "/fixtures/snapshot");
    await env.KV.put(FIXTURES_KV_KEY, JSON.stringify({ at: Date.now(), data } satisfies FixturesCacheEntry));
    await env.KV.put(UPSTREAM_AUTH_KV_KEY, "1");
    return { fixtures: data, source: "txline" };
  } catch (err) {
    console.error(`[relay] fixtures refresh failed (serving stale): ${String(err)}`);
    await env.KV.put(UPSTREAM_AUTH_KV_KEY, "0").catch(() => {});
    if (cached) return { fixtures: cached.data, source: "txline" };
    return { fixtures: FALLBACK_FIXTURES, source: "fallback" };
  }
}
