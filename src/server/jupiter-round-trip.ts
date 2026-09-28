import { randomUUID } from "node:crypto";
import type { PairSymbol, SpreadSample } from "./types.js";
import type { JupiterLiveTradingSettings } from "./jupiter-live-settings.js";

export type JupiterRoundTripStatus =
  | "ENTRY_PLANNED"
  | "ENTRY_SUBMITTED"
  | "HEDGE_PENDING"
  | "HEDGE_SUBMITTED"
  | "OPEN"
  | "HEDGE_CLOSE_PENDING"
  | "HEDGE_CLOSE_SUBMITTED"
  | "EXIT_PLANNED"
  | "EXIT_SUBMITTED"
  | "CLOSED"
  | "FAILED"
  | "MANUAL_INTERVENTION";

export type JupiterRoundTripExitReason =
  | "TARGET"
  | "STOP"
  | "TIMEOUT"
  | "PORTFOLIO_STOP";
export type JupiterLivePortfolioStatus = "RUNNING" | "STOPPED";
export type JupiterLivePortfolioStopMode = "DAILY_LOSS" | "MANUAL" | "SELL_ALL";

export interface JupiterLivePortfolioControl {
  key: "global";
  status: JupiterLivePortfolioStatus;
  stopLossUsd: number;
  startedAt: Date;
  updatedAt: Date;
  stoppedAt: Date | null;
  stopReason: string | null;
  stopMode: JupiterLivePortfolioStopMode | null;
  liquidateOnStop: boolean;
  statusDayUtc: string;
  settings: JupiterLiveTradingSettings;
  settingsUpdatedAt: Date;
}

export interface JupiterExecutionQuote {
  inAmount: string;
  outAmount: string;
  minimumOutAmount: string;
  priceImpactPct: string;
  route: string[];
}

export interface JupiterRoundTripEvent {
  from: JupiterRoundTripStatus | null;
  to: JupiterRoundTripStatus;
  at: Date;
  reason: string;
  signature?: string;
}

export interface JupiterRoundTripTrade {
  tradeId: string;
  sourceTradeId: string;
  campaignId?: string;
  sourceIntegrity?: "VERIFIED_LIVE" | "LEGACY_SYNTHETIC_TRIGGER";
  pair: PairSymbol;
  tokenMint: string;
  tokenDecimals: number;
  sizeUsd: number;
  status: JupiterRoundTripStatus;
  active: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  openedAt: Date | null;
  closedAt: Date | null;
  entryCapturedAt: Date;
  entryConfirmationIndex: number;
  entryEdgePct: number;
  entryTierStart?: number;
  entryTier?: number;
  entryModel?: JupiterRoundTripEntryModel;
  lastEdgePct: number;
  exitReason: JupiterRoundTripExitReason | null;
  entryQuote: JupiterExecutionQuote | null;
  exitQuote: JupiterExecutionQuote | null;
  entrySignature: string | null;
  exitSignature: string | null;
  entryRecentBlockhash: string | null;
  exitRecentBlockhash: string | null;
  entryLastValidBlockHeight: number | null;
  exitLastValidBlockHeight: number | null;
  entrySignedTransactionBase64: string | null;
  exitSignedTransactionBase64: string | null;
  entryTokenAmountRaw: string | null;
  entrySpentUsd: number | null;
  exitReceivedUsd: number | null;
  entryPriceUsd: number | null;
  exitPriceUsd: number | null;
  entryFeeLamports: number | null;
  exitFeeLamports: number | null;
  hedgeSymbol: string;
  entryHedgeClientOrderId: number | null;
  entryHedgeOrderId: string | null;
  entryHedgeQuantity: string | null;
  entryHedgeFilledQuantity: string | null;
  entryHedgeLimitPrice: string | null;
  entryHedgeAveragePriceUsd: number | null;
  entryHedgeFeeUsd: number | null;
  unhedgedSpotQuantity: string | null;
  exitHedgeClientOrderId: number | null;
  exitHedgeOrderId: string | null;
  exitHedgeQuantity: string | null;
  exitHedgeFilledQuantity: string | null;
  exitHedgeLimitPrice: string | null;
  exitHedgeAveragePriceUsd: number | null;
  exitHedgeFeeUsd: number | null;
  spotRealizedPnlUsd: number | null;
  perpRealizedPnlUsd: number | null;
  realizedPnlUsd: number | null;
  exitRequestedAt?: Date | null;
  exitRequestedEdgePct?: number | null;
  exitAttempts: number;
  lastError: string | null;
  events: JupiterRoundTripEvent[];
}

export interface JupiterRoundTripPolicy {
  notionalUsd: number;
  minEntryEdgePct: number;
  exitEdgePct: number;
  addNotionalUsd: number;
  addEdgeStepPct: number;
}

export interface JupiterRoundTripEntryModel {
  quoteSizeUsd: number;
  quantity: number;
  backpackBidVwap: number;
  backpackTakerFeePct: number;
  solanaAndPriorityFeesUsd: number;
  partialFillReserveUsd: number;
}

