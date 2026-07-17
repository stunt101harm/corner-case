"use client";

/**
 * hooks.ts — polling data hooks. Everything here works with no wallet
 * connected (reads go through a bare-connection Anchor program or the relay);
 * only useBalances depends on a connected wallet.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { fetchAllMarkets, getProgram, deriveUsdcAta, type MarketWithKey } from "./program";
import { getFixtures, getSettlements } from "./relay";
import type { FixtureMeta, SettlementEntry } from "./types";

export function useProgram() {
  const { connection } = useConnection();
  return useMemo(() => getProgram(connection), [connection]);
}

/** Generic poller: fetch now, refetch on an interval, expose manual refresh. */
function usePolled<T>(fetcher: () => Promise<T>, intervalMs: number): {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const d = await fetcherRef.current();
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      } catch (err) {
        // Keep the last good data on refresh failure — stale beats blank.
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    const timer = setInterval(run, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, refresh };
}

export function useMarkets(intervalMs = 15_000): {
  markets: MarketWithKey[] | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
} {
  const program = useProgram();
  const { data, error, loading, refresh } = usePolled(() => fetchAllMarkets(program), intervalMs);
  return { markets: data, error, loading, refresh };
}

export function useFixtures(intervalMs = 60_000): { fixtures: FixtureMeta[]; refresh: () => void } {
  const { data, refresh } = usePolled(getFixtures, intervalMs);
  return { fixtures: data ?? [], refresh };
}

export function useSettlements(intervalMs = 30_000): {
  settlements: SettlementEntry[];
  refresh: () => void;
} {
  const { data, refresh } = usePolled(getSettlements, intervalMs);
  return { settlements: data ?? [], refresh };
}

export interface Balances {
  sol: number | null;
  usdc: number | null;
}

export function useBalances(intervalMs = 30_000): Balances & { refresh: () => void } {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const key = publicKey?.toBase58() ?? null;

  const fetcher = useCallback(async (): Promise<Balances> => {
    if (!key) return { sol: null, usdc: null };
    const owner = new PublicKey(key);
    const sol = await connection.getBalance(owner);
    let usdc: number | null = null;
    try {
      usdc = Number((await getAccount(connection, deriveUsdcAta(owner))).amount);
    } catch {
      usdc = 0; // no ATA yet — the faucet will create it
    }
    return { sol, usdc };
  }, [connection, key]);

  const { data, refresh } = usePolled(fetcher, intervalMs);
  return { sol: data?.sol ?? null, usdc: data?.usdc ?? null, refresh };
}
