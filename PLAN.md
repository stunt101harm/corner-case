# Corner Case — Implementation Plan

**TxLINE World Cup Hackathon** · Submission deadline: **July 19, 2026 23:59 UTC** · Plan finalized: July 17

## One-liner

Trustless P2P prop bets on any provable World Cup stat. Two wallets stake USDC-dev against each other on props like "total corners > 9" or "zero red cards in H2". The market account stores the exact `validateStatV2` strategy at creation ("what you sign is what settles"), and at match finalisation a permissionless keeper submits TxLINE's Merkle proofs while our escrow program verifies them via TxLINE's on-chain validation program — payout is a deterministic pure function of TxLINE-attested data. No oracle wallet, no bookie, no admin key.

## Why this wins (mapped to judging criteria)

1. **Core Functionality** — TxLINE is load-bearing at every layer: fixtures snapshot populates the market builder, scores stream + snapshots drive the live UI *and* the settlement trigger, stat-validation Merkle proofs are the only settlement path.
2. **UX & Use Case** — prop bets between fans are the killer demo for TxLINE's stat tree; the receipt UI makes Merkle proofs legible on camera (animated proof chain + in-browser hash re-verification); judges get a self-serve demo mode that works after the tournament ends.
3. **Code Quality & Logic** — settlement is deterministic predicate evaluation; independently designed custom check gates (the track's explicitly stated bonus signal); Anchor tests fed *real recorded proof payloads*, including adversarial cases.

## Architecture

```
┌─────────────┐  fixtures/scores REST + SSE          ┌──────────────────┐
│   TxLINE    │◄─────────────────────────────────────│  Keeper + Relay  │
│  (devnet)   │  /api/scores/stat-validation         │  auth · sync     │
│             │─────────────────────────────────────►│  settle · replay │
└──────┬──────┘                                      └────────┬─────────┘
       │ validateStatV2 (CPI or in-program verify)            │ settle_market tx
       ▼                                                      ▼
┌───────────────────────────────────────────────────────────────────────┐
│  corner-case Anchor program (devnet)                                  │
│  create_market · accept_market · settle_market · cancel/void          │
│  Market PDA ["market", creator, nonce u64 LE]                         │
│  Escrow: market-PDA-owned token ATA (pinned USDC-dev mint)            │
└───────────────────────────────────────────────────────────────────────┘
       ▲ wallet adapter                 ▲ relay (cached snapshots + SSE)
┌──────┴─────────────────────────────────┴──────┐
│ Next.js app: builder · markets · live · receipt · judge demo mode     │
└───────────────────────────────────────────────┘
```

### On-chain program (Anchor 0.31.1, devnet)

**Market account** — PDA `["market", creator, nonce u64 LE]` (nonce avoids per-fixture collisions; the demo creates two markets on the same fixture). Fields: `fixture_id`, `epoch_day` (creation-time estimate), `kickoff_ts`, `strategy: Vec<u8>` (byte-exact SDK encoding, space `8 + BASE + 4 + strategy.len()`), `creator`, `creator_side`, `taker`, `stake`, `state`, `settled_seq`.

**Instructions:**

1. **`create_market`** — creator supplies fixture_id, epoch_day, kickoff_ts, the full `validateStatV2` strategy bytes, side (YES/NO), stake, nonce. USDC-dev → market-PDA-owned escrow ATA. Mint is **hardcoded** (`address = USDC_DEV` constraint); classic `anchor_spl::token` everywhere — Token-2022 exists ONLY in the keeper's client-side TxLINE `subscribe` tx, never in our program.
2. **`accept_market`** — taker matches stake 1:1. **Check gate #1 (kickoff deadline):** rejects accepts at/after `kickoff_ts`.
3. **`settle_market`** — permissionless. Takes proof payload + `epoch_day` **as args** (constrained to `{stored, stored+1}` — North-America evening kickoffs finalise after 00:00 UTC). Derives `["daily_scores_roots", epoch_day u16 LE]` **against TXLINE_PROGRAM_ID** (`6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`), splices stored-strategy + submitted-proof into byte-identical instruction data, and validates via the settlement path chosen at the spike fork (below). Takes **both** `creator_ata` and `taker_ata`, each constrained by ATA derivation (`authority = market.creator/taker`, `mint = USDC_DEV`) — **there is no free winner account**; the boolean selects between two constrained accounts. Sets `state = Settled` **before** the outbound transfer (double-settle race → state error, not drained escrow). Closes escrow ATA (PDA signer) and Market (`close = creator`) to recover rent. **Check gate #2 (finality)** and **#3 (seq)** below.
4. **`cancel` / `void`** — creator reclaims if unmatched at kickoff; mutual refund if unsettled N hours post-fixture.

### Settlement path — decided at the spike fork, not assumed

The spike (Phase 0) determines which of three designs ships. All keep TxLINE's attested on-chain root load-bearing:

- **Path A — CPI wrapper (preferred):** CPI into `validateStatV2`, read result via `sol_get_return_data()`, **checking the returned `program_id`** against TxLINE's and decoding the bool as a single borsh byte. Viable only if the spike shows (1) return-data semantics are well-defined for the FALSE case, (2) `unitsConsumed + ~50k < 1.4M` (the CU limit is **transaction-wide**, not per-CPI), (3) the largest proof payload (binary corner-differential) fits the 1232-byte tx limit.
- **Path B — same-tx two-instruction settle:** direct `validateStatV2` instruction + our settle instruction with Instructions-sysvar introspection. Introspection sees instruction *data*, never *return* data — so Path B is valid **only** if the spike shows `validateStatV2` hard-errors on a false predicate (success == predicate true).
- **Path C — in-program Merkle verification (strongest fallback):** verify the proof chain directly in our program with sha256 syscalls against the `daily_scores_roots` account passed as a plain account. No CPI at all, immune to CU/foreign-program flakiness; requires the spike to capture the exact leaf/node hashing scheme from `tx-on-chain`.

**Fixture binding (correctness-critical):** nothing may allow a valid proof from a *different* match to settle a market (some game somewhere always has >9 corners). The spike locates where `fixtureId` is bound in the `validateStatV2` args: if inside the strategy/payload encoding, storing strategy bytes with fixture baked in suffices; if only in the proof leg, `settle_market` parses and enforces `proof.fixture_id == market.fixture_id` at a verified byte offset, unit-tested against a recorded real payload. **`create_market` is not written until this is answered.**

### Check gates (each documented in README with the failure it prevents)

| Gate | Enforces | Prevents |
|---|---|---|
| #1 Kickoff deadline | no accepts at/after `kickoff_ts` | betting on known outcomes |
| #2 Finality | proof set must include the `period == 100` leaf (if provable — spike decides) | settling "zero H2 red cards" YES on a mid-match proof showing 0-so-far. **Not a nicety: for non-monotone props an early proof settles wrongly.** Fallback if the status leaf isn't provable: `provisional_settle` + challenge window (higher-seq proof can overturn) + `claim` after window — a state machine costing ~½ day, pre-priced in the de-scope ladder |
| #3 Seq policy | proof `seq >=` the seq observed at `game_finalised`; keeper waits a 10-min grace window post-final to absorb official stat corrections | first-settler-wins on a pre-correction proof (corners 9→10 flips the market). Note: gate #3 alone cannot reject a stale *first* proof — #2 carries that load |

### Keeper + relay (single TypeScript Node process, always-on host)

- **Auth as a managed resource:** guest JWT → devnet `subscribe` tx (pre-funded keypair) → `/api/token/activate`; store token + TTL, proactively refresh, wrap every REST/SSE failure with automatic full-chain headless re-auth.
- **State-based settlement, not edge-triggered:** SSE `game_finalised` is a *latency optimization only*. On every (re)connect and on a 60s timer past scheduled fixture end, poll `/api/scores/snapshot/{fixtureId}`; `period/statusId == 100` is the trigger. A missed SSE event can never strand escrow.
- **Close the loop before submitting:** fetch proof → fetch `daily_scores_roots` account → verify the proof against the *actual on-chain bytes* locally → only then send `settle_market`; retry with backoff until API proof and on-chain root agree (root-posting lag is measured in the spike).
- **Relay:** frontend never talks to TxLINE directly (judges won't sign a subscribe tx) — thin backend re-serves cached fixture snapshots + re-broadcasts SSE using the keeper's token.
- **Recorder/replay:** records raw SSE lines + proof payloads to disk; replays through the *identical* code path at configurable speed.

### Frontend (Next.js + wallet adapter)

1. **Market builder** — fixture picker + 5–6 hardcoded templates mapping 1:1 to spike-tested strategy encodings (corners total >N [prefix 0], H1 goals O/U [1000], H2 red cards == 0 [3000], corner differential [binary subtract]); shows the exact strategy JSON before signing; refuses templates whose statKey is absent from the fixture's validation tree.
2. **Open markets list** — one-click accept; **"Get test funds"** button (devnet SOL + self-minted USDC-dev) so a judge is staking within a minute.
3. **Live match view** — SSE ticker (goals/cards/corners/shots/VAR) with per-market condition tracker ("corners 7 of 10 needed").
4. **Settlement receipt** — settle tx explorer link, animated Merkle chain (stat leaf → eventStatRoot → subtree → main tree → `daily_scores_roots` PDA), client-side hash recomputation button. **Fully readable with no wallet connected.**
5. **Judge demo mode (first-class, not video tooling):** judging happens *after* the tournament — the deployed app must not be dead on arrival. "Run demo match" streams a recorded match at 30× into the live view; a demo fixture lets judges create/accept markets and hit **"Settle now"**, which submits the recorded proof payload for a REAL devnet settlement they trigger themselves. App ships pre-seeded with 2–3 settled markets (receipts ready) and 2 open ones.

## Phase 0 spike checklist (GO/NO-GO gate for the settlement path)

Auth + data reality (devnet is an **assumption until proven** — providers often post real feeds to mainnet only):

- [ ] Full auth chain headless on devnet; record token TTL from the activate response; deliberate-expiry re-auth test
- [ ] `/api/fixtures/snapshot` on devnet contains actual WC fixture IDs
- [ ] `getAccountInfo` on devnet `daily_scores_roots` for today + yesterday: account exists, root changes as games progress; TxLINE program is `executable: true`
- [ ] Root retention: PDAs for days 1–14+ old still hold verifiable roots (replay/demo mode depends on this)
- [ ] Hash-verify a fetched proof against the **devnet account bytes**, not the API's claimed root

Proof + program semantics (on a known-good historical fixture):

- [ ] Successful client-side `validateStatV2 .view()`; capture the **exact instruction bytes** (discriminator + arg encoding) the SDK builds
- [ ] **CPI probe:** ~30-line throwaway devnet program that CPIs into `validateStatV2` and logs `get_return_data()` — run with TRUE predicate, FALSE predicate, corrupted proof → determines Path A/B/C
- [ ] Record `unitsConsumed` + serialized tx size for the **largest** template (binary differential) vs 1.4M CU / 1232 bytes
- [ ] Locate the `fixtureId` binding in the args (strategy vs proof leg)
- [ ] statKeys coverage: request every template key across prefixes 0/1000/3000 — hardcode only keys returning verifiable leaves; swap/drop templates that don't
- [ ] Is `period == 100` a provable leaf? → gate #2 design fork
- [ ] Midnight-UTC fixture: which day's root carries final stats for a match that kicked off before and finalised after 00:00 UTC?
- [ ] Seq behavior: for 2–3 finished fixtures, enumerate post-final seqs and diff stat trees — do leaves change after period hits 100, and how long after?
- [ ] Root-posting lag: timestamp SSE finalisation vs first API proof vs first on-chain root that verifies it

**Start FEEDBACK.md at hour 0** — append every TxLINE surprise (endpoint, expected vs got, timestamp). The feedback section is a scored deliverable; its raw material is generated now, not on July 19.

## Scope cuts (final) + de-scope ladder

**Out from the start:** pools/AMM/orderbook · odds pricing · fees · partial fills · non-template strategies in the UI (program stays general) · real Circle USDC (self-minted USDC-dev enables the faucet button).

**Checkpointed ladder — cut in this order, not whatever is currently stuck:**

| Checkpoint | If behind, cut |
|---|---|
| **H10** (spike done) | Fork per spike result: Path A → B → C. If everything fails: escrow program unchanged, keeper-submitted results, honest README framing — still a working build |
| **H24** (program deployed) | cancel/void → creator-reclaim stub; drop gate #3; drop binary-differential template (ship 2 templates covering both payout directions) |
| **H36** (frontend) | cut live match view (keeper logs on camera instead); animated Merkle chain → static hash list + re-verify button; markets list → plain table |
| **H48** | cut the second-direction settlement + adversarial beat from the video; ship one flawless settlement |

The judged core, in descending value: deployed program + one real proof-settled market + legible receipt + video. Everything else is decoration.

## Timeline (~44 real working hours after sleep; checkpoints at wall-clock)

| Window | Work |
|---|---|
| **Jul 17, H0–10** | Spike checklist above. **From ~H5, in parallel:** scaffold the CPI-independent surface (Market account, create/accept/cancel, escrow ATA) — identical in every spike outcome; only `settle_market` waits for the fork |
| Jul 17 PM – Jul 18 AM | `settle_market` per chosen path + devnet deploy + strategy-encoding unit tests |
| Jul 18 (parallel) | Keeper + relay + frontend. **Record the 3rd-place match raw SSE + proofs in full.** Deploy keeper/relay/frontend to always-on host; verify from a clean browser. **Script the video (shot list + narration). Record a rough safety take the moment one market settles end-to-end via replay.** Dry-run the Superteam Earn form fields |
| Jul 18 PM – Jul 19 | Judge demo mode · receipt UI · deterministic test suite with real proofs + adversarial tests (early settle rejected, FALSE predicate routes to NO side, cross-fixture proof rejected, double-settle race) |
| Jul 19 | README (judge quickstart on top) + tech docs + edit FEEDBACK.md · final video cut, upload unlisted early · **submit complete-but-rough by ~18:00 UTC**, polish after if the platform allows edits. Live Final as B-roll only |

## Demo video outline (5 min)

0:00 Hook: "Every prop bet needs someone you trust to say what happened. We replaced that someone with a Merkle proof." → 0:30 create "corners > 9", camera on the stored strategy JSON, wallet B accepts, escrow in explorer → 1:30 30× replay: ticker fills, condition tracker climbs, finalisation fires, keeper verifies proof against the on-chain root and the settle tx lands untouched → 3:00 receipt: validation visible in explorer, animated proof chain, in-browser re-verify; second market ("zero H2 red cards") settles the *other* direction — both predicate shapes, both payout branches → 4:00 adversarial beat: early settle rejected on-chain by the finality gate; check-gates table → 4:30 judge demo mode shown explicitly ("this is what you can click yourself, after the tournament") → 4:50 architecture slide mapped to the judging criteria; live Final B-roll close.

## TxLINE surface used (for submission docs)

`/auth/guest/start` · on-chain `subscribe` (free tier) · `/api/token/activate` · `/api/fixtures/snapshot` · `/api/scores/stream` (SSE) · `/api/scores/snapshot/{fixtureId}` · `/api/scores/updates/{fixtureId}` (backfill) · `/api/scores/stat-validation` (V2 params) · `validateStatV2` (CPI or direct) · `daily_scores_roots` PDA derivation · period-prefixed stat keys · historical replay data.

## Submission checklist

- [ ] Working devnet program + always-on keeper/relay + hosted frontend **that works for a wallet-less judge after the tournament** (pre-seeded receipts + demo mode + faucet button)
- [ ] Judge quickstart at the top of the README (Phantom → devnet → fund → accept → settle → receipt; pre-settled receipt URL as zero-effort fallback)
- [ ] Demo video ≤ 5 min, uploaded unlisted early (Loom/YouTube)
- [ ] Public GitHub repo
- [ ] Technical documentation (core idea, highlights, TxLINE endpoints used)
- [ ] FEEDBACK.md — TxLINE API feedback, kept since hour 0
- [ ] Submitted on Superteam Earn by ~18:00 UTC Jul 19 (hard commitment; deadline 23:59)
