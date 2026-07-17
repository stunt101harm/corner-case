//! Minimal, hand-verified interface to TxLINE's `txoracle` program.
//!
//! We deliberately do NOT use `declare_program!` codegen here: settlement
//! depends on byte-exact serialization of exactly one instruction, and a
//! ~60-line hand-written mirror of the IDL types (field order checked against
//! `idls/txoracle.json`, spike-verified against the live devnet program) is
//! easier to audit than a macro expansion of the full 18-instruction IDL.
//!
//! Serialization notes:
//! - Borsh round-trips are canonical: deserializing the keeper-built payload
//!   and re-serializing it on-chain yields identical bytes, so the proof the
//!   caller fetched is the proof TxLINE verifies.
//! - The `strategy` argument is appended as RAW stored bytes (see
//!   settle_market) — the program never re-encodes what the creator signed.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;

/// TxLINE txoracle program (devnet). Mainnet would be
/// `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA` — a devnet-only pin is
/// correct for this build; a cluster switch is a recompile, not a config.
pub const TXORACLE_ID: Pubkey = pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

/// Anchor discriminator for `validate_stat_v2`, lifted verbatim from the IDL
/// (`idls/txoracle.json`) — not re-derived, so an upstream rename can't
/// silently point us at a different handler.
pub const VALIDATE_STAT_V2_DISCRIMINATOR: [u8; 8] = [208, 215, 194, 214, 241, 71, 246, 178];

/// Seed for TxLINE's daily scores Merkle root accounts:
/// `["daily_scores_roots", epoch_day u16 LE]` under TXORACLE_ID.
pub const DAILY_SCORES_ROOTS_SEED: &[u8] = b"daily_scores_roots";

/// `ScoreStat.period` value stamped on leaves proven from a `game_finalised`
/// record (StatusId 100). Spike-verified: halftime leaves carry 3, final
/// leaves carry 100.
pub const FINAL_PERIOD: i32 = 100;

/// One sibling hash in a Merkle path.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoresUpdateStats {
    pub update_count: i32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

/// Fixture-level summary — the node that binds a proof to ONE fixture.
/// `fixture_id` living inside the proven chain is what makes on-chain fixture
/// binding possible (settle_market's FixtureMismatch gate).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

/// A single provable key/value statistic — the innermost Merkle leaf.
/// `period` is the match-status period of the underlying score record
/// (3 = halftime, 100 = game finalised), NOT the stat key's period prefix.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatLeaf {
    pub stat: ScoreStat,
    pub stat_proof: Vec<ProofNode>,
}

/// Full `validate_stat_v2` payload (IDL: `StatValidationInput`), exactly as
/// the stat-validation endpoint hands it to the keeper.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct StatValidationInput {
    pub ts: i64,
    pub fixture_summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub event_stat_root: [u8; 32],
    pub stats: Vec<StatLeaf>,
}
