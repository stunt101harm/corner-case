/**
 * index.ts — corner-case-relay: the Cloudflare Worker port of the judge-facing
 * relay (reference implementation: keeper/src/relay.ts, which stays the local
 * dev server). Response shapes mirror the local relay exactly — the web app
 * consumes them interchangeably.
 *
 * Routes:
 *   GET  /api/health                       {ok, upstreamAuth, fixtures, uptime}
 *   GET  /api/fixtures                     KV-cached TxLINE snapshot, serve-stale, hardcoded fallback
 *   GET  /api/snapshot/:fixtureId          authed proxy → /scores/snapshot/:id
 *   GET  /api/proof/:fixtureId?seq=&keys=  authed proxy → /scores/stat-validation
 *   GET  /api/stream                       per-request SSE proxy → /scores/stream
 *   GET  /api/replay/:fixtureId?speed=     SSE replay of the bundled recording
 *   POST /api/faucet {wallet}              0.02 SOL + 1000 USDC-dev transfer (KV rate limit)
 *   GET  /api/settlements                  KV-stored journal
 *   POST /api/settlements                  replace journal (X-Sync-Token required)
 */

import type { Env } from "./env";
import {
  FALLBACK_FIXTURES,
  FIXTURES_KV_KEY,
  UPSTREAM_AUTH_KV_KEY,
  authedFetch,
  getFixtures,
  getUpstreamJson,
} from "./txline";
import { RECORDINGS, streamReplay } from "./replay";
import { handleFaucet } from "./faucet";

const SETTLEMENTS_KV_KEY = "settlements";

/**
 * Isolate first-request time — /api/health "uptime" is isolate age, the
 * nearest Worker analog. Lazily set: Date.now() is frozen at 0 during global
 * scope evaluation in workerd.
 */
