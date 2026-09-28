import assert from "node:assert/strict";
import test from "node:test";
import { validateJupiterLiveTradingSettings } from "../src/server/jupiter-live-settings.js";

test("accepts and normalizes live trading settings", () => {
  assert.deepEqual(validateJupiterLiveTradingSettings({
    tradeSizeUsd: 50,
    minEntryEdgePct: 0.25,
    exitEdgePct: 0.1,
    maxBudgetUsd: 500,
  }), {
    tradeSizeUsd: 50,
    minEntryEdgePct: 0.25,
    exitEdgePct: 0.1,
    maxBudgetUsd: 500,
  });
});

test("requires the budget to cover at least one entry", () => {
  assert.throws(() => validateJupiterLiveTradingSettings({
    tradeSizeUsd: 50,
    minEntryEdgePct: 0.25,
    exitEdgePct: 0.1,
    maxBudgetUsd: 49.99,
  }), /at least the entry amount/);
});

test("requires the exit edge to remain below the entry edge", () => {
  assert.throws(() => validateJupiterLiveTradingSettings({
    tradeSizeUsd: 50,
    minEntryEdgePct: 0.25,
    exitEdgePct: 0.25,
    maxBudgetUsd: 500,
  }), /lower than the entry edge/);
});

test("rejects missing and non-finite values", () => {
  assert.throws(() => validateJupiterLiveTradingSettings({
    tradeSizeUsd: 50,
    minEntryEdgePct: Number.NaN,
    exitEdgePct: 0.1,
    maxBudgetUsd: 500,
  }), /finite number/);
});
