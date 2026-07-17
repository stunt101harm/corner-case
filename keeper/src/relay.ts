/**
 * relay.ts — the thin HTTP backend between browsers and TxLINE/devnet.
 *
 * Why it exists: judges will not sign a TxLINE subscribe tx, so the frontend
 * never talks to TxLINE directly. The relay re-serves cached fixture data,
 * fans the single upstream SSE connection out to any number of browser tabs,
 * replays recorded matches through the identical event format, proxies
 * stat-validation proofs, and runs the devnet faucet that takes a judge from
 * an empty wallet to a placed bet in under a minute.
 *
 * Design rules:
 *  - Judges must never see a 503 because TxLINE hiccuped: /api/fixtures
 *    serves the last good snapshot (or a hardcoded fallback) forever.
 *  - One upstream stream connection, N browser clients (fan-out).
 *  - Replay is per-client and independent — two judges can watch the demo
 *    match at different points simultaneously.
 *  - Plain node http. No framework: eight routes do not justify one.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { TxlineAuth } from "./auth";
import { TxlineClient, type FixtureMeta, type StreamHandle } from "./txline";
import { loadRecording, replayFile } from "./replay";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USDC_DEV_MINT = new PublicKey("Cx9Y63x8YN7x9UMFba4B1HdmmmH9QVZbvTZgz7k8kspy");
const DEFAULT_RPC_URL = "https://api.devnet.solana.com";

const FIXTURES_REFRESH_MS = 5 * 60_000;
const SSE_HEARTBEAT_MS = 15_000;
const FAUCET_WINDOW_MS = 10 * 60_000;
const FAUCET_SOL_LAMPORTS = 50_000_000; // 0.05 SOL — fees + rent for a few markets
const FAUCET_USDC_BASE_UNITS = 1_000_000_000n; // 1000 USDC-dev (6 decimals)

const RECORDINGS_DIR = fileURLToPath(new URL("../../recordings", import.meta.url));
const SETTLEMENTS_PATH = fileURLToPath(new URL("../settlements.jsonl", import.meta.url));

/**
 * Served only if the relay has NEVER reached TxLINE (e.g. booted during an
 * outage). Real snapshots replace this at the first successful refresh.
 * StartTimes are the verified devnet kickoffs (spike/NOTES.md).
 */
