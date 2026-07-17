"use client";

/**
 * / — all markets, grouped by fixture, plus settled markets from the keeper's
 * settlement journal (their on-chain accounts are closed). Fully readable
 * with no wallet connected.
 */

import Link from "next/link";
import { useMemo } from "react";
import { useFixtures, useMarkets, useSettlements } from "@/lib/hooks";
import { marketView, type MarketView } from "@/lib/marketView";
import { anyLiveOrUpcoming, fixtureDisplay } from "@/lib/fixtures";
import { fmtKickoff, fmtUsdc, shortAddr } from "@/lib/format";
import { statKeyName } from "@/lib/strategy";
import { DemoBanner } from "@/components/DemoBanner";
import { MarketCard } from "@/components/MarketCard";
import { FixtureBadge } from "@/components/StateBadge";

export default function MarketsPage(): React.ReactNode {
  const { markets, loading, error, refresh } = useMarkets();
  const { fixtures } = useFixtures();
  const { settlements } = useSettlements();

  const groups = useMemo(() => {
    const views = (markets ?? []).map((m) => marketView(m, fixtures));
    const byFixture = new Map<number, MarketView[]>();
    for (const v of views) {
      const list = byFixture.get(v.fixtureId) ?? [];
      list.push(v);
      byFixture.set(v.fixtureId, list);
    }
    // Newest-created first inside a group; groups by kickoff, demo last.
    for (const list of byFixture.values()) list.sort((a, b) => b.createdAt - a.createdAt);
    return [...byFixture.entries()]
      .map(([fixtureId, list]) => ({ fixture: fixtureDisplay(fixtureId, fixtures), list }))
      .sort((a, b) => {
        if ((a.fixture.status === "demo") !== (b.fixture.status === "demo")) {
          return a.fixture.status === "demo" ? 1 : -1;
        }
        return a.fixture.kickoffMs - b.fixture.kickoffMs;
      });
  }, [markets, fixtures]);

  const showDemoBanner = !anyLiveOrUpcoming(fixtures);

  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-2xl font-bold text-chalk">
          Prop bets settled by <span className="text-turf-400">Merkle proofs</span>
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-chalk/60">
          Two wallets stake USDC-dev on a provable World Cup stat. The exact TxLINE validation
          strategy is stored on-chain at creation — what you sign is what settles. No oracle
          wallet, no bookie, no admin key.
        </p>
      </section>

      {showDemoBanner && <DemoBanner />}

      {loading && !markets && (
        <p className="py-8 text-center text-sm text-chalk/50">Loading markets from devnet…</p>
      )}
      {error && !markets && (
        <p className="py-8 text-center text-sm text-card-red">Could not reach devnet: {error}</p>
      )}

      {markets && groups.length === 0 && (
        <div className="card flex flex-col items-center gap-3 border-dashed py-14 text-center">
          <p className="text-3xl">🚩</p>
          <h2 className="text-lg font-semibold text-chalk">No open markets right now</h2>
          <p className="max-w-md text-sm text-chalk/60">
            Be the first: pick a prop like &ldquo;total corners over 9.5&rdquo;, stake USDC-dev,
            and let another fan take the other side.
          </p>
          <div className="mt-2 flex gap-2">
            <Link href="/new" className="btn-primary">
              Create a market
            </Link>
            <Link href="/demo" className="btn-ghost">
              Run the demo
            </Link>
          </div>
        </div>
      )}

      {groups.map(({ fixture, list }) => (
        <section key={fixture.fixtureId}>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-bold text-chalk">
              {fixture.home} <span className="text-chalk/40">v</span> {fixture.away}
            </h2>
            <FixtureBadge status={fixture.status} />
            <span className="text-xs text-chalk/50">
              {fixture.label ? `${fixture.label} · ` : ""}
              {fixture.status === "demo" && fixture.finalScore
                ? `finished ${fixture.finalScore}`
                : fmtKickoff(fixture.kickoffMs)}
            </span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((v) => (
              <MarketCard key={v.pubkey} view={v} onChanged={refresh} />
            ))}
          </div>
        </section>
      ))}

      {settlements.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-bold text-chalk">Settled markets</h2>
          <p className="mb-3 text-xs text-chalk/50">
            Settled markets close their on-chain accounts (rent back to the creator) — these live
            on in the settlement journal, each with a full proof receipt.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {settlements.map((s) => {
              const f = fixtureDisplay(s.fixtureId, fixtures);
              return (
                <Link
                  key={s.txSig}
                  href={`/receipt/${s.txSig}`}
                  className="card block transition-colors hover:border-turf-600/60"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold text-chalk">
                      {f.home} v {f.away}
                    </p>
                    <span className="rounded-full border border-chalk/30 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-chalk/60">
                      Settled
                    </span>
                  </div>
                  {s.statKeys && s.statKeys.length > 0 && (
                    <p className="mt-1 font-mono text-xs text-chalk/50">
                      proven: {s.statKeys.map((k) => statKeyName(k, f.home, f.away)).join(", ")}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-chalk/60">
                    <span className="text-turf-300">{fmtUsdc(s.payout)} USDC</span> →{" "}
                    {shortAddr(s.winner)}
                    {s.predicateTrue !== undefined && (
                      <span> · predicate {s.predicateTrue ? "TRUE" : "FALSE"}</span>
                    )}
                  </p>
                  <p className="mt-2 text-xs text-turf-400">View receipt →</p>
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
