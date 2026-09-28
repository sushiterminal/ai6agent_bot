import assert from "node:assert/strict";
import test from "node:test";
import {
  decideHedgeReconciliation,
  decideSpotReconciliation,
  reconcileBackpackOrder,
} from "../src/server/trade-reconciliation.js";

test("reconciles Backpack fills by client order id", () => {
  const outcome = reconcileBackpackOrder({
    clientOrderId: 42001,
    openOrders: [],
    orderHistory: [{
      id: "order-1",
      clientId: 42001,
      symbol: "SPCX.US_USDC_PERP",
      side: "Ask",
      quantity: "0.12",
      createdAt: "1758621600000",
      executedQuantity: "0.12",
      executedQuoteQuantity: "19.80",
      status: "Filled",
    }],
    fills: [
      { clientId: "42001", fee: "0.01", feeSymbol: "USDC", orderId: "order-1", price: "165", quantity: "0.05", side: "Ask", symbol: "SPCX.US_USDC_PERP", timestamp: "1", tradeId: 1 },
      { clientId: "42001", fee: "0.01", feeSymbol: "USDC", orderId: "order-1", price: "165", quantity: "0.07", side: "Ask", symbol: "SPCX.US_USDC_PERP", timestamp: "2", tradeId: 2 },
    ],
  });
  assert.equal(outcome.state, "FILLED");
  assert.equal(outcome.filledQuantity, "0.12");
  assert.equal(outcome.fillCount, 2);
});

test("maps confirmed spot and complete hedge to durable progress", () => {
  const spot = decideSpotReconciliation({
    state: "CONFIRMED",
    confirmationStatus: "finalized",
    slot: 1,
    error: null,
    feeLamports: 5_000,
    tokenDeltaRaw: "120000",
  }, 6);
  assert.equal(spot.to, "SPOT_CONFIRMED");
  assert.equal(spot.patch.spotFilledQuantity, "0.12");
  const hedge = decideHedgeReconciliation({
    state: "FILLED",
    orderId: "order-1",
    filledQuantity: "0.12",
    fillCount: 1,
    status: "Filled",
  });
  assert.equal(hedge.to, "HEDGED");
  assert.equal(hedge.patch.backpackOrderId, "order-1");
});

test("maps missing results to uncertain without authorizing retries", () => {
  const spot = decideSpotReconciliation({
    state: "NOT_FOUND",
    confirmationStatus: null,
    slot: null,
    error: null,
    feeLamports: null,
    tokenDeltaRaw: null,
  }, 6);
  assert.equal(spot.to, "UNCERTAIN");
  assert.match(spot.patch.lastError ?? "", /resubmission is forbidden/);
  const hedge = decideHedgeReconciliation({
    state: "NOT_FOUND",
    orderId: null,
    filledQuantity: "0",
    fillCount: 0,
    status: null,
  });
  assert.equal(hedge.to, "UNCERTAIN");
  assert.match(hedge.patch.lastError ?? "", /duplicate order is forbidden/);
});

test("keeps missing and partial Backpack outcomes fail-closed", () => {
  assert.equal(reconcileBackpackOrder({
    clientOrderId: 7,
    openOrders: [],
    orderHistory: [],
    fills: [],
  }).state, "NOT_FOUND");
  const partial = reconcileBackpackOrder({
    clientOrderId: 7,
    openOrders: [{ id: "order-7", clientId: 7, symbol: "SPCX.US_USDC_PERP", side: "Ask", quantity: "0.12" }],
    orderHistory: [],
    fills: [{ clientId: 7, fee: "0", feeSymbol: "USDC", orderId: "order-7", price: "165", quantity: "0.03", side: "Ask", symbol: "SPCX.US_USDC_PERP", timestamp: "1", tradeId: 1 }],
  });
  assert.equal(partial.state, "PARTIALLY_FILLED");
  assert.equal(partial.filledQuantity, "0.03");
  const cancelledPartial = reconcileBackpackOrder({
    clientOrderId: 8,
    openOrders: [],
    orderHistory: [{
      id: "order-8",
      clientId: 8,
      symbol: "SPCX.US_USDC_PERP",
      side: "Ask",
      quantity: "0.12",
      createdAt: "1",
      executedQuantity: "0.03",
      executedQuoteQuantity: "4.95",
      status: "Cancelled",
    }],
    fills: [],
  });
  assert.equal(cancelledPartial.state, "PARTIALLY_FILLED");
});
