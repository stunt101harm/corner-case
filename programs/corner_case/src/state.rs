use anchor_lang::prelude::*;

/// Lifecycle of a market. Terminal states (Settled/Cancelled/Voided) are set
/// just before the Market account is closed in the same instruction — they
/// exist so the state machine is explicit and so a double-spend race resolves
/// as a clean state error, never as a second payout.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarketState {
    /// Created and funded by the creator; waiting for a taker.
    Open,
    /// Taker matched 1:1 before kickoff; escrow holds both stakes.
    Matched,
    /// Settled against a TxLINE Merkle proof; winner paid.
    Settled,
    /// Creator reclaimed an unmatched market.
    Cancelled,
    /// Mutual refund via the post-fixture escape hatch.
    Voided,
}

/// One P2P market. PDA: `["market", creator, nonce u64 LE]` — the nonce keeps
/// one creator free to open several markets on the same fixture (the demo
/// creates two).
///
/// `strategy` is the byte-exact TxLINE `validateStatV2` strategy encoding,
/// captured at creation: "what you sign is what settles". The program never
/// interprets it; settle_market splices it verbatim into the validation call.
#[account]
pub struct Market {
    /// Market creator; funded the first stake, receives rent on close.
    pub creator: Pubkey,
    /// Matched taker; `Pubkey::default()` until accept_market.
    pub taker: Pubkey,
    /// TxLINE fixture id (i64, TxLINE's native type). Settlement must bind
    /// proofs to this exact fixture — see settle_market stub notes.
    pub fixture_id: i64,
    /// Creation-time estimate of the TxLINE `daily_scores_roots` epoch day
    /// (floor(ts_ms / 86_400_000)). settle_market will accept {stored,
    /// stored+1} because evening kickoffs finalise after 00:00 UTC.
    pub epoch_day: u16,
    /// Scheduled kickoff (unix). Check gate #1 (accepts) and the void escape
    /// hatch both key off this.
    pub kickoff_ts: i64,
    /// Per-side stake in USDC-dev base units. Escrow holds 2x once matched.
    pub stake: u64,
    /// true = creator bets the strategy predicate evaluates TRUE.
    pub creator_side: bool,
    /// Lifecycle state; every instruction checks it first.
    pub state: MarketState,
    /// PDA seed component; creator-chosen, collision-free per creator.
    pub nonce: u64,
    /// PDA bump, stored once at init so every later signer derivation is O(1)
    /// and canonical.
    pub bump: u8,
    /// Creation unix time (Clock), for UI/keeper bookkeeping.
    pub created_at: i64,
    /// Opaque TxLINE strategy bytes (see struct docs). Variable length —
    /// account space is allocated from the instruction arg at init.
    pub strategy: Vec<u8>,
    /// Check gate #5: the ordered TxLINE stat keys the strategy's leaf
    /// indices refer to (index i in the strategy == key stat_keys[i]).
    /// Settlement refuses a proof whose leaves don't match this list exactly
    /// — without it, a valid proof of the WRONG stats (goals instead of
    /// corners) could flip the payout. 1–5 keys (TxLINE's per-proof limit).
    pub stat_keys: Vec<u32>,
}

impl Market {
    pub const SEED: &'static [u8] = b"market";

    /// Byte length of all fixed fields (everything except the 8-byte
    /// discriminator and the 4-byte-prefixed strategy vec):
    /// creator 32 + taker 32 + fixture_id 8 + epoch_day 2 + kickoff_ts 8
    /// + stake 8 + creator_side 1 + state 1 + nonce 8 + bump 1 + created_at 8.
    pub const BASE_LEN: usize = 32 + 32 + 8 + 2 + 8 + 8 + 1 + 1 + 8 + 1 + 8;

    /// Full account size for given strategy and stat-key lengths (both vecs
    /// carry a 4-byte borsh length prefix).
    pub const fn space(strategy_len: usize, stat_keys_len: usize) -> usize {
        8 + Self::BASE_LEN + 4 + strategy_len + 4 + stat_keys_len * 4
    }
}
