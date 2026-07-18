/**
 * odds.ts — fetch + parse TxLINE consensus odds via the relay's
 * /api/odds/:fixtureId (a 60s-cached proxy of TxLINE /odds/snapshot).
 *
 * Verified payload shape (live fetch, 2026-07-17, fixture 18257865):
 *
 *   [{ "FixtureId": 18257865, "Ts": 1784339111561,
 *      "Bookmaker": "TXLineStablePriceDemargined", "BookmakerId": 10021,
 *      "SuperOddsType": "1X2_PARTICIPANT_RESULT", "InRunning": false,
 *      "MarketParameters": null, "MarketPeriod": "half=1",
 *      "PriceNames": ["part1", "draw", "part2"],
 *      "Prices": [2495, 2705, 4358],
 *      "Pct": ["40.080", "36.969", "22.946"] }, …]
 *
 *  - Prices are decimal odds × 1000 (2495 → 2.495; 1/2.495 = 40.08% matches Pct).
 *  - Pct is the feed's own implied % — as strings, sometimes "NA", so we always
 *    recompute from Prices instead of trusting it.
 *  - MarketPeriod: null = full match, "half=1" = first half (verified against
 *    the historical /odds/updates feed of the semi-final).
 *  - The devnet feed carries one bookmaker, TXLINE's demargined consensus
 *    ("StablePrice") — exactly the "consensus betting odds" headline product.
 *  - Finished fixtures return [] (verified on 18241006). Empty is a valid
 *    answer everywhere in this module, never an error.
 *
 * Odds are decoration: every function here is total — bad input or a failed
 * fetch yields [] / null, never a throw, so a page can render without them.
 */

import { RELAY_URL } from "./constants";

/** Raw wire entry from /api/odds. Field names mirror the TxLINE API exactly. */
export interface OddsWireEntry {
  FixtureId: number;
  Ts: number;
  Bookmaker: string;
  BookmakerId: number;
  /** "1X2_PARTICIPANT_RESULT" | "OVERUNDER_PARTICIPANT_GOALS" | "ASIANHANDICAP_PARTICIPANT_GOALS" | … */
  SuperOddsType: string;
  InRunning?: boolean;
  /** e.g. "line=1.5" for over/unders; null for 1X2. */
  MarketParameters: string | null;
  /** null = full match, "half=1" = first half. */
  MarketPeriod: string | null;
  PriceNames: string[];
  /** Decimal odds × 1000. */
  Prices: number[];
  /** Feed-supplied implied % strings; may be "NA" — recomputed, never trusted. */
  Pct?: string[];
}

export interface OddsSelection {
  /** "part1" | "draw" | "part2" | "over" | "under" | … */
  selection: string;
  /** Decimal odds (e.g. 2.495). */
  price: number;
  /**
   * Implied probability in [0, 1]: 1/price, then normalized so the market's
   * selections sum to 1 (removes bookmaker overround; the demargined
   * consensus feed already sums to ≈1, so this is a ≤0.1% correction there).
   */
  impliedProb: number;
}

export interface NormalizedMarket {
  /** SuperOddsType verbatim. */
  marketType: string;
  /** null = full match, "half=1" = first half. */
  period: string | null;
  parameters: string | null;
  bookmaker: string;
  ts: number;
  inRunning: boolean;
  selections: OddsSelection[];
}

/** The 1X2 (match result) consensus set the UI shows. */
export interface MatchOdds {
  /** Participant1 wins (home in every fixture this product names). */
  p1: OddsSelection;
  draw: OddsSelection;
  /** Participant2 wins. */
  p2: OddsSelection;
  period: string | null;
  ts: number;
  inRunning: boolean;
}

const MATCH_RESULT_TYPE = "1X2_PARTICIPANT_RESULT";

/**
 * Parse raw wire entries into normalized markets. Defensive at every step:
 * anything that is not exactly the verified shape is skipped, and a non-array
 * input yields [] — this function must never take a page down.
 */