let startedAt: number | null = null;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Sync-Token",
};

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    startedAt ??= Date.now();
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.error(`[relay] unhandled route error: ${String(err)}`);
      return json(500, { error: "internal error" });
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "proof", "123"]

  if (parts[0] !== "api") {
    return json(parts.length === 0 ? 200 : 404, {
      service: "corner-case relay",
      endpoints: [
        "GET /api/fixtures", "GET /api/stream", "GET /api/replay/:fixtureId?speed=30|max",
        "GET /api/proof/:fixtureId?seq=N&keys=1,2", "GET /api/snapshot/:fixtureId",
        "POST /api/faucet {wallet}", "GET /api/settlements", "GET /api/health",
      ],
    });
  }

  const [, endpoint, param] = parts;

  switch (endpoint) {
    case "health": {
      let upstreamAuth = await env.KV.get(UPSTREAM_AUTH_KV_KEY);
      if (upstreamAuth === null) {
        // Cold KV — probe upstream once so health reports reality, and warm
        // the fixtures cache while we're at it.
        await getFixtures(env);
        upstreamAuth = await env.KV.get(UPSTREAM_AUTH_KV_KEY);
      }
      const cached = (await env.KV.get(FIXTURES_KV_KEY, "json").catch(() => null)) as
        | { data: unknown[] }
        | null;
      return json(200, {
        ok: true,
        upstreamAuth: upstreamAuth === "1",
        fixtures: cached?.data.length ?? FALLBACK_FIXTURES.length,
        uptime: Math.round((Date.now() - (startedAt ?? Date.now())) / 1000),
      });
    }

    case "fixtures": {
      const { fixtures, source } = await getFixtures(env);
      return json(200, fixtures, { "X-Fixtures-Source": source });
    }

    case "stream": {
      // Per-request proxy: ONE upstream /scores/stream per client, bytes piped
      // through verbatim (upstream heartbeats keep both hops alive).
      let upstream: Response;
      try {
        upstream = await authedFetch(env, "/scores/stream", {
          headers: { Accept: "text/event-stream" },
          noTimeout: true,
          signal: request.signal,
        });
      } catch (err) {
        return json(502, { error: `stream upstream failed: ${String(err)}` });
      }
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel().catch(() => {});
        return json(502, { error: `stream connect → HTTP ${upstream.status}` });
      }
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      ctx.waitUntil(
        (async () => {
          try {
            await writer.write(new TextEncoder().encode(": connected\n\n"));
            writer.releaseLock();
            await upstream.body!.pipeTo(writable);
          } catch {
            await upstream.body?.cancel().catch(() => {});
            await writable.abort().catch(() => {});
          }
        })(),
      );
      return new Response(readable, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          ...CORS_HEADERS,
        },
      });
    }

    case "replay": {
      if (!param || !/^\d+$/.test(param)) {
        return json(400, { error: "usage: /api/replay/:fixtureId?speed=30|max" });
      }
      const entries = RECORDINGS[param];
      if (!entries) {
        return json(404, { error: `no recording for fixture ${param}` });
      }
      const speedParam = url.searchParams.get("speed");
      let speed: number | "max" = 30;
      if (speedParam === "max") speed = "max";
      else if (speedParam !== null) {
        speed = Number(speedParam);
        if (!Number.isFinite(speed) || speed <= 0) {
          return json(400, { error: `invalid speed: ${speedParam}` });
        }
      }
      const { response, done } = streamReplay(entries, speed, request.signal);
      ctx.waitUntil(done);
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
      return new Response(response.body, { status: 200, headers });
    }

    case "proof": {
      if (!param || !/^\d+$/.test(param)) {
        return json(400, { error: "usage: /api/proof/:fixtureId?seq=N&keys=1,2" });
      }
      const seq = Number(url.searchParams.get("seq"));
      const keys = (url.searchParams.get("keys") ?? "")
        .split(",")
        .filter(Boolean)
        .map(Number);
      if (!Number.isInteger(seq) || seq < 0) {
        return json(400, { error: "seq must be a non-negative integer" });
      }
      if (keys.length < 1 || keys.length > 5 || keys.some((k) => !Number.isInteger(k) || k < 0)) {
        return json(400, { error: "keys must be 1-5 comma-separated stat keys" });
      }
      try {
        const proof = await getUpstreamJson<unknown>(
          env,
          `/scores/stat-validation?fixtureId=${param}&seq=${seq}&statKeys=${keys.join(",")}`,
        );
        return json(200, proof);
      } catch (err) {
        return json(502, { error: `stat-validation upstream failed: ${String(err)}` });
      }
    }

    case "snapshot": {
      if (!param || !/^\d+$/.test(param)) {
        return json(400, { error: "usage: /api/snapshot/:fixtureId" });
      }
      try {
        return json(200, await getUpstreamJson<unknown>(env, `/scores/snapshot/${param}`));
      } catch (err) {
        return json(502, { error: `snapshot upstream failed: ${String(err)}` });
      }
    }

    case "faucet": {
      if (request.method !== "POST") {
        return json(405, { error: "POST only" });
      }
      const body = await request.text();
      const { status, json: payload } = await handleFaucet(env, body);
      return json(status, payload);
    }

    case "settlements": {
      if (request.method === "POST") {
        // Laptop → cloud journal sync (scripts/sync_settlements.mjs).
        const token = request.headers.get("X-Sync-Token");
        if (!env.SYNC_TOKEN || token !== env.SYNC_TOKEN) {
          return json(401, { error: "missing or invalid X-Sync-Token" });
        }
        let entries: unknown;
        try {
          entries = JSON.parse(await request.text());
        } catch {
          return json(400, { error: "body must be a JSON array of settlement entries" });
        }
        if (!Array.isArray(entries)) {
          return json(400, { error: "body must be a JSON array of settlement entries" });
        }
        await env.KV.put(SETTLEMENTS_KV_KEY, JSON.stringify(entries));
        return json(200, { ok: true, count: entries.length });
      }
      const stored = (await env.KV.get(SETTLEMENTS_KV_KEY, "json").catch(() => null)) as unknown[] | null;
      return json(200, stored ?? []);
    }

    default:
      return json(404, { error: `unknown endpoint: /${parts.join("/")}` });
  }
}
