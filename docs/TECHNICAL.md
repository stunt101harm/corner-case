# Corner Case — Technical Documentation

*The brief technical overview required by the submission, plus enough depth to
audit our claims. Everything here is verified — by the 30-test suite, by
devnet transactions you can open, or by the spike notes with raw data.*

## Core idea

A prop bet is a predicate over match statistics. TxLINE publishes every match
stat as a leaf in a Merkle tree whose daily roots live on-chain, and exposes
`validate_stat_v2` — an instruction that takes a proof + an
`NDimensionalStrategy` (threshold predicates over proven leaves) and returns a
bool. So a **market** can be: escrowed stakes + a stored strategy + pinned
stat keys, and **settlement** can be: anyone brings a proof, the program asks
TxLINE's program on-chain whether the predicate holds, and pays accordingly.
Nothing in the settlement path is trusted: not the keeper, not our backend,
not even the market creator.

## Settlement design (the interesting part)

`settle_market` is permissionless. Its arguments are only the proof payload
and the epoch day; everything decision-relevant was pinned earlier:

1. Escrowed at create/accept: both stakes, in an ATA owned by the market PDA.
2. Pinned at create: `strategy` bytes (spliced verbatim into the CPI — "what
   you sign is what settles"), ordered `stat_keys`, `fixture_id`, `epoch_day`
   estimate, both payout destinations (derivation-constrained ATAs — there is
   no free winner account anywhere).
3. At settle, five gates run (README table), then the program builds
   `discriminator ‖ borsh(payload) ‖ stored_strategy_bytes` and CPIs into
   TxLINE's `validate_stat_v2` with the `daily_scores_roots` PDA **derived
   against TxLINE's program id** from the caller's epoch-day argument.
4. The verdict is read from **CPI return data**, with the returning program id
   checked. Spike-verified semantics: invalid proof → the whole tx aborts
   (`InvalidStatProof` etc.); valid proof → `Ok` with borsh(bool). A FALSE
   predicate is a *successful* settlement for the NO side — CPI success is
   never conflated with predicate truth.
5. State flips to `Settled` before funds move; escrow is swept (donation-
   griefing-proof) and both accounts close, rent back to the creator.

Compute: ~200k CU for a 2-leaf validation inside a 1.4M budget; a settle tx
with a 2-leaf proof is ~1.07 KB — under the 1,232-byte packet limit with our
11 accounts. The UI deliberately ships only ≤2-leaf templates (4-leaf proofs
measured at 1,187 B would not fit alongside the accounts).

Escape hatches: `cancel` (creator, unmatched) and a fully permissionless
`void` (matched but unsettled 6h past kickoff → both stakes home). Funds can
never strand on a dead keeper or a TxLINE outage.

## Verified integration facts (spike, day 0)

- `validate_stat_v2(payload, strategy) -> bool` via Anchor return data; hard
  error on any invalid proof. CU: 199,670 (2-leaf) / 352,508 (4-leaf,
  3 predicates). Single account: the daily roots PDA.
- Proof leaves carry the record's status period: `100` at `game_finalised`,
  `3` at halftime — the finality gate is a pure per-leaf check, and our
  adversarial fixture (committed) is a real halftime proof.
- `stat-validation` serves 1–5 keys per request; zero-valued leaves are
  provable ("no H2 reds" is a real proof, not an absence).
- Stat keys: 1/2 goals, 3/4 yellows, 5/6 reds, 7/8 corners (P1/P2);
  +1000/H1, +3000/H2. `fixture_id` sits INSIDE the proven summary node.
- Leaf hashing (reverse-engineered, powers the in-browser re-verify):
  `leaf = sha256(key u32 LE ‖ value i32 LE ‖ period i32 LE)`, folded
  `sha256(left ‖ right)` per `isRightSibling`. Verified: leaf → eventStatRoot
  → fixture subtree root, for all base keys.
- **Period-prefixed keys use an undocumented aggregation scheme**: their
  `statProofs` entries are structured parameter nodes (sentinel 0x01/0xff
  padding), not sibling hashes — only TxLINE's on-chain verifier interprets
  them. Receipts recompute plain-hash legs client-side and label aggregation
  legs as on-chain-verified. (Full writeup in FEEDBACK.md.)
- The devnet feed is the real tournament: the fixtures snapshot carried the
  3rd-place match and the final; `daily_scores_roots` gaps align with rest
  days; historical roots are retained for weeks (replay demos work).

## Determinism & testing

The test validator clones TxLINE's devnet program + the epoch-20649 roots
account (Anchor.toml `[test.validator]`), so `anchor test` runs the identical
byte-for-byte settlement path against committed real proofs — deterministic,
offline-reproducible, no mocks. 30 tests: escrow lifecycle, both payout
directions, each gate attacked individually, corrupted proof (inner TxLINE
error propagates, then the honest proof still settles), double-settle race,
forged destination accounts, permissionless outsider callers.

Three settlement code paths were each verified on devnet with real
transactions: a script (`3jDQv5sP…`), the keeper engine (`3Hw1MyRo…`), and
the web client (`5WyXinoy…`).

## Known limitations (honest list)

- 1v1 fixed-stake markets only — no pools, no pricing/odds engine. Deliberate
  scope: a bulletproof deterministic core over a half-working AMM.
- The UI's 5 templates cover goals/corners/cards props; the program itself
  accepts any ≤512-byte strategy over ≤5 pinned keys.
- `kickoff_ts` is creator-supplied and only checked to be in the future —
  the chain cannot know the real schedule. Gate #1's fairness therefore
  trusts the creator's timestamp; the frontend cross-checks it against
  TxLINE's fixture `StartTime` and refuses to display deviant markets as
  normal. A taker should treat a market whose kickoff disagrees with the
  fixture list as suspect. (Also disclosed here because "nothing is
  trusted" deserves its one asterisk.)
- Keeper grace window (post-final correction absorption) defaults to 120s;
  no correction was observed in recorded matches, and gate #2 + single-shot
  settlement bound the exposure either way.
- Devnet-pinned build (TxLINE program id is a compile-time constant); mainnet
  is a recompile.

## Stack

Anchor 0.31.1 / Rust · TypeScript (zero-dep keeper; Node 20+) · Next.js 14 +
wallet-adapter on Cloudflare Pages · Cloudflare Worker + KV (relay, faucet)
· devnet USDC-dev (self-minted, faucet-distributed).
