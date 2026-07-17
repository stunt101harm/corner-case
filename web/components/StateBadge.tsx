import type { MarketStateName } from "@/lib/marketView";
import type { FixtureStatus } from "@/lib/fixtures";

const MARKET_STYLES: Record<MarketStateName, string> = {
  Open: "border-turf-500/60 text-turf-300",
  Matched: "border-sky-400/60 text-sky-300",
  Settled: "border-chalk/30 text-chalk/60",
  Cancelled: "border-chalk/20 text-chalk/40",
  Voided: "border-chalk/20 text-chalk/40",
};

export function StateBadge({ state }: { state: MarketStateName }): React.ReactNode {
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${MARKET_STYLES[state]}`}>
      {state}
    </span>
  );
}

const FIXTURE_STYLES: Record<FixtureStatus, { text: string; cls: string }> = {
  upcoming: { text: "Upcoming", cls: "border-chalk/30 text-chalk/60" },
  live: { text: "● Live", cls: "border-card-red/70 text-card-red" },
  finished: { text: "Full time", cls: "border-chalk/30 text-chalk/60" },
  demo: { text: "Demo · settles instantly", cls: "border-turf-500/60 text-turf-300" },
};

export function FixtureBadge({ status }: { status: FixtureStatus }): React.ReactNode {
  const s = FIXTURE_STYLES[status];
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${s.cls}`}>
      {s.text}
    </span>
  );
}
