"use client";

/**
 * /verify — the Proof Inspector: an independent verifier for ANY TxLINE stat
 * proof, not just our markets. Type a fixture/seq/stat-key set, fetch the
 * proof through the relay, and this page recomputes the sha256 legs with the
 * exact same code the settlement receipts use (lib/merkle.ts) — leaves →
 * eventStatRoot → fixture subtree root — then shows the on-chain main-tree
 * path into TxLINE's daily_scores_roots PDA.
 */

import { useMemo, useState } from "react";
import { Connection } from "@solana/web3.js";
import { useFixtures } from "@/lib/hooks";
import { getProof } from "@/lib/relay";
import { MatchFingerprint } from "@/components/MatchFingerprint";
import { verifyLegs, toHex, type LegResult } from "@/lib/merkle";
import { statKeyName } from "@/lib/strategy";
import { deriveTxlineRootsPda, fetchRootsAccountData } from "@/lib/program";
import { fixtureDisplay } from "@/lib/fixtures";
import { DEMO_FIXTURE_ID, KNOWN_FIXTURES, RPC_URL, epochDayFromMs, explorerAddress } from "@/lib/constants";
import type { StatValidationJson } from "@/lib/types";

const MAX_KEYS = 5;

interface InspectResult {
  proof: StatValidationJson;
  legs: LegResult[];
  allOk: boolean;
  epochDay: number;
}

