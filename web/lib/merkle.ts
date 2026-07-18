/**
 * merkle.ts — in-browser recomputation of TxLINE's Merkle proof legs with
 * WebCrypto sha256. This is the "don't trust us, recompute it" button on the
 * receipt page, and the smoke test runs the identical code under node
 * (globalThis.crypto.subtle exists in both).
 *
 * Verified algorithm (reverse-engineered against real devnet proofs):
 *   leaf hash  = sha256(borsh(ScoreStat)) where borsh(ScoreStat) =
 *                key u32 LE | value i32 LE | period i32 LE   (12 bytes)
 *   chain step = next = isRightSibling ? sha256(current || sibling)
 *                                      : sha256(sibling || current)
 *
 * Legs recomputable client-side:
 *   1. stat leaf --statProof--> eventStatRoot
 *   2. eventStatRoot --subTreeProof--> summary.eventStatsSubTreeRoot
 * Leg 3 (summary → mainTreeProof → daily on-chain root) has a preimage that
 * is not in the receipt payload — it is verified ON-CHAIN by TxLINE's program
 * inside the settle transaction, which is the stronger guarantee; the UI
 * shows it as such rather than pretending to recompute it.
 */

import type { ProofNodeJson } from "./types";

export function scoreStatLeafBytes(key: number, value: number, period: number): Uint8Array {
  const b = new Uint8Array(12);
  const v = new DataView(b.buffer);
  v.setUint32(0, key, true);
  v.setInt32(4, value, true);
  v.setInt32(8, period, true);
  return b;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

export function toHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function bytesEq(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface HashStep {
  /** Hash before this step. */
  currentHex: string;
  siblingHex: string;
  isRightSibling: boolean;
  /** sha256 result after combining. */
  resultHex: string;
}

/** Fold a Merkle path, recording every intermediate hash for the animation. */
export async function foldProof(
  start: Uint8Array,
  proof: ProofNodeJson[],
): Promise<{ root: Uint8Array; steps: HashStep[] }> {
  let current = start;
  const steps: HashStep[] = [];
  for (const node of proof) {
    const sibling = Uint8Array.from(node.hash);
    const joined = new Uint8Array(64);
    // Sibling placement is the whole trick: current goes LEFT when the
    // sibling is the right child, RIGHT otherwise.
    if (node.isRightSibling) {
      joined.set(current, 0);
      joined.set(sibling, 32);
    } else {
      joined.set(sibling, 0);
      joined.set(current, 32);
    }
    const next = await sha256(joined);
    steps.push({
      currentHex: toHex(current),
      siblingHex: toHex(sibling),
      isRightSibling: node.isRightSibling,
      resultHex: toHex(next),
    });
    current = next;
  }
  return { root: current, steps };
}

/** Everything verifyLegs needs — plain JSON, whether it came from a decoded
 *  settle instruction or from the relay's /api/proof response. */
export interface VerifiablePayload {
  stats: { key: number; value: number; period: number; proof: ProofNodeJson[] }[];
  eventStatRoot: number[];
  subTreeProof: ProofNodeJson[];
  eventsSubTreeRoot: number[];
}

/** Detail of a verified non-membership (zero-value) proof — see below. */
export interface NonMembershipResult {
  /** sha256 of the bitmap node, recomputed here. */
  bitmapHashHex: string;
  /** subTreeProof[0] — the committed bitmap hash it must equal. */
  committedHex: string;
  /** The absent key's period bucket / stat type decoded from the key. */
  bucket: number;
  statType: number;
  /** Every non-zero stat key of the match, decoded from the bitmap. */
  presentKeys: number[];
}

export interface LegResult {
  label: string;
  steps: HashStep[];
  computedHex: string;
  expectedHex: string;
  ok: boolean;
  /** True when this stat is a zero-value NON-MEMBERSHIP proof (the scheme we
   *  reverse-engineered — see FEEDBACK.md). Fully verified client-side too;
   *  `nonMembership` carries the recomputed evidence. */
  aggregated: boolean;
  nonMembership?: NonMembershipResult;
}

/**
 * TxLINE's zero-value stats are proven by NON-MEMBERSHIP, not by a leaf:
 * node A is a fixed header [0x01, 0xff×31]; node B is the bitwise complement
 * of a 64-slot presence bitmap (byte = period bucket 0–7, bit = stat type
 * 1–8), cryptographically committed as the left sibling of eventStatRoot
 * (sha256(nodeB) == subTreeProof[0]). We reverse-engineered and validated
 * this against the on-chain verifier (12/12 real proofs, 64/64 byte-flips
 * rejected) — see FEEDBACK.md for the full spec.
 */
const SENTINEL_HEADER = (() => {
  const b = new Uint8Array(32).fill(0xff);
  b[0] = 0x01;
  return b;
})();

export function isAggregationProof(proof: ProofNodeJson[]): boolean {
  return (
    proof.length === 2 && bytesEq(Uint8Array.from(proof[0].hash), SENTINEL_HEADER)
  );
}

export function decodePresenceBitmap(nodeB: ArrayLike<number>): number[] {
  const present: number[] = [];
  for (let bucket = 0; bucket < 8; bucket++) {
    const presenceByte = ~(nodeB as number[])[bucket] & 0xff;
    for (let t = 1; t <= 8; t++) {
      if ((presenceByte >> (t - 1)) & 1) present.push(bucket * 1000 + t);
    }
  }
  return present;
}

async function verifyNonMembership(
  stat: { key: number; value: number },
  proof: ProofNodeJson[],
  subTreeProof: ProofNodeJson[],
): Promise<{ ok: boolean; label: string; nonMembership: NonMembershipResult }> {
  const nodeB = Uint8Array.from(proof[1].hash);
  const bitmapHash = await sha256(nodeB);
  const committed = subTreeProof[0] ? Uint8Array.from(subTreeProof[0].hash) : new Uint8Array(32);
  const bucket = Math.floor(stat.key / 1000);
  const statType = stat.key % 1000;

  const headerOk =
    proof[0].isRightSibling === false && proof[1].isRightSibling === false;
  const tailOk = nodeB.slice(8).every((b) => b === 0);
  const bindOk =
    subTreeProof[0]?.isRightSibling === false && bytesEq(bitmapHash, committed);
  const rangeOk = bucket >= 0 && bucket <= 7 && statType >= 1 && statType <= 8;
  // nodeB is the COMPLEMENT: an absent (zero-value) key has its bit SET.
  const absentOk = rangeOk && ((nodeB[bucket] >> (statType - 1)) & 1) === 1;
  const valueOk = stat.value === 0;

  const ok = headerOk && tailOk && bindOk && rangeOk && absentOk && valueOk;
  return {
    ok,
    label: `stat ${stat.key} = 0 — non-membership vs the committed presence bitmap`,
    nonMembership: {
      bitmapHashHex: toHex(bitmapHash),
      committedHex: toHex(committed),
      bucket,
      statType,
      presentKeys: decodePresenceBitmap(nodeB),
    },
  };
}

/** Recompute legs 1 (per stat leaf) and 2 (subtree). */
export async function verifyLegs(payload: VerifiablePayload): Promise<{ legs: LegResult[]; ok: boolean }> {
  const legs: LegResult[] = [];
  for (const stat of payload.stats) {
    if (isAggregationProof(stat.proof)) {
      const res = await verifyNonMembership(stat, stat.proof, payload.subTreeProof);
      legs.push({
        label: res.label,
        steps: [],
        computedHex: res.nonMembership.bitmapHashHex,
        expectedHex: res.nonMembership.committedHex,
        ok: res.ok,
        aggregated: true,
        nonMembership: res.nonMembership,
      });
      continue;
    }
    const leaf = await sha256(scoreStatLeafBytes(stat.key, stat.value, stat.period));
    const { root, steps } = await foldProof(leaf, stat.proof);
    legs.push({
      label: `stat ${stat.key} = ${stat.value} (period ${stat.period}) → eventStatRoot`,
      steps,
      computedHex: toHex(root),
      expectedHex: toHex(payload.eventStatRoot),
      ok: bytesEq(root, payload.eventStatRoot),
      aggregated: false,
    });
  }
  const sub = await foldProof(Uint8Array.from(payload.eventStatRoot), payload.subTreeProof);
  legs.push({
    label: "eventStatRoot → fixture subtree root",
    steps: sub.steps,
    computedHex: toHex(sub.root),
    expectedHex: toHex(payload.eventsSubTreeRoot),
    ok: bytesEq(sub.root, payload.eventsSubTreeRoot),
    aggregated: false,
  });
  return { legs, ok: legs.every((l) => l.ok) };
}
