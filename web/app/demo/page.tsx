"use client";

/**
 * /demo — judge demo mode as a first-class page. The tournament is over;
 * this is the full product loop on a finished match whose TxLINE proofs are
 * live on devnet: replay the recording, bet on it, settle it for real.
 */

import Link from "next/link";
import { useMemo } from "react";
import { useFixtures, useMarkets } from "@/lib/hooks";
import { marketView } from "@/lib/marketView";
import { fixtureDisplay } from "@/lib/fixtures";
import { DEMO_FIXTURE_ID } from "@/lib/constants";
import { LiveMatch } from "@/components/LiveMatch";
import { MarketCard } from "@/components/MarketCard";

const STEPS = [
  {
    title: "Get test funds",
    body: "Connect a wallet (Phantom/Solflare on devnet) and hit “Get test funds” in the header — devnet SOL and 1000 USDC-dev, in one click.",
  },
  {
    title: "Bet on the demo match",
    body: "Create a market on England v Argentina below (or accept an open one with a second wallet). The match is finished, so accepts stay open for 24h from creation.",
  },
  {
    title: "Run the replay",
    body: "Watch the real recorded match replay at 30× through the exact live pipeline — ticker, score, and your condition tracker filling in.",
  },
  {
    title: "Settle it yourself",
    body: "On the market page hit “Settle now”: YOUR wallet fetches TxLINE's Merkle proof and submits a real devnet settlement. The receipt lets you re-verify every hash in your browser.",
  },
] as const;

export default function DemoPage(): React.ReactNode {
  const { markets, refresh } = useMarkets();
  const { fixtures } = useFixtures();
  const fixture = fixtureDisplay(DEMO_FIXTURE_ID, fixtures);

  const demoMarkets = useMemo(
    () =>
      (markets ?? [])
        .map((m) => marketView(m, fixtures))
        .filter((v) => v.fixtureId === DEMO_FIXTURE_ID)
        .sort((a, b) => b.createdAt - a.createdAt),
    [markets, fixtures],
  );

  return (
    <div className="space-y-8">
      <section>
        <p className="label text-turf-400">Judge demo mode</p>
        <h1 className="mt-1 text-2xl font-bold text-chalk">
          The whole product on a finished match — for real
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-chalk/70">
          England v Argentina (semi-final, 1–2) is finished, its final stats are Merkle-committed
          on devnet, and TxLINE serves proofs for them right now. That means markets on this
          fixture settle <em>instantly</em> — and every settlement you trigger here is a real
          on-chain transaction, not a simulation.
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((step, i) => (
          <div key={step.title} className="card">
            <p className="font-mono text-2xl font-bold text-turf-500">{i + 1}</p>
            <h3 className="mt-1 text-sm font-bold text-chalk">{step.title}</h3>
            <p className="mt-1 text-xs leading-relaxed text-chalk/60">{step.body}</p>
          </div>
        ))}
      </section>

      <section>
        <p className="label mb-2">The demo match — recorded stream, live pipeline</p>
        <LiveMatch
          fixtureId={DEMO_FIXTURE_ID}
          home={fixture.home}
          away={fixture.away}
          mode="replay"
          replaySpeed={30}
        />
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-bold text-chalk">Markets on the demo fixture</h2>
          <Link href={`/new?fixture=${DEMO_FIXTURE_ID}`} className="btn-primary">
            Create a demo market
          </Link>
        </div>
        {demoMarkets.length === 0 ? (
          <p className="card border-dashed py-8 text-center text-sm text-chalk/50">
            No demo markets yet — create one above (it settles the moment it&apos;s matched).
          </p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {demoMarkets.map((v) => (
              <MarketCard key={v.pubkey} view={v} onChanged={refresh} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