export default function VerifyPage(): React.ReactNode {
  const { fixtures } = useFixtures();

  const [fixtureId, setFixtureId] = useState(String(DEMO_FIXTURE_ID));
  const [seq, setSeq] = useState("962");
  const [keys, setKeys] = useState("1,2");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InspectResult | null>(null);

  // Dropdown: the fixtures the product story names first, then everything the
  // relay's live TxLINE snapshot knows about.
  const options = useMemo(() => {
    const seen = new Set<number>();
    const out: { id: number; label: string }[] = [];
    for (const k of Object.values(KNOWN_FIXTURES)) {
      seen.add(k.fixtureId);
      out.push({ id: k.fixtureId, label: `${k.home} v ${k.away} · ${k.fixtureId}` });
    }
    for (const f of fixtures) {
      if (seen.has(f.FixtureId)) continue;
      seen.add(f.FixtureId);
      out.push({ id: f.FixtureId, label: `${f.Participant1} v ${f.Participant2} · ${f.FixtureId}` });
    }
    return out;
  }, [fixtures]);

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setResult(null);

    const fid = Number(fixtureId.trim());
    const s = Number(seq.trim());
    const parsedKeys = keys
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0)
      .map(Number);
    if (!Number.isInteger(fid) || fid <= 0) {
      setError("Fixture id must be a positive integer.");
      return;
    }
    if (!Number.isInteger(s) || s <= 0) {
      setError("Seq must be a positive integer — for settlements it is the game_finalised record's seq.");
      return;
    }
    if (parsedKeys.length === 0 || parsedKeys.length > MAX_KEYS || parsedKeys.some((k) => !Number.isInteger(k) || k <= 0)) {
      setError(`Stat keys must be 1–${MAX_KEYS} comma-separated positive integers, e.g. "1,2" or "3005,3006".`);
      return;
    }

    setBusy(true);
    try {
      const proof = await getProof(fid, s, parsedKeys);
      const minTs = proof.summary.updateStats.minTimestamp;
      const day = epochDayFromMs(minTs);
      // Fetch TxLINE's on-chain roots account so leg 3 verifies to the bytes.
      let rootsAccountData: Uint8Array | undefined;
      try {
        rootsAccountData =
          (await fetchRootsAccountData(new Connection(RPC_URL, "confirmed"), day)) ?? undefined;
      } catch {
        rootsAccountData = undefined;
      }
      // The SAME verification the settlement receipts run (lib/merkle.ts).
      const { legs, ok } = await verifyLegs({
        stats: proof.statsToProve.map((st, i) => ({ ...st, proof: proof.statProofs[i] ?? [] })),
        eventStatRoot: proof.eventStatRoot,
        subTreeProof: proof.subTreeProof,
        eventsSubTreeRoot: proof.summary.eventStatsSubTreeRoot,
        summary: {
          fixtureId: Number(proof.summary.fixtureId),
          updateCount: proof.summary.updateStats.updateCount,
          minTimestamp: minTs,
          maxTimestamp: proof.summary.updateStats.maxTimestamp,
        },
        mainTreeProof: proof.mainTreeProof,
        rootsAccountData,
      });
      setResult({
        proof,
        legs,
        allOk: ok,
        epochDay: epochDayFromMs(proof.summary.updateStats.minTimestamp),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <p className="label text-turf-400">Proof inspector</p>
        <h1 className="mt-1 text-2xl font-bold text-chalk">
          Verify any TxLINE stat proof — <span className="text-turf-400">yourself</span>
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-chalk/70">
          An independent verifier for <strong className="text-chalk">any</strong> TxLINE stat
          proof — not just our markets. Ask for any fixture, any scores-record seq, any stat keys:
          the relay fetches TxLINE&apos;s stat-validation proof and this page recomputes its sha256
          legs in your browser with the exact code the settlement receipts use.
        </p>
      </section>

      {/* Query form */}
      <form onSubmit={onSubmit} className="card space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="vf-fixture">Fixture id</label>
            <input
              id="vf-fixture"
              className="input-field mt-1"
              value={fixtureId}
              onChange={(e) => setFixtureId(e.target.value)}
              inputMode="numeric"
              placeholder="18241006"
            />
          </div>
          <div>
            <label className="label" htmlFor="vf-seq">Seq (scores record)</label>
            <input
              id="vf-seq"
              className="input-field mt-1"
              value={seq}
              onChange={(e) => setSeq(e.target.value)}
              inputMode="numeric"
              placeholder="962"
            />
          </div>
          <div>
            <label className="label" htmlFor="vf-keys">Stat keys (comma list, max {MAX_KEYS})</label>
            <input
              id="vf-keys"
              className="input-field mt-1"
              value={keys}
              onChange={(e) => setKeys(e.target.value)}
              placeholder="1,2"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="input-field w-auto"
            aria-label="Pick a known fixture"
            value={options.some((o) => String(o.id) === fixtureId.trim()) ? fixtureId.trim() : ""}
            onChange={(e) => {
              if (e.target.value) setFixtureId(e.target.value);
            }}
          >
            <option value="">— pick a fixture —</option>
            {options.map((o) => (
              <option key={o.id} value={String(o.id)}>
                {o.label}
              </option>
            ))}
          </select>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "Fetching proof…" : "Fetch & verify proof"}
          </button>
          <p className="text-xs text-chalk/50">
            Defaults: the demo semi-final&apos;s game_finalised record (seq 962), goals for both sides.
          </p>
        </div>
      </form>

      {error && (
        <div className="card border-card-red/50 bg-card-red/5">
          <p className="text-sm text-card-red">{error}</p>
          <p className="mt-1 text-xs text-chalk/50">
            Unknown fixture or seq? TxLINE only serves proofs for processed scores records — the
            demo fixture 18241006 at seq 962 always works.
          </p>
        </div>
      )}

      {result && <ProofView r={result} fixturesHint={fixtures} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Proof rendering
// ---------------------------------------------------------------------------

function ProofView({
  r,
  fixturesHint,
}: {
  r: InspectResult;
  fixturesHint: ReturnType<typeof useFixtures>["fixtures"];
}): React.ReactNode {
  const { proof, legs, allOk, epochDay } = r;
  const f = fixtureDisplay(proof.summary.fixtureId, fixturesHint);
  const rootsPda = deriveTxlineRootsPda(epochDay).toBase58();

  const aggregatedCount = legs.filter((l) => l.aggregated).length;
  const recomputed = legs.filter((l) => !l.aggregated).reduce((n, l) => n + l.steps.length, 0);
  const subLeg = legs[legs.length - 1];

  return (
    <div className="space-y-4">
      {/* Verdict */}
      <div
        className={`card border-2 ${allOk ? "border-turf-500/60" : "border-card-red/60"}`}
      >
        <p className={`text-sm font-semibold ${allOk ? "text-turf-300" : "text-card-red"}`}>
          {allOk
            ? `✓ Recomputed ${recomputed} sha256 hash${recomputed === 1 ? "" : "es"} in this browser — every recomputable node matches.`
            : "✕ Recomputation mismatch — this proof does not check out."}
          {aggregatedCount > 0 &&
            ` ${aggregatedCount} period-scoped stat${aggregatedCount > 1 ? "s use" : " uses"} TxLINE's aggregation scheme (no client recompute; validated by the on-chain program).`}
        </p>
        <p className="mt-1 font-mono text-xs text-chalk/50">
          {f.home} v {f.away} · fixture {proof.summary.fixtureId} · proof ts{" "}
          {new Date(proof.ts).toUTCString()} · updateCount {proof.summary.updateStats.updateCount}
        </p>
      </div>

      {/* The chain */}
      <div className="card">
        <h2 className="text-sm font-bold uppercase tracking-wider text-chalk/80">
          Proof chain, leaf → daily root
        </h2>
        <div className="mt-4 space-y-1">
          {proof.statsToProve.map((stat, si) => {
            const leg = legs[si];
            return (
              <div key={`${stat.key}-${si}`}>
                <div className="rounded-lg border border-pitch-600/70 bg-pitch-800/70 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-chalk">
                      Stat leaf · {statKeyName(stat.key, f.home, f.away)}
                    </span>
                    <PeriodBadge period={stat.period} />
                    {leg && !leg.aggregated && (
                      <span className={leg.ok ? "text-turf-400" : "text-card-red"}>
                        {leg.ok ? "✓" : "✕"}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-chalk/60">
                    key {stat.key} = <span className="font-mono text-chalk/90">{stat.value}</span>
                    {" · "}leaf = sha256(key · value · period as 12 LE bytes)
                  </p>
                  {leg && leg.steps[0] && <p className="mono-hex mt-1">{leg.steps[0].currentHex}</p>}
                </div>
                {leg?.aggregated ? (
                  <div className="ml-6 border-l border-pitch-700/60 py-2 pl-4">
                    <span className="rounded border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 font-mono text-[11px] text-amber-300/90">
                      ⛓ period-scoped aggregation proof — interpreted and verified on-chain by
                      TxLINE&apos;s validateStatV2, exactly as in every settlement tx
                    </span>
                    {leg.nonMembership && (
                      <MatchFingerprint
                        presentKeys={leg.nonMembership.presentKeys}
                        absentKey={stat.key}
                        home={f.home}
                        away={f.away}
                      />
                    )}
                  </div>
                ) : (
                  leg?.steps.map((step, i) => (
                    <Step
                      key={i}
                      isRightSibling={step.isRightSibling}
                      siblingHex={step.siblingHex}
                      resultHex={step.resultHex}
                      ok={leg.ok}
                    />
                  ))
                )}
              </div>
            );
          })}

          <RootCard
            title="eventStatRoot"
            subtitle={`root of this record's stat tree — all ${proof.statsToProve.length} proven leaves fold to it`}
            hex={toHex(proof.eventStatRoot)}
            ok={legs.slice(0, proof.statsToProve.length).every((l) => l.ok)}
          />

          {subLeg?.steps.map((step, i) => (
            <Step
              key={i}
              isRightSibling={step.isRightSibling}
              siblingHex={step.siblingHex}
              resultHex={step.resultHex}
              ok={subLeg.ok}
            />
          ))}

          <RootCard
            title="Fixture subtree root (eventStatsSubTreeRoot)"
            subtitle={`bound to fixture ${proof.summary.fixtureId} — a proof from any other match cannot land here`}
            hex={toHex(proof.summary.eventStatsSubTreeRoot)}
            ok={subLeg?.ok}
          />

          {proof.mainTreeProof.map((node, i) => (
            <Step key={i} isRightSibling={node.isRightSibling} siblingHex={toHex(node.hash)} onChain />
          ))}

          <div className="rounded-lg border border-turf-500/60 bg-pitch-800/70 px-3 py-2">
            <p className="text-sm font-semibold text-chalk">
              daily_scores_roots · epoch day {epochDay}
            </p>
            <p className="text-xs text-chalk/60">
              TxLINE&apos;s attested on-chain root account — the main-tree leg above is what
              validateStatV2 checks against it during settlement
            </p>
            <a
              href={explorerAddress(rootsPda)}
              target="_blank"
              rel="noreferrer"
              className="mono-hex mt-1 block text-turf-400 underline underline-offset-2 hover:text-turf-300"
            >
              {rootsPda} ↗
            </a>
          </div>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-chalk/50">
          Legs 1–2 (leaves → fixture subtree) recompute here with WebCrypto sha256 — the same
          code path as the receipt pages. The main-tree leg&apos;s preimage is not part of the
          payload; it is what TxLINE&apos;s on-chain program folds into the daily root when a
          settlement (or any validateStatV2 call) runs.
        </p>
      </div>
    </div>
  );
}

function PeriodBadge({ period }: { period: number }): React.ReactNode {
  const finalised = period === 100;
  const label =
    period === 100 ? "period 100 · game finalised" : period === 3 ? "period 3 · half-time" : `period ${period}`;
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        finalised ? "border-turf-500/60 text-turf-300" : "border-chalk/30 text-chalk/60"
      }`}
    >
      {label}
    </span>
  );
}

function RootCard({
  title,
  subtitle,
  hex,
  ok,
}: {
  title: string;
  subtitle: string;
  hex: string;
  ok?: boolean;
}): React.ReactNode {
  return (
    <div className="rounded-lg border border-pitch-500 bg-pitch-800/70 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-chalk">{title}</span>
        {ok !== undefined && (
          <span className={ok ? "text-turf-400" : "text-card-red"}>{ok ? "✓" : "✕"}</span>
        )}
      </div>
      <p className="text-xs text-chalk/60">{subtitle}</p>
      <p className="mono-hex mt-1">{hex}</p>
    </div>
  );
}

function Step({
  isRightSibling,
  siblingHex,
  resultHex,
  ok,
  onChain,
}: {
  isRightSibling: boolean;
  siblingHex: string;
  resultHex?: string;
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
      ) : (
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
      )}
      <span className="ml-auto hidden font-mono text-[11px] text-chalk/30 md:inline">
        sib {siblingHex.slice(0, 12)}…
      </span>
    </div>
  );
}
