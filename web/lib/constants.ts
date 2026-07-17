/**
 * constants.ts — the on-chain and off-chain addresses the whole app pivots on,
 * plus hardcoded metadata for the three fixtures the demo story uses. All
 * verified ground truth (spike/NOTES.md).
 */

import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("J5ip9R8afPE8wB6EPXFBaXBpr78EtQfQeG3nNr681bBN");
export const USDC_DEV_MINT = new PublicKey("Cx9Y63x8YN7x9UMFba4B1HdmmmH9QVZbvTZgz7k8kspy");
export const TXLINE_PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
export const USDC_DECIMALS = 6;

export const RELAY_URL = process.env.NEXT_PUBLIC_RELAY_URL ?? "http://localhost:8787";
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";

export const DEMO_FIXTURE_ID = 18241006;

/** A match is treated as "live" from kickoff until this long after. */
export const LIVE_WINDOW_MS = 3.5 * 3600_000;

export function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}
export function explorerAddress(addr: string): string {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}

export interface KnownFixture {
  fixtureId: number;
  home: string;
  away: string;
  /** Kickoff, epoch ms (real match time — the demo fixture's is in the past). */
  kickoffMs: number;
  label: string;
  /** Finished match with a committed recording + live proofs: settles instantly. */
  demo?: boolean;
  finalScore?: string;
}

/**
 * The three fixtures the product story runs on. The relay's live fixtures
 * snapshot enriches/extends this at runtime; these are the ones we can name
 * confidently even if TxLINE is unreachable.
 */
export const KNOWN_FIXTURES: Record<number, KnownFixture> = {
  18241006: {
    fixtureId: 18241006,
    home: "England",
    away: "Argentina",
    kickoffMs: 1784142000000, // 2026-07-15 19:00 UTC
    label: "Semi-final (demo)",
    demo: true,
    finalScore: "1–2",
  },
  18257865: {
    fixtureId: 18257865,
    home: "France",
    away: "England",
    kickoffMs: 1784408400000, // 2026-07-18 21:00 UTC
    label: "Third-place match",
  },
  18257739: {
    fixtureId: 18257739,
    home: "Spain",
    away: "Argentina",
    kickoffMs: 1784487600000, // 2026-07-19 19:00 UTC
    label: "World Cup Final",
  },
};

/** epoch_day exactly as TxLINE derives it: floor(ts_ms / 86_400_000). */
export function epochDayFromMs(tsMs: number): number {
  return Math.floor(tsMs / 86_400_000);
}
