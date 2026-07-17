"use client";

/**
 * providers.tsx — connection + wallet + toast context for the whole app.
 * Reads work with no wallet; the wallet modal only appears on write actions.
 */

import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { RPC_URL } from "@/lib/constants";
import { ToastProvider } from "@/components/Toasts";

export function Providers({ children }: { children: ReactNode }): ReactNode {
  // Explicit adapters give install deep-links when the extension is missing;
  // wallet-standard wallets (including these, when installed) auto-register.
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <ToastProvider>{children}</ToastProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
