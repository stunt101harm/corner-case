// Devnet end-to-end smoke test of the DEPLOYED program: create → accept →
// settle a market on the real England v Argentina fixture, against TxLINE's
// live daily_scores_roots account, using the committed real proof.
//
// Run from repo root: node scripts/devnet_e2e.mjs
// Needs: ~/.config/solana/id.json funded (SOL + mint authority of USDC-dev).

import * as anchor from "@coral-xyz/anchor";
import {
  Keypair, PublicKey, Connection, SystemProgram, LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAccount,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
const require = createRequire(import.meta.url);

const idl = require("../target/idl/corner_case.json");
const USDC_DEV = new PublicKey("Cx9Y63x8YN7x9UMFba4B1HdmmmH9QVZbvTZgz7k8kspy");
const TXORACLE_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const FIXTURE = new BN(18241006);
const EPOCH_DAY = 20649;

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8")))
);
const wallet = new anchor.Wallet(payer);
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);

// Demo taker: persisted so re-runs reuse it (gitignored via *-keypair.json).
const takerPath = fileURLToPath(new URL("../.demo-taker-keypair.json", import.meta.url));
let taker;
if (fs.existsSync(takerPath)) {
  taker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(takerPath, "utf8"))));
} else {
  taker = Keypair.generate();
  fs.writeFileSync(takerPath, JSON.stringify([...taker.secretKey]));
}
console.log("payer:", payer.publicKey.toBase58());
console.log("taker:", taker.publicKey.toBase58());

// Fund taker with a little SOL for fees (idempotent-ish).
const takerBal = await connection.getBalance(taker.publicKey);
if (takerBal < 0.05 * LAMPORTS_PER_SOL) {
  const tx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: taker.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })
  );
  await provider.sendAndConfirm(tx);
  console.log("funded taker with 0.05 SOL");
}

// ATAs + USDC-dev balances (payer is the mint authority).
const creatorAta = (await getOrCreateAssociatedTokenAccount(connection, payer, USDC_DEV, payer.publicKey)).address;
const takerAta = (await getOrCreateAssociatedTokenAccount(connection, payer, USDC_DEV, taker.publicKey)).address;
for (const [ata, label] of [[creatorAta, "creator"], [takerAta, "taker"]]) {
  const acc = await getAccount(connection, ata);
  if (acc.amount < 100_000_000n) {
    await mintTo(connection, payer, USDC_DEV, ata, payer, 1_000_000_000n);
    console.log(`minted 1000 USDC-dev to ${label}`);
  }
}

// Strategy: away − home goals > 0 (TRUE: England 1-2 Argentina). Hand-rolled
// borsh (see tests for layout docs).
function binaryStrategy(indexA, indexB, op, threshold, cmp) {
  const b = Buffer.alloc(18); let o = 0;
  b.writeUInt32LE(0, o); o += 4;
  b.writeUInt8(0, o); o += 1;
  b.writeUInt32LE(1, o); o += 4;
  b.writeUInt8(1, o); o += 1;
  b.writeUInt8(indexA, o); o += 1;
  b.writeUInt8(indexB, o); o += 1;
  b.writeUInt8(op, o); o += 1;
  b.writeInt32LE(threshold, o); o += 4;
  b.writeUInt8(cmp, o);
  return b;
}
const strategy = binaryStrategy(1, 0, 1 /*sub*/, 0, 0 /*gt*/);

const nonce = new BN(Date.now()); // unique per run
const [market] = PublicKey.findProgramAddressSync(
  [Buffer.from("market"), payer.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
  program.programId
);
const escrow = getAssociatedTokenAddressSync(USDC_DEV, market, true);
const kickoff = new BN(Math.floor(Date.now() / 1000) + 3600);
const STAKE = new BN(25_000_000); // 25 USDC-dev

console.log("market:", market.toBase58());

let sig = await program.methods
  .createMarket(nonce, FIXTURE, EPOCH_DAY, kickoff, true, STAKE, strategy, [1, 2])
  .accounts({
    creator: payer.publicKey, market, mint: USDC_DEV, creatorAta, escrow,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
console.log("create_market:", sig);

sig = await program.methods
  .acceptMarket()
  .accounts({
    taker: taker.publicKey, market, mint: USDC_DEV, takerAta, escrow,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([taker])
  .rpc();
console.log("accept_market:", sig);

// Build the settle payload from the committed real proof.
const val = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../fixtures/proof_18241006_seq962_k1-2.json", import.meta.url)), "utf8"));
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

const le = Buffer.alloc(2); le.writeUInt16LE(EPOCH_DAY);
const [roots] = PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), le], TXORACLE_ID);

const before = (await getAccount(connection, creatorAta)).amount;
sig = await program.methods
  .settleMarket(EPOCH_DAY, payload)
  .accounts({
    caller: taker.publicKey, // settlement is permissionless — taker triggers it
    market, creator: payer.publicKey, taker: taker.publicKey, mint: USDC_DEV,
    creatorAta, takerAta, escrow, txlineRoots: roots, txlineProgram: TXORACLE_ID,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  })
  .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
  .signers([taker])
  .rpc();
console.log("settle_market:", sig);

const after = (await getAccount(connection, creatorAta)).amount;
console.log(`creator USDC-dev: ${before} → ${after} (delta ${after - before}; expected +${2n * 25_000_000n})`);
const marketInfo = await connection.getAccountInfo(market);
console.log("market account closed:", marketInfo === null);
console.log("\nEXPLORER:", `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
