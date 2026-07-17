//! create_market — creator opens a market and funds their side of the escrow.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

use crate::{constants::*, errors::CornerCaseError, state::*};

#[derive(Accounts)]
#[instruction(
    nonce: u64,
    fixture_id: i64,
    epoch_day: u16,
    kickoff_ts: i64,
    creator_side: bool,
    stake: u64,
    strategy: Vec<u8>
)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// Space is allocated from the actual strategy arg, so a 16-byte
    /// "corners > 9" market doesn't pay rent for 512 bytes.
    #[account(
        init,
        payer = creator,
        space = Market::space(strategy.len()),
        seeds = [Market::SEED, creator.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub market: Account<'info, Market>,

    /// Pinned settlement mint. `address =` makes "wrong token" a constraint
    /// violation, not a runtime branch someone can forget.
    #[account(address = USDC_MINT @ CornerCaseError::WrongMint)]
    pub mint: Account<'info, Mint>,

    /// Creator's canonical USDC-dev ATA — derived, never free-form.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = creator,
    )]
    pub creator_ata: Account<'info, TokenAccount>,

    /// Escrow = the market PDA's own ATA for the pinned mint. Nobody holds a
    /// key for it; only this program can sign it via the market seeds.
    #[account(
        init,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = market,
    )]
    pub escrow: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<CreateMarket>,
    nonce: u64,
    fixture_id: i64,
    epoch_day: u16,
    kickoff_ts: i64,
    creator_side: bool,
    stake: u64,
    strategy: Vec<u8>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // A zero-stake market would be free spam that still costs a taker rent
    // and keeper attention.
    require!(stake > 0, CornerCaseError::ZeroStake);

    // Opaque but bounded: too short can't encode a predicate, too long is
    // rent/compute abuse at settlement time.
    require!(
        (MIN_STRATEGY_LEN..=MAX_STRATEGY_LEN).contains(&strategy.len()),
        CornerCaseError::StrategyLengthOutOfBounds
    );

    // A market created after kickoff could be accepted mid-match against
    // partially known outcomes; refuse at the source rather than relying on
    // gate #1 alone.
    require!(kickoff_ts > now, CornerCaseError::KickoffNotInFuture);

    // Fund the creator's side before recording anything: escrow reality
    // always >= recorded stake.
    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.creator_ata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.creator.to_account_info(),
            },
        ),
        stake,
        ctx.accounts.mint.decimals,
    )?;

    let market = &mut ctx.accounts.market;
    market.creator = ctx.accounts.creator.key();
    market.taker = Pubkey::default(); // sentinel: unmatched
    market.fixture_id = fixture_id;
    market.epoch_day = epoch_day;
    market.kickoff_ts = kickoff_ts;
    market.stake = stake;
    market.creator_side = creator_side;
    market.state = MarketState::Open;
    market.nonce = nonce;
    market.bump = ctx.bumps.market;
    market.created_at = now;
    market.strategy = strategy;

    Ok(())
}
