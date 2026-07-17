/**
 * faucet.ts — Worker port of the relay's /api/faucet with ONE deliberate
 * difference: the Worker TRANSFERS from the faucet wallet's pre-minted stash
 * (it holds USDC-dev + SOL) instead of minting. The mint authority never
 * leaves the laptop; the cloud faucet can only spend what it was given.
 *
 * Per drip: 0.02 SOL + 1000 USDC-dev, creating the recipient's ATA if needed
 * (faucet pays). Rate limit: 1 per wallet per 10 min via a KV TTL key → 429.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { Env } from "./env";

const USDC_DEV_MINT = new PublicKey("Cx9Y63x8YN7x9UMFba4B1HdmmmH9QVZbvTZgz7k8kspy");
const DEFAULT_RPC_URL = "https://api.devnet.solana.com";

const FAUCET_WINDOW_MS = 10 * 60_000;
const FAUCET_WINDOW_SECONDS = FAUCET_WINDOW_MS / 1000;
const FAUCET_SOL_LAMPORTS = 20_000_000; // 0.02 SOL — fees + rent for a few markets
const FAUCET_USDC_BASE_UNITS = 1_000_000_000n; // 1000 USDC-dev (6 decimals)

const CONFIRM_POLL_MS = 1_000;
const CONFIRM_ATTEMPTS = 30;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function handleFaucet(env: Env, body: string): Promise<{ status: number; json: unknown }> {
  let walletStr: unknown;
  try {
    walletStr = (JSON.parse(body) as { wallet?: unknown }).wallet;
  } catch {
    return { status: 400, json: { error: "body must be JSON: {\"wallet\": \"<base58>\"}" } };
  }
  if (typeof walletStr !== "string") {
    return { status: 400, json: { error: "missing wallet field" } };
  }
  let wallet: PublicKey;
  let ata: PublicKey;
  try {
    wallet = new PublicKey(walletStr);
    // Off-curve owners (PDAs) throw here — a faucet only serves real wallets.
    ata = getAssociatedTokenAddressSync(USDC_DEV_MINT, wallet);
  } catch {
    return { status: 400, json: { error: "not a valid wallet address" } };
  }

  const rateKey = `faucet:${walletStr}`;
  const last = await env.KV.get(rateKey);
  if (last !== null) {
    const lastMs = Number(last);
    const retryInMs = Number.isFinite(lastMs)
      ? Math.max(0, FAUCET_WINDOW_MS - (Date.now() - lastMs))
      : FAUCET_WINDOW_MS;
    return {
      status: 429,
      json: { error: "faucet already used for this wallet — try again later", retryInMs },
    };
  }

  let payer: Keypair;
  try {
    payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env.FAUCET_KEYPAIR) as number[]));
  } catch (err) {
    return { status: 500, json: { error: `faucet keypair unavailable: ${String(err)}` } };
  }

  const connection = new Connection(env.RPC_URL ?? DEFAULT_RPC_URL, "confirmed");
  const faucetAta = getAssociatedTokenAddressSync(USDC_DEV_MINT, payer.publicKey);

  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: wallet,
        lamports: FAUCET_SOL_LAMPORTS,
      }),
      // Idempotent create: a repeat visitor with an existing ATA still works.
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, wallet, USDC_DEV_MINT),
      // TRANSFER from the pre-minted stash — the Worker faucet never mints.
      createTransferInstruction(faucetAta, ata, payer.publicKey, FAUCET_USDC_BASE_UNITS),
    );
    tx.sign(payer);
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });

    // Poll instead of sendAndConfirmTransaction: confirmation-by-subscription
    // needs a websocket, which is pointless plumbing on Workers.
    let confirmed = false;
    for (let i = 0; i < CONFIRM_ATTEMPTS; i++) {
      const st = (await connection.getSignatureStatuses([signature])).value[0];
      if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
        confirmed = true;
        break;
      }
      await sleep(CONFIRM_POLL_MS);
    }
    if (!confirmed) throw new Error(`transaction ${signature} not confirmed within ${CONFIRM_ATTEMPTS}s`);

    // Rate-limit only successful drips — a failed devnet tx should not lock a
    // judge out for 10 minutes.
    await env.KV.put(rateKey, String(Date.now()), { expirationTtl: FAUCET_WINDOW_SECONDS });
    return {
      status: 200,
      json: {
        ok: true,
        signature,
        sol: FAUCET_SOL_LAMPORTS / 1e9,
        usdc: Number(FAUCET_USDC_BASE_UNITS) / 1e6,
      },
    };
  } catch (err) {
    return { status: 502, json: { error: `devnet transaction failed: ${String(err)}` } };
  }
}
