/**
 * receiptCache.ts — localStorage persistence for receipts and prop context.
 *
 * Two problems this solves:
 *  - A settled market's account is CLOSED on-chain, so the strategy/stat-keys
 *    that produced a receipt only exist client-side. We stash them per market
 *    whenever we display a market, and the receipt page picks them up.
 *  - Receipts must survive relay/RPC downtime: once decoded, the full receipt
 *    is cached and re-renders offline.
 */

import type { DecodedReceipt } from "./program";

export interface PropContext {
  description: string;
  templateTitle?: string;
  statKeys: number[];
  strategyHex: string;
  fixtureId: number;
  stake: number;
  creatorSide: boolean;
  creator: string;
  taker?: string;
  home?: string;
  away?: string;
}

function store(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function put(key: string, value: unknown): void {
  try {
    store()?.setItem(key, JSON.stringify(value));
  } catch {
    /* quota/private mode — cache is best-effort */
  }
}

function get<T>(key: string): T | null {
  try {
    const raw = store()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function savePropContext(market: string, ctx: PropContext): void {
  put(`cc:prop:${market}`, ctx);
}

export function loadPropContext(market: string): PropContext | null {
  return get<PropContext>(`cc:prop:${market}`);
}

export function saveReceipt(txSig: string, receipt: DecodedReceipt): void {
  put(`cc:receipt:${txSig}`, receipt);
}

export function loadReceipt(txSig: string): DecodedReceipt | null {
  return get<DecodedReceipt>(`cc:receipt:${txSig}`);
}
