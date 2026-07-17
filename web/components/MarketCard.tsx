"use client";

/**
 * MarketCard.tsx — one market in the list: decoded prop, stakes, parties,
 * and the one-click Accept. Accepting is the only write here; everything
 * else renders wallet-less.
 */

import Link from "next/link";
import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { getAccount } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { buildAcceptMarketIx, deriveUsdcAta, sendIxs } from "@/lib/program";
import { useProgram } from "@/lib/hooks";
import type { MarketView } from "@/lib/marketView";
import { savePropContext } from "@/lib/receiptCache";
import { humanizeError } from "@/lib/errors";
import { fmtUsdc, shortAddr } from "@/lib/format";
import { explorerTx } from "@/lib/constants";
import { StateBadge } from "./StateBadge";
import { useToast } from "./Toasts";

export function MarketCard({
  view,
  onChanged,
  showFixture = false,
}: {
  view: MarketView;
  onChanged?: () => void;
  showFixture?: boolean;
}): React.ReactNode {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const program = useProgram();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const isCreator = wallet.publicKey?.toBase58() === view.creator;
  const kickoffPassed = Date.now() / 1000 > view.kickoffTs;
  const acceptable = view.stateName === "Open" && !kickoffPassed;

  const onAccept = async (): Promise<void> => {
    if (!wallet.publicKey || !wallet.sendTransaction) {
      setVisible(true);
      return;
    }
    setBusy(true);
    try {
      // Pre-flight the USDC balance so the common failure ("judge has no
      // test funds yet") is a helpful toast, not a wallet simulation error.
      try {
        const ata = await getAccount(connection, deriveUsdcAta(wallet.publicKey));
        if (Number(ata.amount) < view.stake) throw new Error("insufficient");
      } catch {
        throw new Error(`You need ${fmtUsdc(view.stake)} USDC-dev to accept — hit Get test funds first.`);
      }
      const ix = await buildAcceptMarketIx(program, {
        taker: wallet.publicKey,
        market: new PublicKey(view.pubkey),
      });
      const sig = await sendIxs(
        connection,
        { publicKey: wallet.publicKey, sendTransaction: wallet.sendTransaction.bind(wallet) },
        [ix],
      );
      savePropContext(view.pubkey, {
        description: view.description,
        templateTitle: view.template?.title,
        statKeys: view.statKeys,
        strategyHex: view.strategyHex,
        fixtureId: view.fixtureId,
        stake: view.stake,
        creatorSide: view.creatorSide,
        creator: view.creator,
        taker: wallet.publicKey.toBase58(),
        home: view.fixture.home,
        away: view.fixture.away,
      });
      toast({
        kind: "success",
        text: `Accepted — you're on ${view.creatorSide ? "NO" : "YES"} for ${fmtUsdc(view.stake)} USDC-dev.`,
        link: { href: explorerTx(sig), label: "View on explorer" },
      });
      onChanged?.();
    } catch (err) {
      toast({ kind: "error", text: humanizeError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {showFixture && (
            <p className="label mb-0.5">
              {view.fixture.home} v {view.fixture.away}
            </p>
          )}
          <h3 className="font-semibold leading-snug text-chalk">{view.title}</h3>
        </div>
        <StateBadge state={view.stateName} />
      </div>

      <p className="font-mono text-xs text-chalk/60">{view.description}</p>

      <div className="flex items-center gap-4 text-sm">
        <div>
          <span className="label mr-1.5">Stake</span>
          <span className="font-mono text-turf-300">{fmtUsdc(view.stake)} USDC</span>
          <span className="text-chalk/40"> /side</span>
        </div>
        <div className="text-xs text-chalk/60">
          <span className="text-turf-300">{view.creatorSide ? "YES" : "NO"}</span>{" "}
          {shortAddr(view.creator)}
          {view.taker && (
            <>
              {" · "}
              <span className="text-card-red">{view.creatorSide ? "NO" : "YES"}</span>{" "}
              {shortAddr(view.taker)}
            </>
          )}
        </div>
      </div>

      <div className="mt-auto flex items-center gap-2 pt-1">
        {acceptable && !isCreator && (
          <button className="btn-primary h-8 text-xs" onClick={onAccept} disabled={busy}>
            {busy ? "Accepting…" : `Take ${view.creatorSide ? "NO" : "YES"} · ${fmtUsdc(view.stake)} USDC`}
          </button>
        )}
        {view.stateName === "Open" && kickoffPassed && (
          <span className="text-xs text-chalk/40">Kickoff passed — accepts closed</span>
        )}
        <Link
          href={`/market/${view.pubkey}`}
          className="btn-ghost h-8 px-3 text-xs"
          onClick={() =>
            savePropContext(view.pubkey, {
              description: view.description,
              templateTitle: view.template?.title,
              statKeys: view.statKeys,
              strategyHex: view.strategyHex,
              fixtureId: view.fixtureId,
              stake: view.stake,
              creatorSide: view.creatorSide,
              creator: view.creator,
              taker: view.taker ?? undefined,
              home: view.fixture.home,
              away: view.fixture.away,
            })
          }
        >
          View →
        </Link>
      </div>
    </div>
  );
}
