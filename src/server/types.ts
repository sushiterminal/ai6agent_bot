export const TRACKED_SIZE = 3_000 as const;
export const CANARY_SIZE = 40 as const;
export type TrackedSize = typeof TRACKED_SIZE | typeof CANARY_SIZE;
export type PairSymbol =
  | "MU"
  | "SNDK"
  | "SPCX"
  | "AMD"
  | "HOOD"
  | "INTC"
  | "SKHY"
  | "DRAM"
  | "META"
  | "MSFT"
  | "GOOGL"
  | "QQQ"
  | "SPY";

export interface TrackedPair {
  symbol: PairSymbol;
  name: string;
  tokenMint: string;
  tokenDecimals: number;
  perpSymbol: string;
  basisRisk: "same_issuer" | "cross_issuer";
}

export interface SpreadSample {
  pair: PairSymbol;
  basisRisk: "same_issuer" | "cross_issuer";
  sizeUsd: TrackedSize;
  capturedAt: Date;
  tokenMint: string;
  perpSymbol: string;
  quantity: number;
  dexBuyPrice: number;
  dexSellPrice: number;
  backpackBidVwap: number;
  backpackAskVwap: number;
  backpackTakerFeePct: number;
  entryBasisPct: number;
  targetExitBasisPct: number;
  immediateExitBasisPct: number;
  expectedReturnPct: number;
  entryEdgePct: number;
  safetyBufferPct: number;
  estimatedConvergencePnlUsd: number;
  immediateLiquidationPnlUsd: number;
  estimatedFundingPnlUsd: number;
  estimatedBackpackFeesUsd: number;
  estimatedSlippageUsd: number;
  solanaAndPriorityFeesUsd: number;
  partialFillReserveUsd: number;
  fundingRatePct: number;
  fundingIntervalMinutes: number;
  nextFundingAt: Date;
  marketSession: string;
  marketHoliday: string | null;
  markPrice: number;
  indexPrice: number;
  jupiterBuyRoute: string[];
  jupiterSellRoute: string[];
  bookUpdateId: string;
  bookTimestamp: Date;
  backpackDataAgeMs: number;
  quoteStartedAt: Date;
  quoteCompletedAt: Date;
  quoteDurationMs: number;
  confirmationIndex: number;
}

export interface MonitorState {
  status: "starting" | "collecting" | "ready" | "error";
  lastCycleAt: string | null;
  nextCycleAt: string | null;
  lastError: string | null;
  futuresMakerFeePct: number | null;
  futuresTakerFeePct: number | null;
  activePair: PairSymbol | null;
  completedPairs: number;
  totalPairs: number;
  pairErrors: Partial<Record<PairSymbol, string>>;
  schedulerLagMs: number;
  confirmedSignals: number;
  marketSession: string;
  marketHoliday: string | null;
  marketContextUpdatedAt: string | null;
  fundingIntervalMinutes: Partial<Record<PairSymbol, number>>;
  restartAttempts: number;
  restoredPairs: number;
}
