/**
 * gates-verify.ts — end-to-end proof that the /gates page works, driving the
 * SAME lib functions the page clicks (lib/attacks.ts fireAttack, lib/program).
 *
 *   cd web && npx tsx scripts/gates-verify.ts
 *
 * 1. A throwaway wallet (funded from the local payer) fires all three attacks
 *    at the three seeded target markets. Each must LAND on-chain and FAIL with
 *    the expected gate error (ProofNotFinal / StatKeysMismatch / FixtureMismatch).
 * 2. The honest-settle CODE PATH is verified on a DISPOSABLE 4th market — we
 *    deliberately do NOT settle targets 1/2 (they must stay Matched for the
 *    demo/video). Create → accept → settle honestly → decode the receipt.
 *
 * Funding uses the local id.json payer (also the USDC-dev mint authority) so
 * the run needs no faucet and can't be rate-limited.
 */

import { BN } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  type SendOptions,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildAcceptMarketIx,
  buildCreateMarketIx,
  buildSettleMarketIxs,
  buildSettlePayload,
  decodeSettleTx,
  fetchMarket,
  getProgram,
  sendIxs,
  type TxSender,
} from "../lib/program";
import { ATTACKS, fireAttack } from "../lib/attacks";
import { findFinalisedSeq, getProof, getSnapshot } from "../lib/relay";
import { TEMPLATES, templateStrategy } from "../lib/strategy";
import { DEMO_FIXTURE_ID, KNOWN_FIXTURES, RPC_URL, USDC_DEV_MINT, epochDayFromMs } from "../lib/constants";

function keypairSender(kp: Keypair): TxSender {
  return {
    publicKey: kp.publicKey,
    async sendTransaction(tx: Transaction, connection: Connection, options?: SendOptions): Promise<string> {
      tx.sign(kp);
      return connection.sendRawTransaction(tx.serialize(), options);
    },
  };
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}
function check(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  const connection = new Connection(RPC_URL, "confirmed");
  const program = getProgram(connection);

  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config", "solana", "id.json"), "utf8"))),
  );

  const fund = async (kp: Keypair, withUsdc: boolean): Promise<void> => {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
    );
    const bh = await connection.getLatestBlockhash("confirmed");
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = bh.blockhash;
    tx.sign(payer);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    if (withUsdc) {
      const ata = (await getOrCreateAssociatedTokenAccount(connection, payer, USDC_DEV_MINT, kp.publicKey)).address;
      await mintTo(connection, payer, USDC_DEV_MINT, ata, payer, 100_000_000n);
    }
  };

  // -------------------------------------------------------------------------
  // 1. Attacks — one throwaway wallet, only needs SOL for fees.
  // -------------------------------------------------------------------------
  const attacker = Keypair.generate();
  console.log(`attacker (throwaway): ${attacker.publicKey.toBase58()}`);
  await fund(attacker, false);

  const attackSigs: Record<string, string> = {};
  for (const attack of ATTACKS) {
    console.log(`\nAttack "${attack.title}" → target ${attack.target.toBase58()}`);
    const res = await fireAttack(connection, keypairSender(attacker), program, attack);
    attackSigs[attack.id] = res.signature;
    console.log(`  landed tx: ${res.signature}`);
    console.log(`  on-chain error: ${res.errorName ?? "(none parsed)"} · gate #${res.gate ?? "?"}`);
    check(res.errorName === attack.errorName, `rejected on-chain with ${attack.errorName} (gate #${attack.gate})`);
    check((await fetchMarket(program, attack.target)) !== null, "target market still Matched (attack did NOT settle it)");
  }

  // -------------------------------------------------------------------------
  // 2. Honest-settle code path — on a DISPOSABLE market, NOT the targets.
  // -------------------------------------------------------------------------
  console.log(`\nHonest-settle verification on a disposable market (targets left untouched):`);
  const creator = Keypair.generate();
  const taker = Keypair.generate();
  await fund(creator, true);
  await fund(taker, true);

  const template = TEMPLATES.find((t) => t.id === "away-wins");
  if (!template) fail("away-wins template missing");
  const demo = KNOWN_FIXTURES[DEMO_FIXTURE_ID];
  const { ix: createIx, market: disposable } = await buildCreateMarketIx(program, {
    creator: creator.publicKey,
    nonce: new BN(Date.now()),
    fixtureId: DEMO_FIXTURE_ID,
    epochDay: epochDayFromMs(demo.kickoffMs),
    kickoffTs: Math.floor(Date.now() / 1000) + 3600,
    creatorSide: true,
    stake: new BN(1_000_000),
    strategy: templateStrategy(template),
    statKeys: template.statKeys,
  });
  await sendIxs(connection, keypairSender(creator), [createIx]);
  console.log(`  disposable market: ${disposable.toBase58()}`);
  const acceptIx = await buildAcceptMarketIx(program, { taker: taker.publicKey, market: disposable });
  await sendIxs(connection, keypairSender(taker), [acceptIx]);

  const finalSeq = findFinalisedSeq(await getSnapshot(DEMO_FIXTURE_ID));
  if (finalSeq === null) fail("no finalised seq in snapshot");
  const proof = await getProof(DEMO_FIXTURE_ID, finalSeq, template.statKeys);
  const settleIxs = await buildSettleMarketIxs(program, {
    caller: taker.publicKey,
    market: disposable,
    creator: creator.publicKey,
    taker: taker.publicKey,
    epochDay: epochDayFromMs(proof.summary.updateStats.minTimestamp),
    payload: buildSettlePayload(proof),
  });
  const settleSig = await sendIxs(connection, keypairSender(taker), settleIxs);
  console.log(`  honest settle tx: ${settleSig}`);
  const receipt = await decodeSettleTx(connection, program, settleSig);
  if (!receipt) fail("could not decode honest settle tx");
  check(receipt.event.market === disposable.toBase58(), "MarketSettled event parsed");
  check(receipt.txlineCpiPresent, "TxLINE validateStatV2 CPI ran in the honest settle");
  check((await fetchMarket(program, disposable)) === null, "disposable market closed after honest settle");

  console.log("\nGATES VERIFY PASSED");
  console.log(`  attack 1 (ProofNotFinal):    ${attackSigs["halftime"]}`);
  console.log(`  attack 2 (StatKeysMismatch): ${attackSigs["wrong-stats"]}`);
  console.log(`  attack 3 (FixtureMismatch):  ${attackSigs["wrong-fixture"]}`);
  console.log(`  disposable honest settle:    ${settleSig}`);
}

main().catch((err) => {
  console.error(`✗ gates-verify failed: ${String(err)}`);
  process.exit(1);
});
