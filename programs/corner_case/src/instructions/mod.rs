pub mod accept_market;
pub mod cancel_market;
pub mod create_market;
pub mod settle_market;
pub mod void_market;

// Glob re-exports on purpose: the #[program] macro needs not just the
// Accounts structs but also their derive-generated `__client_accounts_*` /
// `__cpi_client_accounts_*` modules, which only come along with a glob.
// Handler fns are uniquely named (<ix>_handler) so the globs stay unambiguous.
pub use accept_market::*;
pub use cancel_market::*;
pub use create_market::*;
pub use settle_market::*;
pub use void_market::*;