const transitions: Record<JupiterRoundTripStatus, readonly JupiterRoundTripStatus[]> = {
  ENTRY_PLANNED: ["ENTRY_SUBMITTED", "FAILED"],
  ENTRY_SUBMITTED: ["HEDGE_PENDING", "FAILED", "MANUAL_INTERVENTION"],
  HEDGE_PENDING: ["HEDGE_SUBMITTED", "MANUAL_INTERVENTION"],
  HEDGE_SUBMITTED: ["OPEN", "MANUAL_INTERVENTION"],
  OPEN: ["HEDGE_CLOSE_PENDING", "MANUAL_INTERVENTION"],
  HEDGE_CLOSE_PENDING: ["HEDGE_CLOSE_SUBMITTED", "MANUAL_INTERVENTION"],
  HEDGE_CLOSE_SUBMITTED: ["EXIT_PLANNED", "MANUAL_INTERVENTION"],
  EXIT_PLANNED: ["EXIT_SUBMITTED", "MANUAL_INTERVENTION"],
  EXIT_SUBMITTED: ["CLOSED", "EXIT_PLANNED", "MANUAL_INTERVENTION"],
  CLOSED: [],
  FAILED: [],
  MANUAL_INTERVENTION: [],
};

export function assertJupiterRoundTripTransition(
  from: JupiterRoundTripStatus,
  to: JupiterRoundTripStatus,
) {
  if (!transitions[from].includes(to)) {
    throw new Error(`Invalid Jupiter round-trip transition ${from} -> ${to}`);
  }
}

export function signalSourceId(
  sample: Pick<SpreadSample, "pair" | "capturedAt" | "confirmationIndex">,
) {
  return `${sample.pair}:${sample.capturedAt.toISOString()}:${sample.confirmationIndex}`;
}

export function jupiterCampaignId(
  sample: Pick<SpreadSample, "pair" | "capturedAt" | "confirmationIndex">,
) {
  return `signal:${signalSourceId(sample)}`;
}

export function confirmedRoundTripSourceIds(
  samples: Array<Pick<SpreadSample, "pair" | "capturedAt" | "confirmationIndex">>,
  confirmedSignal: boolean,
) {
  return new Set(confirmedSignal ? samples.map(signalSourceId) : []);
}

export function isJupiterRoundTripEntry(
  sample: Pick<SpreadSample, "entryEdgePct">,
  confirmedSignal: boolean,
  policy: Pick<JupiterRoundTripPolicy, "minEntryEdgePct">,
) {
  return confirmedSignal
    && sample.entryEdgePct >= policy.minEntryEdgePct;
}

export function decideJupiterRoundTripExit(
  edgePct: number,
  policy: Pick<JupiterRoundTripPolicy, "exitEdgePct">,
): JupiterRoundTripExitReason | null {
  return Number.isFinite(edgePct) && edgePct <= policy.exitEdgePct
    ? "TARGET"
    : null;
}

export function highestJupiterEntryTier(
  edgePct: number,
  policy: Pick<JupiterRoundTripPolicy, "minEntryEdgePct" | "addEdgeStepPct">,
) {
  if (!Number.isFinite(edgePct) || edgePct + 1e-9 < policy.minEntryEdgePct) return -1;
  return Math.floor((edgePct - policy.minEntryEdgePct + 1e-9) / policy.addEdgeStepPct);
}

export function nextJupiterEntryTier(
  edgePct: number,
  activeTiers: readonly number[],
  policy: Pick<JupiterRoundTripPolicy, "minEntryEdgePct" | "addEdgeStepPct">,
) {
  const eligibleTier = highestJupiterEntryTier(edgePct, policy);
  if (eligibleTier < 0) return null;
  if (activeTiers.length === 0) return 0;
  const nextTier = Math.max(...activeTiers) + 1;
  return nextTier <= eligibleTier ? nextTier : null;
}

export function jupiterEntrySizeUsd(
  tier: number,
  policy: Pick<JupiterRoundTripPolicy, "notionalUsd" | "addNotionalUsd">,
) {
  return tier === 0 ? policy.notionalUsd : policy.addNotionalUsd;
}

export interface JupiterEntryBatch {
  startTier: number;
  endTier: number;
  sizeUsd: number;
}

export function nextJupiterEntryBatch(
  edgePct: number,
  activeTiers: readonly number[],
  policy: JupiterRoundTripPolicy,
  maxSizeUsd = Number.POSITIVE_INFINITY,
): JupiterEntryBatch | null {
  const eligibleTier = highestJupiterEntryTier(edgePct, policy);
  const startTier = activeTiers.length === 0 ? 0 : Math.max(...activeTiers) + 1;
  if (
    eligibleTier < startTier
    || (!Number.isFinite(maxSizeUsd) && maxSizeUsd !== Number.POSITIVE_INFINITY)
  ) return null;

  let sizeUsd = 0;
  let endTier = startTier - 1;
  for (let tier = startTier; tier <= eligibleTier; tier += 1) {
    const tierSizeUsd = jupiterEntrySizeUsd(tier, policy);
    if (sizeUsd + tierSizeUsd > maxSizeUsd + 1e-9) break;
    sizeUsd += tierSizeUsd;
    endTier = tier;
  }
  return endTier < startTier
    ? null
    : { startTier, endTier, sizeUsd: Math.round(sizeUsd * 100) / 100 };
}