export function normalizeOdds(raw: unknown): NormalizedMarket[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedMarket[] = [];
  for (const item of raw as Partial<OddsWireEntry>[]) {
    if (!item || typeof item !== "object") continue;
    const { PriceNames, Prices, SuperOddsType } = item;
    if (typeof SuperOddsType !== "string") continue;
    if (!Array.isArray(PriceNames) || !Array.isArray(Prices)) continue;
    if (PriceNames.length === 0 || PriceNames.length !== Prices.length) continue;

    // Decimal odds are Prices/1000 and must be ≥ 1 (implied prob ≤ 1); a
    // malformed price invalidates the whole market — a partial 1X2 set would
    // mis-normalize the rest.
    const prices = Prices.map((p) => (typeof p === "number" && Number.isFinite(p) ? p / 1000 : NaN));
    if (prices.some((p) => !Number.isFinite(p) || p < 1)) continue;

    const rawProbs = prices.map((p) => 1 / p);
    const overround = rawProbs.reduce((a, b) => a + b, 0);
    if (!(overround > 0)) continue;

    out.push({
      marketType: SuperOddsType,
      period: typeof item.MarketPeriod === "string" ? item.MarketPeriod : null,
      parameters: typeof item.MarketParameters === "string" ? item.MarketParameters : null,
      bookmaker: typeof item.Bookmaker === "string" ? item.Bookmaker : "unknown",
      ts: typeof item.Ts === "number" ? item.Ts : 0,
      inRunning: item.InRunning === true,
      selections: PriceNames.map((name, i) => ({
        selection: String(name),
        price: prices[i],
        // Normalize the set to sum to 1 — implied probs, overround removed.
        impliedProb: rawProbs[i] / overround,
      })),
    });
  }
  return out;
}

/**
 * Pick the 1X2 consensus set to display: prefer the full-match market
 * (period null), fall back to a period market ("half=1") — the strip labels
 * the period so a first-half price is never passed off as full-time. Ties
 * break to the freshest Ts. Returns null when no complete 1X2 set exists.
 */
export function extractMatchOdds(markets: NormalizedMarket[]): MatchOdds | null {
  let best: MatchOdds | null = null;
  let bestFull = false;
  for (const m of markets) {
    if (m.marketType !== MATCH_RESULT_TYPE) continue;
    const p1 = m.selections.find((s) => s.selection === "part1");
    const draw = m.selections.find((s) => s.selection === "draw");
    const p2 = m.selections.find((s) => s.selection === "part2");
    if (!p1 || !draw || !p2) continue;
    const isFull = m.period === null;
    const better =
      best === null || (isFull && !bestFull) || (isFull === bestFull && m.ts > best.ts);
    if (better) {
      best = { p1, draw, p2, period: m.period, ts: m.ts, inRunning: m.inRunning };
      bestFull = isFull;
    }
  }
  return best;
}

/** "half=1" → "1st half"; null (full match) → null; unknown periods verbatim. */
export function periodLabel(period: string | null): string | null {
  if (period === null) return null;
  if (period === "half=1") return "1st half";
  if (period === "half=2") return "2nd half";
  return period;
}

/** "40%" — whole percents; the strip is a glance, not a pricing terminal. */
export function fmtProb(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/** Decimal odds for tooltips, e.g. "2.50". */
export function fmtPrice(price: number): string {
  return price.toFixed(2);
}

// -- fetch ------------------------------------------------------------------

/** Client-side memo (fixtureId → in-flight/settled fetch) matching the relay's 60s cache. */
const memo = new Map<number, { at: number; promise: Promise<NormalizedMarket[]> }>();
const MEMO_MS = 60_000;

/**
 * Fetch + parse the consensus odds for a fixture. Never throws and never
 * rejects — any failure (relay down, non-JSON, bad shape) resolves to [].
 */
export function fetchOdds(fixtureId: number): Promise<NormalizedMarket[]> {
  const cached = memo.get(fixtureId);
  if (cached && Date.now() - cached.at < MEMO_MS) return cached.promise;
  const promise = (async (): Promise<NormalizedMarket[]> => {
    try {
      const res = await fetch(`${RELAY_URL}/api/odds/${fixtureId}`, { cache: "no-store" });
      if (!res.ok) return [];
      return normalizeOdds((await res.json()) as unknown);
    } catch {
      return [];
    }
  })();
  memo.set(fixtureId, { at: Date.now(), promise });
  return promise;
}
