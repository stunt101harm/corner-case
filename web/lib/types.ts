/**
 * types.ts — wire types for what the relay serves. Field names mirror the
 * TxLINE API exactly (same convention as the keeper) so recorded, live and
 * typed data never drift.
 */

export interface FixtureMeta {
  Ts: number;
  /** Kickoff, epoch ms. */
  StartTime: number;
  Competition: string;
  CompetitionId: number;
  Participant1: string;
  Participant2: string;
  FixtureId: number;
  Participant1IsHome: boolean;
  GameState?: number | string;
}

export interface PeriodScore {
  Goals?: number;
  YellowCards?: number;
  RedCards?: number;
  Corners?: number;
}

export interface ScoreBoard {
  Participant1?: { Total?: PeriodScore; H1?: PeriodScore; H2?: PeriodScore };
  Participant2?: { Total?: PeriodScore; H1?: PeriodScore; H2?: PeriodScore };
}

export interface ScoreRecord {
  FixtureId: number;
  /** kickoff | goal | corner | yellow_card | red_card | halftime_finalised | game_finalised | … */
  Action: string;
  Ts: number;
  Seq: number;
  /** 3 = halftime finalised, 100 = game finalised (the settlement trigger). */
  StatusId?: number;
  Clock?: { Running: boolean; Seconds: number };
  Score?: ScoreBoard;
  /** Stat key → value: 1/2 goals, 3/4 yellows, 5/6 reds, 7/8 corners (P1/P2); +1000 H1, +3000 H2. */
  Stats?: Record<string, number>;
}

export interface ProofNodeJson {
  hash: number[];
  isRightSibling: boolean;
}

export interface StatLeafJson {
  key: number;
  value: number;
  period: number;
}

/** Raw /api/proof (== TxLINE stat-validation) response. */
export interface StatValidationJson {
  ts: number;
  statsToProve: StatLeafJson[];
  eventStatRoot: number[];
  summary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    eventStatsSubTreeRoot: number[];
  };
  statProofs: ProofNodeJson[][];
  subTreeProof: ProofNodeJson[];
  mainTreeProof: ProofNodeJson[];
}

/**
 * One line of keeper/settlements.jsonl (written by the settle submitter).
 * Tolerant shape: the journal has been observed both with and without
 * `predicateTrue`, and with payout as string or number.
 */
export interface SettlementEntry {
  market: string;
  fixtureId: number;
  predicateTrue?: boolean;
  winner: string;
  payout: string | number;
  epochDay: number;
  proofTs: number;
  txSig: string;
  settledAt: string | number;
  statKeys?: number[];
  finalisedSeq?: number;
}
