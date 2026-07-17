//! cancel_market — creator reclaims an unmatched market (stake + all rent).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

use crate::{constants::*, errors::CornerCaseError, state::*};

#[derive(Accounts)]
pub struct CancelMarket<'info> {
    /// Must be the stored creator (has_one below) — nobody else can pull an
    /// open market out from under would-be takers, or steal the refund.
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        mut,
        close = creator, // Market rent back to the creator who paid it.
        has_one = creator @ CornerCaseError::Unauthorized,
        seeds = [Market::SEED, market.creator.as_ref(), &market.nonce.to_le_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,

    #[account(address = USDC_MINT @ CornerCaseError::WrongMint)]
    pub mint: Account<'info, Mint>,

    /// Refund destination: the creator's canonical ATA, derived — not a
    /// caller-supplied account.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = creator,
    )]
    pub creator_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = market,
    )]
    pub escrow: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CancelMarket>) -> Result<()> {
    let market = &ctx.accounts.market;

    // Once matched, the taker has money at stake — the exit paths are
    // settlement or the mutual void, never a unilateral cancel.
    require!(market.state == MarketState::Open, CornerCaseError::MarketNotOpen);

    // The market PDA is the escrow authority; sign with its stored seeds.
    let creator_key = market.creator;
    let nonce_bytes = market.nonce.to_le_bytes();
    let bump = [market.bump];
    let signer_seeds: &[&[&[u8]]] =
        &[&[Market::SEED, creator_key.as_ref(), &nonce_bytes, &bump]];

    // Refund the escrow's *entire* balance, not just `stake`: if anyone
    // donated dust to the escrow ATA, a fixed-amount refund would leave a
    // nonzero balance and make the CloseAccount below fail forever —
    // a cheap way to grief the market shut. Sweeping the balance kills that.
    let refund = ctx.accounts.escrow.amount;
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
        refund,
        ctx.accounts.mint.decimals,
    )?;

    // Close the escrow ATA (rent to creator) with the same PDA signer.
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.creator.to_account_info(),
            authority: ctx.accounts.market.to_account_info(),
        },
        signer_seeds,
    ))?;

    // Terminal state for the logs; Anchor closes the Market account
    // (close = creator) when this instruction returns.
    ctx.accounts.market.state = MarketState::Cancelled;

    Ok(())
}
