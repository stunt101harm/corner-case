// txline_stat_verify.mjs
// Reference verifier for TxLINE `validate_stat_v2` eventStat proofs — reverse-engineered
// from devnet program 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J.
//
// One eventStat tree per (fixture, seq/snapshot). Two leaf schemes share the same
// `eventStatRoot`:
//   PRESENT stat (value != 0): ordinary Merkle leaf with a full sibling path (5 nodes at final).
//   ABSENT  stat (value == 0): 2-node "sentinel" proof = a NON-MEMBERSHIP witness backed by a
//                              64-slot presence bitmap that is committed one level ABOVE
//                              eventStatRoot (it is subTreeProof[0], the left sibling of
//                              eventStatRoot in the fixture sub-tree).
//
// Stat-key encoding:  key = period_bucket*1000 + stat_type
//   stat_type in [1..8]: 1/2 goals, 3/4 yellows, 5/6 reds, 7/8 corners (home/away)
//   period_bucket in [0..7]: 0 = full-time, 1 = 1st-half (1000s), 2 = 2000s, 3 = 2nd-half (3000s), ...
//
// The presence bitmap is 8 bytes: byte = period_bucket, bit (stat_type-1) set => that stat is
// PRESENT (non-zero) in the tree. In the sentinel node it is stored COMPLEMENTED, then padded
// with 24 zero bytes to fill the 32-byte proof-node slot.
//
// SECURITY NOTE: this function proves a leaf against `eventStatRoot` / the fixture sub-tree.
// The caller must SEPARATELY verify (already-solved base scheme) that subTreeProof + mainTreeProof
// fold `eventStatRoot` up to the on-chain daily root for the claimed (fixtureId, epochDay), and
// that fixture_id/period gates hold. Only then is subTreeProof[0] a trusted commitment.

import crypto from "crypto";
const sha256 = (...bufs) => crypto.createHash("sha256").update(Buffer.concat(bufs)).digest();

const SENTINEL_NODE_A = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(31, 0xff)]); // [01, ff*31]
const buf = (x) => Buffer.isBuffer(x) ? x : Buffer.from(x);

function statLeafHash({ key, value, period }) {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(key >>> 0, 0);
  b.writeInt32LE(value | 0, 4);
  b.writeInt32LE(period | 0, 8);
  return sha256(b);
}

function foldToRoot(leafHash, proofNodes) {
  let cur = leafHash;
  for (const n of proofNodes) {
    const sib = buf(n.hash);
    cur = n.isRightSibling ? sha256(cur, sib) : sha256(sib, cur);
  }
  return cur;
}

/**
 * Verify one stat leaf against the eventStat commitment.
 * @param stat        {key,value,period}
 * @param statProof   array of {hash:number[]|Buffer, isRightSibling:boolean}
 * @param eventStatRoot         32-byte root (payload.eventStatRoot)
 * @param subTreeProof          array of {hash,isRightSibling} (validation.subTreeProof); required
 *                              to verify ABSENT proofs (its [0] node is the committed bitmap).
 * @returns {ok:boolean, reason:string, decoded?:object}
 */
export function verifyStat(stat, statProof, eventStatRoot, subTreeProof) {
  const root = buf(eventStatRoot);
  const nodes = statProof.map(n => ({ hash: buf(n.hash), isRightSibling: !!n.isRightSibling }));
  const isSentinel = nodes.length === 2 && nodes[0].hash.equals(SENTINEL_NODE_A);

  if (!isSentinel) {
    // ---------- PRESENT-stat path: plain Merkle membership ----------
    if (stat.value === 0) return { ok: false, reason: "present-path proof but value == 0" };
    const got = foldToRoot(statLeafHash(stat), nodes);
    return got.equals(root)
      ? { ok: true, reason: "present: leaf folds to eventStatRoot" }
      : { ok: false, reason: "present: fold != eventStatRoot (InvalidStatProof)" };
  }

  // ---------- ABSENT-stat (sentinel) path ----------
  if (stat.value !== 0) return { ok: false, reason: "StatNotZero: sentinel proof but value != 0" };
  if (!nodes[0].hash.equals(SENTINEL_NODE_A)) return { ok: false, reason: "bad sentinel header (node A)" };
  if (nodes[0].isRightSibling !== false || nodes[1].isRightSibling !== false)
    return { ok: false, reason: "sentinel nodes must be left-siblings" };
  const nodeB = nodes[1].hash;                             // [ ~bitmap(8) | 0x00 * 24 ]
  if (!nodeB.slice(8).equals(Buffer.alloc(24))) return { ok: false, reason: "node B tail not zero-padded" };

  // CRYPTOGRAPHIC BINDING (updateCount-independent):
  // the bitmap leaf hash == subTreeProof[0] (the committed left sibling of eventStatRoot).
  if (!subTreeProof || subTreeProof.length < 1) return { ok: false, reason: "missing subTreeProof for sentinel binding" };
  const committedBitmap = buf(subTreeProof[0].hash);
  if (subTreeProof[0].isRightSibling !== false) return { ok: false, reason: "subTreeProof[0] not left sibling" };
  if (!sha256(nodeB).equals(committedBitmap))
    return { ok: false, reason: "InvalidStatProof: nodeB is not the committed presence bitmap" };
  // (Self-contained equivalent when only eventStatsSubTreeRoot is trusted and updateCount==1:
  //   sha256( sha256(nodeB) || eventStatRoot ) === eventStatsSubTreeRoot )

  // key -> (bucket, type) bounds
  const bucket = Math.floor(stat.key / 1000);
  const type = stat.key % 1000;
  if (bucket < 0 || bucket > 7 || type < 1 || type > 8)
    return { ok: false, reason: `IndexOutOfBounds: bucket=${bucket} type=${type}` };

  // presence bit must be 0 (absent). nodeB is COMPLEMENTED, so absent <=> nodeB bit == 1.
  const absentBit = (nodeB[bucket] >> (type - 1)) & 1;
  if (absentBit !== 1) return { ok: false, reason: "StatNotZero: key is present in the committed bitmap" };

  return { ok: true, reason: "absent: value 0 proven via committed presence bitmap",
           decoded: { bucket, type, presentKeys: presenceBitmap(nodeB) } };
}

/** Decode the sorted list of present (non-zero) stat keys from a sentinel node B. */
export function presenceBitmap(nodeB) {
  const nb = buf(nodeB), present = [];
  for (let bucket = 0; bucket < 8; bucket++) {
    const presenceByte = (~nb[bucket]) & 0xff;
    for (let t = 1; t <= 8; t++) if ((presenceByte >> (t - 1)) & 1) present.push(bucket * 1000 + t);
  }
  return present;
}
