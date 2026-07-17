# Corner Case — Implementation Plan

**TxLINE World Cup Hackathon** · Submission deadline: **July 19, 2026 23:59 UTC** · Today: July 17

## One-liner

Trustless P2P prop bets on any provable World Cup stat. Two wallets stake USDC against each other on props like "total corners > 9" or "zero red cards in H2". The market account stores the exact `validateStatV2` strategy at creation ("what you sign is what settles"), and at `game_finalised` a permissionless keeper submits TxLINE's Merkle proofs while our escrow program CPIs into `validateStatV2` — payout is a deterministic pure function of TxLINE-attested data. No oracle wallet, no bookie, no admin key.

## Why this wins (mapped to judging criteria)

1. **Core Functionality** — TxLINE is load-bearing at every layer: fixtures snapshot populates the market builder, SSE scores stream drives the live UI *and* the settlement trigger, stat-validation proofs are the only settlement path.
2. **UX & Use Case** — prop bets between fans are the killer demo for TxLINE's stat tree; the receipt UI makes Merkle proofs legible on camera (animated proof chain + in-browser hash re-verification).
3. **Code Quality & Logic** — settlement is deterministic predicate evaluation; three independently designed custom check gates (the track's explicitly stated bonus signal); Anchor tests fed *real recorded proof payloads*.

## Architecture

```
┌─────────────┐   fixtures/odds/scores REST + SSE   ┌──────────────┐
│   TxLINE     │◄────────────────────────────────────│  Keeper (TS) │
│  (devnet)    │   /api/scores/stat-validation       │  auth · sync │
│              │────────────────────────────────────►│  SSE · settle│
└──────┬───────┘                                     └──────┬───────┘
       │ validateStatV2 (CPI, .view)                        │ settle_market tx
       ▼                                                    ▼
┌──────────────────────────────────────────────────────────────────┐
│  corner-case Anchor program (devnet)                              │
│  create_market · accept_market · settle_market · cancel/void      │
│  Market PDA: fixture_id, stored strategy bytes, sides, deadline   │
│  Escrow: market-PDA-owned USDC ATA                                │
└──────────────────────────────────────────────────────────────────┘
       ▲
       │ wallet adapter
┌──────┴───────┐
│ Next.js app  │  builder · markets list · live match view · receipt
└──────────────┘
```

### On-chain program (Anchor 0.31.1, devnet) — 4 instructions

1. **`create_market`** — creator supplies `fixture_id`, `epoch_day`, full `validateStatV2` strategy (single or binary discrete predicate), side (YES/NO), stake, kickoff deadline. USDC → market-PDA-owned escrow ATA. Strategy bytes stored immutably.
2. **`accept_market`** — taker matches stake 1:1 before kickoff deadline (**check gate #1: kickoff deadline**).
3. **`settle_market`** — permissionless. Takes the TxLINE proof payload as args, CPIs into TxLINE program `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` `validateStatV2` with the *stored* strategy + `["daily_scores_roots", epoch_day u16 LE]` PDA. Predicate result routes full escrow to the winning side. Client prepends `setComputeUnitLimit(1_400_000)`. **Check gate #2: finality** — require proof of `period == 100` if the status stat is a provable leaf (spike decides); fallback: time-lock past scheduled fixture end + permissionless re-settle window. **Check gate #3: seq monotonicity** — reject stale-snapshot proofs.
4. **`cancel` / `void`** — creator reclaims if unmatched at kickoff; mutual refund if unsettled N hours post-fixture.

**CPI fallback** if CPI into a foreign program proves flaky at 1.4M CU: two-tx settle (permissionless direct `validateStatV2` call + instruction-introspection check in our program).

### Keeper (single TypeScript Node process)

- Full TxLINE auth: `POST /auth/guest/start` → devnet `subscribe` tx → `POST /api/token/activate` → `X-Api-Token`.
- Fixture sync from `/api/fixtures/snapshot` (kickoff times feed on-chain deadlines).
- SSE consumer on `/api/scores/stream`; on `action=game_finalised` (period/statusId = 100) for a tracked fixture, fetch `/api/scores/stat-validation?fixtureId=&seq=&statKeys=...` for the union of open markets' stat keys, assemble payload, fire `settle_market`.
- **Replay mode**: pipes a recorded historical match (raw SSE lines + saved proof payloads) through the *identical* code path at configurable speed. This is the demo backbone — the video never depends on live luck.

### Frontend (Next.js + wallet adapter, 4 pages)

1. **Market builder** — fixture picker (fixtures snapshot) + 5–6 hardcoded prop templates mapping 1:1 to tested strategy encodings; shows exact on-chain strategy JSON before signing. Templates span period prefixes deliberately: corners total >N (prefix 0), H1 goals O/U (prefix 1000), H2 red cards == 0 (prefix 3000), corner differential (binary subtract).
2. **Open markets list** — one-click accept (second wallet in demo).
3. **Live match view** — SSE ticker (goals/cards/corners/shots/VAR) with per-market live condition tracker ("corners 7 of 10 needed").
4. **Settlement receipt** — settle tx explorer link showing the CPI, animated Merkle chain (stat leaf → eventStatRoot → subtree → main tree → `daily_scores_roots` PDA), client-side hash recomputation button.

## Scope cuts (final — not up for renegotiation mid-build)

1v1 fixed-stake only · USDC-dev only · no fees · no partial fills · no AMM/orderbook · no odds pricing · program accepts arbitrary strategies but UI ships only the tested templates.

## Timeline (~60 hours remaining)

| Window | Work |
|---|---|
| **Jul 17, hours 0–10** | **Spike (GO/NO-GO gate):** run `txodds/tx-on-chain` examples; full auth chain on devnet; fetch a historical fixture's stat-validation proof; land a successful client-side `validateStatV2 .view()`. Decide finality-gate design from real data. **No Anchor code before this passes.** |
| Jul 17 PM – Jul 18 AM | Anchor program (4 instructions) + strategy-encoding unit tests + devnet deploy. |
| Jul 18 (parallel) | Keeper + frontend (parallelized via Claude Code). **Record the 3rd-place match raw SSE + proofs to disk** — guaranteed fresh demo material. |
| Jul 18 PM – Jul 19 | Replay harness polish · receipt UI · deterministic test suite with real proofs · adversarial tests (early settle rejected, wrong predicate fails). |
| Jul 19 (final 12h) | README + technical docs + TxLINE feedback · 5-min demo video (replay-driven, live Final as B-roll if timing allows) · submit hours before deadline. |

## Demo video outline (5 min)

0:00 Hook: "Every prop bet needs someone you trust to say what happened. We replaced that someone with a Merkle proof." → 0:30 create "corners > 9" market, camera on stored strategy JSON, accept from wallet B, escrow visible in explorer → 1:30 30× replay: ticker fills, condition tracker climbs, `game_finalised` fires, keeper log + settle tx land untouched → 3:00 receipt page: CPI in explorer, animated proof chain, in-browser re-verify; second market ("zero H2 red cards") settles the *other* direction — both predicate shapes, both payout branches → 4:00 adversarial beat: early settle rejected on-chain by the finality gate; check-gates slide → 4:40 architecture slide mapped to the three judging criteria; live Final B-roll close.

## TxLINE surface used (for submission docs)

`/auth/guest/start` · on-chain `subscribe` (free tier) · `/api/token/activate` · `/api/fixtures/snapshot` · `/api/scores/stream` (SSE) · `/api/scores/snapshot/{fixtureId}` · `/api/scores/updates/{fixtureId}` · `/api/scores/stat-validation` (legacy + V2 params) · `validateStatV2` via CPI · `daily_scores_roots` PDA derivation · period-prefixed stat keys (0/1000/3000, keys 1–8) · historical replay data.

## Top risks & mitigations

1. **CPI integration burns a day** → hour-0 spike gates everything; fallback: two-tx settle w/ instruction introspection; keep our settle logic tiny so CU budget goes to the CPI.
2. **Predicate-builder scope creep** → UI ships exactly the hardcoded templates; anything non-template-shaped is cut without discussion.
3. **Data doesn't cooperate** (fixture missing validation coverage, SSE quiet, finality-stat assumption fails) → spike validates a specific known-good historical fixture and the demo is built around it; record Jul 18 match in full; finality gate has a designed fallback that changes one function, not the architecture.

## Submission checklist

- [ ] Working devnet deploy (program + hosted frontend)
- [ ] Demo video ≤ 5 min (Loom/YouTube)
- [ ] Public GitHub repo
- [ ] Technical documentation (core idea, highlights, TxLINE endpoints used)
- [ ] TxLINE API feedback section
- [ ] Submitted on Superteam Earn before Jul 19, 23:59 UTC
