/**
 * seed-demo.ts — pre-seed ONE open market on the demo fixture so a solo judge
 * has something to accept immediately (no second wallet needed). Run with the
 * relay up, re-run whenever the seeded market gets settled away:
 *
 *   cd web && npx tsx scripts/seed-demo.ts
 *
 * Prop: "Total corners over 9.5", creator on YES. The semi finished with
 * 1 + 6 = 7 corners, so the judge who accepts (NO) WINS on settlement — the
 * best possible demo beat. Accepts stay open ~30 days (the demo fixture's
 * kickoff gate is synthetic; settlement is gated by the proof, not the clock).
 */

import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, type Transaction } from "@solana/web3.js";
import { buildCreateMarketIx, getProgram, sendIxs, type TxSender } from "../lib/program";
import { requestFaucet } from "../lib/relay";
import { TEMPLATES, templateStrategy } from "../lib/strategy";
import { DEMO_FIXTURE_ID, KNOWN_FIXTURES, RPC_URL, epochDayFromMs } from "../lib/constants";

function keypairSender(kp: Keypair): TxSender {
  return {
    publicKey: kp.publicKey,
    async sendTransaction(tx: Transaction, connection: Connection): Promise<string> {
      tx.sign(kp);
      return connection.sendRawTransaction(tx.serialize());
    },
  };
}

async function main(): Promise<void> {
  const connection = new Connection(RPC_URL, "confirmed");
  const program = getProgram(connection);
  const creator = Keypair.generate();
  console.log(`seed creator (throwaway): ${creator.publicKey.toBase58()}`);

  const faucet = await requestFaucet(creator.publicKey.toBase58());
  console.log(`faucet: +${faucet.sol} SOL, +${faucet.usdc} USDC-dev`);

  const template = TEMPLATES.find((t) => t.id === "corners-over-9-5");
  if (!template) throw new Error("template missing");
  const { ix, market } = await buildCreateMarketIx(program, {
    creator: creator.publicKey,
    nonce: new BN(Date.now()),
    fixtureId: DEMO_FIXTURE_ID,
    epochDay: epochDayFromMs(KNOWN_FIXTURES[DEMO_FIXTURE_ID].kickoffMs),
    kickoffTs: Math.floor(Date.now() / 1000) + 30 * 86_400,
    creatorSide: true, // YES on corners > 9 — FALSE for the semi: the accepting judge wins
    stake: new BN(5_000_000), // 5 USDC-dev
    strategy: templateStrategy(template),
    statKeys: template.statKeys,
  });
  const sig = await sendIxs(connection, keypairSender(creator), [ix]);
  console.log(`create_market: ${sig}`);
  console.log(`seeded open market: ${market.toBase58()}`);
}

main().catch((err) => {
  console.error(`seed failed: ${String(err)}`);
  process.exit(1);
});
