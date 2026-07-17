/**
 * strategy.ts — encode/decode the TxLINE `validateStatV2` NDimensionalStrategy
 * bytes, plus the five product templates and predicate evaluation for the
 * live condition tracker.
 *
 * The encoding is hand-rolled borsh, byte-identical to the reference
 * implementation in tests/corner_case.ts (Anchor's standalone types coder is
 * broken for this nested enum — known bug). Layout:
 *
 *   u32 LE  geometric_targets vec len  (always 0 for us)
 *   u8      distance_predicate Option  (always None = 0)
 *   u32 LE  discrete_predicates vec len (always 1 — one predicate per market)
 *   u8      predicate variant: 0 = Single { index: u8 }
 *                              1 = Binary { index_a: u8, index_b: u8, op: u8 }
 *   ...     variant fields; op: 0 = Add, 1 = Subtract
 *   i32 LE  threshold
 *   u8      comparison: 0 = GreaterThan, 1 = LessThan, 2 = EqualTo
 *
 * "What you sign is what settles": the builder shows these exact bytes before
 * create_market, and the decoder below is the inverse used to describe any
 * on-chain market — including ones created outside our UI.
 */

export const OP = { add: 0, sub: 1 } as const;
export const CMP = { gt: 0, lt: 1, eq: 2 } as const;

export type DecodedPredicate =
  | { kind: "single"; index: number; threshold: number; cmp: number }
  | { kind: "binary"; indexA: number; indexB: number; op: number; threshold: number; cmp: number };

export function encodeBinaryStrategy(
  indexA: number,
  indexB: number,
  op: number,
  threshold: number,
  cmp: number,
): Uint8Array {
  const b = new Uint8Array(4 + 1 + 4 + 1 + 3 + 4 + 1);
  const v = new DataView(b.buffer);
  let o = 0;
  v.setUint32(o, 0, true); o += 4; // geometric_targets: empty
  v.setUint8(o, 0); o += 1; //         distance_predicate: None
  v.setUint32(o, 1, true); o += 4; // discrete_predicates: 1 entry
  v.setUint8(o, 1); o += 1; //         variant: Binary
  v.setUint8(o, indexA); o += 1;
  v.setUint8(o, indexB); o += 1;
  v.setUint8(o, op); o += 1;
  v.setInt32(o, threshold, true); o += 4;
  v.setUint8(o, cmp);
  return b;
}

/**
 * Inverse of the encoder. Returns null for anything that is not exactly the
 * shape our product writes (one discrete predicate, no geometric/distance
 * parts) — the UI then falls back to showing raw hex, never a wrong sentence.
 */
export function decodeStrategy(bytes: Uint8Array): DecodedPredicate | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    let o = 0;
    if (v.getUint32(o, true) !== 0) return null; // geometric targets present
    o += 4;
    if (v.getUint8(o) !== 0) return null; //        distance predicate present
    o += 1;
    if (v.getUint32(o, true) !== 1) return null; // != exactly one predicate
    o += 4;
    const variant = v.getUint8(o); o += 1;
    if (variant === 0) {
      const index = v.getUint8(o); o += 1;
      const threshold = v.getInt32(o, true); o += 4;
      const cmp = v.getUint8(o); o += 1;
      if (o !== bytes.byteLength || cmp > 2) return null;
      return { kind: "single", index, threshold, cmp };
    }
    if (variant === 1) {
      const indexA = v.getUint8(o); o += 1;
      const indexB = v.getUint8(o); o += 1;
      const op = v.getUint8(o); o += 1;
      const threshold = v.getInt32(o, true); o += 4;
      const cmp = v.getUint8(o); o += 1;
      if (o !== bytes.byteLength || cmp > 2 || op > 1) return null;
      return { kind: "binary", indexA, indexB, op, threshold, cmp };
    }
    return null;
  } catch {
    return null; // out-of-bounds read == not our encoding
  }
}

// ---------------------------------------------------------------------------
// Stat-key naming
// ---------------------------------------------------------------------------

const BASE_STATS: Record<number, string> = {
  1: "goals", 2: "goals",
  3: "yellow cards", 4: "yellow cards",
  5: "red cards", 6: "red cards",
  7: "corners", 8: "corners",
};

/** "corners (home)" / "H2 red cards (away)" — key map from spike/NOTES.md. */
export function statKeyName(key: number, home = "home", away = "away"): string {
  const base = key % 1000;
  const prefix = Math.floor(key / 1000);
  const stat = BASE_STATS[base] ?? `stat ${base}`;
  const side = base % 2 === 1 ? home : away;
  const period = prefix === 1 ? "H1 " : prefix === 3 ? "H2 " : "";
  return `${period}${stat} (${side})`;
}

