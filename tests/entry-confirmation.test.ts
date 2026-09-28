import assert from "node:assert/strict";
import test from "node:test";
import { confirmSubmittedHedge, confirmSubmittedSpot } from "../src/server/entry-confirmation.js";
import { createTradeIntent, type TradeIntent } from "../src/server/trade-intents.js";

function submitted(status: TradeIntent["status"], version = 4): TradeIntent {
  return {
    ...createTradeIntent({
      tradeId: "trade-1",
      idempotencyKey: "operator:SPCX:confirm-1",
      pair: "SPCX",
      basisRisk: "same_issuer",
    }),
    status,
    version,
  };
}

function fakeStore(intent: TradeIntent, transitions: string[]) {
  return {
    transitionTradeIntent: async (change: any) => {
      transitions.push(`${change.from}->${change.to}`);
      intent = { ...intent, ...change.patch, status: change.to, version: change.expectedVersion + 1 };
      return intent;
    },
  };
}

test("waits through pending Solana status and confirms only finalized", async () => {
  const transitions: string[] = [];
  const intent = submitted("SPOT_SUBMITTED");
  let reads = 0;
  let clock = 0;
  const result = await confirmSubmittedSpot({
    intent,
    tokenDecimals: 6,
    store: fakeStore(intent, transitions),
    read: async () => {
      reads += 1;
      if (reads === 1) return { state: "PENDING" as const, confirmationStatus: "processed", slot: 1, error: null, feeLamports: null, tokenDeltaRaw: null };
      if (reads === 2) return { state: "CONFIRMED" as const, confirmationStatus: "confirmed", slot: 2, error: null, feeLamports: 5000, tokenDeltaRaw: "120000" };
      return { state: "CONFIRMED" as const, confirmationStatus: "finalized", slot: 3, error: null, feeLamports: 5000, tokenDeltaRaw: "120000" };
    },
    options: {
      timeoutMs: 100,
      pollIntervalMs: 10,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    },
  });
  assert.equal(reads, 3);
  assert.equal(result.status, "SPOT_CONFIRMED");
  assert.equal(result.spotFilledQuantity, "0.12");
  assert.deepEqual(transitions, ["SPOT_SUBMITTED->SPOT_CONFIRMED"]);
});

test("marks a missing Solana result uncertain at deadline without a send", async () => {
  const transitions: string[] = [];
  const intent = submitted("SPOT_SUBMITTED");
  let clock = 0;
  let reads = 0;
  const result = await confirmSubmittedSpot({
    intent,
    tokenDecimals: 6,
    store: fakeStore(intent, transitions),
    read: async () => {
      reads += 1;
      return { state: "NOT_FOUND" as const, confirmationStatus: null, slot: null, error: null, feeLamports: null, tokenDeltaRaw: null };
    },
    options: {
      timeoutMs: 25,
      pollIntervalMs: 10,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    },
  });
  assert.equal(reads, 3);
  assert.equal(result.status, "UNCERTAIN");
  assert.match(result.lastError ?? "", /NOT_FOUND/);
  assert.deepEqual(transitions, ["SPOT_SUBMITTED->UNCERTAIN"]);
});

test("moves a filled hedge through HEDGED to OPEN", async () => {
  const transitions: string[] = [];
  const intent = submitted("HEDGE_SUBMITTED", 6);
  const result = await confirmSubmittedHedge({
    intent,
    store: fakeStore(intent, transitions),
    read: async () => ({ state: "FILLED", orderId: "order-1", filledQuantity: "0.12", fillCount: 1, status: "Filled" }),
    options: { timeoutMs: 100, pollIntervalMs: 10 },
  });
  assert.equal(result.status, "OPEN");
  assert.deepEqual(transitions, ["HEDGE_SUBMITTED->HEDGED", "HEDGED->OPEN"]);
});

test("preserves partial hedge exposure as a terminal recovery state", async () => {
  const transitions: string[] = [];
  const intent = submitted("HEDGE_SUBMITTED", 6);
  const result = await confirmSubmittedHedge({
    intent,
    store: fakeStore(intent, transitions),
    read: async () => ({ state: "PARTIALLY_FILLED", orderId: "order-1", filledQuantity: "0.03", fillCount: 1, status: "Cancelled" }),
    options: { timeoutMs: 100, pollIntervalMs: 10 },
  });
  assert.equal(result.status, "PARTIALLY_HEDGED");
  assert.equal(result.hedgeFilledQuantity, "0.03");
  assert.deepEqual(transitions, ["HEDGE_SUBMITTED->PARTIALLY_HEDGED"]);
});
