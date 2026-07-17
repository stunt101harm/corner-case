"use client";

/**
 * MerkleChain.tsx — the settlement receipt's proof chain, made legible:
 * stat leaves → eventStatRoot → fixture subtree → main tree → the on-chain
 * daily_scores_roots PDA. "Re-verify in this browser" ACTUALLY recomputes
 * legs 1+2 with WebCrypto sha256, animating each hash step; leg 3 is honestly
 * labeled as what it is — verified on-chain by TxLINE's program inside the
 * settle transaction (the stronger guarantee).
 */

import { useCallback, useRef, useState } from "react";
import { verifyLegs, type LegResult } from "@/lib/merkle";
import { statKeyName } from "@/lib/strategy";
import { explorerAddress, explorerTx } from "@/lib/constants";
import { deriveTxlineRootsPda, type PlainSettlePayload } from "@/lib/program";

const STEP_ANIMATION_MS = 220;

export function MerkleChain({
  payload,
  epochDay,
  txSig,
  home,
  away,
}: {
  payload: PlainSettlePayload;
  epochDay: number;
  txSig: string;
  home?: string;
  away?: string;
}): React.ReactNode {
  const [legs, setLegs] = useState<LegResult[] | null>(null);
  const [revealed, setRevealed] = useState(0);
  const [running, setRunning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const totalSteps = legs ? legs.reduce((n, l) => n + l.steps.length + 1, 0) : 0;
  const done = legs !== null && revealed >= totalSteps && !running;
  const allOk = legs?.every((l) => l.ok) ?? false;

  const reverify = useCallback(async (): Promise<void> => {
    if (timerRef.current) clearInterval(timerRef.current);
    setRunning(true);
    setRevealed(0);
    const result = await verifyLegs({
      stats: payload.stats,
      eventStatRoot: payload.eventStatRoot,
      subTreeProof: payload.fixtureProof,
      eventsSubTreeRoot: payload.eventsSubTreeRoot,
    });
    setLegs(result.legs);
    // Recomputation is instant; the reveal is paced so each sha256 step is
    // visible ticking through — that legibility IS the feature.
    const total = result.legs.reduce((n, l) => n + l.steps.length + 1, 0);
    let i = 0;
    timerRef.current = setInterval(() => {
      i++;
      setRevealed(i);
      if (i >= total && timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
        setRunning(false);
      }
    }, STEP_ANIMATION_MS);
  }, [payload]);

  // Steps revealed before this leg starts, for the animation offsets.
  const legOffset = (index: number): number =>
    (legs ?? []).slice(0, index).reduce((n, l) => n + l.steps.length + 1, 0);

  const rootsPda = deriveTxlineRootsPda(epochDay).toBase58();

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-chalk/80">
          Merkle proof chain
        </h2>
        <button className="btn-primary h-8 text-xs" onClick={reverify} disabled={running}>
          {running ? "Recomputing…" : legs ? "Re-verify again" : "Re-verify in this browser"}
        </button>
      </div>
      {done && (
        <p
          className={`mt-2 rounded-lg border px-3 py-2 text-sm ${
            allOk
              ? "border-turf-500/50 bg-turf-600/10 text-turf-300"
              : "border-card-red/50 bg-card-red/10 text-card-red"
          }`}
        >
          {allOk
            ? `✓ Recomputed ${totalSteps} sha256 hashes in this browser — every node matches the proof.`
            : "✕ Recomputation mismatch — this proof does not check out."}
        </p>
      )}

      <div className="mt-4 space-y-1">
        {/* Leg 1: stat leaves */}
        {payload.stats.map((stat, si) => (
          <div key={stat.key}>
            <NodeCard
              tone="leaf"
              title={`Stat leaf · ${statKeyName(stat.key, home, away)}`}
              subtitle={`key ${stat.key} = ${stat.value} · period ${stat.period}${stat.period === 100 ? " (game finalised — check gate #2)" : ""}`}
              hex={legs?.[si]?.steps[0]?.currentHex}
              checked={legs !== null && revealed > legOffset(si)}
              ok={legs?.[si]?.ok}
            />
            {(legs?.[si]?.steps ?? skeletonSteps(payload.stats[si].proof)).map((step, i) => (
              <ProofStep
                key={i}
                siblingHex={step.siblingHex}
                isRightSibling={step.isRightSibling}
                resultHex={step.resultHex}
                revealed={legs !== null && revealed > legOffset(si) + i + 1}
                ok={legs?.[si]?.ok}
              />
            ))}
          </div>
        ))}

        <NodeCard
          tone="root"
          title="eventStatRoot"
          subtitle={`root of this record's stat tree — all ${payload.stats.length} leaves fold to it`}
          hex={hexOf(payload.eventStatRoot)}
          checked={legs !== null && revealed >= legOffset(payload.stats.length)}
          ok={legs ? legs.slice(0, payload.stats.length).every((l) => l.ok) : undefined}
        />

        {/* Leg 2: subtree */}
        {(legs?.[payload.stats.length]?.steps ?? skeletonSteps(payload.fixtureProof)).map(
          (step, i) => (
            <ProofStep
              key={i}
              siblingHex={step.siblingHex}
              isRightSibling={step.isRightSibling}
              resultHex={step.resultHex}
              revealed={legs !== null && revealed > legOffset(payload.stats.length) + i + 1}
              ok={legs?.[payload.stats.length]?.ok}
            />
          ),
        )}

        <NodeCard
          tone="root"
          title="Fixture subtree root"
          subtitle={`bound to fixture ${payload.fixtureId}${home ? ` (${home} v ${away})` : ""} — a proof from any other match cannot land here`}
          hex={hexOf(payload.eventsSubTreeRoot)}
          checked={legs !== null && revealed >= totalSteps}
          ok={legs?.[payload.stats.length]?.ok}
        />

        {/* Leg 3: main tree — on-chain verified */}
        {payload.mainTreeProof.map((node, i) => (
          <ProofStep
            key={i}
            siblingHex={hexOf(node.hash)}
            isRightSibling={node.isRightSibling}
            onChain
          />
        ))}

        <NodeCard
          tone="chain"
          title={`daily_scores_roots · epoch day ${epochDay}`}
          subtitle="TxLINE's attested on-chain root account"
          link={{ href: explorerAddress(rootsPda), label: rootsPda }}
        />
      </div>

      <p className="mt-3 text-xs leading-relaxed text-chalk/50">
        Legs 1–2 (leaves → fixture subtree) recompute above with WebCrypto sha256:
        leaf = sha256(key·value·period as 12 LE bytes), step = sha256(left‖right) with sibling
        placement from the proof. The final leg into the daily root was{" "}
        <a href={explorerTx(txSig)} target="_blank" rel="noreferrer" className="text-turf-400 underline underline-offset-2">
          verified on-chain by TxLINE&apos;s program in this transaction ↗
        </a>
        {" "}— the settlement could not have executed otherwise.
      </p>
    </div>
  );
}

