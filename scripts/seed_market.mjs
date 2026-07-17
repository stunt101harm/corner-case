// Seed a market on devnet (and optionally accept it with the demo taker).
// The pre-seeding tool for judge-facing markets AND the settle-watch test rig.
//
//   node scripts/seed_market.mjs --fixture 18241006 --epoch 20649 \
//     --template away_wins --side yes --stake 25 --accept
//
// Templates (keys are P1/P2-ordered; strategy indices refer to key positions):
//   corners_over   corners P1+P2 > 9        keys [7,8]
//   home_wins      goals P1-P2 > 0          keys [1,2]
//   away_wins      goals P2-P1 > 0          keys [1,2]
//   h1_goals       H1 goals P1+P2 > 0       keys [1001,1002]
//   no_h2_reds     H2 reds P1+P2 < 1        keys [3005,3006]

import * as anchor from "@coral-xyz/anchor";
import {
  Keypair, PublicKey, Connection, SystemProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAccount,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const idl = require("../target/idl/corner_case.json");
const USDC_DEV = new PublicKey("Cx9Y63x8YN7x9UMFba4B1HdmmmH9QVZbvTZgz7k8kspy");

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const OP = { add: 0, sub: 1 };
const CMP = { gt: 0, lt: 1, eq: 2 };
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

const TEMPLATES = {
  corners_over: { keys: [7, 8], strat: binaryStrategy(0, 1, OP.add, 9, CMP.gt), desc: "corners P1+P2 > 9" },
  home_wins: { keys: [1, 2], strat: binaryStrategy(0, 1, OP.sub, 0, CMP.gt), desc: "goals P1-P2 > 0" },
  away_wins: { keys: [1, 2], strat: binaryStrategy(1, 0, OP.sub, 0, CMP.gt), desc: "goals P2-P1 > 0" },
  h1_goals: { keys: [1001, 1002], strat: binaryStrategy(0, 1, OP.add, 0, CMP.gt), desc: "H1 goals P1+P2 > 0" },
  no_h2_reds: { keys: [3005, 3006], strat: binaryStrategy(0, 1, OP.add, 1, CMP.lt), desc: "H2 reds P1+P2 < 1" },
};

const fixture = new BN(arg("fixture"));
const epochDay = Number(arg("epoch"));
const template = TEMPLATES[arg("template", "away_wins")];
if (!template) throw new Error("unknown template");
const side = arg("side", "yes") === "yes";
const stake = new BN(Math.round(Number(arg("stake", "25")) * 1_000_000));
const kickoffArg = arg("kickoff", "auto");

const connection = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(process.env.HOME + "/.config/solana/id.json", "utf8")))
);
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
anchor.setProvider(provider);
const program = new anchor.Program(idl, provider);

const kickoff = new BN(
  kickoffArg === "auto" ? Math.floor(Date.now() / 1000) + 3600 : Number(kickoffArg)
);

const creatorAta = (await getOrCreateAssociatedTokenAccount(connection, payer, USDC_DEV, payer.publicKey)).address;
if ((await getAccount(connection, creatorAta)).amount < 100_000_000n) {
  await mintTo(connection, payer, USDC_DEV, creatorAta, payer, 1_000_000_000n);
}

const nonce = new BN(Date.now());
const [market] = PublicKey.findProgramAddressSync(
  [Buffer.from("market"), payer.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
  program.programId
);
const escrow = getAssociatedTokenAddressSync(USDC_DEV, market, true);

let sig = await program.methods
  .createMarket(nonce, fixture, epochDay, kickoff, side, stake, template.strat, template.keys)
  .accounts({
    creator: payer.publicKey, market, mint: USDC_DEV, creatorAta, escrow,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
console.log(`created ${market.toBase58()}`);
console.log(`  ${template.desc} | side=${side ? "YES" : "NO"} | stake ${arg("stake", "25")} USDC-dev | ${sig}`);

if (has("accept")) {
  const takerPath = fileURLToPath(new URL("../.demo-taker-keypair.json", import.meta.url));
  const taker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(takerPath, "utf8"))));
  if ((await connection.getBalance(taker.publicKey)) < 0.02 * LAMPORTS_PER_SOL) {
    const tx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: taker.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL })
    );
    await provider.sendAndConfirm(tx);
  }
  const takerAta = (await getOrCreateAssociatedTokenAccount(connection, payer, USDC_DEV, taker.publicKey)).address;
  if ((await getAccount(connection, takerAta)).amount < 100_000_000n) {
    await mintTo(connection, payer, USDC_DEV, takerAta, payer, 1_000_000_000n);
  }
  sig = await program.methods
    .acceptMarket()
    .accounts({ taker: taker.publicKey, market, mint: USDC_DEV, takerAta, escrow, tokenProgram: TOKEN_PROGRAM_ID })
    .signers([taker])
    .rpc();
  console.log(`accepted by ${taker.publicKey.toBase58()} | ${sig}`);
}
