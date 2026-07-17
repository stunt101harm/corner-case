# ⚽ Corner Case

**Trustless P2P prop bets on any provable World Cup stat — settled by Merkle proof, not by trust.**

Built for the TxLINE World Cup Hackathon (Superteam Earn, July 2026).

| | |
|---|---|
| **Live app** | https://corner-case.pages.dev |
| **Relay API** | https://corner-case-relay.h-dhaliwal2250.workers.dev |
| **Program (devnet)** | [`J5ip9R8afPE8wB6EPXFBaXBpr78EtQfQeG3nNr681bBN`](https://explorer.solana.com/address/J5ip9R8afPE8wB6EPXFBaXBpr78EtQfQeG3nNr681bBN?cluster=devnet) |
| **Demo video** | _(link added at submission)_ |
| **Technical doc** | [docs/TECHNICAL.md](docs/TECHNICAL.md) · **TxLINE API feedback:** [FEEDBACK.md](FEEDBACK.md) |

---

## 🧑‍⚖️ Judge quickstart (2 minutes, zero setup)

The World Cup is over while you're reading this — the app doesn't care:

1. **No wallet needed to look around:** open [the app](https://corner-case.pages.dev). You'll see open + settled markets. Click any **View receipt** → hit **"Re-verify in this browser"** and watch your own browser recompute the proof's sha256 chain. That's the product thesis in one button.
2. **Run the demo match:** [Demo page](https://corner-case.pages.dev/demo) → "Run demo match" streams TxLINE's real recorded feed of the England v Argentina semifinal at 30× through the live-match UI.
3. **Bet and settle, yourself:**
   - Install Phantom/Solflare, switch to **devnet**, connect.
   - Hit **"Get test funds"** in the header (drips devnet SOL + USDC-dev).
   - Accept the open pre-seeded market — or create your own on the demo fixture from a template.
   - Hit **"Settle now"**: *your wallet* submits TxLINE's Merkle proof, and *your transaction* runs TxLINE's `validateStatV2` on-chain via CPI to decide the payout. No keeper needed, no permission asked.
4. Zero-effort fallback: [a settled receipt](https://corner-case.pages.dev/receipt/3Hw1MyRoFHN8Rvr5v1EK19CLi24LWJuSe4uJkogv8oAMK32JqYXTzvXbG4yTfAv2osWXQwkwUEWGo14Fvgzq7MLa) from a market that settled on the real semifinal result.

## What it does

Two fans stake USDC-dev against each other on props like *"total corners > 9.5"*, *"no red cards in the second half"*, or *"goals in the first half"*. The market account stores the exact TxLINE `validateStatV2` strategy **and** the ordered stat keys at creation — **what you sign is what settles**. When the match finalises, anyone may settle: the escrow program CPIs into TxLINE's on-chain validation program with the stored strategy and a caller-supplied Merkle proof. Payout is a deterministic pure function of cryptographically attested match data.

- 🔮 **No oracle wallet** — settlement requires a valid Merkle proof against TxLINE's on-chain daily roots; the settle instruction is permissionless
- 🧾 **Verifiable receipts** — every settlement shows the full proof chain and re-verifies the plain-hash legs *in your browser*
- 🛡️ **Five check gates** — each documented with the failure it prevents (below)
- ⚽ **The long tail is the point** — match winners work on any oracle; per-half cards and corner counts are only trustlessly settleable because TxLINE Merkle-izes the whole stat tree

## The five check gates

| # | Gate | Prevents |
|---|---|---|
| 1 | **Kickoff deadline** (accept_market) | taking a side after the match started — betting on known outcomes |
| 2 | **Finality** — every proven leaf must carry `period == 100` (game_finalised) | settling *"no H2 red cards"* as YES at minute 60 with a mid-match proof — [rejected on-chain, live demo](scripts/demo_early_settle.mjs) |
| 3 | **Epoch window** — settle's `epoch_day` ∈ {stored, stored+1} | shopping arbitrary historical daily roots; still tolerates matches finalising past 00:00 UTC |
| 4 | **Fixture binding** — `payload.fixture_summary.fixture_id == market.fixture_id` (the id lives *inside* the proven chain) | settling with a valid proof from a *different* match — some game somewhere always has >9 corners |
| 5 | **Stat-key binding** — market pins its ordered stat keys; proof leaves must match exactly | TxLINE strategies address leaves *by index*, so a valid proof of the wrong stats (goals instead of corners) could otherwise flip the payout |

Settlement reads TxLINE's verdict from **CPI return data with a program-id check** — a valid proof of a FALSE predicate also returns success (it pays the NO side), so "CPI succeeded" is never treated as "predicate true".

## Architecture

```
     TxLINE devnet (fixtures · SSE scores · stat-validation proofs · on-chain daily roots)
        │                                   ▲
        ▼                                   │ CPI: validate_stat_v2 → bool
┌───────────────┐   settle_market    ┌─────────────────────────────┐
│ Keeper (local) │ ─────────────────▶ │  corner_case program (devnet)│
│ record·settle  │                    │  create·accept·settle·      │
└───────────────┘                    │  cancel·void  + 5 gates      │
┌───────────────┐                    └─────────────────────────────┘
│ CF Worker relay│ ◀── fixtures·replay·proofs·faucet·settlements ──┐
└───────────────┘                                                  │
┌───────────────┐   wallet adapter (create/accept/settle yourself) │
│ CF Pages app   │ ─────────────────────────────────────────────────┘
└───────────────┘
```

- **Program** ([programs/corner_case](programs/corner_case)) — Anchor 0.31.1, 5 instructions, escrow in a market-PDA-owned ATA of a pinned mint, permissionless settle + void.
- **Keeper** ([keeper/](keeper)) — TxLINE auth (single-flight JWT renewal), state-based finalisation detection, recorder + replay harness, auto-settle engine with simulate-before-send.
- **Relay** — Cloudflare Worker ([worker/](worker)) for judges (replay recording bundled in), Node relay ([keeper/src/relay.ts](keeper/src/relay.ts)) for local dev.
- **Web** ([web/](web)) — Next.js on Cloudflare Pages; every read surface works with no wallet.

## Deterministic tests with real proofs

`anchor test -- --features localtest` — **26 tests** run the *full production settlement path* locally: the validator clones TxLINE's program + the real epoch-20649 roots account from devnet, and the suite replays committed real Merkle proofs from England v Argentina ([fixtures/](fixtures)). Both payout directions, all five gates exercised adversarially, corrupted proofs, double-settles, mismatched roots. No mocks anywhere.

## TxLINE surface used

`POST /auth/guest/start` · on-chain `subscribe` (free tier) · `POST /api/token/activate` · `GET /api/fixtures/snapshot` · `GET /api/scores/stream` (SSE) · `GET /api/scores/snapshot/{id}` · `GET /api/scores/historical/{id}` · `GET /api/scores/stat-validation` · `validate_stat_v2` **via CPI** · `["daily_scores_roots", epoch_day]` PDA · period-prefixed stat keys · historical replay data. Details + payload notes: [docs/TECHNICAL.md](docs/TECHNICAL.md); friction & findings: [FEEDBACK.md](FEEDBACK.md).

## Repo map

```
programs/corner_case/   Anchor program (5 instructions, 5 gates, txoracle CPI interface)
tests/                  26-test suite against cloned TxLINE accounts + real proofs
keeper/                 auth · recorder · replay · settle-watch · local relay
worker/                 Cloudflare Worker relay (judge-facing API + faucet)
web/                    Next.js app (markets · builder · live ticker · receipts · demo)
fixtures/               committed real Merkle proofs (final + halftime = adversarial)
recordings/             full recorded match feed (964 events) powering replay
spike/                  Phase-0 findings (ground truth for every integration claim)
docs/                   technical doc · video script
```

## License

Apache-2.0
