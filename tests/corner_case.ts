// Corner Case — on-chain scaffold tests (issue #4 scope: everything except
// the settlement path, which is a deliberate stub).
//
// Runs against a local validator with the program built under the `localtest`
// feature: the pinned mint is the committed throwaway keypair at
// tests/fixtures/test-mint.json and VOID_DELAY_SECS is 5 seconds.
// Invoke: anchor test -- --features localtest

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { CornerCase } from "../target/types/corner_case";
import {
  createMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  getAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert, expect } from "chai";
import * as fs from "fs";
import * as path from "path";

// Mirrors the localtest consts in programs/corner_case/src/constants.rs.
const VOID_DELAY_SECS = 5;

describe("corner_case", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const program = anchor.workspace.cornerCase as Program<CornerCase>;

  // Creator = provider wallet (payer of everything). Taker + outsider are
  // fresh throwaway keypairs funded from the faucet.
  const payer = (provider.wallet as anchor.Wallet).payer;
  const creator = payer;
  const taker = Keypair.generate();
  const outsider = Keypair.generate();

  // The pinned localtest mint — must be created from the committed keypair
  // so its address matches the compiled-in constant.
  const mintKeypair = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(__dirname, "fixtures", "test-mint.json"),
          "utf-8"
        )
      )
    )
  );
  const mint = mintKeypair.publicKey;
  let wrongMint: PublicKey;

  let creatorAta: PublicKey;
  let takerAta: PublicKey;
  let outsiderAta: PublicKey;

  const DECIMALS = 6;
  const STAKE = new BN(25_000_000); // 25 USDC-dev per side
  const FIXTURE_ID = new BN(18179550); // known devnet example fixture
  const EPOCH_DAY = 20651;
  const STRATEGY = Buffer.from(
    // Opaque bytes as far as the program is concerned; 64 deterministic bytes
    // standing in for a real validateStatV2 strategy encoding.
    Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256)
  );

  let nonceCounter = 0;
  const nextNonce = () => new BN(++nonceCounter);

  // ---- helpers -----------------------------------------------------------

  /** On-chain time — never wall-clock, so clock skew can't flake the tests. */
  async function chainNow(): Promise<number> {
    const slot = await connection.getSlot("confirmed");
    const t = await connection.getBlockTime(slot);
    if (t === null) throw new Error("no block time");
    return t;
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Wait until the chain clock passes `targetTs` (with a small buffer). */
  async function waitUntilChainTime(targetTs: number) {
    for (;;) {
      const now = await chainNow();
      if (now > targetTs) return;
      await sleep(Math.min((targetTs - now + 1) * 1000, 2000));
    }
  }

  function marketPda(creatorKey: PublicKey, nonce: BN): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("market"),
        creatorKey.toBuffer(),
        nonce.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];
  }

  function escrowAta(market: PublicKey, forMint: PublicKey = mint): PublicKey {
    return getAssociatedTokenAddressSync(forMint, market, true);
  }

  /** Create a market with sane defaults; returns its addresses. */
  async function createMarket(opts?: {
    kickoffTs?: BN;
    stake?: BN;
    strategy?: Buffer;
    useMint?: PublicKey;
    useCreatorAta?: PublicKey;
  }) {
    const nonce = nextNonce();
    const kickoffTs =
      opts?.kickoffTs ?? new BN((await chainNow()) + 3600);
    const useMint = opts?.useMint ?? mint;
    const market = marketPda(creator.publicKey, nonce);
    const escrow = escrowAta(market, useMint);

    await program.methods
      .createMarket(
        nonce,
        FIXTURE_ID,
        EPOCH_DAY,
        kickoffTs,
        true, // creator bets TRUE
        opts?.stake ?? STAKE,
        opts?.strategy ?? STRATEGY
      )
      .accounts({
        creator: creator.publicKey,
        market,
        mint: useMint,
        creatorAta:
          opts?.useCreatorAta ??
          getAssociatedTokenAddressSync(useMint, creator.publicKey),
        escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    return { nonce, kickoffTs, market, escrow };
  }

  async function acceptMarket(
    market: PublicKey,
    escrow: PublicKey,
    by: Keypair,
    byAta: PublicKey
  ) {
    return program.methods
      .acceptMarket()
      .accounts({
        taker: by.publicKey,
        market,
        mint,
        takerAta: byAta,
        escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([by])
      .rpc();
  }

  /** Assert a promise rejects with a specific Anchor error code. */
  async function expectErr(p: Promise<unknown>, code: string) {
    try {
      await p;
    } catch (e: any) {
      const got =
        e?.error?.errorCode?.code ?? // AnchorError
        (typeof e?.message === "string" && e.message.includes(code)
          ? code
          : undefined);
      expect(got, `expected error ${code}, got: ${e}`).to.equal(code);
      return;
    }
    assert.fail(`expected error ${code}, but the transaction succeeded`);
  }

  async function tokenBalance(ata: PublicKey): Promise<bigint> {
    return (await getAccount(connection, ata)).amount;
  }

  async function assertClosed(pubkey: PublicKey, label: string) {
    const info = await connection.getAccountInfo(pubkey);
    expect(info, `${label} should be closed`).to.equal(null);
  }

  // ---- setup -------------------------------------------------------------

  before(async () => {
    // Fund the throwaway wallets.
    for (const kp of [taker, outsider]) {
      const sig = await connection.requestAirdrop(
        kp.publicKey,
        10 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");
    }

    // The pinned mint MUST be created from the committed keypair — the
    // program's `address = USDC_MINT` constraint points at this exact pubkey.
    await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      DECIMALS,
      mintKeypair
    );

    // A second, perfectly valid SPL mint that is NOT the pinned one.
    wrongMint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);

    creatorAta = await createAssociatedTokenAccount(
      connection,
      payer,
      mint,
      creator.publicKey
    );
    takerAta = await createAssociatedTokenAccount(
      connection,
      payer,
      mint,
      taker.publicKey
    );
    outsiderAta = await createAssociatedTokenAccount(
      connection,
      payer,
      mint,
      outsider.publicKey
    );

    for (const ata of [creatorAta, takerAta, outsiderAta]) {
      await mintTo(connection, payer, mint, ata, payer, 1_000_000_000); // 1000
    }
  });

  // ---- create ------------------------------------------------------------

  describe("create_market", () => {
    it("initializes the market and funds the escrow", async () => {
      const before = await tokenBalance(creatorAta);
      const { market, escrow, nonce, kickoffTs } = await createMarket();

      const m = await program.account.market.fetch(market);
      expect(m.creator.toBase58()).to.equal(creator.publicKey.toBase58());
      expect(m.taker.toBase58()).to.equal(PublicKey.default.toBase58());
      expect(m.fixtureId.eq(FIXTURE_ID)).to.equal(true);
      expect(m.epochDay).to.equal(EPOCH_DAY);
      expect(m.kickoffTs.eq(kickoffTs)).to.equal(true);
      expect(m.stake.eq(STAKE)).to.equal(true);
      expect(m.creatorSide).to.equal(true);
      expect(m.state).to.deep.equal({ open: {} });
      expect(m.nonce.eq(nonce)).to.equal(true);
      expect(Buffer.from(m.strategy).equals(STRATEGY)).to.equal(true);

      expect(await tokenBalance(escrow)).to.equal(BigInt(STAKE.toString()));
      expect(before - (await tokenBalance(creatorAta))).to.equal(
        BigInt(STAKE.toString())
      );
    });

    it("rejects a non-pinned mint", async () => {
      // Give the wrong-mint path a real, funded ATA so the *only* thing wrong
      // with the transaction is the mint identity.
      const wrongCreatorAta = await createAssociatedTokenAccount(
        connection,
        payer,
        wrongMint,
        creator.publicKey
      );
      await mintTo(connection, payer, wrongMint, wrongCreatorAta, payer, 1_000_000_000);

      await expectErr(
        createMarket({ useMint: wrongMint, useCreatorAta: wrongCreatorAta }),
        "WrongMint"
      );
    });

    it("rejects a kickoff in the past", async () => {
      await expectErr(
        createMarket({ kickoffTs: new BN((await chainNow()) - 10) }),
        "KickoffNotInFuture"
      );
    });

    it("rejects a zero stake", async () => {
      await expectErr(createMarket({ stake: new BN(0) }), "ZeroStake");
    });

    it("rejects an out-of-bounds strategy", async () => {
      await expectErr(
        createMarket({ strategy: Buffer.from([1, 2, 3]) }),
        "StrategyLengthOutOfBounds"
      );
      await expectErr(
        createMarket({ strategy: Buffer.alloc(513, 7) }),
        "StrategyLengthOutOfBounds"
      );
    });
  });

  // ---- accept ------------------------------------------------------------

  describe("accept_market", () => {
    it("matches the market and doubles the escrow", async () => {
      const { market, escrow } = await createMarket();
      const before = await tokenBalance(takerAta);

      await acceptMarket(market, escrow, taker, takerAta);

      const m = await program.account.market.fetch(market);
      expect(m.taker.toBase58()).to.equal(taker.publicKey.toBase58());
      expect(m.state).to.deep.equal({ matched: {} });
      expect(await tokenBalance(escrow)).to.equal(
        BigInt(STAKE.muln(2).toString())
      );
      expect(before - (await tokenBalance(takerAta))).to.equal(
        BigInt(STAKE.toString())
      );
    });

    it("rejects accepts at/after kickoff (check gate #1)", async () => {
      // Kickoff a few seconds out, then let the chain clock pass it.
      const kickoffTs = new BN((await chainNow()) + 4);
      const { market, escrow } = await createMarket({ kickoffTs });
      await waitUntilChainTime(kickoffTs.toNumber());

      await expectErr(
        acceptMarket(market, escrow, taker, takerAta),
        "KickoffPassed"
      );
    });

    it("rejects the creator taking their own market", async () => {
      const { market, escrow } = await createMarket();
      await expectErr(
        acceptMarket(market, escrow, creator, creatorAta),
        "SelfMatch"
      );
    });

    it("rejects a second accept", async () => {
      const { market, escrow } = await createMarket();
      await acceptMarket(market, escrow, taker, takerAta);
      await expectErr(
        acceptMarket(market, escrow, outsider, outsiderAta),
        "MarketNotOpen"
      );
    });
  });

  // ---- settle stub -------------------------------------------------------

  describe("settle_market (stub)", () => {
    it("always errors with SettlementNotImplemented", async () => {
      const { market, escrow } = await createMarket();
      await acceptMarket(market, escrow, taker, takerAta);

      await expectErr(
        program.methods
          .settleMarket()
          .accounts({ caller: creator.publicKey, market } as any)
          .rpc(),
        "SettlementNotImplemented"
      );
    });
  });

  // ---- cancel ------------------------------------------------------------

  describe("cancel_market", () => {
    it("rejects a non-creator", async () => {
      const { market, escrow } = await createMarket();
      await expectErr(
        program.methods
          .cancelMarket()
          .accounts({
            creator: taker.publicKey,
            market,
            mint,
            creatorAta: takerAta,
            escrow,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .signers([taker])
          .rpc(),
        "Unauthorized"
      );
    });

    it("rejects cancel after a match", async () => {
      const { market, escrow } = await createMarket();
      await acceptMarket(market, escrow, taker, takerAta);
      await expectErr(
        program.methods
          .cancelMarket()
          .accounts({
            creator: creator.publicKey,
            market,
            mint,
            creatorAta,
            escrow,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .rpc(),
        "MarketNotOpen"
      );
    });

    it("refunds the creator and closes market + escrow", async () => {
      const before = await tokenBalance(creatorAta);
      const { market, escrow } = await createMarket();

      await program.methods
        .cancelMarket()
        .accounts({
          creator: creator.publicKey,
          market,
          mint,
          creatorAta,
          escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .rpc();

      // Full round trip: the stake left and came back.
      expect(await tokenBalance(creatorAta)).to.equal(before);
      await assertClosed(market, "market");
      await assertClosed(escrow, "escrow");
    });
  });

  // ---- void --------------------------------------------------------------

  describe("void_market", () => {
    function voidIx(market: PublicKey, escrow: PublicKey) {
      return program.methods
        .voidMarket()
        .accounts({
          market,
          creator: creator.publicKey,
          taker: taker.publicKey,
          mint,
          creatorAta,
          takerAta,
          escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any);
    }

    it("rejects void before the delay has elapsed", async () => {
      const kickoffTs = new BN((await chainNow()) + 30);
      const { market, escrow } = await createMarket({ kickoffTs });
      await acceptMarket(market, escrow, taker, takerAta);

      await expectErr(voidIx(market, escrow).rpc(), "VoidDelayNotElapsed");
    });

    it("rejects void of an unmatched market", async () => {
      const { market, escrow } = await createMarket();
      await expectErr(voidIx(market, escrow).rpc(), "MarketNotMatched");
    });

    it("rejects a forged taker refund destination", async () => {
      // A matched market, but the caller substitutes their own account (and
      // its perfectly valid ATA) as the "taker": the handler must pin the
      // refund to the stored taker, not whoever showed up.
      const { market, escrow } = await createMarket();
      await acceptMarket(market, escrow, taker, takerAta);

      await expectErr(
        program.methods
          .voidMarket()
          .accounts({
            market,
            creator: creator.publicKey,
            taker: outsider.publicKey,
            mint,
            creatorAta,
            takerAta: outsiderAta,
            escrow,
            tokenProgram: TOKEN_PROGRAM_ID,
          } as any)
          .rpc(),
        "TakerMismatch"
      );
    });

    it("refunds both sides and closes after kickoff + delay", async () => {
      const creatorBefore = await tokenBalance(creatorAta);
      const takerBefore = await tokenBalance(takerAta);

      // Short-fuse market: accept before kickoff, then outlive the delay.
      const kickoffTs = new BN((await chainNow()) + 4);
      const { market, escrow } = await createMarket({ kickoffTs });
      await acceptMarket(market, escrow, taker, takerAta);

      await waitUntilChainTime(kickoffTs.toNumber() + VOID_DELAY_SECS);
      await voidIx(market, escrow).rpc();

      // Both stakes made the round trip; nothing minted, nothing lost.
      expect(await tokenBalance(creatorAta)).to.equal(creatorBefore);
      expect(await tokenBalance(takerAta)).to.equal(takerBefore);
      await assertClosed(market, "market");
      await assertClosed(escrow, "escrow");
    });
  });
});
