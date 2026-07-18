/**
 * program.ts — every on-chain interaction in one framework-free module.
 * The React pages AND the node smoke script (scripts/smoke.ts) drive these
 * same builders, so the E2E test exercises the code path judges click.
 */

import {
  BN,
  BorshInstructionCoder,
  EventParser,
  Program,
  type IdlAccounts,
  type IdlEvents,
  type IdlTypes,
  type Provider,
} from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type SendOptions,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import idlJson from "../idl/corner_case.json";
import type { CornerCase } from "../idl/corner_case";
import { PROGRAM_ID, TXLINE_PROGRAM_ID, USDC_DEV_MINT } from "./constants";
import type { StatValidationJson } from "./types";

export type MarketAccount = IdlAccounts<CornerCase>["market"];
export type MarketSettledEvent = IdlEvents<CornerCase>["marketSettled"];
export type SettlePayload = IdlTypes<CornerCase>["statValidationInput"];

export interface MarketWithKey {
  publicKey: PublicKey;
  account: MarketAccount;
}

/**
 * Read-only program handle: a bare `{ connection }` provider is enough for
 * account fetches and instruction building, so every read surface works with
 * no wallet connected.
 */
export function getProgram(connection: Connection): Program<CornerCase> {
  return new Program<CornerCase>(idlJson as CornerCase, { connection } as Provider);
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

export function deriveMarketPda(creator: PublicKey, nonce: BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), creator.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID,
  )[0];
}

/** Escrow = the market PDA's own USDC-dev ATA (off-curve owner allowed). */
export function deriveEscrow(market: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(USDC_DEV_MINT, market, true);
}

export function deriveUsdcAta(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(USDC_DEV_MINT, owner);
}

export function deriveTxlineRootsPda(epochDay: number): PublicKey {
  const le = Buffer.alloc(2);
  le.writeUInt16LE(epochDay);
  return PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), le], TXLINE_PROGRAM_ID)[0];
}

/**
 * Fetch the raw bytes of TxLINE's on-chain daily_scores_roots account for a
 * given epoch day — the ground truth leg-3 verification compares against.
 * Returns null if the account doesn't exist (that day never posted), so the
 * caller can degrade to legs 1+2 instead of erroring.
 */
