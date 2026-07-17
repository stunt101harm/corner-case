/**
 * marketView.ts — fold a raw on-chain Market account into everything the UI
 * shows: decoded predicate, template match, human sentence with real team
 * names, lifecycle state. One decoder for every page.
 */

import { PublicKey } from "@solana/web3.js";
import type { MarketAccount, MarketWithKey } from "./program";
import {
  decodeStrategy,
  describePredicate,
  matchTemplate,
  type DecodedPredicate,
  type PropTemplate,
} from "./strategy";
import { fixtureDisplay, type FixtureDisplay } from "./fixtures";
import { strategyHex } from "./format";
import type { FixtureMeta } from "./types";

export type MarketStateName = "Open" | "Matched" | "Settled" | "Cancelled" | "Voided";

export interface MarketView {
  pubkey: string;
  fixtureId: number;
  fixture: FixtureDisplay;
  stateName: MarketStateName;
  /** Per-side stake, USDC-dev base units. */
  stake: number;
  creator: string;
  /** null until accepted. */
  taker: string | null;
  creatorSide: boolean;
  statKeys: number[];
  strategyBytes: Uint8Array;
  strategyHex: string;
  decoded: DecodedPredicate | null;
  template: PropTemplate | null;
  /** "corners (England) + corners (Argentina) > 9" — or a hex fallback. */
  description: string;
  /** Template title when recognized, else the description. */
  title: string;
  kickoffTs: number;
  epochDay: number;
  createdAt: number;
}

function stateName(state: MarketAccount["state"]): MarketStateName {
  if ("open" in state) return "Open";
  if ("matched" in state) return "Matched";
  if ("settled" in state) return "Settled";
  if ("cancelled" in state) return "Cancelled";
  return "Voided";
}

export function marketView(m: MarketWithKey, metas: FixtureMeta[] = []): MarketView {
  const fixtureId = Number(m.account.fixtureId);
  const fixture = fixtureDisplay(fixtureId, metas);
  const strategyBytes = Uint8Array.from(m.account.strategy);
  const statKeys = [...m.account.statKeys];
  const decoded = decodeStrategy(strategyBytes);
  const template = decoded ? matchTemplate(strategyBytes, statKeys) : null;
  const description = decoded
    ? describePredicate(decoded, statKeys, fixture.home, fixture.away)
    : `custom strategy 0x${strategyHex(strategyBytes).replaceAll(" ", "")}`;
  const takerStr = m.account.taker.toBase58();
  return {
    pubkey: m.publicKey.toBase58(),
    fixtureId,
    fixture,
    stateName: stateName(m.account.state),
    stake: Number(m.account.stake),
    creator: m.account.creator.toBase58(),
    taker: takerStr === PublicKey.default.toBase58() ? null : takerStr,
    creatorSide: m.account.creatorSide,
    statKeys,
    strategyBytes,
    strategyHex: strategyHex(strategyBytes),
    decoded,
    template,
    description,
    title: template?.title ?? (decoded ? describePredicate(decoded, statKeys, fixture.home, fixture.away) : "Custom strategy"),
    kickoffTs: Number(m.account.kickoffTs),
    epochDay: m.account.epochDay,
    createdAt: Number(m.account.createdAt),
  };
}
