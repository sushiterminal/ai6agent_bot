import assert from "node:assert/strict";
import test from "node:test";
import { expectedExecutionApproval } from "../src/server/canary-write-adapter.js";
import {
  buildRecoveryPreview,
  expectedRecoveryApprovalText,
  fingerprintRecoveryPreview,
} from "../src/server/recovery-preview.js";
import {
  recoveryClientOrderId,
  submitApprovedRecoveryOrder,
} from "../src/server/recovery-execution.js";
import { createTradeIntent, type TradeIntent } from "../src/server/trade-intents.js";

function recoverable(): TradeIntent {
  const preview = buildRecoveryPreview({
    tradeId: "trade-1",
    pair: "SPCX",
    sourceStatus: "SPOT_ONLY",
    spotQuantity: "0.12",
    perpNetQuantity: "0",
    now: new Date("2026-09-23T10:00:00Z"),
    ttlMs: 30_000,
    market: {
      bestBid: "165",
      bestAsk: "165.1",
      tickSize: "0.01",
      quantityStep: "0.001",
      minimumQuantity: "0.001",
      maximumQuantity: "10",
      slippagePct: 0.05,
    },
  });
  return {
    ...createTradeIntent({
      tradeId: "trade-1",
      idempotencyKey: "operator:SPCX:recovery-order-1",
      pair: "SPCX",
      basisRisk: "same_issuer",
    }),
    status: "SPOT_ONLY",
    version: 8,
    backpackClientOrderId: 321,
    recoveryPreview: preview,
    recoveryFingerprint: fingerprintRecoveryPreview(preview),
  };
}

function approvals(intent: TradeIntent) {
  return {
    recoveryApproval: expectedRecoveryApprovalText(intent.tradeId, intent.recoveryFingerprint!),
    executionApproval: expectedExecutionApproval(intent.tradeId),
  };
}

test("closed switches block before preflight, persistence, and recovery order", async () => {
  const intent = recoverable();
  const calls: string[] = [];
  await assert.rejects(() => submitApprovedRecoveryOrder({
    intent,
    ...approvals(intent),
    gate: { killSwitch: true, executionEnabled: false },
    now: new Date("2026-09-23T10:00:10Z"),
    preflight: async () => { calls.push("preflight"); },
    store: { transitionTradeIntent: async () => { calls.push("persist"); return intent; } },
    send: async () => { calls.push("send"); return { orderId: "order" }; },
  }), /killSwitch,executionDisabled/);
  assert.deepEqual(calls, []);
});

test("persists a distinct deterministic recovery id before one order", async () => {
  const intent = recoverable();
  const calls: string[] = [];
  let persistedId: number | undefined;
  const result = await submitApprovedRecoveryOrder({
    intent,
    ...approvals(intent),
    gate: { killSwitch: false, executionEnabled: true },
    now: new Date("2026-09-23T10:00:10Z"),
    preflight: async () => { calls.push("preflight"); },
    store: {
      transitionTradeIntent: async (change) => {
        calls.push(`persist:${change.to}`);
        persistedId = change.patch?.recoveryClientOrderId;
        return { ...intent, ...change.patch, status: change.to, version: change.expectedVersion + 1 };
      },
    },
    send: async (clientOrderId) => {
      calls.push("send");
      assert.equal(clientOrderId, persistedId);
      return { orderId: "recovery-order" };
    },
  });
  assert.deepEqual(calls, ["preflight", "persist:RECOVERING", "send"]);
  assert.equal(result.status, "RECOVERING");
  assert.equal(result.clientOrderId, recoveryClientOrderId(intent.recoveryFingerprint!));
  assert.notEqual(result.clientOrderId, intent.backpackClientOrderId);
});

test("marks an ambiguous recovery response uncertain without retry", async () => {
  const intent = recoverable();
  const calls: string[] = [];
  const result = await submitApprovedRecoveryOrder({
    intent,
    ...approvals(intent),
    gate: { killSwitch: false, executionEnabled: true },
    now: new Date("2026-09-23T10:00:10Z"),
    preflight: async () => { calls.push("preflight"); },
    store: {
      transitionTradeIntent: async (change) => {
        calls.push(`persist:${change.to}`);
        return { ...intent, ...change.patch, status: change.to, version: change.expectedVersion + 1 };
      },
    },
    send: async () => {
      calls.push("send");
      throw new Error("timeout");
    },
  });
  assert.deepEqual(calls, ["preflight", "persist:RECOVERING", "send", "persist:UNCERTAIN"]);
  assert.equal(result.status, "UNCERTAIN");
});