export async function fetchRootsAccountData(
  connection: Connection,
  epochDay: number,
): Promise<Uint8Array | null> {
  const info = await connection.getAccountInfo(deriveTxlineRootsPda(epochDay));
  return info ? Uint8Array.from(info.data) : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchAllMarkets(program: Program<CornerCase>): Promise<MarketWithKey[]> {
  return program.account.market.all();
}

export async function fetchMarket(
  program: Program<CornerCase>,
  address: PublicKey,
): Promise<MarketAccount | null> {
  return program.account.market.fetchNullable(address);
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

export interface CreateMarketArgs {
  creator: PublicKey;
  nonce: BN;
  fixtureId: number;
  epochDay: number;
  /** Unix seconds. */
  kickoffTs: number;
  creatorSide: boolean;
  /** USDC-dev base units. */
  stake: BN;
  strategy: Uint8Array;
  statKeys: number[];
}

export async function buildCreateMarketIx(
  program: Program<CornerCase>,
  args: CreateMarketArgs,
): Promise<{ ix: TransactionInstruction; market: PublicKey; escrow: PublicKey }> {
  const market = deriveMarketPda(args.creator, args.nonce);
  const escrow = deriveEscrow(market);
  const ix = await program.methods
    .createMarket(
      args.nonce,
      new BN(args.fixtureId),
      args.epochDay,
      new BN(args.kickoffTs),
      args.creatorSide,
      new BN(args.stake),
      Buffer.from(args.strategy),
      args.statKeys,
    )
    .accountsPartial({
      creator: args.creator,
      market,
      mint: USDC_DEV_MINT,
      creatorAta: deriveUsdcAta(args.creator),
      escrow,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return { ix, market, escrow };
}

export async function buildAcceptMarketIx(
  program: Program<CornerCase>,
  args: { taker: PublicKey; market: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods
    .acceptMarket()
    .accountsPartial({
      taker: args.taker,
      market: args.market,
      mint: USDC_DEV_MINT,
      takerAta: deriveUsdcAta(args.taker),
      escrow: deriveEscrow(args.market),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export async function buildCancelMarketIx(
  program: Program<CornerCase>,
  args: { creator: PublicKey; market: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods
    .cancelMarket()
    .accountsPartial({
      creator: args.creator,
      market: args.market,
      mint: USDC_DEV_MINT,
      creatorAta: deriveUsdcAta(args.creator),
      escrow: deriveEscrow(args.market),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/**
 * Raw /api/proof JSON → the typed settle_market payload. Byte-identical to
 * what the on-chain validation expects; ts and epoch day derive from
 * summary.updateStats.minTimestamp per TxLINE's own derivation.
 */
export function buildSettlePayload(val: StatValidationJson): SettlePayload {
  const mapProof = (arr: StatValidationJson["subTreeProof"]) =>
    arr.map((n) => ({ hash: Array.from(n.hash), isRightSibling: n.isRightSibling }));
  return {
    ts: new BN(val.summary.updateStats.minTimestamp),
    fixtureSummary: {
      fixtureId: new BN(val.summary.fixtureId),
      updateStats: {
        updateCount: val.summary.updateStats.updateCount,
        minTimestamp: new BN(val.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(val.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: Array.from(val.summary.eventStatsSubTreeRoot),
    },
    fixtureProof: mapProof(val.subTreeProof),
    mainTreeProof: mapProof(val.mainTreeProof),
    eventStatRoot: Array.from(val.eventStatRoot),
    stats: val.statsToProve.map((s, i) => ({
      stat: { key: s.key, value: s.value, period: s.period },
      statProof: mapProof(val.statProofs[i]),
    })),
  };
}

export interface SettleMarketArgs {
  /** Settlement is permissionless — any funded wallet may be the caller. */
  caller: PublicKey;
  market: PublicKey;
  creator: PublicKey;
  taker: PublicKey;
  epochDay: number;
  payload: SettlePayload;
}

/**
 * Returns [computeBudgetIx, settleIx]: TxLINE's validation costs ~200k CU and
 * the default 200k budget is transaction-wide, so the raise is mandatory.
 */
export async function buildSettleMarketIxs(
  program: Program<CornerCase>,
  args: SettleMarketArgs,
): Promise<TransactionInstruction[]> {
  const settleIx = await program.methods
    .settleMarket(args.epochDay, args.payload)
    .accountsPartial({
      caller: args.caller,
      market: args.market,
      creator: args.creator,
      taker: args.taker,
      mint: USDC_DEV_MINT,
      creatorAta: deriveUsdcAta(args.creator),
      takerAta: deriveUsdcAta(args.taker),
      escrow: deriveEscrow(args.market),
      txlineRoots: deriveTxlineRootsPda(args.epochDay),
      txlineProgram: TXLINE_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .instruction();
  return [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), settleIx];
}

// ---------------------------------------------------------------------------
// Sending — one path for wallet-adapter (browser) and Keypair (smoke script)
// ---------------------------------------------------------------------------

/** The slice of wallet-adapter's interface we need; a Keypair wrapper in the
 *  smoke script implements the same shape. */
export interface TxSender {
  publicKey: PublicKey;
  sendTransaction(tx: Transaction, connection: Connection, options?: SendOptions): Promise<string>;
}

export async function sendIxs(
  connection: Connection,
  sender: TxSender,
  ixs: TransactionInstruction[],
): Promise<string> {
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: sender.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }).add(...ixs);
  const signature = await sender.sendTransaction(tx, connection);
  const conf = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (conf.value.err) {
    throw new Error(`transaction ${signature} failed: ${JSON.stringify(conf.value.err)}`);
  }
  return signature;
}

// ---------------------------------------------------------------------------
// Receipt decoding
// ---------------------------------------------------------------------------

/** Plain-JSON settle payload for display/verification/localStorage. */
export interface PlainSettlePayload {
  ts: number;
  fixtureId: number;
  updateCount: number;
  minTimestamp: number;
  maxTimestamp: number;
  eventsSubTreeRoot: number[];
  fixtureProof: { hash: number[]; isRightSibling: boolean }[];
  mainTreeProof: { hash: number[]; isRightSibling: boolean }[];
  eventStatRoot: number[];
  stats: { key: number; value: number; period: number; proof: { hash: number[]; isRightSibling: boolean }[] }[];
}

export interface PlainMarketSettled {
  market: string;
  fixtureId: number;
  predicateTrue: boolean;
  winner: string;
  payout: number;
  epochDay: number;
  proofTs: number;
}

export interface DecodedReceipt {
  event: PlainMarketSettled;
  payload: PlainSettlePayload;
  epochDay: number;
  /** TxLINE's validateStatV2 ran as an inner instruction of this tx. */
  txlineCpiPresent: boolean;
  blockTime: number | null;
  slot: number;
}

/** The borsh-decoded settle instruction, typed independently of Anchor's IDL
 *  type gymnastics (hash arrays decode as number[]). */
interface DecodedProofNode {
  hash: number[];
  isRightSibling: boolean;
}
interface DecodedSettleArgs {
  epochDay: number;
  payload: {
    ts: BN;
    fixtureSummary: {
      fixtureId: BN;
      updateStats: { updateCount: number; minTimestamp: BN; maxTimestamp: BN };
      eventsSubTreeRoot: number[];
    };
    fixtureProof: DecodedProofNode[];
    mainTreeProof: DecodedProofNode[];
    eventStatRoot: number[];
    stats: { stat: { key: number; value: number; period: number }; statProof: DecodedProofNode[] }[];
  };
}

/**
 * Parse a settle transaction into everything the receipt page renders:
 * the MarketSettled event (from logs) and the full proof payload (from the
 * instruction data itself — no relay round-trip, the tx IS the proof).
 */
export async function decodeSettleTx(
  connection: Connection,
  program: Program<CornerCase>,
  signature: string,
): Promise<DecodedReceipt | null> {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || !tx.meta) return null;

  // 1. MarketSettled from logs.
  const parser = new EventParser(program.programId, program.coder);
  let event: MarketSettledEvent | null = null;
  for (const ev of parser.parseLogs(tx.meta.logMessages ?? [])) {
    if (ev.name === "marketSettled") {
      event = ev.data as MarketSettledEvent;
      break;
    }
  }
  if (!event) return null;

  // 2. The settle instruction's own data — the proof payload, byte-exact.
  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys;
  // The generic InstructionCoder interface is encode-only; the concrete borsh
  // coder (which every Anchor program uses) can decode.
  const ixCoder = program.coder.instruction as BorshInstructionCoder;
  let decoded: DecodedSettleArgs | null = null;
  for (const ix of msg.compiledInstructions) {
    if (!keys[ix.programIdIndex]?.equals(program.programId)) continue;
    const d = ixCoder.decode(Buffer.from(ix.data));
    if (d && d.name === "settleMarket") {
      decoded = d.data as DecodedSettleArgs;
      break;
    }
  }
  if (!decoded) return null;

  // 3. Confirm the TxLINE CPI actually ran inside this tx.
  const txlineCpiPresent = (tx.meta.innerInstructions ?? []).some((group) =>
    group.instructions.some((ix) => keys[ix.programIdIndex]?.equals(TXLINE_PROGRAM_ID)),
  );

  const p = decoded.payload;
  return {
    event: {
      market: event.market.toBase58(),
      fixtureId: Number(event.fixtureId),
      predicateTrue: event.predicateTrue,
      winner: event.winner.toBase58(),
      payout: Number(event.payout),
      epochDay: event.epochDay,
      proofTs: Number(event.proofTs),
    },
    payload: {
      ts: Number(p.ts),
      fixtureId: Number(p.fixtureSummary.fixtureId),
      updateCount: p.fixtureSummary.updateStats.updateCount,
      minTimestamp: Number(p.fixtureSummary.updateStats.minTimestamp),
      maxTimestamp: Number(p.fixtureSummary.updateStats.maxTimestamp),
      eventsSubTreeRoot: Array.from(p.fixtureSummary.eventsSubTreeRoot),
      fixtureProof: p.fixtureProof.map((n) => ({ hash: Array.from(n.hash), isRightSibling: n.isRightSibling })),
      mainTreeProof: p.mainTreeProof.map((n) => ({ hash: Array.from(n.hash), isRightSibling: n.isRightSibling })),
      eventStatRoot: Array.from(p.eventStatRoot),
      stats: p.stats.map((s) => ({
        key: s.stat.key,
        value: s.stat.value,
        period: s.stat.period,
        proof: s.statProof.map((n) => ({ hash: Array.from(n.hash), isRightSibling: n.isRightSibling })),
      })),
    },
    epochDay: decoded.epochDay,
    txlineCpiPresent,
    blockTime: tx.blockTime ?? null,
    slot: tx.slot,
  };
}
