//! Compile-time pinned values. Anything that would be an "admin knob" in a
//! custodial book is a constant here — no config account, no upgrade-time
//! surprises for the two parties who signed against these exact values.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::pubkey;

/// The one and only settlement mint. Pinning it at the type level (an
/// `address =` constraint on every mint account) means no instruction can be
/// steered to a look-alike token: a market is denominated in USDC-dev or it
/// does not exist.
///
/// Devnet: our self-minted USDC-dev (6 dp, see spike/NOTES.md).
#[cfg(not(feature = "localtest"))]
pub const USDC_MINT: Pubkey = pubkey!("Cx9Y63x8YN7x9UMFba4B1HdmmmH9QVZbvTZgz7k8kspy");

/// Local-validator test double. Keypair committed at tests/fixtures/test-mint.json
/// (throwaway, test-only) so the test suite can create this exact mint.
#[cfg(feature = "localtest")]
pub const USDC_MINT: Pubkey = pubkey!("4UiiiUjSFTd1heBG4YRhoXMJcpFpDgGLGZDpXVR28ydk");

/// Mutual-refund escape hatch delay: if a matched market is still unsettled
/// this long after kickoff, either side (or anyone) can void it and both
/// stakes go home. 6h comfortably covers a match + extra time + TxLINE's
/// post-final correction window, while guaranteeing funds can never be
/// stranded by a dead keeper or a TxLINE outage.
#[cfg(not(feature = "localtest"))]
pub const VOID_DELAY_SECS: i64 = 6 * 3600;

/// Test override — keeps the void-path tests inside a single mocha run.
#[cfg(feature = "localtest")]
pub const VOID_DELAY_SECS: i64 = 5;

/// Strategy bytes are opaque to this program (byte-exact TxLINE SDK encoding,
/// spliced back into the validate instruction at settlement). Bounds only:
/// below 8 bytes nothing can encode a real predicate, above 512 is rent abuse.
pub const MIN_STRATEGY_LEN: usize = 8;
pub const MAX_STRATEGY_LEN: usize = 512;
