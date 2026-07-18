//! settle_market — the settlement engine. Path A: direct CPI into TxLINE's
//! `validateStatV2` with the stored strategy, reading the verdict from CPI
//! return data.
//!
//! Permissionless by design: ANYONE may settle any matched market, because
//! nothing the caller controls can change the outcome. The caller supplies
//! only (a) a Merkle proof that TxLINE's program either verifies or rejects
//! against its own on-chain daily root, and (b) which epoch-day root to check.
//! Everything that decides who gets paid — the strategy, the fixture, the
//! stat keys, the two payout destinations — was pinned at create/accept time.
//!
//! Check gates, each annotated inline with the failure it prevents:
//!   gate #2 (finality)      — every proven leaf must carry period == 100
//!   gate #3 (epoch window)  — caller's epoch_day ∈ {stored, stored+1}
//!   gate #4 (fixture bind)  — payload.fixture_summary.fixture_id == market
//!   gate #5 (stat-key bind) — payload leaf keys == market.stat_keys, in order
//!
//! (Gate #1, the kickoff deadline, lives in accept_market. A "proof must be
//! newer than kickoff" check is deliberately absent: gate #2 already proves
//! the match FINISHED and gate #4 that it is THIS match — a finalised proof
//! from before kickoff cannot exist, and dropping the redundant check lets
//! the deterministic test suite replay historical fixtures.)
//!
//! Why gate #5 exists (found in our own adversarial review): the TxLINE
//! strategy references leaves by INDEX, not by stat key. Without pinning the
//! keys, a malicious keeper could satisfy "corners P1 + corners P2 > 9" with
//! a perfectly valid proof of GOALS (keys 1,2) instead of corners (7,8) and
//! flip the payout. The market therefore stores the exact ordered key list
//! the strategy was written against, and settlement refuses any other shape.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke},
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked},
};

use crate::{constants::*, errors::CornerCaseError, state::*, txoracle};

#[derive(Accounts)]
#[instruction(epoch_day: u16)]
pub struct SettleMarket<'info> {
    /// Permissionless caller (the keeper in practice, but anyone may settle).
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [Market::SEED, market.creator.as_ref(), &market.nonce.to_le_bytes()],
        bump = market.bump,
        close = creator,
    )]
    pub market: Account<'info, Market>,

    /// Rent destination on close; must be the stored creator.
    /// CHECK: address-constrained to market.creator; receives lamports only.
    #[account(mut, address = market.creator @ CornerCaseError::Unauthorized)]
    pub creator: UncheckedAccount<'info>,

    /// CHECK: address-constrained to market.taker; used only to derive the
    /// taker's canonical ATA below.
    #[account(address = market.taker @ CornerCaseError::TakerMismatch)]
    pub taker: UncheckedAccount<'info>,

    #[account(address = USDC_MINT @ CornerCaseError::WrongMint)]
    pub mint: Account<'info, Mint>,

    /// Creator's canonical ATA — one of exactly two possible payout
    /// destinations. Both are derivation-constrained; the caller cannot
    /// substitute a free-form winner account. `init_if_needed`: a party who
    /// closed their token account must not be able to block settlement (a
    /// ransom vector against the winner) — the caller fronts the ~0.002 SOL
    /// rent to recreate it at the same derived address.
    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = mint,
        associated_token::authority = creator,
    )]
    pub creator_ata: Account<'info, TokenAccount>,

    /// Taker's canonical ATA — the other possible payout destination.
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

    /// TxLINE's daily scores Merkle root account for `epoch_day`.
    /// CHECK: handler re-derives the PDA from the epoch_day ARG against
    /// TXORACLE_ID (never our own program id — a classic foreign-PDA bug) and
    /// requires the account to be owned by TxLINE. The proof only verifies if
    /// it chains to whatever root TxLINE posted in this exact account, so a
    /// wrong-but-well-derived day simply fails validation.
    pub txline_roots: UncheckedAccount<'info>,

    /// CHECK: pinned to TxLINE's program id; the runtime enforces that the
    /// CPI target is executable.
    #[account(address = txoracle::TXORACLE_ID @ CornerCaseError::InvalidTxlineProgram)]
    pub txline_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Emitted on settlement so the frontend receipt can reconstruct the outcome
/// without re-reading the (now closed) market account.
#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub fixture_id: i64,
    pub predicate_true: bool,
    pub winner: Pubkey,
    pub payout: u64,
    pub epoch_day: u16,
    pub proof_ts: i64,
}

