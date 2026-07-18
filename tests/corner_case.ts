// Corner Case — full on-chain test suite: escrow lifecycle, all five check
// gates exercised adversarially, and the COMPLETE settlement path run against
// TxLINE's real program + real Merkle proofs (see the settle_market describe
// block and Anchor.toml [test.validator] clones).
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
  transferChecked,
  closeAccount,
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
    statKeys?: number[];
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
        opts?.strategy ?? STRATEGY,
        opts?.statKeys ?? [1, 2]
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
          caller: creator.publicKey, // any fee payer; provider wallet here
          market,
          creator: creator.publicKey,
          taker: taker.publicKey,
          mint,
          creatorAta,
          takerAta,
          escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
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

  // ---- settle ------------------------------------------------------------
  //
  // Deterministic AND real: the local validator has TxLINE's txoracle program
  // and the epoch-day-20649 daily_scores_roots account CLONED from devnet
  // (Anchor.toml [test.validator]), and these tests replay committed real
  // Merkle proofs from the England v Argentina semifinal (2026-07-15,
  // fixture 18241006, final seq 962: England 1-2 Argentina). No mocks —
  // every settlement here runs the full production validation path.

  describe("settle_market", () => {
    const TXORACLE_ID = new PublicKey(
      "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"
    );
    const SEMI_FIXTURE = new BN(18241006);
    const SEMI_EPOCH_DAY = 20649;

    // Hand-rolled borsh for NDimensionalStrategy. (Anchor 0.31's standalone
    // `coder.types.encode` returns a broken zero-filled buffer for this
    // nested enum type — while the instruction coder handles the identical
    // type fine. 18 explicit bytes beat a coder bug.)
    //
    // Layout: geometric_targets vec len u32 | distance_predicate option u8 |
    // discrete_predicates vec len u32 | per predicate: variant u8
    // (0=Single{index u8}, 1=Binary{index_a u8, index_b u8, op u8
    // (0=Add,1=Subtract)}) | threshold i32 LE | comparison u8
    // (0=GreaterThan,1=LessThan,2=EqualTo).
    const CMP = { gt: 0, lt: 1, eq: 2 } as const;
    const OP = { add: 0, sub: 1 } as const;

    function binaryStrategy(
      indexA: number,
      indexB: number,
      op: number,
      threshold: number,
      cmp: number
    ): Buffer {
      const b = Buffer.alloc(4 + 1 + 4 + 1 + 3 + 4 + 1);
      let o = 0;
      b.writeUInt32LE(0, o); o += 4;        // geometric_targets: empty
      b.writeUInt8(0, o); o += 1;           // distance_predicate: None
      b.writeUInt32LE(1, o); o += 4;        // discrete_predicates: 1 entry
      b.writeUInt8(1, o); o += 1;           // variant: Binary
      b.writeUInt8(indexA, o); o += 1;
      b.writeUInt8(indexB, o); o += 1;
      b.writeUInt8(op, o); o += 1;
      b.writeInt32LE(threshold, o); o += 4;
      b.writeUInt8(cmp, o);
      return b;
    }

    /** away − home goals > 0 — TRUE for England 1-2 Argentina (keys [1,2]). */
    const STRAT_AWAY_WINS = binaryStrategy(1, 0, OP.sub, 0, CMP.gt);

    /** home − away goals > 0 — FALSE for this match. */
    const STRAT_HOME_WINS = binaryStrategy(0, 1, OP.sub, 0, CMP.gt);

    function loadProof(name: string) {
      return JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "fixtures", name), "utf-8")
      );
    }
    const finalProof = loadProof("proof_18241006_seq962_k1-2.json");
    const halftimeProof = loadProof("proof_18241006_seq425_halftime_k1-2.json");

    /** API response → the typed payload our settle_market instruction takes. */
    function buildPayload(val: any) {
      const mapProof = (arr: any[]) =>
        arr.map((n) => ({
          hash: Array.from(n.hash) as number[],
          isRightSibling: n.isRightSibling,
        }));
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
        stats: val.statsToProve.map((s: any, i: number) => ({
          stat: { key: s.key, value: s.value, period: s.period },
          statProof: mapProof(val.statProofs[i]),
        })),
      };
    }

    function rootsPdaFor(epochDay: number): PublicKey {
      const le = Buffer.alloc(2);
      le.writeUInt16LE(epochDay);
      return PublicKey.findProgramAddressSync(
        [Buffer.from("daily_scores_roots"), le],
        TXORACLE_ID
      )[0];
    }

    /** Create+accept a semifinal market with explicit fixture/epoch values. */
    async function createSemiMarket(opts?: {
      strategy?: Buffer;
      statKeys?: number[];
      fixtureId?: BN;
      epochDay?: number;
      creatorSide?: boolean;
    }) {
      const nonce = nextNonce();
      const kickoffTs = new BN((await chainNow()) + 3600);
      const market = marketPda(creator.publicKey, nonce);
      const escrow = escrowAta(market);
      await program.methods
        .createMarket(
          nonce,
          opts?.fixtureId ?? SEMI_FIXTURE,
          opts?.epochDay ?? SEMI_EPOCH_DAY,
          kickoffTs,
          opts?.creatorSide ?? true,
          STAKE,
          opts?.strategy ?? STRAT_AWAY_WINS,
          opts?.statKeys ?? [1, 2]
        )
        .accounts({
          creator: creator.publicKey,
          market,
          mint,
          creatorAta,
          escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .rpc();
      await acceptMarket(market, escrow, taker, takerAta);
      return { market, escrow };
    }

    function settleIx(
      market: PublicKey,
      escrow: PublicKey,
      payload: any,
      opts?: { epochDay?: number; rootsPda?: PublicKey; signer?: Keypair }
    ) {
      const epochDay = opts?.epochDay ?? SEMI_EPOCH_DAY;
      const signer = opts?.signer ?? outsider; // default: NOT a party — settlement is permissionless
      return program.methods
        .settleMarket(epochDay, payload)
        .accounts({
          caller: signer.publicKey,
          market,
          creator: creator.publicKey,
          taker: taker.publicKey,
          mint,
          creatorAta,
          takerAta,
          escrow,
          txlineRoots: opts?.rootsPda ?? rootsPdaFor(epochDay),
          txlineProgram: TXORACLE_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .preInstructions([
          anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
            units: 1_400_000,
          }),
        ])
        .signers([signer]);
    }

    it("settles TRUE to the side that bet TRUE — full production path, called by an outsider", async () => {
      const { market, escrow } = await createSemiMarket(); // creator bets TRUE on away-wins
      const creatorBefore = await tokenBalance(creatorAta);
      const payload = buildPayload(finalProof);

      await settleIx(market, escrow, payload).rpc();

      // Creator (TRUE side) sweeps both stakes; both accounts closed.
      expect(await tokenBalance(creatorAta)).to.equal(
        creatorBefore + BigInt(STAKE.muln(2).toString())
      );
      await assertClosed(market, "market");
      await assertClosed(escrow, "escrow");
    });

    it("settles FALSE to the other side — CPI success is NOT read as predicate-true", async () => {
      const { market, escrow } = await createSemiMarket({
        strategy: STRAT_HOME_WINS, // evaluates FALSE for 1-2
      });
      const takerBefore = await tokenBalance(takerAta);

      await settleIx(market, escrow, buildPayload(finalProof)).rpc();

      // The VALID proof of a FALSE predicate pays the taker.
      expect(await tokenBalance(takerAta)).to.equal(
        takerBefore + BigInt(STAKE.muln(2).toString())
      );
      await assertClosed(market, "market");
    });

    it("gate #2 (finality): rejects a mid-match proof — period 3 != 100", async () => {
      const { market, escrow } = await createSemiMarket();
      await expectErr(
        settleIx(market, escrow, buildPayload(halftimeProof)).rpc(),
        "ProofNotFinal"
      );
    });

    it("gate #4 (fixture binding): a valid proof for a DIFFERENT fixture cannot settle", async () => {
      const { market, escrow } = await createSemiMarket({
        fixtureId: new BN(99999999), // market bet on some other match
      });
      await expectErr(
        settleIx(market, escrow, buildPayload(finalProof)).rpc(),
        "FixtureMismatch"
      );
    });

    it("gate #5 (stat-key binding): a valid proof of the WRONG stats cannot settle", async () => {
      const { market, escrow } = await createSemiMarket({
        statKeys: [7, 8], // strategy written against corners...
      });
      await expectErr(
        // ...but the keeper proves goals (keys 1,2). Without gate #5 this
        // valid proof would evaluate the corners predicate against goal
        // values and could flip the payout.
        settleIx(market, escrow, buildPayload(finalProof)).rpc(),
        "StatKeysMismatch"
      );
    });

    it("gate #3 (epoch window): rejects an epoch_day outside {stored, stored+1}", async () => {
      const { market, escrow } = await createSemiMarket({
        epochDay: SEMI_EPOCH_DAY - 2,
      });
      await expectErr(
        settleIx(market, escrow, buildPayload(finalProof)).rpc(),
        "EpochDayOutOfRange"
      );
    });

    it("rejects a corrupted proof — TxLINE's validation hard-errors the whole tx", async () => {
      const { market, escrow } = await createSemiMarket();
      const payload = buildPayload(finalProof);
      payload.stats[0].statProof[0].hash[0] ^= 0xff;
      try {
        await settleIx(market, escrow, payload).rpc();
        assert.fail("expected the corrupted proof to fail");
      } catch (e: any) {
        // The error surfaces from the INNER txoracle program (InvalidStatProof).
        expect(String(e)).to.match(/InvalidStatProof|6023|custom program error/i);
      }
      // Market untouched — still settleable with the honest proof.
      await settleIx(market, escrow, buildPayload(finalProof)).rpc();
      await assertClosed(market, "market");
    });

    it("rejects a mismatched roots account for the claimed epoch_day", async () => {
      const { market, escrow } = await createSemiMarket();
      await expectErr(
        settleIx(market, escrow, buildPayload(finalProof), {
          rootsPda: rootsPdaFor(SEMI_EPOCH_DAY + 1), // exists-or-not, it's not the arg's PDA
        }).rpc(),
        "InvalidRootsAccount"
      );
    });

    it("cannot settle an unmatched market", async () => {
      // Created but never accepted.
      const nonce = nextNonce();
      const kickoffTs = new BN((await chainNow()) + 3600);
      const market = marketPda(creator.publicKey, nonce);
      const escrow = escrowAta(market);
      await program.methods
        .createMarket(nonce, SEMI_FIXTURE, SEMI_EPOCH_DAY, kickoffTs, true, STAKE, STRAT_AWAY_WINS, [1, 2])
        .accounts({
          creator: creator.publicKey,
          market,
          mint,
          creatorAta,
          escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .rpc();

      // The taker constraint (default pubkey) fails account resolution before
      // the state check can even run — either way, no settlement.
      try {
        await settleIx(market, escrow, buildPayload(finalProof), {}).rpc();
        assert.fail("expected settle of unmatched market to fail");
      } catch {
        /* expected */
      }
    });

    it("double settle: the second attempt dies cleanly, no double payout", async () => {
      const { market, escrow } = await createSemiMarket();
      const creatorBefore = await tokenBalance(creatorAta);
      await settleIx(market, escrow, buildPayload(finalProof)).rpc();
      try {
        await settleIx(market, escrow, buildPayload(finalProof)).rpc();
        assert.fail("expected second settle to fail");
      } catch {
        /* market account is closed — clean failure */
      }
      // Exactly one payout happened.
      expect(await tokenBalance(creatorAta)).to.equal(
        creatorBefore + BigInt(STAKE.muln(2).toString())
      );
    });

    it("gate #3 positive path: epoch_day = stored + 1 settles (post-midnight finals)", async () => {
      // Market created with the PREVIOUS day's estimate; the proof lives
      // under 20649's root — exactly the evening-kickoff-finalises-after-
      // midnight case the +1 tolerance exists for.
      const { market, escrow } = await createSemiMarket({
        epochDay: SEMI_EPOCH_DAY - 1,
      });
      await settleIx(market, escrow, buildPayload(finalProof)).rpc();
      await assertClosed(market, "market");
    });

    it("forged destination: outsider's ATA as creator_ata is a constraint violation", async () => {
      const { market, escrow } = await createSemiMarket();
      const outsiderBefore = await tokenBalance(outsiderAta);
      try {
        await program.methods
          .settleMarket(SEMI_EPOCH_DAY, buildPayload(finalProof))
          .accounts({
            caller: outsider.publicKey,
            market,
            creator: creator.publicKey,
            taker: taker.publicKey,
            mint,
            creatorAta: outsiderAta, // the forgery — not creator's derived ATA
            takerAta,
            escrow,
            txlineRoots: rootsPdaFor(SEMI_EPOCH_DAY),
            txlineProgram: TXORACLE_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
          } as any)
          .preInstructions([
            anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ])
          .signers([outsider])
          .rpc();
        assert.fail("expected the forged destination to fail");
      } catch {
        /* associated-token derivation constraint rejects it */
      }
      expect(await tokenBalance(outsiderAta)).to.equal(outsiderBefore);
      // The honest settle still works afterwards.
      await settleIx(market, escrow, buildPayload(finalProof)).rpc();
      await assertClosed(market, "market");
    });

    it("closed-ATA ransom defused: settle recreates the winner's ATA and pays", async () => {
      // Taker wins (home-wins predicate is FALSE for 1-2) but has closed
      // their token account — pre-fix this bricked settlement forever.
      const { market, escrow } = await createSemiMarket({
        strategy: STRAT_HOME_WINS,
      });
      const drained = await tokenBalance(takerAta);
      await transferChecked(
        connection, taker, takerAta, mint, outsiderAta, taker, drained, DECIMALS
      );
      await closeAccount(connection, taker, takerAta, taker.publicKey, taker);
      expect(await connection.getAccountInfo(takerAta)).to.equal(null);

      await settleIx(market, escrow, buildPayload(finalProof)).rpc();

      // Recreated at the same derived address, payout delivered.
      expect(await tokenBalance(takerAta)).to.equal(
        BigInt(STAKE.muln(2).toString())
      );
      await assertClosed(market, "market");

      // Restore taker liquidity for any later tests.
      await mintTo(connection, payer, mint, takerAta, payer, 1_000_000_000);
    });

    it("closed-ATA ransom defused: void recreates the refund ATA and unwinds", async () => {
      const nonce = nextNonce();
      const kickoffTs = new BN((await chainNow()) + 2);
      const market = marketPda(creator.publicKey, nonce);
      const escrow = escrowAta(market);
      await program.methods
        .createMarket(nonce, SEMI_FIXTURE, SEMI_EPOCH_DAY, kickoffTs, true, STAKE, STRAT_AWAY_WINS, [1, 2])
        .accounts({
          creator: creator.publicKey,
          market,
          mint,
          creatorAta,
          escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .rpc();
      await acceptMarket(market, escrow, taker, takerAta);

      const drained = await tokenBalance(takerAta);
      await transferChecked(
        connection, taker, takerAta, mint, outsiderAta, taker, drained, DECIMALS
      );
      await closeAccount(connection, taker, takerAta, taker.publicKey, taker);

      await waitUntilChainTime(kickoffTs.toNumber() + VOID_DELAY_SECS);
      await program.methods
        .voidMarket()
        .accounts({
          caller: outsider.publicKey, // a stranger unbricks it, permissionlessly
          market,
          creator: creator.publicKey,
          taker: taker.publicKey,
          mint,
          creatorAta,
          takerAta,
          escrow,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        } as any)
        .signers([outsider])
        .rpc();

      expect(await tokenBalance(takerAta)).to.equal(BigInt(STAKE.toString()));
      await assertClosed(market, "market");
      await mintTo(connection, payer, mint, takerAta, payer, 1_000_000_000);
    });
  });
});
