import assert from "node:assert/strict";
import test from "node:test";
import { calculateProfitability, vwap } from "../src/server/profitability.js";

test("vwap sorts an unordered bid book from the best price", () => {
  const result = vwap(
    [
      ["100", "2"],
      ["102", "1"],
      ["101", "3"],
    ],
    2,
    "bid",
  );
  assert.equal(result.price, 101.5);
});

const baseInput = {
  sizeUsd: 100,
  quantity: 1,
  dexSellProceedsUsd: 99.96,
  backpackBidVwap: 100.2,
  backpackAskVwap: 100.21,
  backpackTakerFeePct: 0.05,
  fundingRatePct: 0,
  expectedFundingPeriods: 0,
  targetExitBasisPct: 0,
  expectedSpotSlippagePct: 0,
  expectedPerpSlippagePct: 0,
  solanaTransactionFeesUsd: 0,
  priorityFeesUsd: 0,
  partialFillReservePct: 0,
  safetyBufferPct: 0.05,
};

test("separates entry basis, convergence PnL, and immediate liquidation PnL", () => {
  const result = calculateProfitability({
    ...baseInput,
  });

  assert.ok(Math.abs(result.entryBasisPct - 0.2) < 1e-9);
  assert.ok(Math.abs(result.estimatedConvergencePnlUsd - 0.09992) < 1e-9);
  assert.ok(Math.abs(result.immediateLiquidationPnlUsd - (-0.150205)) < 1e-9);
  assert.ok(Math.abs(result.entryEdgePct - 0.04992) < 1e-9);
});

test("charges explicit slippage, Solana fees, priority fees, and partial-fill reserve", () => {
  const result = calculateProfitability({
    ...baseInput,
    expectedSpotSlippagePct: 0.1,
    expectedPerpSlippagePct: 0.1,
    solanaTransactionFeesUsd: 0.01,
    priorityFeesUsd: 0.02,
    partialFillReservePct: 0.05,
  });

  assert.equal(result.solanaAndPriorityFeesUsd, 0.03);
  assert.equal(result.partialFillReserveUsd, 0.05);
  assert.ok(result.estimatedSlippageUsd > 0.39);
  assert.ok(result.estimatedConvergencePnlUsd < -0.37);
});

test("positive funding is income for a short and safety buffer is not booked as a cost", () => {
  const withoutFunding = calculateProfitability(baseInput);
  const withFunding = calculateProfitability({
    ...baseInput,
    fundingRatePct: 0.01,
    expectedFundingPeriods: 2,
    safetyBufferPct: 1,
  });

  assert.ok(Math.abs(withFunding.estimatedFundingPnlUsd - 0.02004) < 1e-9);
  assert.ok(
    Math.abs(
      withFunding.estimatedConvergencePnlUsd
      - withoutFunding.estimatedConvergencePnlUsd
      - withFunding.estimatedFundingPnlUsd,
    ) < 1e-9,
  );
  assert.ok(Math.abs(withFunding.entryEdgePct - (withFunding.expectedReturnPct - 1)) < 1e-9);
});

test("rejects invalid monetary inputs instead of producing NaN", () => {
  assert.throws(
    () => calculateProfitability({ ...baseInput, quantity: 0 }),
    /quantity must be finite/,
  );
});

