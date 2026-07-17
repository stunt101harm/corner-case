// Demo: attempt to settle with a MID-MATCH proof and get rejected on-chain
// by check gate #2 (finality). Used in the video's adversarial beat.
//
//   node scripts/demo_early_settle.mjs <market-address>
//
// The market must be a Matched market on fixture 18241006 with stat keys
// [1,2] (e.g. seeded via seed_market.mjs --template away_wins --accept).
// The halftime proof (seq 425, period 3) is real and VALID — TxLINE will
// verify it happily. Our program refuses it anyway: every proven leaf must
// carry period 100 (game_finalised), or "no red cards so far" could settle
// YES at minute 60.

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, Connection, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const idl = require("../target/idl/corner_case.json");
const USDC_DEV = new PublicKey("Cx9Y63x8YN7x9UMFba4B1HdmmmH9QVZbvTZgz7k8kspy");
const TXORACLE_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

const marketAddr = process.argv[2];
if (!marketAddr) throw new Error("usage: node scripts/demo_early_settle.mjs <market-address>");

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8")))
);
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);

const market = new PublicKey(marketAddr);
const acc = await program.account.market.fetch(market);

const val = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../fixtures/proof_18241006_seq425_halftime_k1-2.json", import.meta.url)), "utf8")
);
const mapProof = (arr) => arr.map((n) => ({ hash: Array.from(n.hash), isRightSibling: n.isRightSibling }));
const payload = {
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
  stats: val.statsToProve.map((s, i) => ({ stat: { key: s.key, value: s.value, period: s.period }, statProof: mapProof(val.statProofs[i]) })),
};
console.log("Proof leaves:", JSON.stringify(val.statsToProve));
console.log("→ This proof is from HALFTIME (period 3). Attempting settlement…\n");

const epochDay = Math.floor(val.summary.updateStats.minTimestamp / 86400000);
const le = Buffer.alloc(2); le.writeUInt16LE(epochDay);
const [roots] = PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), le], TXORACLE_ID);

try {
  await program.methods
    .settleMarket(epochDay, payload)
    .accounts({
      caller: payer.publicKey, market, creator: acc.creator, taker: acc.taker, mint: USDC_DEV,
      creatorAta: getAssociatedTokenAddressSync(USDC_DEV, acc.creator),
      takerAta: getAssociatedTokenAddressSync(USDC_DEV, acc.taker),
      escrow: getAssociatedTokenAddressSync(USDC_DEV, market, true),
      txlineRoots: roots, txlineProgram: TXORACLE_ID,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
    .rpc();
  console.log("!!! settlement went through — THIS SHOULD NEVER PRINT");
} catch (e) {
  const msg = String(e.error?.errorMessage ?? e.message ?? e);
  console.log("REJECTED ON-CHAIN ✋");
  console.log(`  ${msg}`);
  console.log("\nCheck gate #2 (finality): every proven leaf must carry period 100.");
  console.log("The escrow is untouched; the market settles only against game_finalised.");
}
