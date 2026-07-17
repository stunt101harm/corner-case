"use client";

/**
 * /receipt/[txSig] — the settlement receipt. Everything renders from the
 * transaction itself: the MarketSettled event (logs) and the FULL Merkle
 * proof payload (decoded from the settle instruction data — the tx IS the
 * proof, no relay round-trip needed). Decoded receipts cache to localStorage
 * so they survive relay/RPC downtime.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useConnection } from "@solana/wallet-adapter-react";
import { decodeSettleTx, type DecodedReceipt } from "@/lib/program";
import { useFixtures, useProgram } from "@/lib/hooks";
import { fixtureDisplay } from "@/lib/fixtures";
import { loadPropContext, loadReceipt, saveReceipt, type PropContext } from "@/lib/receiptCache";
import { statKeyName } from "@/lib/strategy";
import { fmtUsdc, shortAddr } from "@/lib/format";
import { explorerTx } from "@/lib/constants";
import { MerkleChain } from "@/components/MerkleChain";

export default function ReceiptPage(): React.ReactNode {
  const params = useParams<{ txSig: string }>();
  const txSig = params.txSig;
  const { connection } = useConnection();
  const program = useProgram();
  const { fixtures } = useFixtures();

  const [receipt, setReceipt] = useState<DecodedReceipt | null>(() => loadReceipt(txSig));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Cache-first, then refresh from chain: a cached receipt renders even
    // with the RPC down; a fresh decode fixes any stale cache.
    void (async () => {
      try {
        const decoded = await decodeSettleTx(connection, program, txSig);
        if (cancelled) return;
        if (decoded) {
          setReceipt(decoded);
          saveReceipt(txSig, decoded);
        } else if (!loadReceipt(txSig)) {
          setError("This transaction exists but carries no Corner Case settlement (or is not confirmed yet).");
        }
      } catch (err) {
        if (!cancelled && !loadReceipt(txSig)) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection, program, txSig]);

  const prop: PropContext | null = useMemo(
    () => (receipt ? loadPropContext(receipt.event.market) : null),
    [receipt],
  );

  if (!receipt) {
    return (
      <div className="py-16 text-center text-sm">
        {error ? (
          <p className="text-card-red">{error}</p>
        ) : (
          <p className="text-chalk/50">Decoding settlement transaction…</p>
        )}
        <Link href="/" className="mt-4 inline-block text-turf-400 underline underline-offset-2">
          ← All markets
        </Link>
      </div>
    );
  }

  const f = fixtureDisplay(receipt.event.fixtureId, fixtures);
  const home = prop?.home ?? f.home;
  const away = prop?.away ?? f.away;
  const yesWon = receipt.event.predicateTrue;
  const provenStats = receipt.payload.stats;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/" className="text-sm text-chalk/50 hover:text-chalk">
          ← Markets
        </Link>
        <h1 className="text-xl font-bold text-chalk">Settlement receipt</h1>
      </div>

      {/* Outcome banner */}
      <div
        className={`card border-2 ${yesWon ? "border-turf-500/70" : "border-card-red/60"} bg-gradient-to-r from-pitch-800 to-pitch-900 p-6`}
      >
        <p className="label">
          {home} v {away} · fixture {receipt.event.fixtureId}
        </p>
        <h2 className="mt-1 text-2xl font-bold text-chalk">
          PROVEN <span className={yesWon ? "text-turf-400" : "text-card-red"}>{yesWon ? "TRUE" : "FALSE"}</span>
          {prop && (
            <span className="ml-2 font-mono text-lg font-normal text-chalk/80">{prop.description}</span>
          )}
        </h2>
        <p className="mt-2 text-sm text-chalk/80">
          {yesWon ? "YES" : "NO"} side wins{" "}
          <span className="font-mono font-bold text-turf-300">
            {fmtUsdc(receipt.event.payout)} USDC-dev
          </span>{" "}
          → {shortAddr(receipt.event.winner, 6)}
        </p>
        <p className="mt-1 font-mono text-xs text-chalk/50">
          final stats: {provenStats.map((s) => `${statKeyName(s.key, home, away)} = ${s.value}`).join(" · ")}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <a href={explorerTx(txSig)} target="_blank" rel="noreferrer" className="text-turf-400 underline underline-offset-2 hover:text-turf-300">
            settlement transaction ↗
          </a>
          <span
            className={`rounded-full border px-2.5 py-0.5 font-semibold uppercase tracking-wider ${
              receipt.txlineCpiPresent ? "border-turf-500/60 text-turf-300" : "border-chalk/30 text-chalk/50"
            }`}
          >
            {receipt.txlineCpiPresent
              ? "✓ TxLINE validateStatV2 ran on-chain in this tx"
              : "TxLINE CPI not visible (inner instructions unavailable)"}
          </span>
        </div>
      </div>

      {/* Fact grid */}
      <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Epoch day" value={String(receipt.epochDay)} />
        <Fact label="Proof timestamp" value={new Date(receipt.event.proofTs).toUTCString()} />
        <Fact
          label="Settled at"
          value={receipt.blockTime ? new Date(receipt.blockTime * 1000).toUTCString() : `slot ${receipt.slot}`}
        />
        <Fact label="Market (closed)" value={shortAddr(receipt.event.market, 6)} />
      </div>

      {/* The proof chain, recomputable in-browser */}
      <MerkleChain
        payload={receipt.payload}
        epochDay={receipt.epochDay}
        txSig={txSig}
        home={home}
        away={away}
      />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }): React.ReactNode {
  return (
    <div className="card py-3">
      <p className="label">{label}</p>
      <p className="mt-0.5 font-mono text-xs text-chalk/90">{value}</p>
    </div>
  );
}
