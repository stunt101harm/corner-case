// Spike #3 probe: validateStatV2 semantics via simulation (issue #3)
// Runs .view()-equivalent simulations against the devnet TxLINE program with a REAL proof:
//   1. TRUE predicate  (away goals - home goals > 0  → Argentina beat England)
//   2. FALSE predicate (home goals - away goals > 0)
//   3. Corrupted proof (flip one byte in a stat proof hash)
//   4. Big payload     (statKeys=1,2,7,8 → 4 leaves, binary Add on corners)
// Measures unitsConsumed + serialized tx size for each.
//
// Run from vendor/tx-on-chain (for node_modules):
//   TXLINE_API_TOKEN=... ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=$HOME/.config/solana/id.json node probe_view.mjs

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
import fs from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const idl = require("./examples/devnet/idl/txoracle.json");

const API = "https://txline-dev.txodds.com/api";
const FIXTURE = 18241006; // England v Argentina, 2026-07-15, final seq 962 (game_finalised, StatusId 100)
const SEQ = 962;

const apiToken = process.env.TXLINE_API_TOKEN;
if (!apiToken) throw new Error("TXLINE_API_TOKEN not set");

const jwtRes = await fetch("https://txline-dev.txodds.com/auth/guest/start", { method: "POST" });
const jwt = (await jwtRes.json()).token;
const H = { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken };

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);
const conn = provider.connection;

const mapProof = (arr) => arr.map((n) => ({ hash: Array.from(n.hash), isRightSibling: n.isRightSibling }));

async function fetchValidation(statKeys) {
  const url = `${API}/scores/stat-validation?fixtureId=${FIXTURE}&seq=${SEQ}&statKeys=${statKeys}`;
  const res = await fetch(url, { headers: H });
  if (!res.ok) throw new Error(`stat-validation ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json();
}

function buildPayload(val) {
  return {
    ts: new BN(val.summary.updateStats.minTimestamp),
    fixtureSummary: {
      fixtureId: new BN(val.summary.fixtureId),
      updateStats: {
        updateCount: val.summary.updateStats.updateCount,
        minTimestamp: new BN(val.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(val.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: Array.from(val.summary.eventStatsSubTreeRoot),
    },
    fixtureProof: mapProof(val.subTreeProof),
    mainTreeProof: mapProof(val.mainTreeProof),
    eventStatRoot: Array.from(val.eventStatRoot),
    stats: val.statsToProve.map((s, i) => ({ stat: s, statProof: mapProof(val.statProofs[i]) })),
  };
}

function pdaFor(tsMs) {
  const epochDay = Math.floor(tsMs / 86400000);
  const b = Buffer.alloc(2);
  b.writeUInt16LE(epochDay);
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), b], program.programId);
  return { pda, epochDay };
}

async function runCase(name, payload, strategy, pda) {
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
  try {
    const tx = await program.methods
      .validateStatV2(payload, strategy)
      .accounts({ dailyScoresMerkleRoots: pda })
      .preInstructions([cuIx])
      .transaction();
    const blockhash = (await conn.getLatestBlockhash()).blockhash;
    const msg = new TransactionMessage({
      payerKey: provider.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: tx.instructions,
    }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    const size = vtx.serialize().length;
    const sim = await conn.simulateTransaction(vtx, { sigVerify: false });
    const v = sim.value;
    let ret = null;
    if (v.returnData?.data?.[0]) {
      const buf = Buffer.from(v.returnData.data[0], "base64");
      ret = { programId: v.returnData.programId, bytes: [...buf], bool: buf.length > 0 && buf[0] === 1 };
    } else if (v.returnData === null && !v.err) {
      ret = { note: "no returnData field (RPC truncates trailing zeros → bool false comes back EMPTY)", bool: false };
    }
    console.log(`\n=== ${name}`);
    console.log(`  err: ${JSON.stringify(v.err)}  unitsConsumed: ${v.unitsConsumed}  txSize: ${size} bytes`);
    console.log(`  returnData: ${JSON.stringify(ret)}`);
    if (v.err) console.log(`  logs tail: ${JSON.stringify((v.logs || []).slice(-5), null, 1)}`);
  } catch (e) {
    console.log(`\n=== ${name}\n  THREW: ${String(e).slice(0, 400)}`);
  }
}

// --- Case set A: two goal stats (keys 1,2) ---
const val2 = await fetchValidation("1,2");
fs.writeFileSync("proof_18241006_seq962_k1-2.json", JSON.stringify(val2, null, 2));
console.log("proof (keys 1,2) captured. statsToProve:", JSON.stringify(val2.statsToProve));
console.log("summary:", JSON.stringify(val2.summary));

const payload2 = buildPayload(val2);
const { pda, epochDay } = pdaFor(val2.summary.updateStats.minTimestamp);
console.log("epochDay:", epochDay, "PDA:", pda.toBase58());

const gt0 = { threshold: 0, comparison: { greaterThan: {} } };
// TRUE: away(idx1) - home(idx0) > 0  → 2-1 > 0
await runCase("TRUE binary (away-home goals > 0)", payload2, {
  geometricTargets: [], distancePredicate: null,
  discretePredicates: [{ binary: { indexA: 1, indexB: 0, op: { subtract: {} }, predicate: gt0 } }],
}, pda);
// FALSE: home - away > 0
await runCase("FALSE binary (home-away goals > 0)", payload2, {
  geometricTargets: [], distancePredicate: null,
  discretePredicates: [{ binary: { indexA: 0, indexB: 1, op: { subtract: {} }, predicate: gt0 } }],
}, pda);
// CORRUPTED: flip a byte in stat proof 0
const corrupted = JSON.parse(JSON.stringify(payload2));
corrupted.ts = new BN(val2.summary.updateStats.minTimestamp);
corrupted.fixtureSummary.fixtureId = new BN(val2.summary.fixtureId);
corrupted.fixtureSummary.updateStats.minTimestamp = new BN(val2.summary.updateStats.minTimestamp);
corrupted.fixtureSummary.updateStats.maxTimestamp = new BN(val2.summary.updateStats.maxTimestamp);
corrupted.stats[0].statProof[0].hash[0] ^= 0xff;
await runCase("CORRUPTED stat proof (bit-flipped hash)", corrupted, {
  geometricTargets: [], distancePredicate: null,
  discretePredicates: [{ binary: { indexA: 1, indexB: 0, op: { subtract: {} }, predicate: gt0 } }],
}, pda);

// --- Case set B: 4 leaves, corners Add (largest realistic template) ---
const val4 = await fetchValidation("1,2,7,8");
fs.writeFileSync("proof_18241006_seq962_k1-2-7-8.json", JSON.stringify(val4, null, 2));
const payload4 = buildPayload(val4);
// corners total: P1(idx2) + P2(idx3) = 1+6=7 > 6 → TRUE; every leaf must be referenced: also single-check goals
await runCase("4-leaf: corners Add > 6 AND goals singles", payload4, {
  geometricTargets: [], distancePredicate: null,
  discretePredicates: [
    { binary: { indexA: 2, indexB: 3, op: { add: {} }, predicate: { threshold: 6, comparison: { greaterThan: {} } } } },
    { single: { index: 0, predicate: { threshold: 2, comparison: { lessThan: {} } } } },
    { single: { index: 1, predicate: { threshold: 1, comparison: { greaterThan: {} } } } },
  ],
}, pda);

console.log("\nDone.");
