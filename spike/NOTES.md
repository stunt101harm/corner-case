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
