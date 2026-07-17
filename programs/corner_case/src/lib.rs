//! Corner Case — trustless P2P prop bets on provable World Cup stats,
//! settled by TxLINE Merkle proofs.
//!
//! Two wallets stake USDC-dev against each other on a predicate ("total
//! corners > 9"). The market stores the exact TxLINE `validateStatV2`
//! strategy bytes at creation, escrow lives in a market-PDA-owned ATA of a
//! pinned mint, and settlement (separate spike-decided path) pays out as a
//! pure function of TxLINE-attested data. No oracle wallet, no bookie, no
//! admin key — and a permissionless void hatch so funds can never strand.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;
pub mod txoracle;

use instructions::*;

declare_id!("J5ip9R8afPE8wB6EPXFBaXBpr78EtQfQeG3nNr681bBN");

#[program]
pub mod corner_case {
    use super::*;

    /// Open a market: init the Market PDA (space sized to the strategy),
    /// init the PDA-owned escrow ATA, move the creator's stake in.
    #[allow(clippy::too_many_arguments)]
    pub fn create_market(
        ctx: Context<CreateMarket>,
        nonce: u64,
        fixture_id: i64,
        epoch_day: u16,
        kickoff_ts: i64,
        creator_side: bool,
        stake: u64,
        strategy: Vec<u8>,
        stat_keys: Vec<u32>,
    ) -> Result<()> {
        create_market_handler(
            ctx,
            nonce,
            fixture_id,
            epoch_day,
            kickoff_ts,
            creator_side,
            stake,
            strategy,
            stat_keys,
        )
    }

    /// Take the other side 1:1. Check gate #1: no accepts at/after kickoff.
    pub fn accept_market(ctx: Context<AcceptMarket>) -> Result<()> {
        accept_market_handler(ctx)
    }

    /// Creator-only: reclaim an unmatched market (stake + all rent).
    pub fn cancel_market(ctx: Context<CancelMarket>) -> Result<()> {
        cancel_market_handler(ctx)
    }

    /// Permissionless mutual refund once a matched market has sat unsettled
    /// for VOID_DELAY_SECS past kickoff.
    pub fn void_market(ctx: Context<VoidMarket>) -> Result<()> {
        void_market_handler(ctx)
    }

    /// Permissionless settlement: CPI into TxLINE's `validateStatV2` with
    /// the STORED strategy against the caller-selected daily root, read the
    /// verdict from return data, pay the winning side. Five check gates —
    /// see instructions/settle_market.rs for the full story.
    pub fn settle_market(
        ctx: Context<SettleMarket>,
        epoch_day: u16,
        payload: txoracle::StatValidationInput,
    ) -> Result<()> {
        settle_market_handler(ctx, epoch_day, payload)
    }
}
