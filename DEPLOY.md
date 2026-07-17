# Deployment (issue #18)

Three pieces. The program is already live on devnet; the other two need hosts.

## 1. Program — DONE ✅

Deployed to devnet: `J5ip9R8afPE8wB6EPXFBaXBpr78EtQfQeG3nNr681bBN`
(upgrade authority = the local `~/.config/solana/id.json`; keypair backed up in `target/deploy/` — do not delete before the judging window ends).

## 2. Keeper + relay (always-on Node host — Railway or Render)

One service runs `keeper/`: the relay HTTP server (`npm run relay`) plus, during
match hours, the recorder/settle-watch. Judges hit the relay for fixtures,
replay streams, proofs, and the faucet.

**Needs from harm:** a Railway (railway.com, GitHub OAuth) **or** Render
(render.com) account + CLI login. Then:

- Root directory: `keeper/`
- Build: `npm install`
- Start: `npm run relay`
- Env vars:
  - `TXLINE_API_TOKEN` — from repo `.env` (long-lived TxLINE B2B token)
  - `RELAY_PORT` — the host's `$PORT` (Railway/Render inject it; relay reads `RELAY_PORT`, so set `RELAY_PORT=$PORT` or map it)
  - `RPC_URL` — `https://api.devnet.solana.com` (default; a Helius devnet URL avoids public-RPC rate limits if the faucet gets traffic)
  - `FAUCET_KEYPAIR_PATH` — path to a devnet keypair that is the USDC-dev
    mint authority and holds SOL for top-ups. **Do not put the main wallet on
    a host.** Use a dedicated burner: `solana-keygen new -o faucet.json`, fund
    it (`solana transfer <pubkey> 1 --url devnet`), then hand it the toy
    mint's authority: `spl-token authorize Cx9Y63x8YN7x9UMFba4B1HdmmmH9QVZbvTZgz7k8kspy mint <faucet-pubkey> --url devnet`.
    On the host, write the keypair JSON from a secret env var to a file at
    boot and point `FAUCET_KEYPAIR_PATH` at it.
- Persistent disk: not required (settlements journal is best-effort; recordings live on the laptop).

## 3. Frontend (Vercel)

**Needs from harm:** `npx vercel login` (or the Vercel dashboard) on an account.

- Root directory: `web/`
- Framework preset: Next.js (zero config)
- Env vars:
  - `NEXT_PUBLIC_RELAY_URL` — the deployed relay URL from step 2
  - `NEXT_PUBLIC_RPC_URL` — devnet RPC (public or Helius)

## 4. Post-deploy checklist (clean browser, no wallet, no local state)

- [ ] `/` shows markets incl. the pre-seeded open market + settled section
- [ ] `/demo` replay runs (ticker fills, condition tracker moves)
- [ ] Receipt page renders + "Re-verify in this browser" completes
- [ ] Connect fresh wallet → "Get test funds" → balances appear → accept works
- [ ] "Settle now" on a demo-fixture market lands a real devnet settlement
- [ ] Update README with the live URLs
