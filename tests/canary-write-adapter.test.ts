import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSupervisedExecution,
  buildIocLimitPreview,
  CanaryWriteAdapter,
  expectedExecutionApproval,
} from "../src/server/canary-write-adapter.js";

test("blocks writes unless both switches and exact trade approval pass", () => {
  const tradeId = "trade-1";
  assert.throws(() => assertSupervisedExecution({
    gate: { killSwitch: true, executionEnabled: false },
    tradeId,
    approval: expectedExecutionApproval(tradeId),
  }), /killSwitch,executionDisabled/);
  assert.throws(() => assertSupervisedExecution({
    gate: { killSwitch: false, executionEnabled: true },
    tradeId,
    approval: "EXECUTE $40 another-trade",
  }), /approvalMismatch/);
  assert.doesNotThrow(() => assertSupervisedExecution({
    gate: { killSwitch: false, executionEnabled: true },
    tradeId,
    approval: expectedExecutionApproval(tradeId),
  }));
});

test("rounds short and close IOC limits conservatively to tick size", () => {
  assert.deepEqual(buildIocLimitPreview({
    side: "Ask",
    bestPrice: "165.17",
    tickSize: "0.05",
    slippagePct: 0.1,
  }), {
    orderType: "Limit",
    timeInForce: "IOC",
    side: "Ask",
    bestPrice: "165.17",
    worstPrice: "165",
    tickSize: "0.05",
    slippagePct: "0.1",
  });
  assert.equal(buildIocLimitPreview({
    side: "Bid",
    bestPrice: "165.17",
    tickSize: "0.05",
    slippagePct: 0.1,
  }).worstPrice, "165.35");
});

test("does not invoke Backpack when supervised execution is blocked", async () => {
  let calls = 0;
  const adapter = new CanaryWriteAdapter(
    { killSwitch: true, executionEnabled: false },
    { executeIocLimitOrder: async () => { calls += 1; throw new Error("must not run"); } },
  );
  await assert.rejects(() => adapter.submitHedge({
    tradeId: "trade-1",
    approval: expectedExecutionApproval("trade-1"),
    clientId: 42,
    symbol: "SPCX.US_USDC_PERP",
    quantity: "0.12",
    worstPrice: "166.50",
  }), /Canary write blocked/);
  assert.equal(calls, 0);
});
