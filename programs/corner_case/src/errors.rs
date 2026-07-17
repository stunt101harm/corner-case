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

    #[msg("Void delay has not elapsed yet")]
    VoidDelayNotElapsed,

    #[msg("Settlement path not implemented yet (pending spike decision)")]
    SettlementNotImplemented,

    #[msg("Escrow balance below expected stake (invariant violation)")]
    EscrowUnderfunded,
}
