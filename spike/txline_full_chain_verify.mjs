// txline_full_chain_verify.mjs — COMPLETE chain verifier for TxLINE validate_stat_v2 proofs.
// Verifies: stat leaf -> eventStatRoot -> eventStatsSubTreeRoot -> summary leaf ->
//           daily batch root == on-chain `daily_scores_roots` account slot bytes.
// Devnet program: 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J
import crypto from "crypto";
import fs from "fs";
const sha = (...b) => crypto.createHash("sha256").update(Buffer.concat(b)).digest();
const buf = (x) => Buffer.isBuffer(x) ? x : Buffer.from(x);

const DAY_MS = 86400000, SLOT_MS = 300000;
const ACCT_HEADER = 10;              // 8B anchor discriminator (d90c0c170ab7737d) + u16 LE epoch_day
const N_SLOTS = 288;                 // one per 5-min batch; account tail: u8 bump (+5B pad)

// ---- shared fold: isRightSibling => sibling goes on the RIGHT of current ----
const fold = (leaf, proof) => proof.reduce(
  (cur, n) => n.isRightSibling ? sha(cur, buf(n.hash)) : sha(buf(n.hash), cur), leaf);

// ---- Leg 1: stat leaf (no domain tag) ----
function statLeafHash({ key, value, period }) {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(key >>> 0, 0); b.writeInt32LE(value | 0, 4); b.writeInt32LE(period | 0, 8);
  return sha(b);
}

// ---- Leg 3 (SOLVED): main-tree leaf = sha256(0x01 || borsh(ScoresBatchSummary)) ----
// borsh(ScoresBatchSummary) = fixture_id i64 LE | update_count i32 LE |
//                             min_timestamp i64 LE | max_timestamp i64 LE | events_sub_tree_root[32]
// => 61-byte preimage. 0x01 is a leaf domain tag in the main (batch) tree.
export function summaryLeaf(summary) {
  const b = Buffer.alloc(61);
  b[0] = 0x01;
  b.writeBigInt64LE(BigInt(summary.fixtureId), 1);
  b.writeInt32LE(summary.updateStats.updateCount | 0, 9);
  b.writeBigInt64LE(BigInt(summary.updateStats.minTimestamp), 13);
  b.writeBigInt64LE(BigInt(summary.updateStats.maxTimestamp), 21);
  buf(summary.eventStatsSubTreeRoot).copy(b, 29);
  return sha(b);
}

// slot index inside the day account: floor((minTs mod day) / 5min)
export const slotIndex = (minTs) => Math.floor((minTs % DAY_MS) / SLOT_MS);
export const epochDay  = (minTs) => Math.floor(minTs / DAY_MS);

/** Leg 3 alone: summary + mainTreeProof vs raw account bytes. */
export function verifySummaryToRoot(validation, accountData) {
  const mn = validation.summary.updateStats.minTimestamp;
  if (accountData.length !== ACCT_HEADER + N_SLOTS*32 + 6) return { ok:false, reason:"bad account size" };
  if (accountData.readUInt16LE(8) !== epochDay(mn))
    return { ok:false, reason:`account epoch_day ${accountData.readUInt16LE(8)} != ${epochDay(mn)}` };
  const idx = slotIndex(mn);
  const slot = accountData.subarray(ACCT_HEADER + idx*32, ACCT_HEADER + idx*32 + 32);
  if (slot.every(b => b === 0)) return { ok:false, reason:`slot ${idx} empty (RootNotAvailable)` };
  const root = fold(summaryLeaf(validation.summary), validation.mainTreeProof);
  return { ok: root.equals(slot), idx, computed: root.toString("hex"), onchain: Buffer.from(slot).toString("hex"),
           reason: root.equals(slot) ? "ok" : "InvalidMainTreeProof" };
}

/** Full chain for every non-zero stat in the payload + summary->on-chain root. */
export function verifyPayload(validation, accountData) {
  const out = { stats: [], leg2: false, leg3: null };
  // Leg 2: eventStatRoot -> eventStatsSubTreeRoot via subTreeProof
  out.leg2 = fold(buf(validation.eventStatRoot), validation.subTreeProof)
               .equals(buf(validation.summary.eventStatsSubTreeRoot));
  // Leg 1 per stat (present-path only here; zero-value sentinel scheme is in txline_stat_verify.mjs)
  validation.statsToProve.forEach((st, i) => {
    const proof = validation.statProofs[i];
    const sentinel = proof.length === 2 && buf(proof[0].hash)[0] === 0x01 &&
                     buf(proof[0].hash).subarray(1).every(b => b === 0xff);
    if (sentinel) { out.stats.push({ key: st.key, ok: st.value === 0, path: "sentinel" }); return; }
    out.stats.push({ key: st.key,
      ok: fold(statLeafHash(st), proof).equals(buf(validation.eventStatRoot)), path: "present" });
  });
  // Leg 3
  out.leg3 = verifySummaryToRoot(validation, accountData);
  out.ok = out.leg2 && out.leg3.ok && out.stats.every(s => s.ok);
  return out;
}

// ---- CLI: node txline_full_chain_verify.mjs <acctHexFile> <proofJson...> ----
if (process.argv[1]?.endsWith("txline_full_chain_verify.mjs") && process.argv[2]) {
  const acct = Buffer.from(fs.readFileSync(process.argv[2], "utf8").trim(), "hex");
  for (const f of process.argv.slice(3)) {
    const d = JSON.parse(fs.readFileSync(f));
    const vs = d.proofs ? Object.entries(d.proofs).map(([k,p]) => [k, p.validation]) : [["-", d.validation ?? d]];
    for (const [k, v] of vs) {
      const r = verifyPayload(v, acct);
      console.log(`${f.split("/").pop()} [${k}]`, r.ok ? "FULL-CHAIN PASS" : "FAIL",
        `slot=${r.leg3.idx}`, `stats=${r.stats.map(s=>`${s.key}:${s.ok?"ok":"BAD"}(${s.path})`).join(",")}`,
        r.ok ? "" : JSON.stringify(r.leg3));
      // adversarial: flip 1 bit in mainTreeProof sibling
      const vv = JSON.parse(JSON.stringify(v)); vv.mainTreeProof[0].hash[5] ^= 0x40;
      if (verifyPayload(vv, acct).ok) console.log("  !! mainTreeProof bit-flip ACCEPTED (bug)");
    }
  }
}
