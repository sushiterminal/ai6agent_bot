import assert from "node:assert/strict";
import test from "node:test";
import { expectedExecutionApproval } from "../src/server/canary-write-adapter.js";
import {
  backpackClientOrderId,
  executeApprovedSpot,
  executeConfirmedHedge,
} from "../src/server/supervised-entry.js";
import { createTradeIntent, type TradeIntent } from "../src/server/trade-intents.js";
import { fingerprintCanaryPreview, type CanaryApprovalPreview } from "../src/server/canary-approval.js";

function approvedIntent(): TradeIntent {
  const intent = createTradeIntent({
    tradeId: "trade-1",
    idempotencyKey: "operator:SPCX:entry-1",
    pair: "SPCX",
    basisRisk: "same_issuer",
  });
  const preview: CanaryApprovalPreview = {
    tradeId: intent.tradeId,
    pair: "SPCX",
    basisRisk: "same_issuer",
    sizeUsd: 40,
    createdAt: new Date("2026-09-23T10:00:00Z"),
    expiresAt: new Date("2026-09-23T10:01:00Z"),
    spot: { inputMint: "USDC", outputMint: "SPCX", inAmount: "40000000", outAmount: "240000", minimumOutAmount: "238800", priceImpactPct: "0", route: ["Fixture"], quoteResponse: {}, simulationPassed: true, priorityFeeLamports: 1 },
    hedge: { symbol: "SPCX.US_USDC_PERP", quantity: "0.24", bestBid: "165", worstPrice: "164.96", tickSize: "0.01", timeInForce: "IOC", preflightPassed: true },
    economics: { entryEdgePct: 0.5, immediateLiquidationPnlUsd: -0.2, worstCaseLossUsd: 0.2 },
    risk: { pass: true, failures: [], gates: { all: true } },
  };
  return {
    ...intent,
    status: "APPROVED",
    version: 3,
    preview,
    previewFingerprint: fingerprintCanaryPreview(preview),
  };
}

test("blocks before preflight, signing, persistence, or send when switches are closed", async () => {
  const calls: string[] = [];
  await assert.rejects(() => executeApprovedSpot({
    intent: approvedIntent(),
    approval: expectedExecutionApproval("trade-1"),
    gate: { killSwitch: true, executionEnabled: false },
    now: new Date("2026-09-23T10:00:10Z"),
    preflight: async () => { calls.push("preflight"); },
    prepare: async () => { calls.push("prepare"); return { signature: "sig", signedTransactionBase64: "tx" }; },
    store: { transitionTradeIntent: async () => { calls.push("persist"); return approvedIntent(); } },
    send: async () => { calls.push("send"); return "sig"; },
  }), /killSwitch,executionDisabled/);
  assert.deepEqual(calls, []);
});

test("uses a deterministic uint32 Backpack client id", () => {
  const first = backpackClientOrderId("trade-1", "OPEN_HEDGE");
  assert.equal(first, backpackClientOrderId("trade-1", "OPEN_HEDGE"));
  assert.notEqual(first, backpackClientOrderId("trade-1", "CLOSE_HEDGE"));
  assert.ok(first > 0 && first <= 0xffff_ffff);
});

test("hedges actual confirmed spot quantity with persist-before-send", async () => {
  const calls: string[] = [];
  const base = approvedIntent();
  const intent: TradeIntent = {
    ...base,
    status: "SPOT_CONFIRMED",
    version: 5,
    spotFilledQuantity: "0.2396",
  };
  let persistedClientId: number | undefined;
  const result = await executeConfirmedHedge({
    intent,
    approval: expectedExecutionApproval(intent.tradeId),
    gate: { killSwitch: false, executionEnabled: true },
    preflight: async () => { calls.push("preflight"); },
    store: {
      transitionTradeIntent: async (change) => {
        calls.push("persist");
        persistedClientId = change.patch?.backpackClientOrderId;
        return { ...intent, status: change.to, version: change.expectedVersion + 1 };
      },
    },
    send: async (clientOrderId) => {
      calls.push("send");
      assert.equal(clientOrderId, persistedClientId);
      return { orderId: "order-1" };
    },
  });
  assert.deepEqual(calls, ["preflight", "persist", "send"]);
  assert.equal(result.status, "HEDGE_SUBMITTED");
});

test("runs preflight before prepare and persist-before-send", async () => {
  const calls: string[] = [];
  const intent = approvedIntent();
  const result = await executeApprovedSpot({
    intent,
    approval: expectedExecutionApproval(intent.tradeId),
    gate: { killSwitch: false, executionEnabled: true },
    now: new Date("2026-09-23T10:00:10Z"),
    preflight: async () => { calls.push("preflight"); },
    prepare: async () => { calls.push("prepare"); return { signature: "sig", signedTransactionBase64: "tx" }; },
    store: {
      transitionTradeIntent: async (change) => {
        calls.push("persist");
        return { ...intent, status: change.to, version: change.expectedVersion + 1 };
      },
    },
    send: async () => { calls.push("send"); return "sig"; },
  });
  assert.deepEqual(calls, ["preflight", "prepare", "persist", "send"]);
  assert.equal(result.status, "SPOT_SUBMITTED");
});
