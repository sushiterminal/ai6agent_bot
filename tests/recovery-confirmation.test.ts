import assert from "node:assert/strict";
import test from "node:test";
import { classifyRecoveryExposure, confirmRecoveryOrder, reconcileRecoveryOrder } from "../src/server/recovery-confirmation.js";
import { buildRecoveryPreview, fingerprintRecoveryPreview } from "../src/server/recovery-preview.js";
import { assertTradeIntentTransition, createTradeIntent, type TradeIntent } from "../src/server/trade-intents.js";

function recovering(status: "RECOVERING" | "UNCERTAIN" = "RECOVERING"): TradeIntent {
  const preview = buildRecoveryPreview({
    tradeId: "trade-1", pair: "SPCX", sourceStatus: "SPOT_ONLY",
    spotQuantity: "0.12", perpNetQuantity: "0", ttlMs: 30_000,
    market: { bestBid: "165", bestAsk: "165.1", tickSize: "0.01", quantityStep: "0.001", minimumQuantity: "0.001", maximumQuantity: "10", slippagePct: 0.05 },
  });
  return {
    ...createTradeIntent({ tradeId: "trade-1", idempotencyKey: "operator:recovery-confirm-1", pair: "SPCX", basisRisk: "same_issuer" }),
    status,
    version: 10,
    recoveryPreview: preview,
    recoveryFingerprint: fingerprintRecoveryPreview(preview),
    recoveryClientOrderId: 123,
  };
}

test("classifies factual post-recovery exposure", () => {
  assert.equal(classifyRecoveryExposure({ spotQuantity: "0.12", perpNetQuantity: "-0.119", fullRecoveryFill: true }), "OPEN");
  assert.equal(classifyRecoveryExposure({ spotQuantity: "0", perpNetQuantity: "0", fullRecoveryFill: true }), "CLOSED");
  assert.equal(classifyRecoveryExposure({ spotQuantity: "0.12", perpNetQuantity: "-0.03", fullRecoveryFill: false }), "PARTIALLY_HEDGED");
  assert.equal(classifyRecoveryExposure({ spotQuantity: "0", perpNetQuantity: "-0.03", fullRecoveryFill: false }), "PERP_ONLY");
  assert.equal(classifyRecoveryExposure({ spotQuantity: "0.1", perpNetQuantity: "-0.2", fullRecoveryFill: true }), "MANUAL_INTERVENTION");
});

test("terminal recovery fill transitions using factual exposure", async () => {
  const intent = recovering();
  const transitions: string[] = [];
  const result = await reconcileRecoveryOrder({
    intent,
    outcome: { state: "FILLED", orderId: "order-1", filledQuantity: "0.119", fillCount: 1, status: "Filled" },
    readExposure: async () => ({ spotQuantity: "0.12", perpNetQuantity: "-0.119" }),
    store: {
      transitionTradeIntent: async (change) => {
        assertTradeIntentTransition(change.from, change.to);
        transitions.push(`${change.from}->${change.to}`);
        return { ...intent, ...change.patch, status: change.to, version: change.expectedVersion + 1 };
      },
    },
  });
  assert.equal(result.resolved, true);
  assert.equal(result.intent.status, "OPEN");
  assert.equal(result.intent.recoveryFilledQuantity, "0.119");
  assert.deepEqual(transitions, ["RECOVERING->OPEN"]);
});

test("non-terminal recovery outcome remains unchanged and performs no exposure read", async () => {
  const intent = recovering("UNCERTAIN");
  let reads = 0;
  const result = await reconcileRecoveryOrder({
    intent,
    outcome: { state: "NOT_FOUND", orderId: null, filledQuantity: "0", fillCount: 0, status: null },
    readExposure: async () => { reads += 1; return { spotQuantity: "0", perpNetQuantity: "0" }; },
    store: { transitionTradeIntent: async () => { throw new Error("must not transition"); } },
  });
  assert.equal(result.resolved, false);
  assert.equal(result.intent.status, "UNCERTAIN");
  assert.equal(reads, 0);
});

test("bounded recovery confirmation becomes uncertain without resubmission", async () => {
  const intent = recovering();
  let clock = 0;
  let reads = 0;
  const transitions: string[] = [];
  const result = await confirmRecoveryOrder({
    intent,
    read: async () => {
      reads += 1;
      return { state: "NOT_FOUND", orderId: null, filledQuantity: "0", fillCount: 0, status: null };
    },
    readExposure: async () => { throw new Error("must not read exposure"); },
    timeoutMs: 25,
    pollIntervalMs: 10,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    store: {
      transitionTradeIntent: async (change) => {
        assertTradeIntentTransition(change.from, change.to);
        transitions.push(`${change.from}->${change.to}`);
        return { ...intent, ...change.patch, status: change.to, version: change.expectedVersion + 1 };
      },
    },
  });
  assert.equal(reads, 3);
  assert.equal(result.intent.status, "UNCERTAIN");
  assert.deepEqual(transitions, ["RECOVERING->UNCERTAIN"]);
});