export function summarizeJupiterRealizedPnl(
  trades: ReadonlyArray<Pick<JupiterRoundTripTrade, "realizedPnlUsd">>,
) {
  return trades.reduce((summary, trade) => {
    if (!Number.isFinite(trade.realizedPnlUsd)) return summary;
    const pnlUsd = Number(trade.realizedPnlUsd);
    summary.netUsd += pnlUsd;
    if (pnlUsd < 0) summary.grossLossUsd += Math.abs(pnlUsd);
    return summary;
  }, { netUsd: 0, grossLossUsd: 0 });
}

export function createJupiterRoundTripTrade(input: {
  sample: SpreadSample;
  sourceSample?: Pick<SpreadSample, "pair" | "capturedAt" | "confirmationIndex">;
  sourceTradeId?: string;
  sizeUsd?: number;
  entryTierStart?: number;
  entryTier?: number;
  tokenDecimals: number;
  policy: JupiterRoundTripPolicy;
  now?: Date;
}): JupiterRoundTripTrade {
  const now = input.now ?? new Date();
  const entryTier = input.entryTier ?? 0;
  const entryTierStart = input.entryTierStart ?? entryTier;
  if (entryTierStart < 0 || entryTierStart > entryTier) {
    throw new Error("Jupiter entry tier range is invalid");
  }
  return {
    tradeId: randomUUID(),
    sourceTradeId: input.sourceTradeId ?? signalSourceId(input.sourceSample ?? input.sample),
    campaignId: jupiterCampaignId(input.sample),
    sourceIntegrity: "VERIFIED_LIVE",
    pair: input.sample.pair,
    tokenMint: input.sample.tokenMint,
    tokenDecimals: input.tokenDecimals,
    sizeUsd: input.sizeUsd ?? input.policy.notionalUsd,
    status: "ENTRY_PLANNED",
    active: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
    openedAt: null,
    closedAt: null,
    entryCapturedAt: (input.sourceSample ?? input.sample).capturedAt,
    entryConfirmationIndex: (input.sourceSample ?? input.sample).confirmationIndex,
    entryEdgePct: input.sample.entryEdgePct,
    entryTierStart,
    entryTier,
    entryModel: {
      quoteSizeUsd: input.sample.sizeUsd,
      quantity: input.sample.quantity,
      backpackBidVwap: input.sample.backpackBidVwap,
      backpackTakerFeePct: input.sample.backpackTakerFeePct,
      solanaAndPriorityFeesUsd: input.sample.solanaAndPriorityFeesUsd,
      partialFillReserveUsd: input.sample.partialFillReserveUsd,
    },
    lastEdgePct: input.sample.entryEdgePct,
    exitReason: null,
    entryQuote: null,
    exitQuote: null,
    entrySignature: null,
    exitSignature: null,
    entryRecentBlockhash: null,
    exitRecentBlockhash: null,
    entryLastValidBlockHeight: null,
    exitLastValidBlockHeight: null,
    entrySignedTransactionBase64: null,
    exitSignedTransactionBase64: null,
    entryTokenAmountRaw: null,
    entrySpentUsd: null,
    exitReceivedUsd: null,
    entryPriceUsd: null,
    exitPriceUsd: null,
    entryFeeLamports: null,
    exitFeeLamports: null,
    hedgeSymbol: input.sample.perpSymbol,
    entryHedgeClientOrderId: null,
    entryHedgeOrderId: null,
    entryHedgeQuantity: null,
    entryHedgeFilledQuantity: null,
    entryHedgeLimitPrice: null,
    entryHedgeAveragePriceUsd: null,
    entryHedgeFeeUsd: null,
    unhedgedSpotQuantity: null,
    exitHedgeClientOrderId: null,
    exitHedgeOrderId: null,
    exitHedgeQuantity: null,
    exitHedgeFilledQuantity: null,
    exitHedgeLimitPrice: null,
    exitHedgeAveragePriceUsd: null,
    exitHedgeFeeUsd: null,
    spotRealizedPnlUsd: null,
    perpRealizedPnlUsd: null,
    realizedPnlUsd: null,
    exitRequestedAt: null,
    exitRequestedEdgePct: null,
    exitAttempts: 0,
    lastError: null,
    events: [{
      from: null,
      to: "ENTRY_PLANNED",
      at: now,
      reason: entryTierStart === entryTier
        ? "Confirmed positive entry edge"
        : `Confirmed positive entry edge covered tiers ${entryTierStart}-${entryTier}`,
    }],
  };
}
