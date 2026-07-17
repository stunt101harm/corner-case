// Settlement engine (issue #9): watches matched markets, detects fixture
// finalisation, fetches the Merkle proof for each market's OWN pinned stat
// keys, and fires permissionless settle_market transactions.
//
// Design notes:
// - State-based, not edge-based: finalisation comes from snapshot scans
//   (summariseSnapshot — StatusId 100 anywhere in the record set), so a missed
//   SSE event can never strand escrow. This process needs no stream at all.
// - Grace window: we wait GRACE_SECS after FIRST observing finalisation before
//   settling, then re-read the snapshot and use the freshest finalised seq —
//   absorbing official post-final stat corrections. (No correction was
//   observed on the semifinal, but the window costs only latency.)
// - Root-posting lag: every settle is SIMULATED first. TxLINE hard-errors
//   (RootNotAvailable / proof mismatch) while the API's proof is ahead of the
//   on-chain root; a failed simulation just means "retry next tick", and
//   nothing is spent. This is the "verify against the actual chain before
//   submitting" loop from the plan, in its strongest form.
// - Permissionless means self-healing: if this process dies, anyone (the
//   frontend's "Settle now" button, a judge, another keeper) can settle with
//   the same proof. We are a convenience cranker, not an authority.
//
// Run:  npx tsx src/settle.ts            (watch loop, 30s ticks)
//       npx tsx src/settle.ts --once     (single pass, e.g. for the demo fixture)
//       npx tsx src/settle.ts --fixture 18241006   (restrict to one fixture)

import * as anchor from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  Connection,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { TxlineAuth, loadRepoEnv, sleep } from "./auth.js";
import { TxlineClient, summariseSnapshot, type StatValidationResponse } from "./txline.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const IDL_PATH = path.join(REPO_ROOT, "idls", "corner_case.json");
const SETTLEMENTS_PATH = path.join(REPO_ROOT, "keeper", "settlements.jsonl");

const USDC_DEV = new PublicKey("Cx9Y63x8YN7x9UMFba4B1HdmmmH9QVZbvTZgz7k8kspy");
const TXORACLE_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

const POLL_SECS = Number(process.env.SETTLE_POLL_SECS ?? 30);
const GRACE_SECS = Number(process.env.SETTLE_GRACE_SECS ?? 120);
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

loadRepoEnv();
const keypairPath =
  process.env.KEEPER_KEYPAIR_PATH ?? path.join(os.homedir(), ".config", "solana", "id.json");
const keeper = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8"))),
);
const connection = new Connection(RPC_URL, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keeper), {
  commitment: "confirmed",
});
const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
const program = new anchor.Program(idl, provider);
const eventParser = new anchor.EventParser(program.programId, new anchor.BorshCoder(idl));

const client = new TxlineClient(new TxlineAuth());

// fixtureId → unix seconds when we FIRST saw it finalised (grace-window anchor)
const finalisedSeenAt = new Map<number, number>();

// markets we've already settled (or that vanished) this process lifetime
const done = new Set<string>();

// ---------------------------------------------------------------------------
// Payload construction (mirrors scripts/devnet_e2e.mjs, the reference impl)
// ---------------------------------------------------------------------------

function buildPayload(val: StatValidationResponse) {
  const mapProof = (arr: { hash: number[]; isRightSibling: boolean }[]) =>
    arr.map((n) => ({ hash: Array.from(n.hash), isRightSibling: n.isRightSibling }));
  return {
    ts: new anchor.BN(val.summary.updateStats.minTimestamp),
    fixtureSummary: {
      fixtureId: new anchor.BN(val.summary.fixtureId),
      updateStats: {
        updateCount: val.summary.updateStats.updateCount,
        minTimestamp: new anchor.BN(val.summary.updateStats.minTimestamp),
        maxTimestamp: new anchor.BN(val.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: Array.from(val.summary.eventStatsSubTreeRoot),
    },
    fixtureProof: mapProof(val.subTreeProof),
    mainTreeProof: mapProof(val.mainTreeProof),
    eventStatRoot: Array.from(val.eventStatRoot),
    stats: val.statsToProve.map((s, i) => ({
      stat: { key: s.key, value: s.value, period: s.period },
      statProof: mapProof(val.statProofs[i]),
    })),
  };
}

function rootsPdaFor(epochDay: number): PublicKey {
  const le = Buffer.alloc(2);
  le.writeUInt16LE(epochDay);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("daily_scores_roots"), le],
    TXORACLE_ID,
  )[0];
}

// ---------------------------------------------------------------------------
// Settlement of one market
// ---------------------------------------------------------------------------

interface MarketAccount {
  publicKey: PublicKey;
  account: any; // anchor-decoded Market
}

