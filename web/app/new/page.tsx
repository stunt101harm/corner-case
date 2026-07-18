"use client";

/**
 * /new — the market builder. Fixture picker, five prop templates, YES/NO side
 * toggle, stake — and a pre-signature panel showing the EXACT strategy bytes
 * that will be stored on-chain: what you sign is what settles.
 */

import { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { BN } from "@coral-xyz/anchor";
import { buildCreateMarketIx, sendIxs } from "@/lib/program";
import { useFixtures, useProgram } from "@/lib/hooks";
import {
  TEMPLATES,
  describePredicate,
  templateStrategy,
  type PropTemplate,
} from "@/lib/strategy";
import { fixtureDisplay } from "@/lib/fixtures";
import {
  DEMO_FIXTURE_ID,
  KNOWN_FIXTURES,
  USDC_DECIMALS,
  epochDayFromMs,
  explorerTx,
} from "@/lib/constants";
import { fmtKickoff, strategyHex } from "@/lib/format";
import { savePropContext } from "@/lib/receiptCache";
import { humanizeError } from "@/lib/errors";
import { useToast } from "@/components/Toasts";
import { FixtureBadge } from "@/components/StateBadge";
import { OddsStrip } from "@/components/OddsStrip";

export default function NewMarketPage(): React.ReactNode {
  // useSearchParams requires a Suspense boundary for the static build.
  return (
    <Suspense fallback={null}>
      <Builder />
    </Suspense>
  );
}

function Builder(): React.ReactNode {
  const search = useSearchParams();
  const router = useRouter();
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const program = useProgram();
  const { fixtures } = useFixtures();
  const toast = useToast();

  // Demo fixture first (it always works), real fixtures by kickoff.
  const fixtureIds = Object.values(KNOWN_FIXTURES)
    .sort((a, b) =>
      (a.demo ? 1 : 0) !== (b.demo ? 1 : 0) ? (a.demo ? -1 : 1) : a.kickoffMs - b.kickoffMs,
    )
    .map((f) => f.fixtureId);
  const requested = Number(search.get("fixture"));
  const [fixtureId, setFixtureId] = useState<number>(
    fixtureIds.includes(requested) ? requested : DEMO_FIXTURE_ID,
  );
  const [templateId, setTemplateId] = useState<string>(TEMPLATES[0].id);
  const [side, setSide] = useState<boolean>(true); // true = YES
  const [stakeStr, setStakeStr] = useState("10");
  const [busy, setBusy] = useState(false);

  const fixture = fixtureDisplay(fixtureId, fixtures);
  const template: PropTemplate = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0];
  const strategy = useMemo(() => templateStrategy(template), [template]);
  const sentence = describePredicate(
    { kind: "binary", indexA: template.indexA, indexB: template.indexB, op: template.op, threshold: template.threshold, cmp: template.cmp },
    template.statKeys,
    fixture.home,
    fixture.away,
  );

  const stake = Math.round(Number(stakeStr) * 10 ** USDC_DECIMALS);
  const stakeValid = Number.isFinite(stake) && stake > 0;

  // Demo fixture: the real kickoff is in the past and the program requires a
  // future kickoff — the demo market opens a 24h accept window instead, and
  // settles instantly (once matched) because the match is already finalised.
  const isDemo = fixtureId === DEMO_FIXTURE_ID;
  const kickoffMs = fixture.kickoffMs;
  const kickoffTs = isDemo ? Math.floor(Date.now() / 1000) + 24 * 3600 : Math.floor(kickoffMs / 1000);
  const epochDay = epochDayFromMs(kickoffMs);
  const creatable = isDemo || kickoffMs > Date.now();

  const onCreate = async (): Promise<void> => {
    if (!wallet.publicKey || !wallet.sendTransaction) {
      setVisible(true);
      return;
    }
    if (!stakeValid) {
      toast({ kind: "error", text: "Enter a stake greater than zero." });
      return;
    }
    setBusy(true);
    try {
      const nonce = new BN(Date.now()); // unique per creator per ms — collision-free enough
      const { ix, market } = await buildCreateMarketIx(program, {
        creator: wallet.publicKey,
        nonce,
        fixtureId,
        epochDay,
        kickoffTs,
        creatorSide: side,
        stake: new BN(stake),
        strategy,
        statKeys: template.statKeys,
      });
      const sig = await sendIxs(
        connection,
        { publicKey: wallet.publicKey, sendTransaction: wallet.sendTransaction.bind(wallet) },
        [ix],
      );
      savePropContext(market.toBase58(), {
        description: sentence,
        templateTitle: template.title,
        statKeys: template.statKeys,
        strategyHex: strategyHex(strategy),
        fixtureId,
        stake,
        creatorSide: side,
        creator: wallet.publicKey.toBase58(),
        home: fixture.home,
        away: fixture.away,
      });
      toast({
        kind: "success",
        text: "Market created — waiting for a taker.",
        link: { href: explorerTx(sig), label: "View on explorer" },
      });
      router.push(`/market/${market.toBase58()}`);
    } catch (err) {
      toast({ kind: "error", text: humanizeError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold text-chalk">Create a market</h1>

      {/* Fixture picker */}
      <section>
        <p className="label mb-2">1 · Pick the match</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {fixtureIds.map((id) => {
            const f = fixtureDisplay(id, fixtures);
            const enabled = id === DEMO_FIXTURE_ID || f.kickoffMs > Date.now();
            return (
              <button
                key={id}
                onClick={() => setFixtureId(id)}
                disabled={!enabled}
                className={`card text-left transition-colors disabled:opacity-40 ${
                  fixtureId === id ? "border-turf-500 shadow-glow" : "hover:border-pitch-500"
                }`}
              >
                <p className="font-semibold text-chalk">
                  {f.home} v {f.away}
                </p>
                <p className="mt-1 text-xs text-chalk/50">
                  {f.status === "demo"
                    ? `Demo — finished ${f.finalScore ?? ""}, settles instantly`
                    : enabled
                      ? fmtKickoff(f.kickoffMs)
                      : "Kickoff passed"}
                </p>
                <div className="mt-2">
                  <FixtureBadge status={f.status} />
                </div>
              </button>
            );
          })}
        </div>
        {/* Consensus odds for the selected fixture — silently absent when
            TxLINE has none (demo/finished fixtures). For the win templates it
            adds the 1:1-vs-consensus expected-value context line. */}
        <div className="mt-2">
          <OddsStrip
            fixtureId={fixtureId}
            home={fixture.home}
            away={fixture.away}
            highlightSide={
              template.id === "home-wins" ? "home" : template.id === "away-wins" ? "away" : null
            }
          />
        </div>
      </section>

      {/* Template picker */}
      <section>
        <p className="label mb-2">2 · Pick the prop</p>
        <div className="grid gap-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => setTemplateId(t.id)}
              className={`card flex items-center justify-between py-3 text-left transition-colors ${
                templateId === t.id ? "border-turf-500" : "hover:border-pitch-500"
              }`}
            >
              <span className="font-semibold text-chalk">{t.title}</span>
              <span className="font-mono text-xs text-chalk/50">
                keys [{t.statKeys.join(", ")}]
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* Side + stake */}
      <section className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="label mb-2">3 · Your side</p>
          <div className="flex overflow-hidden rounded-lg border border-pitch-500">
            {([true, false] as const).map((s) => (
              <button
                key={String(s)}
                onClick={() => setSide(s)}
                className={`flex-1 py-2.5 text-sm font-bold transition-colors ${
                  side === s
                    ? s
                      ? "bg-turf-600 text-pitch-950"
                      : "bg-card-red/90 text-pitch-950"
                    : "text-chalk/60 hover:text-chalk"
                }`}
              >
                {s ? "YES — it happens" : "NO — it doesn't"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="label mb-2">4 · Stake (USDC-dev, each side)</p>
          <input
            value={stakeStr}
            onChange={(e) => setStakeStr(e.target.value)}
            inputMode="decimal"
            className="h-10 w-full rounded-lg border border-pitch-500 bg-pitch-900 px-3 font-mono text-chalk outline-none focus:border-turf-500"
          />
        </div>
      </section>

      {/* What you sign is what settles */}
      <section className="card border-turf-600/40">
        <p className="label text-turf-400">What you sign is what settles</p>
        <p className="mt-2 text-sm text-chalk">
          You bet <span className={side ? "font-bold text-turf-300" : "font-bold text-card-red"}>{side ? "TRUE" : "FALSE"}</span>
          : <span className="font-mono">{sentence}</span>
        </p>
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          <div>
            <p className="label">strategy bytes (borsh, stored on-chain)</p>
            <p className="mono-hex mt-1">{strategyHex(strategy)}</p>
          </div>
          <div className="space-y-1.5">
            <p>
              <span className="label mr-1.5">stat keys</span>
              <span className="font-mono text-chalk/70">[{template.statKeys.join(", ")}]</span>
            </p>
            <p>
              <span className="label mr-1.5">epoch day</span>
              <span className="font-mono text-chalk/70">{epochDay}</span>
            </p>
            <p>
              <span className="label mr-1.5">accepts close</span>
              <span className="font-mono text-chalk/70">
                {isDemo ? "24h from creation (demo)" : fmtKickoff(kickoffMs)}
              </span>
            </p>
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-chalk/50">
          Settlement splices these exact bytes into TxLINE&apos;s validateStatV2 against Merkle-proven
          final stats. Nobody — including us — can settle this market any other way.
        </p>
      </section>

      <button className="btn-primary h-11 w-full text-base" onClick={onCreate} disabled={busy || !creatable}>
        {busy
          ? "Creating…"
          : !creatable
            ? "Kickoff passed — pick the demo fixture"
            : wallet.publicKey
              ? `Create market · stake ${stakeValid ? stakeStr : "?"} USDC-dev`
              : "Connect wallet to create"}
      </button>
    </div>
  );
}
