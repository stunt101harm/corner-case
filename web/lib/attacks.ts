/**
 * attacks.ts — the "Try to cheat" adversarial demo. Three REAL settle_market
 * transactions that are engineered to fail, each defeated by a different check
 * gate. Every attack lands ON-CHAIN (skipPreflight) and fails there, so the
 * rejection is a public devnet transaction a judge can open in the explorer.
 *
 * Same tx-building path as the honest "Settle now" button (lib/program.ts) —
 * the ONLY thing wrong with each attack is the input, which is exactly the
 * point: the program, not our server, is what refuses.
 *
 * The page (web/app/gates) AND the node verifier (web/scripts/gates-verify.ts)
 * both drive fireAttack(), so what a judge clicks is what we tested.
 */

import { PublicKey, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import {
  buildSettleMarketIxs,
  buildSettlePayload,
  fetchMarket,
  type MarketAccount,
  type TxSender,
} from "./program";
import type { Program } from "@coral-xyz/anchor";
import type { CornerCase } from "../idl/corner_case";
import type { StatValidationJson } from "./types";
import { epochDayFromMs } from "./constants";

// ===========================================================================
// Target markets — seeded on devnet with scripts/seed_market.mjs, all Matched
// and (by design) NEVER settled by the keeper. Targets 1 and 2 live on the
// demo fixture 18241006, so they are on the keeper's settle-watch SKIP LIST;
// target 3 lives on a fixture that will never exist, so nothing could ever
// settle it. Re-seed and update these three constants if a market is spent.
// (Recorded 2026-07-17.)
// ===========================================================================

/**
 * ATTACK 1 target — gate #2 (ProofNotFinal). away_wins, keys [1,2], real
 * fixture 18241006, Matched. The ONE market here that CAN be honestly settled
 * (a valid [1,2] game_finalised proof exists) — the counterpoint button.
 */
export const TARGET_1 = new PublicKey("HzcHywyow31YJNFGvzTApHEphTaNHiFqidXCHdFHxEkD");

/**
 * ATTACK 2 target — gate #5 (StatKeysMismatch). corners_over, keys [7,8],
 * real fixture 18241006, Matched. Honestly settleable ONLY with a corners
 * [7,8] proof; a goals proof (below) is a valid-but-wrong-stats forgery.
 */
export const TARGET_2 = new PublicKey("J2YUfmKTbUCsbrkUvdrTp8kaumdQyuJ6E3jcSeCoVEXr");

/**
 * ATTACK 3 target — gate #4 (FixtureMismatch). fixture_id 99999901 (never
 * exists), keys [1,2], epoch 20649, Matched. No valid proof for this fixture
 * can ever be produced, so this escrow can only ever be recovered via the
 * permissionless void hatch — funds can never strand, but nobody can settle.
 */
export const TARGET_3 = new PublicKey("95oW57EuiPPXMQAUQQXajPoi187fFt73XzDgL2HJxasg");

// ===========================================================================
// Committed real proofs (fixtures/) embedded verbatim so the demo needs no
// relay round-trip and is byte-reproducible. These are the SAME proofs the
// 26-test suite and scripts/demo_early_settle.mjs replay.
// ===========================================================================

/**
 * fixtures/proof_18241006_seq425_halftime_k1-2.json — a VALID TxLINE proof of
 * the 0-0 halftime score (period 3 leaves). TxLINE would verify it happily;
 * gate #2 refuses it because settlement requires period 100 on every leaf.
 */
export const HALFTIME_PROOF_K1_2: StatValidationJson = {
  ts: 1784145044821,
  statsToProve: [
    { key: 1, value: 0, period: 3 },
    { key: 2, value: 0, period: 3 },
  ],
  eventStatRoot: [169, 120, 172, 8, 248, 74, 238, 137, 225, 139, 33, 88, 8, 243, 178, 117, 188, 135, 213, 26, 24, 179, 72, 169, 53, 43, 17, 42, 170, 158, 101, 40],
  summary: {
    fixtureId: 18241006,
    updateStats: { updateCount: 1, minTimestamp: 1784145044821, maxTimestamp: 1784145044821 },
    eventStatsSubTreeRoot: [18, 185, 127, 31, 29, 227, 186, 212, 89, 40, 251, 5, 136, 75, 180, 253, 111, 28, 62, 178, 101, 211, 184, 128, 201, 96, 178, 104, 3, 186, 39, 96],
  },
  statProofs: [
    [
      { hash: [1, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255], isRightSibling: false },
      { hash: [51, 51, 51, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], isRightSibling: false },
    ],
    [
      { hash: [1, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255], isRightSibling: false },
      { hash: [51, 51, 51, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], isRightSibling: false },
    ],
  ],
  subTreeProof: [
    { hash: [239, 141, 97, 49, 112, 132, 178, 29, 56, 47, 179, 42, 129, 143, 243, 52, 37, 254, 126, 13, 166, 157, 103, 52, 54, 32, 225, 156, 214, 179, 135, 224], isRightSibling: false },
  ],
  mainTreeProof: [
    { hash: [104, 106, 176, 65, 33, 182, 152, 77, 94, 91, 2, 213, 155, 14, 75, 106, 88, 195, 88, 7, 15, 39, 36, 222, 45, 135, 2, 160, 146, 185, 176, 171], isRightSibling: false },
  ],
};

/**
 * fixtures/proof_18241006_seq962_k1-2.json — the real GOALS final proof
 * (England 1, Argentina 2; period 100). Used two ways: as attack 2's
 * valid-but-wrong-stats payload against a corners market, and as attack 3's
 * valid-but-wrong-fixture payload against the 99999901 market.
 */
export const GOALS_FINAL_PROOF_K1_2: StatValidationJson = {
  ts: 1784150064772,
  statsToProve: [
    { key: 1, value: 1, period: 100 },
    { key: 2, value: 2, period: 100 },
  ],
  eventStatRoot: [72, 60, 173, 77, 230, 239, 187, 167, 49, 147, 65, 209, 224, 29, 222, 208, 237, 163, 225, 99, 166, 251, 70, 47, 7, 187, 223, 60, 247, 124, 182, 217],
  summary: {
    fixtureId: 18241006,
    updateStats: { updateCount: 1, minTimestamp: 1784150064772, maxTimestamp: 1784150064772 },
    eventStatsSubTreeRoot: [14, 144, 207, 35, 222, 198, 120, 201, 28, 173, 84, 2, 7, 191, 96, 22, 78, 15, 55, 20, 156, 71, 143, 141, 231, 179, 120, 56, 170, 35, 202, 113],
  },
  statProofs: [
    [
      { hash: [154, 54, 196, 190, 117, 77, 92, 202, 57, 50, 201, 4, 2, 53, 38, 202, 209, 56, 240, 191, 36, 33, 41, 240, 227, 115, 8, 78, 30, 38, 166, 141], isRightSibling: true },
      { hash: [194, 82, 27, 52, 52, 184, 223, 205, 138, 205, 159, 138, 42, 40, 147, 106, 1, 99, 88, 196, 17, 103, 19, 182, 216, 42, 134, 78, 221, 125, 143, 97], isRightSibling: true },
      { hash: [123, 37, 114, 55, 115, 108, 48, 179, 85, 28, 26, 23, 16, 135, 182, 157, 182, 154, 187, 114, 18, 18, 36, 100, 93, 37, 65, 170, 230, 193, 124, 142], isRightSibling: true },
      { hash: [168, 73, 76, 40, 232, 229, 47, 28, 5, 158, 11, 88, 78, 98, 157, 0, 140, 38, 165, 141, 46, 157, 60, 52, 92, 11, 203, 17, 32, 154, 209, 90], isRightSibling: true },
      { hash: [45, 61, 198, 225, 177, 234, 133, 186, 203, 14, 87, 9, 142, 158, 31, 155, 221, 44, 191, 174, 229, 76, 132, 232, 86, 150, 95, 192, 244, 116, 31, 147], isRightSibling: true },
    ],
    [
      { hash: [184, 10, 179, 141, 202, 101, 144, 249, 125, 103, 105, 52, 12, 8, 34, 9, 65, 82, 180, 13, 5, 210, 191, 211, 31, 70, 85, 168, 162, 76, 115, 166], isRightSibling: false },
      { hash: [194, 82, 27, 52, 52, 184, 223, 205, 138, 205, 159, 138, 42, 40, 147, 106, 1, 99, 88, 196, 17, 103, 19, 182, 216, 42, 134, 78, 221, 125, 143, 97], isRightSibling: true },
      { hash: [123, 37, 114, 55, 115, 108, 48, 179, 85, 28, 26, 23, 16, 135, 182, 157, 182, 154, 187, 114, 18, 18, 36, 100, 93, 37, 65, 170, 230, 193, 124, 142], isRightSibling: true },
      { hash: [168, 73, 76, 40, 232, 229, 47, 28, 5, 158, 11, 88, 78, 98, 157, 0, 140, 38, 165, 141, 46, 157, 60, 52, 92, 11, 203, 17, 32, 154, 209, 90], isRightSibling: true },
      { hash: [45, 61, 198, 225, 177, 234, 133, 186, 203, 14, 87, 9, 142, 158, 31, 155, 221, 44, 191, 174, 229, 76, 132, 232, 86, 150, 95, 192, 244, 116, 31, 147], isRightSibling: true },
    ],
  ],
  subTreeProof: [
    { hash: [137, 27, 77, 94, 82, 24, 12, 216, 142, 179, 86, 112, 166, 89, 137, 87, 140, 134, 156, 177, 253, 149, 199, 170, 212, 53, 119, 68, 231, 96, 250, 59], isRightSibling: false },
  ],
  mainTreeProof: [
    { hash: [147, 110, 37, 85, 255, 234, 201, 196, 255, 51, 94, 119, 87, 36, 185, 147, 173, 173, 38, 11, 13, 24, 63, 120, 4, 64, 65, 8, 101, 71, 8, 152], isRightSibling: false },
  ],
};

// ===========================================================================
// Attack + gate definitions
// ===========================================================================

export type GateErrorName = "ProofNotFinal" | "StatKeysMismatch" | "FixtureMismatch";

export interface AttackSpec {
  id: "halftime" | "wrong-stats" | "wrong-fixture";
  /** Headline on the card. */
  title: string;
  /** One line: what the attacker is doing. */
  what: string;
  /** One line: why it would steal money if the program let it through. */
  why: string;
  /** The proof payload the attacker submits (a real, valid TxLINE proof). */
  proof: StatValidationJson;
  /** The market the attack is fired at. */
  target: PublicKey;
  /** The gate that catches it, and its program error name. */
  gate: number;
  errorName: GateErrorName;
  /** Our human explanation of the rejection. */
  explanation: string;
  /**
   * Can this market ever be honestly settled? Cards 1 and 2 can (with the
   * right proof); card 3 can never be (no valid proof for its fixture).
   */
  honestlySettleable: boolean;
  /**
   * For the counterpoint "Now settle it honestly" button: the stat keys of
   * the RIGHT proof (fetched from the relay at the finalised seq).
   */
  honestKeys?: number[];
}

export const ATTACKS: AttackSpec[] = [
  {
    id: "halftime",
    title: "Settle at halftime",
    what: "Submit a real, valid TxLINE proof — of the 0–0 score at the halftime whistle (period 3) — to settle before the match is over.",
    why: "A prop like “no red cards in the second half” reads YES at minute 60, when no H2 red has happened yet. Settle early and you bank a bet the match could still lose.",
    proof: HALFTIME_PROOF_K1_2,
    target: TARGET_1,
    gate: 2,
    errorName: "ProofNotFinal",
    explanation:
      "Gate #2 (finality) requires period == 100 (game_finalised) on EVERY proven leaf. TxLINE verified this proof — it’s genuinely the halftime score — but the program only settles against the final whistle.",
    honestlySettleable: true,
    honestKeys: [1, 2],
  },
  {
    id: "wrong-stats",
    title: "Prove the wrong stats",
    what: "This market is “total corners > 9.5” (keys [7,8]). Submit a real, valid, FINAL proof — of the goals (keys [1,2]) — instead.",
    why: "TxLINE strategies address leaves by index, not by stat key. A valid proof of the wrong stat slots into index 0/1 and can flip a losing corners bet into a winning one.",
    proof: GOALS_FINAL_PROOF_K1_2,
    target: TARGET_2,
    gate: 5,
    errorName: "StatKeysMismatch",
    explanation:
      "Gate #5 (stat-key binding) pins the market’s ordered stat keys at creation. The proof’s leaf keys must match exactly — [1,2] is not [7,8], so the program refuses to interpret goals as corners.",
    honestlySettleable: true,
    honestKeys: [7, 8],
  },
  {
    id: "wrong-fixture",
    title: "Use another match’s proof",
    what: "This market is bound to fixture 99999901. Submit the real, valid, final England v Argentina (18241006) proof to settle it anyway.",
    why: "Some match somewhere always satisfies your predicate. If proofs weren’t bound to THIS fixture, a valid proof from a different game could settle any market you like.",
    proof: GOALS_FINAL_PROOF_K1_2,
    target: TARGET_3,
    gate: 4,
    errorName: "FixtureMismatch",
    explanation:
      "Gate #4 (fixture binding) compares the fixture_id inside the proven summary node against the market’s pinned fixture_id. 18241006 ≠ 99999901, so a real proof from the wrong match is rejected on-chain.",
    honestlySettleable: false,
  },
];

export function getAttack(id: AttackSpec["id"]): AttackSpec {
  const a = ATTACKS.find((x) => x.id === id);
  if (!a) throw new Error(`unknown attack ${id}`);
  return a;
}

// ===========================================================================
// The five gates, for the reference table at the bottom of the page.
// ===========================================================================

export interface GateRow {
  n: number;
  name: string;
  prevents: string;
}

export const GATES: GateRow[] = [
  { n: 1, name: "Kickoff deadline", prevents: "taking a side after the match started — betting on known outcomes" },
  { n: 2, name: "Finality (period == 100)", prevents: "settling a mid-match proof as final (this page, attack 1)" },
  { n: 3, name: "Epoch window", prevents: "shopping arbitrary historical daily roots" },
  { n: 4, name: "Fixture binding", prevents: "settling with a valid proof from a different match (attack 3)" },
  { n: 5, name: "Stat-key binding", prevents: "settling with a valid proof of the wrong stats (attack 2)" },
];

/** Anchor of the README's gate table (for the reference links). */
export const README_GATES_URL =
  "https://github.com/stunt101harm/corner-case/blob/main/README.md#the-five-check-gates";

// ===========================================================================
// Firing an attack: build the real settle tx, land it on-chain with
// skipPreflight so it FAILS on-chain (not just in simulation), then poll the
// transaction back for the program error + logs.
// ===========================================================================

/** Program error name → the gate number that owns it. */
const ERROR_TO_GATE: Record<GateErrorName, number> = {
  ProofNotFinal: 2,
  FixtureMismatch: 4,
  StatKeysMismatch: 5,
};

export interface AttackResult {
  /** The failed transaction's signature (it landed on-chain — inspectable). */
  signature: string;
  /** The program error name pulled from the failed tx's logs, if found. */
  errorName: string | null;
  /** Which gate caught it (from the error name). */
  gate: number | null;
  /** The single most relevant raw log line (the AnchorError line). */
  rawLogLine: string | null;
  /** All program logs, for the "show raw log" expander. */
  logs: string[];
}

/**
 * Send a transaction with skipPreflight so a doomed instruction still LANDS
 * on-chain (a preflight simulation would abort it before it ever hit a
 * validator). Returns the signature without waiting for confirmation.
 */
async function sendLandingTx(
  connection: Connection,
  sender: TxSender,
  ixs: TransactionInstruction[],
): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: sender.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(...ixs);
  // skipPreflight is the whole point: we WANT the failing tx recorded.
  return sender.sendTransaction(tx, connection, { skipPreflight: true });
}

