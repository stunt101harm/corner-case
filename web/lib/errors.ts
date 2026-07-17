/**
 * errors.ts — turn wallet/RPC/program failures into sentences a soccer fan
 * can act on. Program error names and codes come from the deployed IDL.
 */

const PROGRAM_ERRORS: Record<string, string> = {
  ZeroStake: "Stake must be greater than zero.",
  StrategyLengthOutOfBounds: "Strategy bytes are out of bounds (8–512).",
  KickoffNotInFuture: "Kickoff must be in the future to create this market.",
  WrongMint: "That token account is not USDC-dev — use Get test funds.",
  MarketNotOpen: "This market is no longer open.",
  MarketNotMatched: "This market has no taker yet.",
  KickoffPassed: "Kickoff has passed — accepts are closed.",
  SelfMatch: "You can't accept your own market.",
  Unauthorized: "Only the market creator can do that.",
  TakerMismatch: "Taker account doesn't match the stored taker.",
  VoidDelayNotElapsed: "The void delay hasn't elapsed yet.",
  EscrowUnderfunded: "Escrow balance below expected stake.",
  StatKeysCountOutOfBounds: "Markets pin 1–5 stat keys.",
  EpochDayOutOfRange: "Epoch day must be the market's stored day or the day after.",
  FixtureMismatch: "That proof is for a different match than this market.",
  StatKeysMismatch: "Proof leaves don't match this market's pinned stat keys.",
  ProofNotFinal: "That proof is from mid-match — settlement needs the final whistle (period 100).",
  InvalidRootsAccount: "TxLINE roots account doesn't match the expected derivation.",
  NoValidationResult: "TxLINE validation returned no readable verdict.",
};

/** code (6000 + index) → name, for logs that only carry the hex code. */
const CODE_TO_NAME: Record<number, string> = Object.fromEntries(
  Object.keys(PROGRAM_ERRORS).map((name, i) => [6000 + i, name]),
);

/** TxLINE's own validation errors we know judges can hit. */
const TXLINE_ERRORS: Record<number, string> = {
  6023: "TxLINE rejected the Merkle proof (InvalidStatProof).",
};

export function humanizeError(err: unknown): string {
  const raw =
    err instanceof Error
      ? `${err.message}${"logs" in err && Array.isArray((err as { logs?: string[] }).logs) ? "\n" + ((err as { logs?: string[] }).logs ?? []).join("\n") : ""}`
      : String(err);

  // Wallet-side failures first — most common for judges.
  if (/user rejected|rejected the request|approval denied/i.test(raw)) {
    return "Transaction cancelled in the wallet.";
  }
  if (/wallet ?not ?connected/i.test(raw)) {
    return "Connect a wallet first.";
  }
  if (/insufficient (funds|lamports)|debit an account|attempt to pay/i.test(raw)) {
    return "Not enough SOL for fees — hit Get test funds.";
  }
  if (/insufficient funds.*token|Error: insufficient funds/i.test(raw) && /token/i.test(raw)) {
    return "Not enough USDC-dev — hit Get test funds.";
  }
  // Anchor puts the error name in logs: "Error Code: KickoffPassed".
  const nameMatch = /Error Code: ([A-Za-z]+)/.exec(raw);
  if (nameMatch && PROGRAM_ERRORS[nameMatch[1]]) return PROGRAM_ERRORS[nameMatch[1]];
  // Raw custom program error: 0x1776 style.
  const codeMatch = /custom program error: (0x[0-9a-fA-F]+|\d+)/.exec(raw);
  if (codeMatch) {
    const code = Number(codeMatch[1]);
    const name = CODE_TO_NAME[code];
    if (name) return PROGRAM_ERRORS[name];
    if (TXLINE_ERRORS[code]) return TXLINE_ERRORS[code];
    return `Program error ${code}.`;
  }
  // Anchor account-not-found during fetch/simulation.
  if (/Account does not exist/i.test(raw)) {
    return "Account not found — you may need USDC-dev first (Get test funds).";
  }
  const firstLine = raw.split("\n")[0];
  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
}
