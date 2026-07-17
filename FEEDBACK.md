# TxLINE API Feedback (running log — kept since hour 0)

Per submission requirement: our team's experience using the TxLINE API — what we liked,
where we hit friction. Raw entries appended as they happen (below); this section is the
edited final summary the submission calls for, drawn from the running log that follows.

## Experience using the TxLINE API

### What we liked most

- **The on-chain infrastructure is solid and genuinely devnet-first.** The devnet program
  exists and is executable; `daily_scores_roots` PDAs are posted daily going back 3+ weeks
  with gaps matching World Cup rest days — i.e. **real tournament data is on devnet**, and
  historical roots are retained long enough that replay-based demos work after the
  tournament. For a hackathon this is the part that most demos hand-wave; TxLINE actually
  shipped it.
- **`validate_stat_v2` is CPI-friendly by design.** It is declared `returns: bool` in the
  IDL (so the verdict is reachable via Anchor return data from a wrapping settlement
  program), uses a single PDA account, and bakes `fixture_id` in as a typed field inside
  the proven summary — which made fixture binding in our escrow program a one-line check
  instead of a fragile byte-offset parse.
- **The auth-chain examples are runnable as-is.** The free-tier chain (guest JWT →
  Token-2022 ATA → `subscribe` level 1 → `/token/activate`) worked first try against our
  own keypair, and the activation message format (`txSig:leagues:jwt`, nacl detached sig)
  matched the docs exactly. Nothing about onboarding was a research project.

### Where we hit friction

- **`weeks` must be a multiple of 4 and ≥ 4.** Discoverable only from example-code
  validation (`users.ts`), not from the endpoint docs, which label it `DURATION_WEEKS` and
  imply a free choice. A one-line constraint in the docs would save the next integrator an
  unnecessary round trip.
- **Devnet data-endpoint instability during integration.** Our first proof fetch hit a
  `504 Gateway Time-out` on `/api/scores/stat-validation` immediately after a successful
  activation, and shortly after all devnet *data* endpoints returned `503` for a window
  while devnet *auth* endpoints and mainnet stayed up. Endpoints recovered and the
  on-chain data we depend on (roots, program) was never affected — but a keeper talking to
  the data API needs real retry/backoff, not just happy-path code.
- **`validate_stat_v3` (multiproof) is undocumented.** It exists in the IDL and has a
  devnet example script (`subscription_scores_v3c.ts`), but the hosted documentation only
  describes the legacy and V2 surfaces. V2 was sufficient for us; we flag it because an
  undocumented instruction with a working example is the kind of thing that surprises an
  integrator reading the docs end-to-end.

### One thing we'd ask for

A single "integration-guide for a third program that settles on TxLINE" page covering the
three things we had to discover empirically: the FALSE predicate also returns success
(`[0]`, not a hard error) so a settle program must read the return bool and not trust CPI
success; the `weeks` multiple-of-4 constraint; and that `period == 100` is the game-final
marker available inside every proven stat leaf. Each was cheap to find but not free.

---

## Running log (raw, since hour 0)

Per submission requirement: our team's experience using the TxLINE API — what we liked, where we hit friction. Raw entries appended as they happen; edited into a final section before submission.

## 2026-07-17

- **21:10 UTC — Docs/examples quality: excellent.** The `txodds/tx-on-chain` repo's devnet examples are runnable as-is; the full free-tier auth chain (guest JWT → Token-2022 ATA → `subscribe` level 1 → `/token/activate`) worked first try with our own keypair. Activation message format (`txSig:leagues:jwt`, nacl detached sig) matched the docs exactly.
- **21:12 UTC — Friction: `weeks` must be a multiple of 4 and ≥ 4.** Only discoverable from example-code validation (`users.ts`), not from the endpoint docs, which say "DURATION_WEEKS".
- **21:15 UTC — Friction: `/api/scores/stat-validation?fixtureId=18179550&seq=1315&statKeys=1` (devnet) returned `504 Gateway Time-out`** on our first proof fetch, immediately after successful activation.
- **21:25–21:35 UTC — Outage: ALL devnet data endpoints returning `503 Service Temporarily Unavailable`** (fixtures/scores/odds snapshots, stat-validation, SSE streams), while devnet `auth/guest/start` and `/token/activate` kept working and mainnet endpoints were up (200/401). Monitoring for recovery.
- **21:31 UTC — Liked: on-chain infrastructure is solid and genuinely devnet-first.** TxLINE devnet program exists/executable; `daily_scores_roots` PDAs (9,232 B — 288 five-minute batch roots per day) posted daily going back 3+ weeks, with gaps matching World Cup rest days (Jul 8, 13, 16, 17) — i.e., real tournament data is posted to devnet. Historical roots are retained (June 27 still live), which makes replay-based demos possible.
- **21:33 UTC — Docs gap: `validate_stat_v3` (multiproof: `leaves` + `multiproof_hashes` + `leaf_indices`) exists in the IDL and has a devnet example script (`subscription_scores_v3c.ts`), but the hosted documentation only describes legacy + V2.**
- **Liked: `validate_stat_v2` is CPI-friendly by design** — declared `returns: bool` in the IDL (Anchor return-data), single PDA account, and `ScoresBatchSummary.fixture_id` is a typed field inside the proven payload, which makes fixture binding in a wrapping settlement program straightforward.
