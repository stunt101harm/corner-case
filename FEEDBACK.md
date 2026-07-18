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

## 2026-07-18 (deployment + receipt work)

- **Discovery (docs gap — later fully reverse-engineered, see the appendix below): zero-value stats use an undocumented NON-MEMBERSHIP proof scheme.** For present (non-zero) stats, `statProofs` entries are ordinary sibling hashes — `sha256(key u32 LE ‖ value i32 LE ‖ period i32 LE)` folded with `sha256(left‖right)` (duplicate-last-odd-node rule) reproduces `eventStatRoot`. For **zero-value** keys the two "proof nodes" are structured: a fixed header and the complement of a presence bitmap. Nothing in the docs mentions the distinction; client-side verifiers will hit it. Full spec appendix at the bottom of this file — we'd love to see it merged into the official docs.
- **Friction (not TxLINE's fault but relevant to Solana devnet integrations): Cloudflare Workers egress IPs are blocked by `api.devnet.solana.com`** (403 "IP or provider blocked"), so our Worker faucet uses a third-party devnet RPC.
- **Liked: the whole judge-facing surface (proofs, replays via `/scores/historical`, fixtures) works fine from serverless** — the API is plain HTTPS + tokens, no SDK lock-in.

## 2026-07-18 (odds integration)

- **Docs gap: `/odds/snapshot/{id}` semantics.** `Prices` are decimal odds ×1000 (undocumented — deduced from `Pct`); `Pct` can be the string `"NA"`; `MarketPeriod: null` means full match vs `"half=1"`. More importantly, **the snapshot returns only the LATEST update batch, not a merged book** — successive polls return different (sometimes empty) subsets, so any consumer must maintain a rolling per-fixture book keyed by market type/period/parameters or their UI flickers. Worth a prominent docs callout; it's the odds-side sibling of the scores-snapshot per-action-type surprise.
- **Liked: `TXLineStablePriceDemargined`** — a demargined consensus feed means implied probabilities normalize to ~1.000 out of the box; our overround correction measured ≤0.1%. Great primitive for analytics UIs.
- **Note: finished fixtures return `200 []`** on odds snapshot (fine, but worth documenting).


---

# Appendix: TxLINE's zero-value (non-membership) stat proofs — a community spec

*We reverse-engineered this scheme because our receipts recompute every proof leg in the browser. Validated against the on-chain verifier: 12/12 real proofs across two fixtures accepted, 64/64 single-byte corruptions rejected, semantics confirmed by transaction simulation. Reference implementation: [`spike/txline_stat_verify.mjs`](spike/txline_stat_verify.mjs). Suggested docs text below — feel free to merge it nearly verbatim.*

## The scheme

One Merkle tree per (fixture, snapshot) roots at `eventStatRoot`. Its leaves are **all non-zero stats**, sorted ascending by key, hashed `sha256(key u32 LE ‖ value i32 LE ‖ period i32 LE)`, combined `sha256(left ‖ right)` with the duplicate-last-odd-node rule. A **zero-value** stat is not in the tree — it is proven ABSENT via a 2-node proof:

| Node | Bytes | Meaning |
|---|---|---|
| A | `[0]` = `0x01` | header tag (node count). Wrong → `IndexOutOfBounds` (6073) |
| A | `[1..31]` = `0xff` | fixed padding, must be exact → else `InvalidStatProof` (6023) |
| B | `[0..7]` | **bitwise complement of a 64-slot presence bitmap**: byte = period bucket (0=full-time, 1=H1, 3=H2, … 0–7), bit `(stat_type − 1)` for stat types 1–8 (goals/yellows/reds/corners × home/away). Bit set in the complement ⇒ stat absent ⇒ value 0 |
| B | `[8..31]` = `0x00` | zero padding |

**Cryptographic binding:** the bitmap is committed in the fixture sub-tree as the **left sibling of `eventStatRoot`** — i.e. `sha256(nodeB) == subTreeProof[0].hash`. Since `subTreeProof` + `mainTreeProof` already fold to the on-chain daily root, the bitmap cannot be forged. (Equivalent when `updateCount == 1`: `sha256(sha256(nodeB) ‖ eventStatRoot) == eventStatsSubTreeRoot`.)

## Verification algorithm (absent path)

1. require `value == 0` (else `StatNotZero`, 6074)
2. node A == `[0x01, 0xff×31]`, both nodes `isRightSibling == false`
3. node B bytes 8..31 all zero
4. `sha256(nodeB) == subTreeProof[0].hash` (else `InvalidStatProof`)
5. `bucket = key / 1000 ∈ [0,7]`, `type = key % 1000 ∈ [1,8]` (else `IndexOutOfBounds`)
6. `(nodeB[bucket] >> (type−1)) & 1 == 1` — the complement bit is set ⇒ absent ⇒ value 0 proven

## Test vectors (England v Argentina, fixture 18241006, seq 962)

- Presence bitmap complement (node B bytes 0–3): `30 33 33 74` → decodes to present keys `1,2,3,4,7,8,1003,1004,1007,1008,2003,2004,2007,2008,3001,3002,3004,3008` — exactly the match's non-zero stats.
- `sha256(nodeB)` equals `subTreeProof[0].hash` in every zero-value proof served for this fixture (keys 1001, 1002, 3005, 3006).
- A present key submitted through the absent path is rejected `StatNotZero`; flipping node A byte 0 → `IndexOutOfBounds`; flipping any node B byte → `InvalidStatProof`.

*A bonus for integrators: node B alone is a compact "which stats exist" summary — decoding the complement enumerates every non-zero stat key of the match from 32 bytes.*


## Appendix 2: the main-tree leg (summary → on-chain daily root) — completing the chain

*With this, the ENTIRE `validate_stat_v2` proof chain is client-verifiable against the raw on-chain account bytes. Ground truth was recovered by decoding TxLINE's own `insert_scores_root` transactions.*

- **Main-tree leaf** = `sha256(0x01 ‖ borsh(ScoresBatchSummary))` — a 61-byte preimage: `0x01` leaf-domain tag ‖ `fixture_id i64 LE` ‖ `update_count i32 LE` ‖ `min_timestamp i64 LE` ‖ `max_timestamp i64 LE` ‖ `events_sub_tree_root[32]`. (The undocumented `0x01` domain tag is what defeats naive reimplementations.)
- **Fold** with the same `sha256(left ‖ right)` / `isRightSibling` convention as every other leg.
- **`daily_scores_roots` account layout**: 8-byte anchor discriminator `d90c0c170ab7737d` ‖ `epoch_day u16 LE` (self-describing!) ‖ `288 × [u8;32]` batch roots ‖ `bump u8` ‖ 5 pad bytes = 9,232 bytes. **The header is 10 bytes, not 16** — a misread here makes every slot straddle two roots.
- **Slot formula**: `slot = floor((min_timestamp % 86_400_000) / 300_000)` (= `hour*12 + minute/5`, matching the `insert_scores_root(epoch_day, hour, minute, root)` instruction; roots post ~44 s after each 5-minute window closes).
- Validated: 10/10 full-chain verifications across two fixtures, three seqs, four slots, and two epoch days; adversarial mutations (bit flips, `updateCount+1`, `fixtureId+1`, timestamp nudges) all rejected. Reference: [`spike/txline_full_chain_verify.mjs`](spike/txline_full_chain_verify.mjs).

## 2026-07-18 (odds stream)

- **`/odds/stream` inconsistencies vs `/scores/stream`:** heartbeat blocks put `data:` BEFORE `event: heartbeat` (scores is event-first); odds `id:` is `<5min-bucket-ms>:<offset>` not `Seq`; heartbeat `Ts` is epoch seconds while record `Ts` is ms. A consumer written against the scores stream needs small tweaks.
- **Stream entries are a superset of the snapshot** (extra `MessageId`, `GameState`), carry every fixture with quoted markets (client-side FixtureId filtering mandatory), and `Pct` is still `"NA"` on some market types — recompute from `Prices` (decimal×1000).
- **Liked:** one entry per SSE block (never batched), so browser `onmessage` parsing is trivial; and the demargined consensus makes it a clean analytics primitive.
