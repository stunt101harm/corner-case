use anchor_lang::prelude::*;

#[error_code]
pub enum CornerCaseError {
    #[msg("Stake must be greater than zero")]
    ZeroStake,

    #[msg("Strategy must be between 8 and 512 bytes")]
    StrategyLengthOutOfBounds,

    #[msg("Kickoff must be in the future at market creation")]
    KickoffNotInFuture,

    #[msg("Token account is not the pinned USDC-dev mint")]
    WrongMint,

    #[msg("Market is not open")]
    MarketNotOpen,

    #[msg("Market is not matched")]
    MarketNotMatched,

    // Check gate #1 — see accept_market.
    #[msg("Kickoff has passed; accepts are closed")]
    KickoffPassed,

    #[msg("Creator cannot take their own market")]
    SelfMatch,

    #[msg("Only the market creator may do this")]
    Unauthorized,

    #[msg("Taker account does not match the stored taker")]
    TakerMismatch,

    #[msg("Void delay has not elapsed yet")]
    VoidDelayNotElapsed,

    #[msg("Escrow balance below expected stake (invariant violation)")]
    EscrowUnderfunded,

    #[msg("Market must pin 1-5 stat keys (TxLINE's per-proof limit)")]
    StatKeysCountOutOfBounds,

    // Check gate #3 — see settle_market.
    #[msg("epoch_day must be the market's stored day or the day after")]
    EpochDayOutOfRange,

    // Check gate #4 — see settle_market.
    #[msg("Proof is for a different fixture than this market")]
    FixtureMismatch,

    // Check gate #5 — see settle_market.
    #[msg("Proof leaves do not match the market's pinned stat keys")]
    StatKeysMismatch,

    // Check gate #2 — see settle_market.
    #[msg("Proof is from a mid-match record; settlement requires game_finalised (period 100)")]
    ProofNotFinal,

    #[msg("TxLINE roots account or program does not match the expected derivation")]
    InvalidRootsAccount,

    #[msg("TxLINE validation returned no readable verdict")]
    NoValidationResult,
}
