/** Bindings for the corner-case-relay Worker (see wrangler.toml). */
export interface Env {
  /** One namespace for everything: fixtures cache, guest JWT, faucet rate limits, settlements journal. */
  KV: KVNamespace;
  /** Long-lived TxLINE B2B token — X-Api-Token header on every data request. */
  TXLINE_API_TOKEN: string;
  /** Devnet faucet wallet secret key as a JSON number-array string. */
  FAUCET_KEYPAIR: string;
  /** Shared secret required on POST /api/settlements. */
  SYNC_TOKEN: string;
  /** Devnet RPC endpoint (plain var; overridable per-deploy). */
  RPC_URL?: string;
}
