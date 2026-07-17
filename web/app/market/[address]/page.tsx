"use client";

/**
 * /market/[address] — one market: full prop details, the live ticker with a
 * condition tracker, and the "Settle now" button that lets ANYONE (settlement
 * is permissionless) submit TxLINE's Merkle proof for a real devnet
 * settlement. Closed markets fall back to the settlement journal.
 */

// Cloudflare Pages (@cloudflare/next-on-pages) requires dynamic routes to run
// on the edge runtime; the page stays a pure client component.
export const runtime = "edge";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import {
  buildAcceptMarketIx,
  buildCancelMarketIx,
  buildSettleMarketIxs,
  buildSettlePayload,
  deriveUsdcAta,
  fetchMarket,
  sendIxs,
  type MarketAccount,
} from "@/lib/program";
import { useFixtures, useProgram, useSettlements } from "@/lib/hooks";
import { marketView, type MarketView } from "@/lib/marketView";
import { findFinalisedSeq, getProof, getSnapshot } from "@/lib/relay";
import { savePropContext } from "@/lib/receiptCache";
import { humanizeError } from "@/lib/errors";
import { fmtKickoff, fmtUsdc, shortAddr } from "@/lib/format";
import { DEMO_FIXTURE_ID, epochDayFromMs, explorerAddress, explorerTx } from "@/lib/constants";
import { LiveMatch, type TrackerSpec } from "@/components/LiveMatch";
import { StateBadge, FixtureBadge } from "@/components/StateBadge";
import { useToast } from "@/components/Toasts";

export default function MarketPage(): React.ReactNode {
  const params = useParams<{ address: string }>();
  const address = params.address;

  const marketPk = useMemo(() => {
    try {
      return new PublicKey(address);
    } catch {
      return null;
    }
  }, [address]);

  if (!marketPk) {
    return <p className="py-16 text-center text-sm text-card-red">Not a valid market address.</p>;
  }
  return <MarketDetail marketPk={marketPk} />;
}

