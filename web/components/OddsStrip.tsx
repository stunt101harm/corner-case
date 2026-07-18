"use client";

/**
 * OddsStrip — compact "TxLINE consensus" line: the 1X2 implied probabilities
 * for a fixture, so a bettor can eyeball whether a 1:1 stake is +EV against
 * the bookmaker consensus. Renders NOTHING when no odds exist (finished
 * fixtures, relay hiccups, demo fixture) — odds are decoration, and their
 * absence must be silent.
 *
 * With `highlightSide` set (the builder's "Home/Away side wins" templates) it
 * adds one contextual line comparing the consensus to the market's implicit
 * 50% price. That line only ever uses FULL-MATCH odds — quoting a first-half
 * price against a full-time prop would be a lie — while the strip itself will
 * show a period market with an explicit label when that is all TxLINE has.
 */

import { useEffect, useState } from "react";
import {
  extractMatchOdds,
  fetchOdds,
  fmtPrice,
  fmtProb,
  periodLabel,
  type MatchOdds,
} from "@/lib/odds";

const REFRESH_MS = 60_000; // matches the relay-side cache window

export function OddsStrip({
  fixtureId,
  home,
  away,
  highlightSide,
}: {
  fixtureId: number;
  /** Participant1 display name (P1 is home for every fixture we name). */
  home: string;
  /** Participant2 display name. */
  away: string;
  /** "home"/"away" adds the 1:1-vs-consensus context line for win props. */
  highlightSide?: "home" | "away" | null;
}): React.ReactNode {
  const [odds, setOdds] = useState<MatchOdds | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOdds(null); // switching fixtures must not show the old fixture's odds
    const load = async (): Promise<void> => {
      // fetchOdds never rejects — [] on any failure, so no try/catch needed.
      const matchOdds = extractMatchOdds(await fetchOdds(fixtureId));
      if (!cancelled) setOdds(matchOdds);
    };
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [fixtureId]);

  if (!odds) return null; // silent: no data, no strip

  const period = periodLabel(odds.period);
  const cells: { name: string; prob: number; price: number }[] = [
    { name: home, prob: odds.p1.impliedProb, price: odds.p1.price },
    { name: "Draw", prob: odds.draw.impliedProb, price: odds.draw.price },
    { name: away, prob: odds.p2.impliedProb, price: odds.p2.price },
  ];

  // The contextual line compares against full-match win odds only.
  const highlight =
    highlightSide && odds.period === null
      ? { name: highlightSide === "home" ? home : away, sel: highlightSide === "home" ? odds.p1 : odds.p2 }
      : null;

  return (
    <div className="space-y-1">
      <p
        className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-chalk/70"
        title="TXLINE StablePrice consensus (demargined) — implied % from decimal odds, set normalized to 100%"
      >
        <span className="label text-sky-300/80">TxLINE consensus</span>
        {period && <span className="label">· {period}</span>}
        {odds.inRunning && <span className="label text-card-red/80">· in-running</span>}
        {cells.map((c, i) => (
          <span key={c.name + i} className="whitespace-nowrap">
            {i > 0 && <span className="mr-1.5 text-chalk/30">·</span>}
            {c.name} <span className="font-semibold text-chalk">{fmtProb(c.prob)}</span>
            <span className="ml-1 font-mono text-[10px] text-chalk/40">@{fmtPrice(c.price)}</span>
          </span>
        ))}
      </p>
      {highlight && (
        <p className="text-xs text-chalk/50">
          TxLINE consensus implies{" "}
          <span className="font-semibold text-sky-300">{fmtProb(highlight.sel.impliedProb)}</span>{" "}
          {highlight.name} wins — a 1:1 stake pays out as if 50%.
        </p>
      )}
    </div>
  );
}