pub fn settle_market_handler(
    ctx: Context<SettleMarket>,
    epoch_day: u16,
    payload: txoracle::StatValidationInput,
) -> Result<()> {
    let market = &ctx.accounts.market;

    require!(
        market.state == MarketState::Matched,
        CornerCaseError::MarketNotMatched
    );

    // Gate #3 (epoch window): the creation-time epoch_day is an estimate —
    // an evening kickoff can finalise after 00:00 UTC under the next day's
    // root. Accepting exactly {stored, stored+1} keeps the caller from
    // shopping arbitrary historical roots while never stranding a late final.
    require!(
        epoch_day == market.epoch_day || epoch_day == market.epoch_day.wrapping_add(1),
        CornerCaseError::EpochDayOutOfRange
    );

    // Gate #4 (fixture binding): the fixture id lives INSIDE the proven
    // summary node, so this one comparison pins the whole proof to the match
    // the two parties actually bet on. Without it, any fixture anywhere whose
    // stats satisfy the predicate could settle this market.
    require!(
        payload.fixture_summary.fixture_id == market.fixture_id,
        CornerCaseError::FixtureMismatch
    );

    // Gate #5 (stat-key binding): strategy predicates address leaves by
    // index. Enforce that leaf i proves exactly the stat key the creator
    // wrote the strategy against — same keys, same order, same count.
    require!(
        payload.stats.len() == market.stat_keys.len(),
        CornerCaseError::StatKeysMismatch
    );
    for (leaf, expected_key) in payload.stats.iter().zip(market.stat_keys.iter()) {
        require!(
            leaf.stat.key == *expected_key,
            CornerCaseError::StatKeysMismatch
        );
    }

    // Gate #2 (finality): leaves proven from a mid-match record carry that
    // record's status period (e.g. 3 = halftime). Requiring 100 on EVERY leaf
    // means settlement can only happen against the game_finalised record —
    // "zero red cards in H2" cannot be settled YES at minute 60.
    for leaf in payload.stats.iter() {
        require!(
            leaf.stat.period == txoracle::FINAL_PERIOD,
            CornerCaseError::ProofNotFinal
        );
    }

    // The roots account: derive against TxLINE's id from the caller's arg.
    let (expected_roots, _) = Pubkey::find_program_address(
        &[txoracle::DAILY_SCORES_ROOTS_SEED, &epoch_day.to_le_bytes()],
        &txoracle::TXORACLE_ID,
    );
    require_keys_eq!(
        ctx.accounts.txline_roots.key(),
        expected_roots,
        CornerCaseError::InvalidRootsAccount
    );
    require!(
        ctx.accounts.txline_roots.owner == &txoracle::TXORACLE_ID,
        CornerCaseError::InvalidRootsAccount
    );

    // Build the validate_stat_v2 call: discriminator + payload (canonical
    // borsh round-trip of what the keeper fetched) + the STORED strategy
    // bytes, spliced verbatim — what was signed at create is what settles.
    let mut data =
        Vec::with_capacity(8 + 1_024 + market.strategy.len());
    data.extend_from_slice(&txoracle::VALIDATE_STAT_V2_DISCRIMINATOR);
    payload.serialize(&mut data)?;
    data.extend_from_slice(&market.strategy);

    let ix = Instruction {
        program_id: txoracle::TXORACLE_ID,
        accounts: vec![AccountMeta::new_readonly(
            ctx.accounts.txline_roots.key(),
            false,
        )],
        data,
    };
    invoke(
        &ix,
        &[
            ctx.accounts.txline_roots.to_account_info(),
            ctx.accounts.txline_program.to_account_info(),
        ],
    )?;

    // The verdict. Spike-verified semantics: TxLINE hard-errors on any
    // invalid proof (aborting this whole transaction), and returns
    // borsh(bool) for a VALID proof — so CPI success alone means only "the
    // proof is real", never "the predicate holds". Read the bool from return
    // data and require it came from TxLINE's program id, not some inner CPI.
    let (returning_program, ret) =
        get_return_data().ok_or(CornerCaseError::NoValidationResult)?;
    require_keys_eq!(
        returning_program,
        txoracle::TXORACLE_ID,
        CornerCaseError::NoValidationResult
    );
    require!(ret.len() == 1, CornerCaseError::NoValidationResult);
    let predicate_true = ret[0] == 1;

    // Outcome routing between the two pre-constrained destinations.
    let creator_wins = predicate_true == market.creator_side;

    // Terminal state BEFORE any funds move: a racing second settle in the
    // same slot dies here as a clean state error.
    let market = &mut ctx.accounts.market;
    market.state = MarketState::Settled;

    let creator_key = market.creator;
    let nonce_le = market.nonce.to_le_bytes();
    let seeds: &[&[u8]] = &[
        Market::SEED,
        creator_key.as_ref(),
        &nonce_le,
        &[market.bump],
    ];
    let signer_seeds = &[seeds];

    let winner_ata = if creator_wins {
        &ctx.accounts.creator_ata
    } else {
        &ctx.accounts.taker_ata
    };

    // Sweep the FULL escrow balance (not 2x stake): a donation-griefed
    // escrow must still close, and the winner keeps any dust.
    let payout = ctx.accounts.escrow.amount;
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.escrow.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: winner_ata.to_account_info(),
                authority: ctx.accounts.market.to_account_info(),
            },
            signer_seeds,
        ),
        payout,
        ctx.accounts.mint.decimals,
    )?;

    // Escrow rent back to the creator (mirrors cancel/void).
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.escrow.to_account_info(),
            destination: ctx.accounts.creator.to_account_info(),
            authority: ctx.accounts.market.to_account_info(),
        },
        signer_seeds,
    ))?;

    emit!(MarketSettled {
        market: ctx.accounts.market.key(),
        fixture_id: ctx.accounts.market.fixture_id,
        predicate_true,
        winner: if creator_wins {
            creator_key
        } else {
            ctx.accounts.market.taker
        },
        payout,
        epoch_day,
        proof_ts: payload.ts,
    });

    Ok(())
}
