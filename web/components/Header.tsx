"use client";

/**
 * Header.tsx — brand, nav, live balances and the faucet button. The faucet is
 * deliberately in the header: "Get test funds" is the first thing a judge
 * with an empty wallet needs, on every page.
 */

import Link from "next/link";
import dynamic from "next/dynamic";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useBalances } from "@/lib/hooks";
import { requestFaucet } from "@/lib/relay";
import { humanizeError } from "@/lib/errors";
import { fmtSol, fmtUsdc } from "@/lib/format";
import { explorerTx } from "@/lib/constants";
import { useToast } from "./Toasts";

// The wallet button renders wallet state that only exists client-side;
// SSR'ing it produces hydration mismatches.
const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false },
);

const NAV = [
  { href: "/", label: "Markets" },
  { href: "/new", label: "Create" },
  { href: "/demo", label: "Demo" },
] as const;

export function Header(): React.ReactNode {
  const pathname = usePathname();
  const { publicKey } = useWallet();
  const { sol, usdc, refresh } = useBalances();
  const toast = useToast();
  const [fauceting, setFauceting] = useState(false);

  const onFaucet = async (): Promise<void> => {
    if (!publicKey) return;
    setFauceting(true);
    try {
      const res = await requestFaucet(publicKey.toBase58());
      toast({
        kind: "success",
        text: `Funded: +${res.sol} SOL, +${res.usdc} USDC-dev`,
        link: { href: explorerTx(res.signature), label: "View on explorer" },
      });
      refresh();
    } catch (err) {
      toast({ kind: "error", text: humanizeError(err) });
    } finally {
      setFauceting(false);
    }
  };

  return (
    <header className="sticky top-0 z-40 border-b border-pitch-700/60 bg-pitch-950/90 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4">
        <Link href="/" className="flex items-center gap-2">
          <CornerFlag />
          <span className="text-base font-bold uppercase tracking-widest text-chalk">
            Corner<span className="text-turf-400"> Case</span>
          </span>
        </Link>
        <nav className="ml-2 hidden items-center gap-1 sm:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-md px-3 py-1.5 text-sm ${
                pathname === item.href
                  ? "bg-pitch-700 text-turf-300"
                  : "text-chalk/70 hover:text-chalk"
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {publicKey && (
            <>
              <div className="hidden items-center gap-3 font-mono text-xs text-chalk/80 md:flex">
                <span>{sol === null ? "…" : `${fmtSol(sol)} SOL`}</span>
                <span className="text-turf-400">
                  {usdc === null ? "…" : `${fmtUsdc(usdc)} USDC-dev`}
                </span>
              </div>
              <button className="btn-ghost h-8 px-3 text-xs" onClick={onFaucet} disabled={fauceting}>
                {fauceting ? "Funding…" : "Get test funds"}
              </button>
            </>
          )}
          <WalletMultiButton />
        </div>
      </div>
    </header>
  );
}

/** Tiny corner-flag mark — the app's namesake. */
function CornerFlag(): React.ReactNode {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
      <line x1="4" y1="2" x2="4" y2="18" stroke="#E9F5EC" strokeWidth="1.6" />
      <path d="M4 2 L15 5 L4 8 Z" fill="#2EE07C" />
      <path d="M1 18 A 3 3 0 0 1 7 18 Z" fill="none" stroke="#E9F5EC" strokeWidth="1.2" />
    </svg>
  );
}
