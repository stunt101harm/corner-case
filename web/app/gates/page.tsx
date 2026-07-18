"use client";

/**
 * /gates — "Try to cheat". Three real adversarial settle_market transactions,
 * fired from the judge's own wallet at real Matched devnet markets, each
 * rejected on-chain by a different check gate. The rejections are real,
 * inspectable, failed transactions — that's the product thesis you can touch.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { PublicKey } from "@solana/web3.js";
import {
  buildSettleMarketIxs,
  buildSettlePayload,
  fetchMarket,
  sendIxs,
  type MarketAccount,
} from "@/lib/program";
import {
  ATTACKS,
  GATES,
  README_GATES_URL,
  fireAttack,
  type AttackResult,
  type AttackSpec,
} from "@/lib/attacks";
import { useProgram, useSettlements } from "@/lib/hooks";
import { findFinalisedSeq, getProof, getSnapshot } from "@/lib/relay";
import { humanizeError } from "@/lib/errors";
import { shortAddr } from "@/lib/format";
import { epochDayFromMs, explorerAddress, explorerTx } from "@/lib/constants";
import { useToast } from "@/components/Toasts";
import type { SettlementEntry } from "@/lib/types";

export default function GatesPage(): React.ReactNode {
  return (
    <div className="space-y-8">
      <section>
        <p className="label text-turf-400">Adversarial demo</p>
        <h1 className="mt-1 text-2xl font-bold text-chalk">
          Go ahead. <span className="text-turf-400">Try to cheat.</span>
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-chalk/70">
          Settlement here is <strong className="text-chalk">permissionless</strong> — no oracle
          wallet, no admin key, no allow-list. Anyone can settle any market, and the reason that
          is safe is the five check gates the program runs on every settle. To prove it, we seeded
          three real matched markets and armed three real attacks against them. Connect a wallet
          and fire one: <em>your</em> wallet signs a real{" "}
          <code className="rounded bg-pitch-800 px-1 py-0.5 font-mono text-xs text-turf-300">
            settle_market
          </code>{" "}
          transaction with a genuinely valid TxLINE Merkle proof — just the <em>wrong</em> one —
          and watch the program reject it <strong className="text-chalk">on-chain</strong>. The
          failed transaction lands on devnet anyway, so you can open it in the explorer and read
          the gate that stopped you.
        </p>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        {ATTACKS.map((attack) => (
          <AttackCard key={attack.id} attack={attack} />
        ))}
      </section>

      <GatesTable />
    </div>
  );
}

// ---------------------------------------------------------------------------
// One attack card
// ---------------------------------------------------------------------------

type TargetState =
  | { kind: "loading" }
  | { kind: "matched"; account: MarketAccount }
  | { kind: "gone"; receipt: SettlementEntry | null }
  | { kind: "error" };

function AttackCard({ attack }: { attack: AttackSpec }): React.ReactNode {
  const program = useProgram();
  const { connection } = useConnection();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const { settlements } = useSettlements();
  const toast = useToast();
  const router = useRouter();

  const [target, setTarget] = useState<TargetState>({ kind: "loading" });
  const [result, setResult] = useState<AttackResult | null>(null);
  const [busy, setBusy] = useState<null | "attack" | "honest">(null);

  const targetStr = attack.target.toBase58();
  const receiptFor = useCallback(
    (): SettlementEntry | null => settlements.find((s) => s.market === targetStr) ?? null,
    [settlements, targetStr],
  );

  const loadTarget = useCallback(async (): Promise<void> => {
    try {
      const account = await fetchMarket(program, attack.target);
      if (account) {
        setTarget({ kind: "matched", account });
      } else {
        // Account closed — someone honestly settled it (only possible for
        // cards 1 and 2). Find its receipt in the settlement journal.
        setTarget({ kind: "gone", receipt: receiptFor() });
      }
    } catch {
      setTarget((prev) => (prev.kind === "matched" ? prev : { kind: "error" }));
    }
  }, [program, attack.target, receiptFor]);

  useEffect(() => {
    void loadTarget();
  }, [loadTarget]);

  // Keep the "gone" receipt fresh once the journal poller catches up.
  useEffect(() => {
    setTarget((prev) => (prev.kind === "gone" && !prev.receipt ? { kind: "gone", receipt: receiptFor() } : prev));
  }, [receiptFor]);

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

  const onAttack = async (): Promise<void> => {
    if (!requireWallet()) return;
    setBusy("attack");
    setResult(null);
    try {
      const res = await fireAttack(connection, sender(), program, attack);
      setResult(res);
      if (res.errorName === attack.errorName) {
        toast({
          kind: "success",
          text: `Rejected on-chain by gate #${attack.gate} (${res.errorName}). The escrow never moved.`,
          link: { href: explorerTx(res.signature), label: "Open the failed tx" },
        });
      } else {
        toast({
          kind: "info",
          text: res.errorName
            ? `Rejected on-chain (${res.errorName}).`
            : "Transaction landed — open it to inspect the result.",
          link: { href: explorerTx(res.signature), label: "Open the tx" },
        });
      }
    } catch (err) {
      // Wallet/RPC-side failure (e.g. no SOL for fees) — never a program reject.
      toast({ kind: "error", text: humanizeError(err) });
    } finally {
      setBusy(null);
    }
  };

  const onHonest = async (): Promise<void> => {
    if (!requireWallet() || !attack.honestKeys) return;
    if (target.kind !== "matched") return;
    setBusy("honest");
    try {
      const fixtureId = Number(target.account.fixtureId);
      const finalSeq = findFinalisedSeq(await getSnapshot(fixtureId));
      if (finalSeq === null) throw new Error("No game_finalised record yet — try again shortly.");
      const proof = await getProof(fixtureId, finalSeq, attack.honestKeys);
      const payload = buildSettlePayload(proof);
      const ixs = await buildSettleMarketIxs(program, {
        caller: wallet.publicKey as PublicKey,
        market: attack.target,
        creator: target.account.creator,
        taker: target.account.taker,
        epochDay: epochDayFromMs(proof.summary.updateStats.minTimestamp),
        payload,
      });
      const sig = await sendIxs(connection, sender(), ixs);
      toast({
        kind: "success",
        text: "Settled honestly with the RIGHT proof — the gates only ever block the wrong one.",
        link: { href: explorerTx(sig), label: "View on explorer" },
      });
      router.push(`/receipt/${sig}`);
    } catch (err) {
      toast({ kind: "error", text: humanizeError(err) });
      setBusy(null);
    }
  };

  const caught = result?.errorName === attack.errorName;

  return (
    <div className="card flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="label text-chalk/40">Attack {ATTACKS.indexOf(attack) + 1}</p>
          <h3 className="text-lg font-bold text-chalk">{attack.title}</h3>
        </div>
        <span className="shrink-0 rounded-full border border-pitch-500 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-chalk/60">
          Gate #{attack.gate}
        </span>
      </div>

      <p className="text-sm leading-relaxed text-chalk/75">{attack.what}</p>
      <div className="rounded-lg border border-card-red/30 bg-card-red/5 px-3 py-2">
        <p className="label text-card-red/80">If it worked</p>
        <p className="mt-0.5 text-xs leading-relaxed text-chalk/70">{attack.why}</p>
      </div>

      <p className="text-xs text-chalk/45">
        Target ·{" "}
        <a
          href={explorerAddress(targetStr)}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-turf-400 underline underline-offset-2 hover:text-turf-300"
        >
          {shortAddr(targetStr, 6)} ↗
        </a>
        {target.kind === "matched" && <span className="ml-1 text-chalk/40">· Matched</span>}
      </p>

      {/* Target 3 can never settle — the honest counterpoint doesn't exist. */}
      {!attack.honestlySettleable && (
        <p className="rounded-lg border border-pitch-600/60 bg-pitch-800/50 px-3 py-2 text-xs leading-relaxed text-chalk/60">
          No valid proof for fixture 99999901 can ever be produced, so <em>nobody</em> — not even
          an honest settler — can close this market. Its escrow is recoverable only via the
          permissionless <strong className="text-chalk/80">void</strong> hatch (both stakes home,
          6h past kickoff). Funds can never strand.
        </p>
      )}

      <div className="mt-auto space-y-2 pt-1">
        {target.kind === "gone" ? (
          <div className="rounded-lg border border-turf-500/40 bg-turf-500/5 px-3 py-2 text-xs leading-relaxed text-chalk/75">
            Settled by a previous visitor — the honest proof worked, of course. The attack target
            is gone because someone brought the <em>right</em> proof.
            {target.receipt && (
              <Link
                href={`/receipt/${target.receipt.txSig}`}
                className="mt-1 block text-turf-400 underline underline-offset-2 hover:text-turf-300"
              >
                See its proof receipt →
              </Link>
            )}
          </div>
        ) : (
          <>
            <button
              className="btn-primary w-full"
              onClick={onAttack}
              disabled={busy !== null || target.kind === "loading"}
            >
              {busy === "attack" ? "Firing on-chain…" : wallet.publicKey ? "Attack" : "Connect wallet to attack"}
            </button>

            {attack.honestlySettleable && target.kind === "matched" && (
              <button
                className="btn-ghost w-full"
                onClick={onHonest}
                disabled={busy !== null}
                title="Settle this market legitimately with the correct proof"
              >
                {busy === "honest" ? "Settling honestly…" : "Now settle it honestly"}
              </button>
            )}
          </>
        )}

        {result && <AttackVerdict attack={attack} result={result} caught={caught} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The on-chain rejection, surfaced
// ---------------------------------------------------------------------------

function AttackVerdict({
  attack,
  result,
  caught,
}: {
  attack: AttackSpec;
  result: AttackResult;
  caught: boolean;
}): React.ReactNode {
  return (
    <div className="rounded-lg border border-turf-500/50 bg-pitch-800/70 p-3 text-xs">
      <p className="font-semibold text-turf-300">
        {caught ? "✋ Rejected on-chain" : result.errorName ? "Rejected on-chain" : "Landed on-chain"}
      </p>
      {result.errorName && (
        <p className="mt-1">
          <span className="font-mono text-sm font-bold text-card-red">{result.errorName}</span>
          {result.gate && <span className="ml-1.5 text-chalk/50">· gate #{result.gate}</span>}
        </p>
      )}
      <p className="mt-1.5 leading-relaxed text-chalk/70">{attack.explanation}</p>
      {result.rawLogLine && (
        <details className="mt-2">
          <summary className="cursor-pointer text-chalk/45 hover:text-chalk">Raw program log</summary>
          <pre className="mono-hex mt-1 whitespace-pre-wrap">{result.rawLogLine}</pre>
        </details>
      )}
      <a
        href={explorerTx(result.signature)}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-block text-turf-400 underline underline-offset-2 hover:text-turf-300"
      >
        Inspect the failed transaction ↗
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reference: all five gates
// ---------------------------------------------------------------------------

function GatesTable(): React.ReactNode {
  return (
    <section className="card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-chalk">The five check gates</h2>
        <a
          href={README_GATES_URL}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-turf-400 underline underline-offset-2 hover:text-turf-300"
        >
          Full write-up in the README ↗
        </a>
      </div>
      <p className="mb-3 max-w-3xl text-xs leading-relaxed text-chalk/55">
        Three of these are what you just fired at. All five run on every permissionless settle;
        together they mean the only thing a settler controls is <em>which valid proof</em> to
        bring, and the program decides the rest.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-pitch-600/60 text-left">
              <th className="py-2 pr-3 font-semibold text-chalk/50">#</th>
              <th className="py-2 pr-3 font-semibold text-chalk/50">Gate</th>
              <th className="py-2 font-semibold text-chalk/50">Prevents</th>
            </tr>
          </thead>
          <tbody>
            {GATES.map((g) => (
              <tr key={g.n} className="border-b border-pitch-700/40 last:border-0">
                <td className="py-2 pr-3 font-mono text-turf-400">{g.n}</td>
                <td className="py-2 pr-3 font-semibold text-chalk/90">{g.name}</td>
                <td className="py-2 text-chalk/65">{g.prevents}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
