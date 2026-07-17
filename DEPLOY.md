# Deployment

## Live

| Piece | Where |
|---|---|
| Program (devnet) | `J5ip9R8afPE8wB6EPXFBaXBpr78EtQfQeG3nNr681bBN` |
| Relay API | https://corner-case-relay.h-dhaliwal2250.workers.dev (Cloudflare Worker `corner-case-relay`) |
| Web app | https://corner-case.pages.dev (Cloudflare Pages `corner-case`) |

## Worker (`worker/`)

```bash
cd worker && npx wrangler deploy
```
- KV namespace `KV` (`9741c1bb6dc249ce8774278439ec47ab`): fixtures cache, guest JWT, faucet rate limits, settlements journal.
- Secrets: `TXLINE_API_TOKEN`, `FAUCET_KEYPAIR` (burner `3Nsnfaow4ihMjgDq25KALAQgKJR6c1ata4ZN5xx3iiBs` — holds the USDC-dev stash + SOL; **top up SOL before Jul 20**, each judge drip = 0.02 SOL + 1000 USDC-dev), `SYNC_TOKEN` (mirrors `RELAY_SYNC_TOKEN` in repo `.env`).
- `RPC_URL` var = MagicBlock devnet RPC — Cloudflare egress IPs are 403-blocked by `api.devnet.solana.com`. A keyed Helius devnet URL (as a secret) would be sturdier.
- The recording ships inside the Worker bundle; `/api/replay/18241006` needs no storage.

## Pages (`web/`)

```bash
cd web \
  && NEXT_PUBLIC_RELAY_URL=https://corner-case-relay.h-dhaliwal2250.workers.dev \
     NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com \
     npx next-on-pages \
  && npx wrangler pages deploy --branch main --commit-dirty=true
```
(`NEXT_PUBLIC_*` are build-time. next-on-pages pinned at 1.13.12 for Next 14.2.)

## Local processes (this Mac, match days)

- Recorder: `cd keeper && npx tsx src/record.ts 18143850 18257865 18257739`
- Settle-watch: `cd keeper && npx tsx src/settle.ts`
- After any local settlement: `node scripts/sync_settlements.mjs` pushes the journal to the Worker.

## Post-deploy checklist (verified 2026-07-18)

- [x] `/` markets + settled section render (no wallet)
- [x] `/demo` replay runs against the Worker
- [x] Receipt renders; re-verify recomputes base-key legs (11 hashes ✓) and labels aggregation legs as on-chain-verified
- [x] Faucet drips 0.02 SOL + 1000 USDC-dev; repeat call 429s
- [x] Settlements journal synced (1 entry)
