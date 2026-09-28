import assert from "node:assert/strict";
import test from "node:test";
import { submitHedgeOnce, submitSpotOnce } from "../src/server/execution-coordinator.js";
import { createTradeIntent, type TradeIntent } from "../src/server/trade-intents.js";

function intent(status: TradeIntent["status"], version = 2): TradeIntent {
  return { ...createTradeIntent({
    tradeId: "trade-1",
    idempotencyKey: "operator:SPCX:test-1",
    pair: "SPCX",
    basisRisk: "same_issuer",
  }), status, version };
}

test("never broadcasts spot when durable persistence fails", async () => {
  let sends = 0;
  await assert.rejects(() => submitSpotOnce({
    intent: intent("APPROVED"),
    prepare: async () => ({ signature: "signature-1", signedTransactionBase64: "signed-1" }),
    store: { transitionTradeIntent: async () => { throw new Error("Mongo unavailable"); } },
    send: async () => { sends += 1; return "signature-1"; },
  }), /Mongo unavailable/);
  assert.equal(sends, 0);
});

test("broadcasts spot once and marks a timeout uncertain without retry", async () => {
  let sends = 0;
  const transitions: string[] = [];
  const result = await submitSpotOnce({
    intent: intent("APPROVED"),
    prepare: async () => ({ signature: "signature-1", signedTransactionBase64: "signed-1" }),
    store: {
      transitionTradeIntent: async (change) => {
        transitions.push(`${change.from}->${change.to}`);
        return intent(change.to, change.expectedVersion + 1);
      },
    },
    send: async () => { sends += 1; throw new Error("timeout"); },
  });
  assert.equal(sends, 1);
  assert.deepEqual(transitions, ["APPROVED->SPOT_SUBMITTED", "SPOT_SUBMITTED->UNCERTAIN"]);
  assert.equal(result.status, "UNCERTAIN");
  assert.equal(result.requiresReconciliation, true);
});

test("persists Backpack client id before one order submission", async () => {
  let sends = 0;
  let persistedClientId: number | undefined;
  const result = await submitHedgeOnce({
    intent: intent("SPOT_CONFIRMED", 4),
    clientOrderId: 42001,
    store: {
      transitionTradeIntent: async (change) => {
        persistedClientId = change.patch?.backpackClientOrderId;
        return intent(change.to, change.expectedVersion + 1);
      },
    },
    send: async (clientOrderId) => {
      sends += 1;
      assert.equal(persistedClientId, clientOrderId);
      return { orderId: "order-1" };
    },
  });
  assert.equal(sends, 1);
  assert.equal(result.status, "HEDGE_SUBMITTED");
  assert.equal(result.requiresReconciliation, true);
});

test("refuses to execute a recovered already-submitted intent", async () => {
  let sends = 0;
  await assert.rejects(() => submitSpotOnce({
    intent: intent("SPOT_SUBMITTED", 3),
    prepare: async () => ({ signature: "signature-1", signedTransactionBase64: "signed-1" }),
    store: { transitionTradeIntent: async () => intent("SPOT_SUBMITTED", 4) },
    send: async () => { sends += 1; return "signature-1"; },
  }), /requires an APPROVED intent/);
  assert.equal(sends, 0);
});
