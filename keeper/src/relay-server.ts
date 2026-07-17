/**
 * relay-server.ts — CLI entry for the relay: `npm run relay` / `npx tsx
 * src/relay-server.ts`. Config via env: RELAY_PORT (default 8787), RPC_URL
 * (default devnet), FAUCET_KEYPAIR_PATH (default ~/.config/solana/id.json —
 * the USDC-dev mint authority). TxLINE credentials come from the repo root
 * .env exactly like every other keeper process.
 */

import { startRelay } from "./relay";

startRelay()
  .then(({ port }) => {
    console.log(`[relay] listening on http://localhost:${port}`);
    console.log(
      "[relay] endpoints: /api/fixtures /api/stream /api/replay/:id /api/proof/:id /api/snapshot/:id /api/faucet /api/settlements /api/health",
    );
  })
  .catch((err) => {
    console.error(`[relay] failed to start: ${String(err)}`);
    process.exit(1);
  });

// Never die from a background hiccup (stream reconnects, faucet RPC errors
// surface per-request); log and keep serving — a relay that crashes during
// judging is worse than any single failed request.
process.on("unhandledRejection", (err) => {
  console.error(`[relay] unhandled rejection: ${String(err)}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[relay] uncaught exception: ${String(err)}`);
});
