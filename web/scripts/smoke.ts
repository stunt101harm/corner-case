/**
 * smoke.ts — end-to-end devnet smoke test through the SAME client code the UI
 * uses (lib/program.ts, lib/relay.ts, lib/merkle.ts). Run with the relay up:
 *
 *   cd web && npm run smoke
 *
 * Flow (all with fresh throwaway keypairs — nothing pre-funded):
 *   1. faucet both wallets via the relay (SOL + USDC-dev)
 *   2. creator opens "Away side wins" (1 USDC-dev) on demo fixture 18241006
 *   3. taker accepts
 *   4. taker settles: snapshot → finalised seq → /api/proof → settle_market
 *   5. verify the receipt pipeline: MarketSettled event parsed, payload
 *      decoded from the tx, Merkle legs 1+2 recomputed with sha256
 */

import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, type Transaction } from "@solana/web3.js";
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
import { findFinalisedSeq, getProof, getSnapshot, requestFaucet } from "../lib/relay";
import { verifyLegs } from "../lib/merkle";
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

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function check(cond: boolean, msg: string): void {
  if (!cond) fail(msg);
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
const connection = new Connection(RPC_URL, "confirmed");
const program = getProgram(connection);

const creator = Keypair.generate();
const taker = Keypair.generate();
console.log(`creator (throwaway): ${creator.publicKey.toBase58()}`);
console.log(`taker   (throwaway): ${taker.publicKey.toBase58()}`);

// 1. Faucet — the same endpoint the header button hits.
for (const [kp, label] of [[creator, "creator"], [taker, "taker"]] as const) {
  const res = await requestFaucet(kp.publicKey.toBase58());
  console.log(`faucet → ${label}: +${res.sol} SOL, +${res.usdc} USDC-dev (${res.signature})`);
}

// 2. Create: template "Away side wins", 1 USDC-dev, demo fixture.
const template = TEMPLATES.find((t) => t.id === "away-wins");
if (!template) fail("away-wins template missing");
const demo = KNOWN_FIXTURES[DEMO_FIXTURE_ID];
const { ix: createIx, market } = await buildCreateMarketIx(program, {
  creator: creator.publicKey,
  nonce: new BN(Date.now()),
  fixtureId: DEMO_FIXTURE_ID,
  epochDay: epochDayFromMs(demo.kickoffMs),
  kickoffTs: Math.floor(Date.now() / 1000) + 3600, // demo fixture: 1h accept window
  creatorSide: true, // YES on away-wins — TRUE for England 1-2 Argentina
  stake: new BN(1_000_000), // 1 USDC-dev
  strategy: templateStrategy(template),
  statKeys: template.statKeys,
});
const createSig = await sendIxs(connection, keypairSender(creator), [createIx]);
console.log(`create_market: ${createSig}`);
console.log(`market: ${market.toBase58()}`);

// 3. Accept from the second throwaway.
const acceptIx = await buildAcceptMarketIx(program, { taker: taker.publicKey, market });
const acceptSig = await sendIxs(connection, keypairSender(taker), [acceptIx]);
console.log(`accept_market: ${acceptSig}`);

// 4. Settle exactly like the "Settle now" button: snapshot scan → proof → tx.
const finalSeq = findFinalisedSeq(await getSnapshot(DEMO_FIXTURE_ID));
if (finalSeq === null) fail("no finalised seq in snapshot");
console.log(`finalised seq from snapshot scan: ${finalSeq}`);
const proof = await getProof(DEMO_FIXTURE_ID, finalSeq, template.statKeys);
const settleIxs = await buildSettleMarketIxs(program, {
  caller: taker.publicKey,
  market,
  creator: creator.publicKey,
  taker: taker.publicKey,
  epochDay: epochDayFromMs(proof.summary.updateStats.minTimestamp),
  payload: buildSettlePayload(proof),
});
const settleSig = await sendIxs(connection, keypairSender(taker), settleIxs);
console.log(`settle_market: ${settleSig}`);
console.log(`explorer: https://explorer.solana.com/tx/${settleSig}?cluster=devnet`);

// 5. Receipt pipeline — what /receipt/[txSig] does in the browser.
console.log("receipt pipeline:");
const receipt = await decodeSettleTx(connection, program, settleSig);
if (!receipt) fail("could not decode settle tx");
check(receipt.event.market === market.toBase58(), `MarketSettled event parsed (market ${receipt.event.market})`);
check(receipt.event.predicateTrue, "predicate TRUE (away side won 1-2)");
check(receipt.event.winner === creator.publicKey.toBase58(), "winner = creator (bet YES)");
check(receipt.event.payout === 2_000_000, `payout ${receipt.event.payout} = both stakes`);
check(receipt.txlineCpiPresent, "TxLINE validateStatV2 CPI present in tx");
check(receipt.payload.fixtureId === DEMO_FIXTURE_ID, "payload fixture binding");

const verification = await verifyLegs({
  stats: receipt.payload.stats,
  eventStatRoot: receipt.payload.eventStatRoot,
  subTreeProof: receipt.payload.fixtureProof,
  eventsSubTreeRoot: receipt.payload.eventsSubTreeRoot,
});
for (const leg of verification.legs) {
  check(leg.ok, `sha256 recompute: ${leg.label} (${leg.steps.length} steps)`);
}
check(verification.ok, "all Merkle legs recomputed ✓");

check((await fetchMarket(program, market)) === null, "market account closed after settlement");

console.log("\nSMOKE PASSED");
console.log(`  create: ${createSig}`);
console.log(`  accept: ${acceptSig}`);
console.log(`  settle: ${settleSig}`);
}

main().catch((err) => {
  console.error(`✗ smoke failed: ${String(err)}`);
  process.exit(1);
});
