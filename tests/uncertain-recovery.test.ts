import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTradeIntentTransition,
  createTradeIntent,
  type TradeIntent,
} from "../src/server/trade-intents.js";
import { recoverUncertainIntent } from "../src/server/uncertain-recovery.js";

function uncertain(patch: Partial<TradeIntent>): TradeIntent {
  return {
    ...createTradeIntent({
      tradeId: "trade-1",
      idempotencyKey: "operator:SPCX:recovery-1",
      pair: "SPCX",
      basisRisk: "same_issuer",
    }),
    status: "UNCERTAIN",
    version: 5,
    ...patch,
  };
}

function store(transitions: string[]) {
  return {
    transitionTradeIntent: async (change: any) => {
      assertTradeIntentTransition(change.from, change.to);
      transitions.push(`${change.from}->${change.to}`);
      return {
        ...uncertain({}),
        ...change.patch,
        status: change.to,
        version: change.expectedVersion + 1,
      };
    },
  };
}

test("keeps an absent uncertain spot transaction unresolved without any transition", async () => {
  const transitions: string[] = [];
  let hedgeReads = 0;
  const intent = uncertain({ solanaSignature: "sig" });
  const result = await recoverUncertainIntent({
    intent,
    tokenDecimals: 6,
    store: store(transitions),
    readSpot: async () => ({
      state: "NOT_FOUND", confirmationStatus: null, slot: null, error: null,
      feeLamports: null, tokenDeltaRaw: null,
    }),
    readHedge: async () => {
      hedgeReads += 1;
      throw new Error("must not read hedge");
    },
  });
  assert.equal(result.resolved, false);
  assert.equal(result.intent.status, "UNCERTAIN");
  assert.equal(hedgeReads, 0);
  assert.deepEqual(transitions, []);
});

test("resolves a finalized uncertain spot from its actual token delta", async () => {
  const transitions: string[] = [];
  const result = await recoverUncertainIntent({
    intent: uncertain({ solanaSignature: "sig" }),
    tokenDecimals: 6,
    store: store(transitions),
    readSpot: async () => ({
      state: "CONFIRMED", confirmationStatus: "finalized", slot: 10, error: null,
      feeLamports: 5000, tokenDeltaRaw: "119000",
    }),
    readHedge: async () => { throw new Error("must not read hedge"); },
  });
  assert.equal(result.resolved, true);
  assert.equal(result.intent.status, "SPOT_CONFIRMED");
  assert.equal(result.intent.spotFilledQuantity, "0.119");
  assert.deepEqual(transitions, ["UNCERTAIN->SPOT_CONFIRMED"]);
});

test("prefers the persisted hedge client id and preserves a partial fill", async () => {
  const transitions: string[] = [];
  let spotReads = 0;
  const result = await recoverUncertainIntent({
    intent: uncertain({ solanaSignature: "sig", backpackClientOrderId: 123 }),
    tokenDecimals: 6,
    store: store(transitions),
    readSpot: async () => {
      spotReads += 1;
      throw new Error("must not read spot");
    },
    readHedge: async () => ({
      state: "PARTIALLY_FILLED", orderId: "order-1", filledQuantity: "0.03",
      fillCount: 1, status: "Cancelled",
    }),
  });
  assert.equal(result.intent.status, "PARTIALLY_HEDGED");
  assert.equal(result.intent.hedgeFilledQuantity, "0.03");
  assert.equal(spotReads, 0);
  assert.deepEqual(transitions, ["UNCERTAIN->PARTIALLY_HEDGED"]);
});

test("requires manual intervention when no external id was persisted", async () => {
  const transitions: string[] = [];
  const result = await recoverUncertainIntent({
    intent: uncertain({}),
    tokenDecimals: 6,
    store: store(transitions),
    readSpot: async () => { throw new Error("must not read spot"); },
    readHedge: async () => { throw new Error("must not read hedge"); },
  });
  assert.equal(result.intent.status, "MANUAL_INTERVENTION");
  assert.deepEqual(transitions, ["UNCERTAIN->MANUAL_INTERVENTION"]);
});
