//! accept_market — taker matches the creator's stake 1:1 and the market locks.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::*, errors::CornerCaseError, state::*};

#[derive(Accounts)]
pub struct AcceptMarket<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    /// Re-derived from the *stored* creator + nonce, so a forged account at
    /// the right discriminator can't stand in for a real market.
    #[account(
        mut,
        seeds = [Market::SEED, market.creator.as_ref(), &market.nonce.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(address = USDC_MINT @ CornerCaseError::WrongMint)]
    pub mint: Account<'info, Mint>,

    /// Taker's canonical ATA — derived from (taker, pinned mint).
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = taker,
    )]
    pub taker_ata: Account<'info, TokenAccount>,

    /// The market's escrow ATA, re-derived — funds can only land in the one
    /// escrow this market owns.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = market,
    )]
    pub escrow: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<AcceptMarket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let market = &ctx.accounts.market;

    // Only an open market can be taken; a matched/terminal one is spoken for.
    require!(market.state == MarketState::Open, CornerCaseError::MarketNotOpen);

    // ── Check gate #1 (kickoff deadline) ────────────────────────────────
    // No accepts at or after kickoff. Without this, a taker could watch the
    // match start (or finish) and only then take the side that is already
    // winning — betting on a known outcome. Strict `<`: at kickoff the book
    // is closed.
    require!(now < market.kickoff_ts, CornerCaseError::KickoffPassed);

    // Self-matching would let a creator fake volume and, post-settlement UI,
    // fake "settled market" receipts with zero risk.
    require!(
        ctx.accounts.taker.key() != market.creator,
        CornerCaseError::SelfMatch
    );

    // Match the stake 1:1 before recording the taker (funds first, state after).
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.taker_ata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.taker.to_account_info(),
            },
        ),
        market.stake,
        ctx.accounts.mint.decimals,
    )?;

    let market = &mut ctx.accounts.market;
    market.taker = ctx.accounts.taker.key();
    market.state = MarketState::Matched;

    Ok(())
}