function MarketDetail({ marketPk }: { marketPk: PublicKey }): React.ReactNode {
  const program = useProgram();
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const { fixtures } = useFixtures();
  const { settlements } = useSettlements();
  const toast = useToast();
  const router = useRouter();

  const [account, setAccount] = useState<MarketAccount | null>(null);
  const [checked, setChecked] = useState(false);
  const [finalSeq, setFinalSeq] = useState<number | null>(null);
  const [busy, setBusy] = useState<null | "accept" | "cancel" | "settle">(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      setAccount(await fetchMarket(program, marketPk));
    } catch {
      /* transient RPC failure — keep last state */
    } finally {
      setChecked(true);
    }
  }, [program, marketPk]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 12_000);
    return () => clearInterval(t);
  }, [reload]);

  const view: MarketView | null = useMemo(
    () => (account ? marketView({ publicKey: marketPk, account }, fixtures) : null),
    [account, marketPk, fixtures],
  );

  // Persist prop context so the receipt can describe the bet after the
  // market account is closed on-chain.
  useEffect(() => {
    if (!view) return;
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
    });
  }, [view]);

  // Finalisation is state-based, never edge-triggered: poll the snapshot and
  // scan ALL records for StatusId 100 (the newest record of a finished match
  // is a StatusId-less "disconnected"). The replay's game_finalised event
  // also feeds this, but a missed event can never strand the settle button.
  const fixtureId = view?.fixtureId;
  useEffect(() => {
    if (fixtureId === undefined) return;
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        const seq = findFinalisedSeq(await getSnapshot(fixtureId));
        if (!cancelled && seq !== null) setFinalSeq((prev) => prev ?? seq);
      } catch {
        /* relay/upstream hiccup — next poll retries */
      }
    };
    void check();
    const t = setInterval(check, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [fixtureId]);

  const journalEntry = settlements.find((s) => s.market === marketPk.toBase58());

  if (!checked) {
    return <p className="py-16 text-center text-sm text-chalk/50">Loading market…</p>;
  }

  if (!account) {
    // Account closed (settled/cancelled/voided) or never existed.
    if (journalEntry) {
      return (
        <div className="mx-auto max-w-xl space-y-4 py-10 text-center">
          <p className="text-3xl">🏁</p>
          <h1 className="text-xl font-bold text-chalk">This market has settled</h1>
          <p className="text-sm text-chalk/60">
            {fmtUsdc(journalEntry.payout)} USDC-dev paid to {shortAddr(journalEntry.winner)}; the
            on-chain account was closed with settlement.
          </p>
          <Link href={`/receipt/${journalEntry.txSig}`} className="btn-primary">
            View the proof receipt →
          </Link>
        </div>
      );
    }
    return (
      <div className="py-16 text-center text-sm text-chalk/60">
        <p>Market not found — it may have been cancelled or voided (accounts close on exit).</p>
        <Link href="/" className="mt-4 inline-block text-turf-400 underline underline-offset-2">
          ← All markets
        </Link>
      </div>
    );
  }

  if (!view) return null;

  const isDemo = view.fixtureId === DEMO_FIXTURE_ID;
  const isLive = view.fixture.status === "live";
  const me = wallet.publicKey?.toBase58();
  const kickoffPassed = Date.now() / 1000 > view.kickoffTs;
  const canAccept = view.stateName === "Open" && !kickoffPassed && me !== view.creator;
  const canCancel = view.stateName === "Open" && me === view.creator;
  const canSettle = view.stateName === "Matched" && finalSeq !== null;

  const tracker: TrackerSpec | null = view.decoded
    ? { decoded: view.decoded, statKeys: view.statKeys, description: view.description }
    : null;

  const requireWallet = (): boolean => {
    if (!wallet.publicKey || !wallet.sendTransaction) {
      setVisible(true);
      return false;
    }
    return true;
  };
  const sender = () => ({
    publicKey: wallet.publicKey as PublicKey,
    sendTransaction: (wallet.sendTransaction as NonNullable<typeof wallet.sendTransaction>).bind(wallet),
  });

  const onAccept = async (): Promise<void> => {
    if (!requireWallet()) return;
    setBusy("accept");
    try {
      try {
        const ata = await getAccount(connection, deriveUsdcAta(wallet.publicKey as PublicKey));
        if (Number(ata.amount) < view.stake) throw new Error("insufficient");
      } catch {
        throw new Error(`You need ${fmtUsdc(view.stake)} USDC-dev to accept — hit Get test funds first.`);
      }
      const ix = await buildAcceptMarketIx(program, { taker: wallet.publicKey as PublicKey, market: marketPk });
      const sig = await sendIxs(connection, sender(), [ix]);
      toast({
        kind: "success",
        text: `Matched! You're on ${view.creatorSide ? "NO" : "YES"}.`,
        link: { href: explorerTx(sig), label: "View on explorer" },
      });
      void reload();
    } catch (err) {
      toast({ kind: "error", text: humanizeError(err) });
    } finally {
      setBusy(null);
    }
  };

  const onCancel = async (): Promise<void> => {
    if (!requireWallet()) return;
    setBusy("cancel");
    try {
      const ix = await buildCancelMarketIx(program, { creator: wallet.publicKey as PublicKey, market: marketPk });
      const sig = await sendIxs(connection, sender(), [ix]);
      toast({
        kind: "success",
        text: "Market cancelled — stake refunded.",
        link: { href: explorerTx(sig), label: "View on explorer" },
      });
      router.push("/");
    } catch (err) {
      toast({ kind: "error", text: humanizeError(err) });
      setBusy(null);
    }
  };

  const onSettle = async (): Promise<void> => {
    if (!requireWallet() || finalSeq === null || !view.taker) return;
    setBusy("settle");
    try {
      // 1. Fetch the Merkle proof for this market's pinned stat keys at the
      //    finalised seq — the proof of the FINAL stats (period 100 leaves).
      const proof = await getProof(view.fixtureId, finalSeq, view.statKeys);
      // 2. Rebuild the exact on-chain payload; epoch day derives from the
      //    proof's own timestamp, exactly like TxLINE derives its PDA.
      const payload = buildSettlePayload(proof);
      const epochDay = epochDayFromMs(proof.summary.updateStats.minTimestamp);
      const ixs = await buildSettleMarketIxs(program, {
        caller: wallet.publicKey as PublicKey,
        market: marketPk,
        creator: new PublicKey(view.creator),
        taker: new PublicKey(view.taker),
        epochDay,
        payload,
      });
      // 3. This wallet — yours — submits the settlement. Permissionless.
      const sig = await sendIxs(connection, sender(), ixs);
      toast({
        kind: "success",
        text: "Settled on devnet with a TxLINE Merkle proof.",
        link: { href: explorerTx(sig), label: "View on explorer" },
      });
      router.push(`/receipt/${sig}`);
    } catch (err) {
      toast({ kind: "error", text: humanizeError(err) });
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/" className="text-sm text-chalk/50 hover:text-chalk">
          ← Markets
        </Link>
        <h1 className="text-xl font-bold text-chalk">{view.title}</h1>
        <StateBadge state={view.stateName} />
        <FixtureBadge status={view.fixture.status} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Prop details */}
        <div className="card space-y-4">
          <div>
            <p className="label">
              {view.fixture.home} v {view.fixture.away}
              {view.fixture.label ? ` · ${view.fixture.label}` : ""}
            </p>
            <p className="mt-2 text-sm text-chalk">
              Creator bet{" "}
              <span className={view.creatorSide ? "font-bold text-turf-300" : "font-bold text-card-red"}>
                {view.creatorSide ? "TRUE" : "FALSE"}
              </span>
              : <span className="font-mono">{view.description}</span>
            </p>
          </div>
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <Info label="Stake / side" value={`${fmtUsdc(view.stake)} USDC-dev`} mono />
            <Info label="Winner takes" value={`${fmtUsdc(view.stake * 2)} USDC-dev`} mono />
            <Info label={`Creator · ${view.creatorSide ? "YES" : "NO"}`} value={shortAddr(view.creator, 6)} mono link={explorerAddress(view.creator)} />
            <Info
              label={`Taker · ${view.creatorSide ? "NO" : "YES"}`}
              value={view.taker ? shortAddr(view.taker, 6) : "waiting for taker"}
              mono={!!view.taker}
              link={view.taker ? explorerAddress(view.taker) : undefined}
            />
            <Info label="Accepts close" value={fmtKickoff(view.kickoffTs * 1000)} />
            <Info label="Epoch day" value={String(view.epochDay)} mono />
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer text-chalk/50 hover:text-chalk">
              Exact bytes stored on-chain (what settles)
            </summary>
            <div className="mt-2 space-y-2">
              <div>
                <p className="label">strategy (borsh NDimensionalStrategy)</p>
                <p className="mono-hex mt-1">{view.strategyHex}</p>
              </div>
              <p>
                <span className="label mr-1.5">stat keys</span>
                <span className="font-mono text-chalk/70">[{view.statKeys.join(", ")}]</span>
              </p>
              <p>
                <span className="label mr-1.5">market PDA</span>
                <a href={explorerAddress(view.pubkey)} target="_blank" rel="noreferrer" className="font-mono text-turf-400 underline underline-offset-2">
                  {shortAddr(view.pubkey, 8)} ↗
                </a>
              </p>
            </div>
          </details>
        </div>

        {/* Actions */}
        <div className="card h-fit space-y-3">
          <p className="label">Actions</p>
          {canAccept && (
            <button className="btn-primary w-full" onClick={onAccept} disabled={busy !== null}>
              {busy === "accept" ? "Accepting…" : `Take ${view.creatorSide ? "NO" : "YES"} · ${fmtUsdc(view.stake)} USDC`}
            </button>
          )}
          {view.stateName === "Open" && kickoffPassed && (
            <p className="text-xs text-chalk/50">Kickoff has passed — accepts are closed.</p>
          )}
          {canCancel && (
            <button className="btn-ghost w-full" onClick={onCancel} disabled={busy !== null}>
              {busy === "cancel" ? "Cancelling…" : "Cancel & refund stake"}
            </button>
          )}
          {view.stateName === "Matched" && (
            <>
              <button className="btn-primary w-full" onClick={onSettle} disabled={!canSettle || busy !== null}>
                {busy === "settle" ? "Submitting proof…" : "Settle now"}
              </button>
              <p className="text-xs leading-relaxed text-chalk/50">
                {canSettle
                  ? `Match finalised at seq ${finalSeq}. Settling fetches TxLINE's Merkle proof for keys [${view.statKeys.join(", ")}] and submits it from YOUR wallet — settlement is permissionless, the proof does all the judging.`
                  : "Enabled at the final whistle: settlement requires the game_finalised (period 100) proof."}
              </p>
            </>
          )}
          {view.stateName === "Open" && !kickoffPassed && !canAccept && (
            <p className="text-xs text-chalk/50">
              This is your market — share this page with someone who disagrees.
            </p>
          )}
        </div>
      </div>

      {/* Live ticker: replay for the demo fixture, live stream during a real
          match. Same component, same event format — that's the point. */}
      {(isDemo || isLive) && (
        <section>
          <p className="label mb-2">
            {isDemo ? "Demo replay — recorded semi-final through the live pipeline" : "Live match"}
          </p>
          <LiveMatch
            fixtureId={view.fixtureId}
            home={view.fixture.home}
            away={view.fixture.away}
            mode={isDemo ? "replay" : "live"}
            replaySpeed={30}
            autoStart={isLive}
            tracker={tracker}
            onFinalised={(seq) => setFinalSeq((prev) => prev ?? seq)}
          />
        </section>
      )}
    </div>
  );
}

function Info({
  label,
  value,
  mono,
  link,
}: {
  label: string;
  value: string;
  mono?: boolean;
  link?: string;
}): React.ReactNode {
  const inner = <span className={mono ? "font-mono text-chalk/90" : "text-chalk/90"}>{value}</span>;
  return (
    <div>
      <p className="label">{label}</p>
      <p className="mt-0.5 text-sm">
        {link ? (
          <a href={link} target="_blank" rel="noreferrer" className="hover:text-turf-300">
            {inner} ↗
          </a>
        ) : (
          inner
        )}
      </p>
    </div>
  );
}