const FALLBACK_FIXTURES: FixtureMeta[] = [
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

// ---------------------------------------------------------------------------
// Live stream fan-out
// ---------------------------------------------------------------------------

/**
 * One upstream /scores/stream connection shared by every browser client.
 * The upstream connects lazily on the first subscriber and disconnects when
 * the last one leaves — after the tournament the stream is silent anyway, and
 * holding a permanent idle upstream SSE buys nothing.
 */
class StreamHub {
  private readonly clients = new Set<http.ServerResponse>();
  private handle: StreamHandle | null = null;

  constructor(private readonly client: TxlineClient) {}

  get size(): number {
    return this.clients.size;
  }

  add(res: http.ServerResponse): void {
    this.clients.add(res);
    if (!this.handle) {
      this.handle = this.client.streamScores({
        // raw.raw is the upstream block verbatim (incl. `id:` line) — browsers
        // see byte-identical SSE whether it came from TxLINE or a recording.
        onRecord: (_record, raw) => this.broadcast(raw.raw),
        // Status transitions go out as SSE comments: visible in curl for
        // debugging, invisible to EventSource consumers.
        onStatus: (s) => this.broadcast(`: upstream ${s.type}${s.detail ? ` ${s.detail}` : ""}\n\n`),
      });
    }
  }

  remove(res: http.ServerResponse): void {
    this.clients.delete(res);
    if (this.clients.size === 0 && this.handle) {
      this.handle.stop();
      this.handle = null;
    }
  }

  private broadcast(text: string): void {
    for (const res of this.clients) {
      try {
        res.write(text);
      } catch {
        this.clients.delete(res); // dead socket — reaped on its 'close' too
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Relay server
// ---------------------------------------------------------------------------

export interface RelayOptions {
  port?: number;
  rpcUrl?: string;
  faucetKeypairPath?: string;
}

export interface Relay {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

export async function startRelay(opts: RelayOptions = {}): Promise<Relay> {
  const startedAt = Date.now();
  const auth = new TxlineAuth();
  const client = new TxlineClient(auth);
  const hub = new StreamHub(client);
  const connection = new Connection(opts.rpcUrl ?? process.env.RPC_URL ?? DEFAULT_RPC_URL, "confirmed");

  // -- fixtures cache -------------------------------------------------------

  let fixturesCache: FixtureMeta[] | null = null;
  let upstreamAuthOk = false;

  async function refreshFixtures(): Promise<void> {
    try {
      fixturesCache = await client.fixturesSnapshot();
      upstreamAuthOk = true;
    } catch (err) {
      // Keep serving the stale cache — that is the whole contract.
      upstreamAuthOk = false;
      console.error(`[relay] fixtures refresh failed (serving stale): ${String(err)}`);
    }
  }
  await refreshFixtures();
  const refreshTimer = setInterval(() => void refreshFixtures(), FIXTURES_REFRESH_MS);
  refreshTimer.unref?.();

  // -- faucet ---------------------------------------------------------------

  const faucetPath =
    opts.faucetKeypairPath ??
    process.env.FAUCET_KEYPAIR_PATH ??
    path.join(process.env.HOME ?? "", ".config/solana/id.json");

  let faucetKeypair: Keypair | null = null;
  function getFaucetKeypair(): Keypair {
    if (!faucetKeypair) {
      // Lazy: the relay must boot (and serve read endpoints) even on a host
      // with no keypair; only /api/faucet needs it.
      faucetKeypair = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(faucetPath, "utf8")) as number[]),
      );
    }
    return faucetKeypair;
  }

  /** wallet base58 → last successful drip (in-memory; restarts reset it). */
  const faucetLastDrip = new Map<string, number>();

  async function handleFaucet(body: string): Promise<{ status: number; json: unknown }> {
    let walletStr: unknown;
    try {
      walletStr = (JSON.parse(body) as { wallet?: unknown }).wallet;
    } catch {
      return { status: 400, json: { error: "body must be JSON: {\"wallet\": \"<base58>\"}" } };
    }
    if (typeof walletStr !== "string") {
      return { status: 400, json: { error: "missing wallet field" } };
    }
    let wallet: PublicKey;
    let ata: PublicKey;
    try {
      wallet = new PublicKey(walletStr);
      // Off-curve owners (PDAs) throw here — a faucet only serves real wallets.
      ata = getAssociatedTokenAddressSync(USDC_DEV_MINT, wallet);
    } catch {
      return { status: 400, json: { error: "not a valid wallet address" } };
    }

    const last = faucetLastDrip.get(walletStr);
    if (last !== undefined && Date.now() - last < FAUCET_WINDOW_MS) {
      const retryInMs = FAUCET_WINDOW_MS - (Date.now() - last);
      return {
        status: 429,
        json: { error: "faucet already used for this wallet — try again later", retryInMs },
      };
    }

    let payer: Keypair;
    try {
      payer = getFaucetKeypair();
    } catch (err) {
      return { status: 500, json: { error: `faucet keypair unavailable: ${String(err)}` } };
    }

    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: wallet,
          lamports: FAUCET_SOL_LAMPORTS,
        }),
        // Idempotent create: a repeat visitor with an existing ATA still works.
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, wallet, USDC_DEV_MINT),
        createMintToInstruction(USDC_DEV_MINT, ata, payer.publicKey, FAUCET_USDC_BASE_UNITS),
      );
      const signature = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: "confirmed",
      });
      // Rate-limit only successful drips — a failed devnet tx should not
      // lock a judge out for 10 minutes.
      faucetLastDrip.set(walletStr, Date.now());
      return {
        status: 200,
        json: { ok: true, signature, sol: FAUCET_SOL_LAMPORTS / 1e9, usdc: Number(FAUCET_USDC_BASE_UNITS) / 1e6 },
      };
    } catch (err) {
      return { status: 502, json: { error: `devnet transaction failed: ${String(err)}` } };
    }
  }

  // -- replay ---------------------------------------------------------------

  /**
   * Recordings begin DAYS before kickoff (pre-match coverage records), and
   * replayFile's 5-minute wall cap compresses by total Ts span — untrimmed,
   * ~97% of the demo's wall clock would be silent pre-match records and the
   * whole match would flash by in seconds. Trimming to the kickoff record
   * makes 30× mean 30× of actual match. The trimmed file is byte-exact SSE
   * (SseEvent.raw round-trips), cached in tmpdir, and fed through the same
   * replayFile pacing path as everything else.
   */
  const replayTrimCache = new Map<string, { mtimeMs: number; path: string }>();
  function prepareReplayFile(file: string): string {
    const { mtimeMs } = fs.statSync(file);
    const cached = replayTrimCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.path;
    let out = file;
    try {
      const entries = loadRecording(file);
      const kickoffIdx = entries.findIndex((e) => e.record.Action === "kickoff");
      if (kickoffIdx > 0) {
        const trimmed = path.join(os.tmpdir(), `corner-case-trimmed-${path.basename(file)}`);
        fs.writeFileSync(trimmed, entries.slice(kickoffIdx).map((e) => e.raw.raw).join(""));
        out = trimmed;
      }
    } catch (err) {
      // Trim is an optimization — an unparseable/unwritable edge falls back
      // to replaying the raw file.
      console.error(`[relay] replay trim failed for ${file}: ${String(err)}`);
    }
    replayTrimCache.set(file, { mtimeMs, path: out });
    return out;
  }

  /**
   * Find the recording for a fixture: committed recordings first, then raw
   * captures. Matched by filename prefix so the committed
   * `18241006-england-argentina-semi.sse` resolves from just the id.
   */
  function findRecording(fixtureId: string): string | null {
    for (const dir of [RECORDINGS_DIR, path.join(RECORDINGS_DIR, "raw")]) {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      const match = entries
        .filter((f) => f.startsWith(fixtureId) && f.endsWith(".sse"))
        .sort()[0];
      if (match) return path.join(dir, match);
    }
    return null;
  }

  // -- settlements journal --------------------------------------------------

  function readSettlements(): unknown[] {
    let text: string;
    try {
      text = fs.readFileSync(SETTLEMENTS_PATH, "utf8");
    } catch {
      return []; // the settle submitter has not written anything yet
    }
    const out: unknown[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A half-written trailing line (journal being appended right now) is
        // expected; skip it rather than failing the whole endpoint.
      }
    }
    return out;
  }

  // -- http plumbing --------------------------------------------------------

  function setCors(res: http.ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(text);
  }

  function openSse(res: http.ServerResponse): () => void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx and friends buffer SSE to death without this.
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    // Heartbeat comments keep proxies from idling the connection out.
    const hb = setInterval(() => {
      try {
        res.write(": hb\n\n");
      } catch {
        clearInterval(hb);
      }
    }, SSE_HEARTBEAT_MS);
    hb.unref?.();
    return () => clearInterval(hb);
  }

  function readBody(req: http.IncomingMessage, maxBytes = 10_240): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  // -- routes ---------------------------------------------------------------

  const server = http.createServer((req, res) => {
    void route(req, res).catch((err) => {
      console.error(`[relay] unhandled route error: ${String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://relay.local");
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "proof", "123"]

    if (parts[0] !== "api") {
      sendJson(res, parts.length === 0 ? 200 : 404, {
        service: "corner-case relay",
        endpoints: [
          "GET /api/fixtures", "GET /api/stream", "GET /api/replay/:fixtureId?speed=30|max",
          "GET /api/proof/:fixtureId?seq=N&keys=1,2", "GET /api/snapshot/:fixtureId",
          "POST /api/faucet {wallet}", "GET /api/settlements", "GET /api/health",
        ],
      });
      return;
    }

    const [, endpoint, param] = parts;

    switch (endpoint) {
      case "health": {
        sendJson(res, 200, {
          ok: true,
          upstreamAuth: upstreamAuthOk,
          fixtures: (fixturesCache ?? FALLBACK_FIXTURES).length,
          uptime: Math.round((Date.now() - startedAt) / 1000),
        });
        return;
      }

      case "fixtures": {
        // Stale-tolerant by construction: whatever we have, we serve.
        res.setHeader("X-Fixtures-Source", fixturesCache ? "txline" : "fallback");
        sendJson(res, 200, fixturesCache ?? FALLBACK_FIXTURES);
        return;
      }

      case "stream": {
        const stopHb = openSse(res);
        hub.add(res);
        req.on("close", () => {
          stopHb();
          hub.remove(res);
        });
        return;
      }

      case "replay": {
        if (!param || !/^\d+$/.test(param)) {
          sendJson(res, 400, { error: "usage: /api/replay/:fixtureId?speed=30|max" });
          return;
        }
        const file = findRecording(param);
        if (!file) {
          sendJson(res, 404, { error: `no recording for fixture ${param}` });
          return;
        }
        const speedParam = url.searchParams.get("speed");
        let speed: number | "max" = 30;
        if (speedParam === "max") speed = "max";
        else if (speedParam !== null) {
          speed = Number(speedParam);
          if (!Number.isFinite(speed) || speed <= 0) {
            sendJson(res, 400, { error: `invalid speed: ${speedParam}` });
            return;
          }
        }
        const stopHb = openSse(res);
        // Independent replay per connection: each client gets its own pacing
        // and its own abort (navigating away stops only that client's replay).
        const abort = new AbortController();
        req.on("close", () => {
          stopHb();
          abort.abort();
        });
        const result = await replayFile(
          prepareReplayFile(file),
          {
            onRecord: (_record, raw) => {
              try {
                res.write(raw.raw);
              } catch {
                abort.abort();
              }
            },
          },
          { speed, signal: abort.signal },
        );
        if (!abort.signal.aborted) {
          // Explicit end-of-replay event so the UI can show "match complete"
          // without heuristics. EventSource clients must close on it or the
          // browser would auto-reconnect and replay forever.
          res.write(`event: replay_done\ndata: ${JSON.stringify(result)}\n\n`);
          res.end();
        }
        return;
      }

      case "proof": {
        if (!param || !/^\d+$/.test(param)) {
          sendJson(res, 400, { error: "usage: /api/proof/:fixtureId?seq=N&keys=1,2" });
          return;
        }
        const seq = Number(url.searchParams.get("seq"));
        const keys = (url.searchParams.get("keys") ?? "")
          .split(",")
          .filter(Boolean)
          .map(Number);
        if (!Number.isInteger(seq) || seq < 0) {
          sendJson(res, 400, { error: "seq must be a non-negative integer" });
          return;
        }
        if (keys.length < 1 || keys.length > 5 || keys.some((k) => !Number.isInteger(k) || k < 0)) {
          sendJson(res, 400, { error: "keys must be 1-5 comma-separated stat keys" });
          return;
        }
        try {
          sendJson(res, 200, await client.statValidation(Number(param), seq, keys));
        } catch (err) {
          sendJson(res, 502, { error: `stat-validation upstream failed: ${String(err)}` });
        }
        return;
      }

      case "snapshot": {
        if (!param || !/^\d+$/.test(param)) {
          sendJson(res, 400, { error: "usage: /api/snapshot/:fixtureId" });
          return;
        }
        try {
          sendJson(res, 200, await client.scoresSnapshot(Number(param)));
        } catch (err) {
          sendJson(res, 502, { error: `snapshot upstream failed: ${String(err)}` });
        }
        return;
      }

      case "faucet": {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "POST only" });
          return;
        }
        let body: string;
        try {
          body = await readBody(req);
        } catch (err) {
          sendJson(res, 400, { error: String(err) });
          return;
        }
        const { status, json } = await handleFaucet(body);
        sendJson(res, status, json);
        return;
      }

      case "settlements": {
        sendJson(res, 200, readSettlements());
        return;
      }

      default:
        sendJson(res, 404, { error: `unknown endpoint: /${parts.join("/")}` });
    }
  }

  const port = opts.port ?? Number(process.env.RELAY_PORT ?? 8787);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve());
  });

  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(refreshTimer);
        server.close(() => resolve());
        // SSE connections keep the server open forever otherwise.
        server.closeAllConnections?.();
      }),
  };
}
