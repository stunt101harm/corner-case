# Spike findings (issues #2, #3) — running notes

## Confirmed on devnet (2026-07-17)
- Auth chain end-to-end ✅ — subscribe tx `66ynwpRQefrhpme2tsG12oFA3DYswzvbZgXsnsF9DzYpVXDfhmCRXayTM5Fvj92QgUXphY3iWVTbAgNCBEsDW7iV`, API token acquired. Service level 1: 0 tokens/week, sampling 0s, league bundle 1, market bundle 2. `weeks` must be multiple of 4.
- TxLINE devnet program `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` exists, executable ✅
- `daily_scores_roots` PDAs: 9,232 B (16 B header + 288 × 32 B = one root per 5-min batch). Present daily June 27 → July 15 except Jul 8/13 (WC rest days); Jul 16/17 absent (rest days before 3rd-place match). **Retention: weeks — replay mode viable.**
- Devnet data API: **outage observed 21:25 UTC** — all data endpoints 503; auth endpoints unaffected; mainnet up. Monitor running.

## From IDL (v1.5.6, devnet address confirmed)
- `validate_stat_v2(payload: StatValidationInput, strategy: NDimensionalStrategy)` → **returns bool** (Anchor return-data). Single account: `daily_scores_merkle_roots`.
- `StatValidationInput { ts: i64, fixture_summary: ScoresBatchSummary, fixture_proof: Vec<ProofNode>, main_tree_proof: Vec<ProofNode>, event_stat_root: [u8;32], stats: Vec<StatLeaf> }`
- `ScoresBatchSummary { fixture_id: i64, update_stats: ScoresUpdateStats, events_sub_tree_root: [u8;32] }` — **fixture_id is typed + inside the proof chain → fixture binding solved** (settle_market checks `payload.fixture_summary.fixture_id == market.fixture_id`).
- `ScoreStat { key: u32, value: i32, period: i32 }` — every proven leaf carries `period` → candidate trivial finality gate (require `period == 100`); empirical check pending API recovery.
- `StatPredicate = Single { index: u8, predicate } | Binary { index_a, index_b, op, predicate }`; `BinaryExpression = Add | Subtract` (**Add exists** — "corners A + corners B > N" maps natively); `Comparison = GreaterThan | LessThan | EqualTo`.
- `validate_stat_v3` exists (multiproof) — undocumented; v2 sufficient for us.
- PDA: `["daily_scores_roots", epoch_day u16 LE]`, epochDay = floor(ts_ms / 86400000), ts from `summary.updateStats.minTimestamp`.

## Assets
- Our USDC-dev mint (devnet): `Cx9Y63x8YN7x9UMFba4B1HdmmmH9QVZbvTZgz7k8kspy` (6 dp, authority = deploy wallet)
- Known devnet example fixture: `18179550` seq `1315` (from official examples; pre-WC test data)

## Open questions (blocked on API recovery)
- Real proof payload capture; statKeys coverage for WC fixtures across period prefixes
- `ScoreStat.period` semantics at `game_finalised` (== 100?)
- Post-final seq corrections; root-posting lag
- CPI probe: return-data semantics TRUE/FALSE/corrupted + CU consumption + tx size

---

# SPIKE VERDICT (2026-07-17 ~22:00 UTC) — settlement Path A: CPI wrapper. GO.

## Empirical results (real proof, England v Argentina 18241006, devnet)

Simulated `validateStatV2` against the on-chain devnet program with the real seq-962 (game_finalised) proof:

| Case | Result | CU | tx size |
|---|---|---|---|
| TRUE binary (away−home goals > 0) | Ok, returnData `[1]` | 199,670 | 811 B |
| FALSE binary (home−away goals > 0) | Ok, returnData `[0]` | 199,649 | 811 B |
| Corrupted stat proof (bit flip) | **hard error** `InvalidStatProof` 6023 | 125,601 | 811 B |
| 4-leaf, 3 predicates (stress) | Ok `[1]` | 352,508 | 1,187 B |

- **Return semantics:** bool via Anchor return data; program hard-errors on invalid proofs. ⚠️ FALSE predicate ALSO succeeds (returnData [0]) — settle_market must read the bool from `get_return_data()` and check the returning program_id; CPI success ≠ predicate true.
- **CU:** ≤353k incl. 1.4M budget — our wrapper overhead (~50k) fits trivially. Path B/C fallbacks not needed.
- **Tx size:** all product templates are 1–2 leaves (≤ ~811 B payload) — fits under 1,232 B with our ~250 B of settle accounts. 4-leaf props (1,187 B) would NOT fit → templates stay ≤2 leaves (UI-enforced).
- **Finality gate (check gate #2) validated:** proven leaves carry the record's status period — `period: 100` at seq 962 (game_finalised), `period: 3` at seq 425 (halftime). Gate = require `period == 100` on every proven leaf. Mid-match proof captured as the adversarial test fixture.
- **statKeys limits:** 1–5 keys per stat-validation request. Zero-value leaves ARE provable (3005:0 = "no H2 reds"). Per-period keys (1001/1002/3001/3005/3006) all provable at final seq.
- **Fixture binding:** `payload.fixture_summary.fixture_id` is typed and inside the proven chain — settle_market enforces `== market.fixture_id`.
- **Epoch day:** derived from `summary.updateStats.minTimestamp` (== game_finalised Ts). Neither remaining WC fixture crosses midnight UTC (3rd place 21:00, final 19:00) — `{stored, stored+1}` tolerance retained regardless.

## World Cup on devnet (confirmed)
- Fixtures snapshot carries the real tournament: **18257865 France v England (3rd place, Jul 18 21:00 UTC)**, **18257739 Spain v Argentina (FINAL, Jul 19 19:00 UTC)**, + Vietnam v Myanmar friendly Jul 18 12:00 UTC (early live test target).
- `/api/scores/historical/{fixtureId}` (undocumented) returns the full match log as SSE lines (`data:`/`id:`) — id == Seq. England v Argentina: 964 records, 1.0 MB → committed as `recordings/18241006-england-argentina-semi.sse` (canonical replay recording).
- England 1–2 Argentina; key map confirmed: 1/2 goals, 3/4 yellows, 5/6 reds, 7/8 corners (P1/P2), prefix 0/1000/3000 = total/H1/H2. `halftime_finalised` → StatusId 3; `game_finalised` → StatusId 100, and it was the last stats-bearing record (no post-final corrections observed).

## Still to measure live (Jul 18, during 3rd-place match)
- Root-posting lag: SSE game_finalised → first proof available → first on-chain root that verifies it.
- Guest JWT TTL under long-running keeper; SSE reconnect/Last-Event-ID behavior.
