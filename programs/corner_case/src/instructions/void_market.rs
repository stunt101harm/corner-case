//! void_market — permissionless mutual-refund escape hatch.
//!
//! If a matched market is still unsettled VOID_DELAY_SECS after kickoff
//! (dead keeper, TxLINE outage, unprovable stat), *anyone* can unwind it:
//! both stakes go back to their owners' canonical ATAs. The only signer is
//! the fee payer (any wallet) — the safety valve must not depend on either
//! party's key, and the caller fronts rent if a refund ATA was closed.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked},
};

use crate::{constants::*, errors::CornerCaseError, state::*};

#[derive(Accounts)]
pub struct VoidMarket<'info> {
    /// Any fee payer; also fronts rent to recreate a closed refund ATA
    /// (init_if_needed below) so neither party can brick the escape hatch
    /// by closing their token account.
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        close = creator, // Market rent back to the creator who paid it.
        has_one = creator @ CornerCaseError::Unauthorized,
        seeds = [Market::SEED, market.creator.as_ref(), &market.nonce.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    /// CHECK: pinned to the stored `market.creator` by has_one; receives the
    /// escrow + market rent and (via ATA derivation below) the refund.
    #[account(mut)]
    pub creator: UncheckedAccount<'info>,

    /// CHECK: pinned to the stored `market.taker` in the handler (not via
    /// has_one: an *unmatched* market stores `Pubkey::default()` here, and a
    /// constraint would mask the real "market is not matched" error). The
    /// binding is enforced before any transfer; only used as the ATA
    /// derivation authority below.
    pub taker: UncheckedAccount<'info>,

    #[account(address = USDC_MINT @ CornerCaseError::WrongMint)]
    pub mint: Account<'info, Mint>,

    /// Refund destinations are both *derived* ATAs of the stored parties —
    /// the caller (who can be anyone) picks nothing. Recreated on the spot
    /// if a party closed theirs (funds must never strand).
    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = mint,
        associated_token::authority = creator,
    )]
    pub creator_ata: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = mint,
        associated_token::authority = taker,
    )]
    pub taker_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = market,
    )]
    pub escrow: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn void_market_handler(ctx: Context<VoidMarket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &ctx.accounts.market;

    // Only a *matched* market can be voided: an open one has a unilateral
    // cancel, and terminal states have nothing left in escrow.
    require!(
        market.state == MarketState::Matched,
        CornerCaseError::MarketNotMatched
    );

    // Taker binding (deferred from the accounts struct — see field docs):
    // the taker_ata refund destination below derives from this account, so
    // it must be the stored taker before a single token moves.
    require_keys_eq!(
        ctx.accounts.taker.key(),
        market.taker,
        CornerCaseError::TakerMismatch
    );

    // The delay is what makes this an escape hatch rather than a rug: a
    // losing side must not be able to void the moment the result is known —
    // the keeper (or any honest party) gets VOID_DELAY_SECS after kickoff to
    // land a proof-backed settlement first.
    require!(
        now > market.kickoff_ts + VOID_DELAY_SECS,
        CornerCaseError::VoidDelayNotElapsed
    );

    let creator_key = market.creator;
    let nonce_bytes = market.nonce.to_le_bytes();
    let bump = [market.bump];
    let signer_seeds: &[&[&[u8]]] =
        &[&[Market::SEED, creator_key.as_ref(), &nonce_bytes, &bump]];

    // Escrow must hold at least both stakes (only this program moves funds
    // out, so anything else is an invariant break worth failing loudly on).
    let escrow_balance = ctx.accounts.escrow.amount;
    let stake = market.stake;
    require!(
        escrow_balance >= stake.saturating_mul(2),
        CornerCaseError::EscrowUnderfunded
    );

    let decimals = ctx.accounts.mint.decimals;

    // Taker gets exactly their stake back...
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.escrow.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.taker_ata.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signer_seeds,
        ),
        stake,
        decimals,
    )?;

    // ...and the creator gets everything that remains (their stake plus any
    // dust donated to the escrow ATA). Sweeping to zero is what lets the
    // CloseAccount below succeed unconditionally — a fixed 2x-stake refund
    // could be griefed shut by a 1-lamport token donation.
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.escrow.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.creator_ata.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signer_seeds,
        ),
        escrow_balance - stake, // >= stake by the check above
        decimals,
    )?;

    // Escrow rent goes to the creator, who paid for it at create_market.
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.creator.to_account_info(),
            authority: ctx.accounts.market.to_account_info(),
        },
        signer_seeds,
    ))?;

    // Terminal state for the logs; Anchor then closes the Market account.
    ctx.accounts.market.state = MarketState::Voided;

    Ok(())
}