const CMP_SYMBOL = [">", "<", "="] as const;
const OP_SYMBOL = ["+", "−"] as const; // + / −

/**
 * Human sentence for the exact predicate, e.g.
 * "corners (England) + corners (Argentina) > 9".
 */
export function describePredicate(
  p: DecodedPredicate,
  statKeys: number[],
  home = "home",
  away = "away",
): string {
  const name = (i: number): string =>
    i < statKeys.length ? statKeyName(statKeys[i], home, away) : `key[${i}]?`;
  if (p.kind === "single") {
    return `${name(p.index)} ${CMP_SYMBOL[p.cmp]} ${p.threshold}`;
  }
  return `${name(p.indexA)} ${OP_SYMBOL[p.op]} ${name(p.indexB)} ${CMP_SYMBOL[p.cmp]} ${p.threshold}`;
}

/**
 * Evaluate the predicate against a live Stats map (key → value). Returns the
 * current left-hand value and verdict, or null while the needed keys have not
 * appeared in the stream yet.
 */
export function evaluatePredicate(
  p: DecodedPredicate,
  statKeys: number[],
  stats: Record<string, number> | undefined,
): { value: number; verdict: boolean } | null {
  if (!stats) return null;
  const val = (i: number): number | null => {
    const key = statKeys[i];
    if (key === undefined) return null;
    const v = stats[String(key)];
    return v === undefined ? null : v;
  };
  let lhs: number | null;
  if (p.kind === "single") {
    lhs = val(p.index);
  } else {
    const a = val(p.indexA);
    const b = val(p.indexB);
    lhs = a === null || b === null ? null : p.op === OP.add ? a + b : a - b;
  }
  if (lhs === null) return null;
  const verdict =
    p.cmp === CMP.gt ? lhs > p.threshold : p.cmp === CMP.lt ? lhs < p.threshold : lhs === p.threshold;
  return { value: lhs, verdict };
}

// ---------------------------------------------------------------------------
// Product templates — the only five props the builder offers. Each maps 1:1
// to spike-tested strategy bytes; the YES/NO toggle picks the market side,
// never the bytes.
// ---------------------------------------------------------------------------

export interface PropTemplate {
  id: string;
  title: string;
  /** Ordered TxLINE stat keys; strategy indices refer into this list. */
  statKeys: number[];
  indexA: number;
  indexB: number;
  op: number;
  threshold: number;
  cmp: number;
}

export const TEMPLATES: PropTemplate[] = [
  {
    id: "corners-over-9-5",
    title: "Total corners over 9.5",
    statKeys: [7, 8],
    indexA: 0, indexB: 1, op: OP.add, threshold: 9, cmp: CMP.gt,
  },
  {
    id: "home-wins",
    title: "Home side wins",
    statKeys: [1, 2],
    indexA: 0, indexB: 1, op: OP.sub, threshold: 0, cmp: CMP.gt,
  },
  {
    id: "away-wins",
    title: "Away side wins",
    statKeys: [1, 2],
    indexA: 1, indexB: 0, op: OP.sub, threshold: 0, cmp: CMP.gt,
  },
  {
    id: "h1-goals",
    title: "Goals in the first half",
    statKeys: [1001, 1002],
    indexA: 0, indexB: 1, op: OP.add, threshold: 0, cmp: CMP.gt,
  },
  {
    id: "no-h2-reds",
    title: "No red cards in the second half",
    statKeys: [3005, 3006],
    indexA: 0, indexB: 1, op: OP.add, threshold: 1, cmp: CMP.lt,
  },
];

export function templateStrategy(t: PropTemplate): Uint8Array {
  return encodeBinaryStrategy(t.indexA, t.indexB, t.op, t.threshold, t.cmp);
}

/**
 * Recognize an on-chain market as one of our templates (bytes + keys must
 * both match exactly). Used to show the friendly title instead of the raw
 * predicate sentence.
 */
export function matchTemplate(strategy: Uint8Array, statKeys: number[]): PropTemplate | null {
  for (const t of TEMPLATES) {
    if (t.statKeys.length !== statKeys.length) continue;
    if (!t.statKeys.every((k, i) => k === statKeys[i])) continue;
    const bytes = templateStrategy(t);
    if (bytes.length === strategy.length && bytes.every((b, i) => b === strategy[i])) return t;
  }
  return null;
}
