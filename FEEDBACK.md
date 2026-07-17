# TxLINE API Feedback (running log — kept since hour 0)

Per submission requirements: our team's experience using the TxLINE API — what we liked, where we hit friction. Raw entries appended as they happen; edited into a final section before submission.

## 2026-07-17

- **21:10 UTC — Docs/examples quality: excellent.** The `txodds/tx-on-chain` repo's devnet examples are runnable as-is; the full free-tier auth chain (guest JWT → Token-2022 ATA → `subscribe` level 1 → `/token/activate`) worked first try with our own keypair. Activation message format (`txSig:leagues:jwt`, nacl detached sig) matched the docs exactly.
- **21:12 UTC — Friction: `weeks` must be a multiple of 4 and ≥ 4.** Only discoverable from example-code validation (`users.ts`), not from the endpoint docs, which say "DURATION_WEEKS".
- **21:15 UTC — Friction: `/api/scores/stat-validation?fixtureId=18179550&seq=1315&statKeys=1` (devnet) returned `504 Gateway Time-out`** on our first proof fetch, immediately after successful activation.
- **21:25–21:35 UTC — Outage: ALL devnet data endpoints returning `503 Service Temporarily Unavailable`** (fixtures/scores/odds snapshots, stat-validation, SSE streams), while devnet `auth/guest/start` and `/token/activate` kept working and mainnet endpoints were up (200/401). Monitoring for recovery.
- **21:31 UTC — Liked: on-chain infrastructure is solid and genuinely devnet-first.** TxLINE devnet program exists/executable; `daily_scores_roots` PDAs (9,232 B — 288 five-minute batch roots per day) posted daily going back 3+ weeks, with gaps matching World Cup rest days (Jul 8, 13, 16, 17) — i.e., real tournament data is posted to devnet. Historical roots are retained (June 27 still live), which makes replay-based demos possible.
- **21:33 UTC — Docs gap: `validate_stat_v3` (multiproof: `leaves` + `multiproof_hashes` + `leaf_indices`) exists in the IDL and has a devnet example script (`subscription_scores_v3c.ts`), but the hosted documentation only describes legacy + V2.**
- **Liked: `validate_stat_v2` is CPI-friendly by design** — declared `returns: bool` in the IDL (Anchor return-data), single PDA account, and `ScoresBatchSummary.fixture_id` is a typed field inside the proven payload, which makes fixture binding in a wrapping settlement program straightforward.

## 2026-07-17 (keeper build — evening)

- **Friction: `/scores/snapshot/{id}` semantics.** Returns an array of the latest record *per Action type* (37 entries for a finished match, mixed Seqs) rather than one merged state. The max-Seq entry of a finished match is a StatusId-less `disconnected` record, so "check the newest record's StatusId" silently misses finalisation — consumers must scan all entries for StatusId 100. Worth a docs callout.
- **Friction: stream heartbeats are named SSE events** (`event: heartbeat` + JSON data), not comments — naive consumers JSON-parse them as score records. Also, heartbeat `Ts` is epoch **seconds** while record `Ts` is epoch **ms**.
- **Inconsistency: `GameState` is numeric in `/fixtures/snapshot` but a string (`"scheduled"`) inside score records** — same field name, different types.
- **Pre-coverage snapshot is `200 []`**, and WC fixtures emit Seq-1 `comment` records days before kickoff — fine once known, surprising first time.
- **Liked: proof retention.** All 5 key-set proofs for a 2-day-old match fetch first-try in 140–380 ms each.
- **Liked (tooling note): client-side, Anchor 0.31's standalone `coder.types.encode("NDimensionalStrategy", ...)` returns a broken zero-filled buffer** (the instruction coder encodes the same type correctly). Not TxLINE's bug, but integrators will hit it when building strategy bytes to store — hand-rolling the 18-byte borsh encoding is the workaround.
