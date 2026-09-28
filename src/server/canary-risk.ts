import type { PairSymbol } from "./types.js";
import { CANARY_SIZE } from "./types.js";

export interface CanaryRiskPolicy {
  killSwitch: boolean;
  maxLossPerTradeUsd: number;
  maxDailyLossUsd: number;
  maxDailyAttempts: number;
  maxOpenPositions: number;
  minExpectedPnlUsd: number;
  minEntryEdgePct: number;
  allowedPairs: readonly string[];
}

export interface CanaryRiskInput {
  pair: PairSymbol;
  sizeUsd: number;
  worstCaseLossUsd: number;
  realizedPnlTodayUsd: number;
  attemptsToday: number;
  openPositions: number;
  hasUnknownIntent: boolean;
  expectedPnlUsd: number;
  entryEdgePct: number;
}

export function evaluateCanaryRisk(policy: CanaryRiskPolicy, input: CanaryRiskInput) {
  const dailyLossUsd = Math.max(0, -input.realizedPnlTodayUsd);
  const gates = {
    killSwitchOff: !policy.killSwitch,
    fixedNotional: input.sizeUsd === CANARY_SIZE,
    pairAllowed: policy.allowedPairs.includes(input.pair),
    perTradeLoss: Number.isFinite(input.worstCaseLossUsd)
      && input.worstCaseLossUsd >= 0
      && input.worstCaseLossUsd <= policy.maxLossPerTradeUsd,
    dailyLoss: Number.isFinite(dailyLossUsd) && dailyLossUsd < policy.maxDailyLossUsd,
    dailyAttempts: Number.isInteger(input.attemptsToday)
      && input.attemptsToday >= 0
      && input.attemptsToday < policy.maxDailyAttempts,
    concurrency: Number.isInteger(input.openPositions)
      && input.openPositions >= 0
      && input.openPositions < policy.maxOpenPositions,
    knownState: !input.hasUnknownIntent,
    expectedPnl: Number.isFinite(input.expectedPnlUsd)
      && input.expectedPnlUsd > policy.minExpectedPnlUsd,
    entryEdge: Number.isFinite(input.entryEdgePct)
      && input.entryEdgePct > policy.minEntryEdgePct,
  };
  const failures = Object.entries(gates)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return {
    pass: failures.length === 0,
    failures,
    gates,
    remaining: {
      dailyLossUsd: Math.max(0, policy.maxDailyLossUsd - dailyLossUsd),
      attempts: Math.max(0, policy.maxDailyAttempts - input.attemptsToday),
      positions: Math.max(0, policy.maxOpenPositions - input.openPositions),
    },
  };
}