async function settleOne(m: MarketAccount, finalisedSeq: number): Promise<void> {
  const acc = m.account;
  const fixtureId = Number(acc.fixtureId.toString());
  const statKeys: number[] = acc.statKeys;

  const proof = await client.statValidation(fixtureId, finalisedSeq, statKeys);
  const payload = buildPayload(proof);
  const epochDay = Math.floor(proof.summary.updateStats.minTimestamp / 86_400_000);

  const creator: PublicKey = acc.creator;
  const taker: PublicKey = acc.taker;
  const accounts = {
    caller: keeper.publicKey,
    market: m.publicKey,
    creator,
    taker,
    mint: USDC_DEV,
    creatorAta: getAssociatedTokenAddressSync(USDC_DEV, creator),
    takerAta: getAssociatedTokenAddressSync(USDC_DEV, taker),
    escrow: getAssociatedTokenAddressSync(USDC_DEV, m.publicKey, true),
    txlineRoots: rootsPdaFor(epochDay),
    txlineProgram: TXORACLE_ID,
  };
  const builder = program.methods
    .settleMarket(epochDay, payload)
    .accounts(accounts as any)
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]);

  // Simulate first: while TxLINE's on-chain root lags the API proof, the sim
  // fails and we retry next tick at zero cost.
  try {
    await builder.simulate();
  } catch (e: any) {
    log(
      `  sim failed for ${m.publicKey.toBase58()} (root lag or transient) — will retry: ${String(
        e?.message ?? e,
      ).slice(0, 160)}`,
    );
    return;
  }

  const txSig = await builder.rpc();
  log(`  SETTLED ${m.publicKey.toBase58()} → ${txSig}`);
  done.add(m.publicKey.toBase58());

  // Journal for the relay's /api/settlements (receipts of closed markets).
  let predicateTrue: boolean | null = null;
  let winner: string | null = null;
  let payout: string | null = null;
  try {
    const tx = await connection.getTransaction(txSig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    for (const ev of eventParser.parseLogs(tx?.meta?.logMessages ?? [])) {
      if (ev.name === "marketSettled" || ev.name === "MarketSettled") {
        predicateTrue = (ev.data.predicateTrue ?? ev.data.predicate_true ?? null) as
          | boolean
          | null;
        winner = (ev.data.winner as PublicKey).toBase58();
        payout = ev.data.payout.toString();
      }
    }
  } catch {
    // Journal completeness is best-effort; the chain is the source of truth.
  }
  fs.appendFileSync(
    SETTLEMENTS_PATH,
    JSON.stringify({
      market: m.publicKey.toBase58(),
      fixtureId,
      statKeys,
      predicateTrue,
      winner,
      payout,
      epochDay,
      proofTs: proof.summary.updateStats.minTimestamp,
      finalisedSeq,
      txSig,
      settledAt: new Date().toISOString(),
    }) + "\n",
  );
}

// ---------------------------------------------------------------------------
// Watch loop
// ---------------------------------------------------------------------------

async function tick(onlyFixture?: number): Promise<void> {
  const all: MarketAccount[] = await (program.account as any).market.all();
  const matched = all.filter(
    (m) =>
      "matched" in m.account.state &&
      !done.has(m.publicKey.toBase58()) &&
      (onlyFixture === undefined || Number(m.account.fixtureId.toString()) === onlyFixture),
  );
  if (matched.length === 0) return;

  const byFixture = new Map<number, MarketAccount[]>();
  for (const m of matched) {
    const f = Number(m.account.fixtureId.toString());
    byFixture.set(f, [...(byFixture.get(f) ?? []), m]);
  }
  log(`tick: ${matched.length} matched market(s) across ${byFixture.size} fixture(s)`);

  for (const [fixtureId, markets] of byFixture) {
    let summary;
    try {
      summary = summariseSnapshot(await client.scoresSnapshot(fixtureId));
    } catch (e) {
      log(`  snapshot failed for ${fixtureId}: ${String(e).slice(0, 120)}`);
      continue;
    }
    if (!summary.finalised || summary.finalisedSeq === undefined) continue;

    const now = Date.now() / 1000;
    const firstSeen = finalisedSeenAt.get(fixtureId);
    if (firstSeen === undefined) {
      finalisedSeenAt.set(fixtureId, now);
      log(
        `  fixture ${fixtureId} FINALISED (seq ${summary.finalisedSeq}) — grace window ${GRACE_SECS}s`,
      );
      // A zero grace window (demo fixtures, --once runs) settles immediately;
      // otherwise wait out the correction-absorbing window first.
      if (GRACE_SECS > 0) continue;
    } else if (now - firstSeen < GRACE_SECS) {
      continue;
    }

    for (const m of markets) {
      try {
        await settleOne(m, summary.finalisedSeq);
      } catch (e) {
        log(`  settle error for ${m.publicKey.toBase58()}: ${String(e).slice(0, 200)}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const fxIdx = args.indexOf("--fixture");
  const onlyFixture = fxIdx >= 0 ? Number(args[fxIdx + 1]) : undefined;

  log(
    `settle-watch: keeper ${keeper.publicKey.toBase58()}, program ${program.programId.toBase58()}, poll ${POLL_SECS}s, grace ${GRACE_SECS}s${
      onlyFixture ? `, fixture ${onlyFixture}` : ""
    }`,
  );
  for (;;) {
    try {
      await tick(onlyFixture);
    } catch (e) {
      log(`tick error: ${String(e).slice(0, 200)}`);
    }
    if (once) break;
    await sleep(POLL_SECS * 1000);
  }
}

process.on("unhandledRejection", (e) => log(`unhandledRejection: ${String(e).slice(0, 200)}`));
main();