function hexOf(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pre-verification placeholder rows: real sibling hashes, no results yet. */
function skeletonSteps(
  proof: { hash: number[]; isRightSibling: boolean }[],
): { siblingHex: string; isRightSibling: boolean; resultHex: string }[] {
  return proof.map((n) => ({ siblingHex: hexOf(n.hash), isRightSibling: n.isRightSibling, resultHex: "" }));
}

function NodeCard({
  tone,
  title,
  subtitle,
  hex,
  checked,
  ok,
  link,
}: {
  tone: "leaf" | "root" | "chain";
  title: string;
  subtitle: string;
  hex?: string;
  checked?: boolean;
  ok?: boolean;
  link?: { href: string; label: string };
}): React.ReactNode {
  const border =
    tone === "chain"
      ? "border-turf-500/60"
      : tone === "root"
        ? "border-pitch-500"
        : "border-pitch-600/70";
  return (
    <div className={`rounded-lg border ${border} bg-pitch-800/70 px-3 py-2`}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-chalk">{title}</span>
        {checked && (
          <span className={ok === false ? "text-card-red" : "text-turf-400"}>
            {ok === false ? "✕" : "✓"}
          </span>
        )}
      </div>
      <p className="text-xs text-chalk/60">{subtitle}</p>
      {hex && <p className="mono-hex mt-1">{hex}</p>}
      {link && (
        <a
          href={link.href}
          target="_blank"
          rel="noreferrer"
          className="mono-hex mt-1 block text-turf-400 underline underline-offset-2 hover:text-turf-300"
        >
          {link.label} ↗
        </a>
      )}
    </div>
  );
}

function ProofStep({
  siblingHex,
  isRightSibling,
  resultHex,
  revealed,
  ok,
  onChain,
}: {
  siblingHex: string;
  isRightSibling: boolean;
  resultHex?: string;
  revealed?: boolean;
  ok?: boolean;
  onChain?: boolean;
}): React.ReactNode {
  return (
    <div className="flex items-center gap-2 py-0.5 pl-5">
      <span className="text-chalk/30">↓</span>
      <span className="font-mono text-[11px] text-chalk/50">
        sha256({isRightSibling ? "· ‖ sib" : "sib ‖ ·"})
      </span>
      {onChain ? (
        <span className="rounded border border-pitch-500 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-chalk/50">
          verified on-chain
        </span>
      ) : revealed ? (
        <>
          <span className={`text-xs ${ok === false ? "text-card-red" : "text-turf-400"}`}>
            {ok === false ? "✕" : "✓"}
          </span>
          {resultHex && (
            <span className="hidden font-mono text-[11px] text-chalk/40 sm:inline">
              → {resultHex.slice(0, 16)}…
            </span>
          )}
        </>
      ) : (
        siblingHex !== "" && <span className="text-[11px] text-chalk/30">pending</span>
      )}
      {siblingHex && (
        <span className="ml-auto hidden font-mono text-[11px] text-chalk/30 md:inline">
          sib {siblingHex.slice(0, 12)}…
        </span>
      )}
    </div>
  );
}
