# ⚽ Corner Case

**Trustless P2P prop bets on any provable World Cup stat — settled by Merkle proof, not by trust.**

Built for the [TxLINE World Cup Hackathon](https://txline.txodds.com/documentation/worldcup) (Superteam Earn, July 2026).

## What it does

Two fans stake USDC against each other on props like *"total corners > 9"*, *"zero red cards in the second half"*, or *"Argentina out-corners France"*. The market account stores the exact TxLINE `validateStatV2` strategy at creation — **what you sign is what settles**. When the match finalises, a permissionless keeper submits TxLINE's Merkle proofs and the escrow program CPIs into TxLINE's on-chain validation program: payout is a deterministic pure function of cryptographically attested match data.

- 🔮 **No oracle wallet** — settlement requires a valid Merkle proof against TxLINE's on-chain daily roots
- 🧾 **Verifiable receipts** — every settlement shows the full proof chain (stat leaf → event root → subtree → main tree → on-chain PDA) and re-verifies it in your browser
- 🛡️ **Custom check gates** — kickoff deadline, finality gate, and seq-monotonicity checks, each documented with the failure it prevents

## Architecture

Three components (see [PLAN.md](PLAN.md) for the full implementation plan):

1. **Anchor program (devnet)** — `create_market` · `accept_market` · `settle_market` (CPI → `validateStatV2`) · `cancel/void`
2. **Keeper (TypeScript)** — TxLINE auth, fixture sync, SSE scores consumer, proof fetcher, auto-settlement, replay mode
3. **Frontend (Next.js)** — market builder, open markets, live match view with SSE ticker, settlement receipt UI

## Live

- **App:** https://corner-case.pages.dev
- **Relay API:** https://corner-case-relay.h-dhaliwal2250.workers.dev
- **Program (devnet):** [`J5ip9R8afPE8wB6EPXFBaXBpr78EtQfQeG3nNr681bBN`](https://explorer.solana.com/address/J5ip9R8afPE8wB6EPXFBaXBpr78EtQfQeG3nNr681bBN?cluster=devnet)

🚧 Hackathon build — deadline July 19, 2026 23:59 UTC. Progress in the [issues](../../issues).

## License

Apache-2.0