/** Extract the Anchor error name from a failed tx's program logs. */
function errorNameFromLogs(logs: string[]): string | null {
  for (const line of logs) {
    const m = /Error Code: ([A-Za-z]+)/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/** The most explanatory single log line — the AnchorError, else the first. */
function pickRawLogLine(logs: string[]): string | null {
  return logs.find((l) => /AnchorError|Error Code:/.test(l)) ?? logs[0] ?? null;
}

/**
 * Poll getTransaction until the (failed) tx is indexed, then read its error
 * and logs. A failed tx confirms just like a successful one — meta.err is
 * populated instead of throwing.
 */
export async function pollFailedTx(
  connection: Connection,
  signature: string,
  { attempts = 30, delayMs = 1500 }: { attempts?: number; delayMs?: number } = {},
): Promise<AttackResult> {
  for (let i = 0; i < attempts; i++) {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx?.meta) {
      const logs = tx.meta.logMessages ?? [];
      const errorName = errorNameFromLogs(logs);
      return {
        signature,
        errorName,
        gate: errorName && errorName in ERROR_TO_GATE ? ERROR_TO_GATE[errorName as GateErrorName] : null,
        rawLogLine: pickRawLogLine(logs),
        logs,
      };
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  // Indexed slowly? Return the signature so the explorer link still works.
  return { signature, errorName: null, gate: null, rawLogLine: null, logs: [] };
}

/**
 * Fire one attack: fetch the target market (for its creator/taker), build the
 * real settle_market tx with the attack's proof, land it on-chain, and poll
 * back the on-chain rejection. Throws only on wallet/RPC-side failures (e.g.
 * insufficient funds) — a program rejection is a SUCCESSFUL demo and returns
 * an AttackResult with the error name.
 */
export async function fireAttack(
  connection: Connection,
  sender: TxSender,
  program: Program<CornerCase>,
  attack: AttackSpec,
): Promise<AttackResult> {
  const market = await fetchMarket(program, attack.target);
  if (!market) {
    throw new Error("This target market no longer exists on-chain.");
  }
  const payload = buildSettlePayload(attack.proof);
  const epochDay = epochDayFromMs(attack.proof.summary.updateStats.minTimestamp);
  const ixs = await buildSettleMarketIxs(program, {
    caller: sender.publicKey,
    market: attack.target,
    creator: market.creator,
    taker: market.taker,
    epochDay,
    payload,
  });
  const signature = await sendLandingTx(connection, sender, ixs);
  return pollFailedTx(connection, signature);
}

export type { MarketAccount };
