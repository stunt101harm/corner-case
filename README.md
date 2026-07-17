# ⚽ Corner Case

**Trustless P2P prop bets on any provable World Cup stat — settled by Merkle proof, not by trust.**

Built for the [TxLINE World Cup Hackathon](https://txline.txodds.com/documentation/worldcup) (Superteam Earn, July 2026).

## Judge quickstart

Two ways to see a settlement. The zero-effort path is a pre-settled receipt you can
inspect right now; the hands-on path walks a fresh wallet through a devnet market.

### Zero-effort: read a pre-settled receipt

A market settled on devnet against a real recorded Merkle proof. The receipt re-derives
the full proof chain (stat leaf → eventStatRoot → subtree → main tree → on-chain PDA) in
the browser and recomputes every hash, with no wallet connected:

> Pre-settled receipt: <!-- receipt-url --> _populated by #18 once the hosted frontend is
> deployed; until then, the same proof/receipt is exercised end-to-end in
> `tests/corner_case.ts` (the "settles a real recorded proof" suite) and the underlying
> settle transaction is replayable against the cloned devnet `daily_scores_roots` account._

### Hands-on: Phantom → fund → accept → settle → receipt

1. **Install Phantom** (Solana) and switch the network to **Devnet**.
2. **Fund the wallet** — in the hosted app, click **Get test funds** (devnet SOL +
   self-minted USDC-dev, so you are staking within a minute). On a clean devnet wallet you
   can also run `solana airdrop 2` and mint test USDC-dev yourself.
3. **Create a market** — pick a fixture from the builder, choose a template (e.g.
   "total corners > 9"), pick a side, set a stake, and sign. Your USDC-dev moves into the
   market-PDA-owned escrow; the exact `validateStatV2` strategy you signed is stored on the
   market account — **what you sign is what settles**.
4. **Accept with a second wallet** — open the market in the markets list and accept. The
   taker stakes 1:1; the market is now `Matched`.
5. **Settle** — when the match finalises, hit **Settle now** (demo mode replays a recorded
   match at 30× straight into the live view). The keeper submits the TxLINE Merkle proof;
   our escrow program CPIs into TxLINE's `validateStatV2` against the on-chain daily root.
   Payout is a deterministic pure function of cryptographically attested data.
6. **Read the receipt** — settle tx explorer link, animated Merkle chain, and an
   in-browser **re-verify** button. Fully readable with no wallet connected.

> **Hosted app:** <!-- app-url --> _populated by #18 — the Next.js frontend deploys to the
> always-on host alongside the keeper/relay. Status: not yet deployed; see issue #18._
>
> **Demo video (≤5 min):** <!-- demo-video --> _populated by #20 — unlisted Loom/YouTube
> cut, shot to the script in the "Demo video outline" section of `PLAN.md`. Status: not
> yet recorded; see issue #20._

## What it does

Two fans stake USDC against each other on props like *"total corners > 9"*, *"zero red cards in the second half"*, or *"Argentina out-corners France"*. The market account stores the exact TxLINE `validateStatV2` strategy at creation — **what you sign is what settles**. When the match finalises, a permissionless keeper submits TxLINE's Merkle proofs and the escrow program CPIs into TxLINE's on-chain validation program: payout is a deterministic pure function of cryptographically attested match data.

- 🔮 **No oracle wallet** — settlement requires a valid Merkle proof against TxLINE's on-chain daily roots
- 🧾 **Verifiable receipts** — every settlement shows the full proof chain (stat leaf → event root → subtree → main tree → on-chain PDA) and re-verifies it in your browser
- 🛡️ **Custom check gates** — kickoff deadline, finality gate, and seq-monotonicity checks, each documented with the failure it prevents

## Check gates

Every gate is enforced on-chain in the settlement program (`programs/corner_case/src/`),
not at the keeper. Each exists because a missing check would let a real attack flip a
payout; the right-hand column names that attack.

| # | Gate | Enforces | Prevents |
|---|---|---|---|
| 1 | Kickoff deadline | no market creation or accept at/after `kickoff_ts` (`create_market`, `accept_market`) | betting on a known outcome once kickoff has passed |
| 2 | Finality | every proven stat leaf carries `period == 100` (game_finalised); `settle_market` rejects any mid-match record | settling "zero H2 red cards" **YES** on a halftime proof that merely shows zero-so-far — a non-monotone prop settled wrongly on partial data |
| 3 | Epoch-day window | the caller's `epoch_day` must be the market's stored day or the day after | shopping arbitrary historical roots to settle against a stale day that happens to verify the proof |
| 4 | Fixture binding | `payload.fixture_summary.fixture_id == market.fixture_id` | any finished match somewhere whose stats satisfy the predicate settling this market ("some game always has >9 corners") |
| 5 | Stat-key binding | every proven leaf key == the market's pinned ordered `stat_keys`, in order | a keeper satisfying "corners P1+P2 > 9" with a perfectly valid proof of **goals** (keys 1,2) instead of corners (7,8), since TxLINE strategies address leaves by index, not key |

> Note on the planned "seq policy" gate (grace window after `game_finalised` to absorb
> official stat corrections): the spike observed no post-`period==100` stat corrections on
> the recorded England v Argentina semi-final, so the production gate set above covers what
> was empirically attackable. The seq/grace gate remains described (with its de-scope cost)
> in `PLAN.md` as a fallback if a future fixture shows post-final corrections.

## Technical documentation

### Core idea

Trustless 1v1 prop bets on provable World Cup stats. Two wallets stake USDC-dev against
each other on a predicate like "total corners > 9" or "zero red cards in H2". The market
account stores the exact TxLINE `validateStatV2` strategy at creation, byte-for-byte as
the TxLINE SDK encodes it — what the two parties signed is exactly what later settles. At
match finalisation a permissionless keeper submits TxLINE's Merkle proofs and our escrow
program verifies them via TxLINE's on-chain validation program. Payout is a deterministic
pure function of TxLINE-attested data: no oracle wallet, no bookie, no admin key, nobody
whose discretion decides who won.

### Architecture

Three components (full implementation plan: [`PLAN.md`](PLAN.md)):

1. **Anchor program (devnet)** — `create_market` · `accept_market` · `settle_market`
   (CPI → TxLINE `validateStatV2`) · `cancel` · `void`. Market PDA
   `["market", creator, nonce u64 LE]`; escrow is a market-PDA-owned token ATA on the
   pinned USDC-dev mint. Settlement is permissionless — anyone may settle any matched
   market, because nothing the caller controls can change the outcome.
2. **Keeper + relay (TypeScript, always-on host)** — TxLINE auth as a managed resource
   (guest JWT → devnet `subscribe` tx → `/api/token/activate`, with proactive refresh),
   fixture sync, SSE scores consumer, proof fetcher, state-based (not edge-triggered)
   auto-settlement, and a recorder/replay harness. The relay re-serves cached fixtures and
   re-broadcasts SSE using the keeper's token, so the frontend never talks to TxLINE
   directly (judges will not sign a subscribe tx).
3. **Frontend (Next.js + wallet adapter)** — market builder with hardcoded spike-tested
   templates, open markets list with a one-click **Get test funds** faucet, live match view
   with an SSE ticker and per-market condition tracker, settlement receipt (animated Merkle
   chain + in-browser re-verify, readable with no wallet), and a first-class judge demo
   mode for post-tournament judging.

### Settlement path chosen, and why

Three designs were considered at the spike fork (`spike/NOTES.md`):

- **Path A — CPI wrapper** — CPI into `validateStatV2` and read the verdict from CPI return
  data. Requires well-defined FALSE-case return semantics, CU headroom under the
  transaction-wide 1.4M limit, and a proof payload that fits the 1232-byte tx limit.
- **Path B — same-tx two-instruction settle** — direct `validateStatV2` +
  Instructions-sysvar introspection. Valid only if `validateStatV2` hard-errors on a false
  predicate.
- **Path C — in-program Merkle verification** — verify the proof chain directly in our
  program with sha256 syscalls against the `daily_scores_roots` account. Strongest fallback,
  no CPI, but requires reconstructing TxLINE's exact leaf/node hashing scheme.

**Shipped: Path A.** The spike ran a real `validateStatV2` against the on-chain devnet
program with the recorded England v Argentina semi-final proof and found:

- `validateStatV2` returns `borsh(bool)` for a valid proof and **hard-errors** on any
  invalid proof (corrupted stat proof → `InvalidStatProof` 6023).
- ⚠️ A **FALSE predicate still succeeds** (`returnData [0]`) — so CPI success only means
  "the proof is real", never "the predicate holds". `settle_market` therefore reads the bool
  from `get_return_data()` and `require_keys_eq!` checks the returning `program_id` is
  TxLINE's, not some inner CPI — this is the load-bearing correctness check Path A needed.
- CU ≤353k for the largest 4-leaf stress case (well under 1.4M with ~50k wrapper overhead);
  product templates are 1–2 leaves (≤~811 B payload, fits 1232 B). A 4-leaf prop (1,187 B)
  would not fit, so UI templates are capped at ≤2 leaves.

Paths B and C were not needed; both remain documented in `PLAN.md` as fallbacks.

### TxLINE endpoints and surface used

REST / SSE:
- `/auth/guest/start` — guest JWT to begin the free-tier auth chain
- on-chain `subscribe` (free tier, service level 1) — Token-2022 ATA, pre-funds the keeper keypair
- `/api/token/activate` — exchange the subscribe signature for an API token + TTL
- `/api/fixtures/snapshot` — fixture list (real WC fixture IDs confirmed on devnet)
- `/api/scores/stream` (SSE) — live scores (latency optimization only; settlement is state-based)
- `/api/scores/snapshot/{fixtureId}` — poll-based finalisation trigger (`period/statusId == 100`)
- `/api/scores/updates/{fixtureId}` — backfill
- `/api/scores/stat-validation` (V2 params) — Merkle proof fetch (`fixtureId`, `seq`, `statKeys`)
- `/api/scores/historical/{fixtureId}` (undocumented) — full match log as SSE lines, `id == Seq`

On-chain (devnet program `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`):
- `validateStatV2` (CPI target) — returns `bool` via Anchor return data
- `daily_scores_roots` PDA `["daily_scores_roots", epoch_day u16 LE]` — the on-chain Merkle
  root a proof must chain to; one 32-byte root per 5-min batch, posted daily
- period-prefixed stat keys (`0`/`1000`/`3000` = total/H1/H2) and historical replay data

### Deployed program

| Item | Value |
|---|---|
| Program (devnet) | `J5ip9R8afPE8wB6EPXFBaXBpr78EtQfQeG3nNr681bBN` |
| Mint (USDC-dev, devnet) | `Cx9Y63x8YN7x9UMFba4B1HdmmmH9QVZbvTZgz7k8kspy` |
| TxLINE program (devnet) | `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` |
| Cluster | devnet |

Program ID and mint sources: `Anchor.toml` and `programs/corner_case/src/{lib.rs,constants.rs}`.

## Status

🚧 Hackathon build in progress — deadline July 19, 2026 23:59 UTC. Track progress in the [issues](../../issues).

## License

Apache-2.0
