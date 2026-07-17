import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";
import { Providers } from "./providers";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "Corner Case — provable prop bets",
  description:
    "Trustless P2P prop bets on World Cup stats, settled by TxLINE Merkle proofs on Solana devnet.",
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Header />
          <main className="mx-auto w-full max-w-6xl px-4 pb-24 pt-6">{children}</main>
          <footer className="border-t border-pitch-700/60 py-6 text-center text-xs text-chalk/40">
            Corner Case · Solana devnet · settled exclusively by TxLINE Merkle proofs — no oracle
            wallet, no bookie, no admin key
          </footer>
        </Providers>
      </body>
    </html>
  );
}
