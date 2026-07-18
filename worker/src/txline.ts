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
export const ODDS_FRESH_MS = 60_000;
/** Book entries older than this are dropped — a pulled market must not linger. */
const ODDS_RETENTION_MS = 6 * 3600_000;
/** The whole per-fixture book expires from KV after a day untouched. */
const ODDS_KV_TTL_SECONDS = 86_400;

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

interface OddsCacheEntry {
  at: number;
  /** Market identity ("type|period|params") → { ts, entry: verbatim upstream entry }. */
  book: Record<string, { ts: number; entry: unknown }>;
}

/**
 * Rolling odds book for one fixture (mirrors keeper/src/relay.ts getOdds).
 *
 * TxLINE's /odds/snapshot returns only the LATEST update batch (verified
 * live: every entry shares one Ts and later polls return different, smaller
 * sets), so a pure proxy would make the 1X2 consensus flicker in and out.
 * Each refresh merges the batch into a KV-stored book keyed by market
 * identity (type + period + parameters), newest Ts wins, 6h retention. The
 * response stays an array of verbatim upstream entries.
 *
 * Odds are pure decoration, so this NEVER throws — upstream failures serve
 * the existing book, else []. Finished fixtures legitimately return []
 * upstream (verified on 18241006); that is a valid answer, not an error.
 */
export async function getOddsSnapshot(env: Env, fixtureId: string): Promise<unknown[]> {
  const key = `txline:odds:${fixtureId}`;
  const cached = (await env.KV.get(key, "json").catch(() => null)) as OddsCacheEntry | null;
  const book: OddsCacheEntry["book"] =
    cached && typeof cached.book === "object" && cached.book !== null ? cached.book : {};
  if (cached && Date.now() - cached.at < ODDS_FRESH_MS) {
    return Object.values(book).map((v) => v.entry);
  }
  try {
    const body = await getUpstreamJson<unknown>(env, `/odds/snapshot/${fixtureId}`);
    for (const raw of Array.isArray(body) ? (body as unknown[]) : []) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as { SuperOddsType?: unknown; MarketPeriod?: unknown; MarketParameters?: unknown; Ts?: unknown };
      if (typeof e.SuperOddsType !== "string") continue;
      const marketKey = `${e.SuperOddsType}|${String(e.MarketPeriod ?? "")}|${String(e.MarketParameters ?? "")}`;
      const ts = typeof e.Ts === "number" ? e.Ts : 0;
      const prev = book[marketKey];
      if (!prev || ts >= prev.ts) book[marketKey] = { ts, entry: raw };
    }
    const cutoff = Date.now() - ODDS_RETENTION_MS;
    for (const [k, v] of Object.entries(book)) {
      if (v.ts !== 0 && v.ts < cutoff) delete book[k];
    }
    // A KV write hiccup must not turn a good upstream answer into [].
    await env.KV.put(key, JSON.stringify({ at: Date.now(), book } satisfies OddsCacheEntry), {
      expirationTtl: ODDS_KV_TTL_SECONDS,
    }).catch(() => {});
  } catch (err) {
    console.error(`[relay] odds refresh failed for ${fixtureId} (serving ${Object.keys(book).length ? "stale book" : "empty"}): ${String(err)}`);
  }
  return Object.values(book).map((v) => v.entry);
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
