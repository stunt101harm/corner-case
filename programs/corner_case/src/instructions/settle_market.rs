//! settle_market — STUB. The settlement path (issue #4 scope boundary).
//!
//! The Phase-0 spike decides which of three designs lands here (see PLAN.md,
//! "Settlement path"): Path A (CPI into TxLINE `validateStatV2` + return-data
//! check), Path B (same-tx two-instruction settle with Instructions-sysvar
//! introspection), or Path C (in-program Merkle verification with sha256
//! syscalls against the `daily_scores_roots` account).
//!
//! Whatever the path, the implementation contract is already fixed:
//! - Args: proof payload + `epoch_day` (constrained to `{market.epoch_day,
//!   market.epoch_day + 1}` — evening kickoffs finalise after 00:00 UTC).
//! - Derive `["daily_scores_roots", epoch_day u16 LE]` against TxLINE's
//!   program id `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J` — never trust
//!   a caller-supplied roots account.
//! - Fixture binding: `payload.fixture_summary.fixture_id` is typed and
//!   inside the proof chain (spike finding) — require it equals
//!   `market.fixture_id`, or any >9-corner game anywhere settles this market.
//! - Splice `market.strategy` verbatim into the validation call: what was
//!   signed at create is what settles.
//! - Both `creator_ata` and `taker_ata` passed and ATA-constrained (mirror
//!   the VoidMarket accounts); the predicate boolean XOR `market.creator_side`
//!   selects between two *constrained* accounts — no free winner account.
//! - Set `state = Settled` BEFORE the outbound transfer so a double-settle
//!   race dies as a state error, not a drained escrow.
//! - Check gate #2 (finality: `period == 100` leaf) and #3 (seq policy) per
//!   the spike's findings.
//! - Close escrow (PDA signer, sweep full balance) + Market (`close =
//!   creator`) to recover rent, exactly like cancel/void.

use anchor_lang::prelude::*;

use crate::{errors::CornerCaseError, state::*};

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    /// Permissionless caller (the keeper in practice, but anyone may settle).
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [Market::SEED, market.creator.as_ref(), &market.nonce.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
    // The real implementation adds: mint, creator_ata, taker_ata, escrow
    // (all constrained as in VoidMarket), the TxLINE roots account, and the
    // path-specific accounts (TxLINE program for A, Instructions sysvar
    // for B, nothing extra for C).
}

pub fn settle_market_handler(_ctx: Context<SettleMarket>) -> Result<()> {
    // Deliberate hard stop: the account/state design above is final, but no
    // settlement may happen until the spike-chosen validation path lands.
    err!(CornerCaseError::SettlementNotImplemented)
}
