"use client";

/**
 * MatchFingerprint — the 64-slot presence bitmap from a TxLINE non-membership
 * proof, drawn as an 8×8 dot grid: rows are period buckets (key = bucket×1000
 * + type), columns are the eight stat types (goals/yellows/reds/corners, each
 * home then away). A lit dot means the match has a non-zero value for that
 * slot; the ringed dot is the slot the proof shows ABSENT. The input is
 * `LegResult.nonMembership.presentKeys` (lib/merkle.ts decodePresenceBitmap)
 * — the whole picture decodes from the 32-byte bitmap node.
 */

import { Fragment } from "react";

/** Period buckets observed in TxLINE stat keys: 0 = full-time totals,
 *  1 = first half, 3 = second half; 2 is the half-time boundary bucket and
 *  the rest are unseen — labeled by number so nothing renders as a lie. */
const BUCKET_LABELS = ["FT", "H1", "HT", "H2", "P4", "P5", "P6", "P7"] as const;

const BUCKET_NAMES: Record<number, string> = {
  0: "full-time",
  1: "H1",
  2: "half-time",
  3: "H2",
};

/** Stat types 1–8: odd = home (P1), even = away (P2). */
const TYPE_GROUPS = ["goals", "yel", "red", "cor"] as const;
const TYPE_NAMES = ["goals", "goals", "yellows", "yellows", "reds", "reds", "corners", "corners"] as const;

export function MatchFingerprint({
  presentKeys,
  absentKey,
  home,
  away,
}: {
  /** Non-zero stat keys decoded from the bitmap (bucket×1000 + type). */
  presentKeys: number[];
  /** The key this proof shows absent (zero-value) — gets the red ring. */
  absentKey?: number;
  home?: string;
  away?: string;
}): React.ReactNode {
  const present = new Set(presentKeys);
  return (
    <div className="mt-2">
      <div className="inline-grid grid-cols-[auto_repeat(8,17px)] items-center gap-y-px">
        <span />
        {TYPE_GROUPS.map((g) => (
          <span
            key={g}
            className="col-span-2 pb-0.5 text-center text-[9px] uppercase tracking-wide text-chalk/40"
          >
            {g}
          </span>
        ))}
        {BUCKET_LABELS.map((label, bucket) => (
          <Fragment key={label}>
            <span className="pr-1.5 text-right font-mono text-[9px] text-chalk/40">{label}</span>
            {Array.from({ length: 8 }, (_, i) => {
              const type = i + 1;
              const key = bucket * 1000 + type;
              const isHome = type % 2 === 1;
              const lit = present.has(key);
              const isAbsentSlot = absentKey === key;
              const side = isHome ? (home ?? "home") : (away ?? "away");
              return (
                <span
                  key={type}
                  className="flex h-[15px] w-[17px] items-center justify-center"
                  title={`${BUCKET_NAMES[bucket] ?? `bucket ${bucket}`} ${TYPE_NAMES[i]} (${side}) · key ${key} · ${
                    lit ? "present (non-zero)" : isAbsentSlot ? "proven absent (zero)" : "absent (zero)"
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      lit
                        ? isHome
                          ? "bg-turf-300"
                          : "bg-turf-600"
                        : "bg-pitch-600/70"
                    } ${isAbsentSlot ? "ring-1 ring-card-red/90" : ""}`}
                  />
                </span>
              );
            })}
          </Fragment>
        ))}
      </div>
      <p className="mt-1 flex items-center gap-2 text-[10px] text-chalk/40">
        <span>the match&apos;s stat fingerprint — decoded from 32 bytes</span>
        <span className="flex items-center gap-1" aria-hidden>
          <span className="h-1.5 w-1.5 rounded-full bg-turf-300" /> {home ?? "home"}
          <span className="ml-1 h-1.5 w-1.5 rounded-full bg-turf-600" /> {away ?? "away"}
        </span>
      </p>
    </div>
  );
}
