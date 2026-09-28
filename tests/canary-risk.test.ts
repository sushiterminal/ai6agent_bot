import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCanaryRisk } from "../src/server/canary-risk.js";

const policy = {
  killSwitch: false,
  maxLossPerTradeUsd: 1,
  maxDailyLossUsd: 5,
  maxDailyAttempts: 5,
  maxOpenPositions: 1,
  minExpectedPnlUsd: 0,
  minEntryEdgePct: 0,
  allowedPairs: ["SPCX", "META"],
};

const input = {
  pair: "SPCX" as const,
  sizeUsd: 40,
  worstCaseLossUsd: 0.5,
  realizedPnlTodayUsd: -2,
  attemptsToday: 2,
  openPositions: 0,
  hasUnknownIntent: false,
  expectedPnlUsd: 0.25,
  entryEdgePct: 0.5,
};

test("passes the configured forty dollar canary limits", () => {
  const result = evaluateCanaryRisk(policy, input);
  assert.equal(result.pass, true);
  assert.deepEqual(result.remaining, { dailyLossUsd: 3, attempts: 3, positions: 1 });
});

test("fails closed when the kill switch is engaged", () => {
  const result = evaluateCanaryRisk({ ...policy, killSwitch: true }, input);
  assert.deepEqual(result.failures, ["killSwitchOff"]);
});

test("rejects loss, limits, unknown state, and unprofitable entries independently", () => {
  const result = evaluateCanaryRisk(policy, {
    ...input,
    worstCaseLossUsd: 1.01,
    realizedPnlTodayUsd: -5,
    attemptsToday: 5,
    openPositions: 1,
    hasUnknownIntent: true,
    expectedPnlUsd: -0.1,
    entryEdgePct: -0.2,
  });
  assert.deepEqual(result.failures, [
    "perTradeLoss", "dailyLoss", "dailyAttempts", "concurrency", "knownState",
    "expectedPnl", "entryEdge",
  ]);
});

test("allows an explicitly configured cross-issuer pair but rejects unlisted pairs", () => {
  assert.equal(evaluateCanaryRisk(policy, { ...input, pair: "META" }).gates.pairAllowed, true);
  assert.equal(evaluateCanaryRisk(policy, { ...input, pair: "MU" }).gates.pairAllowed, false);
});
