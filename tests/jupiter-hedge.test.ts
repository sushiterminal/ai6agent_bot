import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedHedgeQuantity,
  calculateHedgedRealizedPnl,
  summarizeBackpackExecution,
} from "../src/server/jupiter-hedge.js";

test("rounds the short down and bounds the unhedged spot remainder", () => {
  assert.deepEqual(boundedHedgeQuantity({
    spotQuantity: "0.336311",
    stepSize: "0.01",
    minimumQuantity: "0.01",
    maximumQuantity: "100",
    markPriceUsd: "148.66",
    maxUnhedgedUsd: 2,
  }), {
    hedgeQuantity: "0.33",
    unhedgedSpotQuantity: "0.006311",
  });
  assert.throws(() => boundedHedgeQuantity({
    spotQuantity: "0.336311",
    stepSize: "0.01",
    minimumQuantity: "0.01",
    maximumQuantity: "100",
    markPriceUsd: "148.66",
    maxUnhedgedUsd: 0.5,
  }), /remainder/);
});

test("reconciles exact Backpack fills and calculates weighted execution", () => {
  const result = summarizeBackpackExecution({
    clientOrderId: 42,
    symbol: "SPCX.US_USDC_PERP",
    side: "Ask",
    openOrders: [],
    orderHistory: [{
      id: "order-1",
      clientId: 42,
      symbol: "SPCX.US_USDC_PERP",
      side: "Ask",
      quantity: "0.3",
      createdAt: "1",
      executedQuantity: "0.3",
      executedQuoteQuantity: "44.7",
      status: "Filled",
    }],
    fills: [
      { clientId: 42, fee: "0.01", feeSymbol: "USDC", orderId: "order-1", price: "150", quantity: "0.1", side: "Ask", symbol: "SPCX.US_USDC_PERP", timestamp: "1", tradeId: 1 },
      { clientId: 42, fee: "0.02", feeSymbol: "USDC", orderId: "order-1", price: "148.5", quantity: "0.2", side: "Ask", symbol: "SPCX.US_USDC_PERP", timestamp: "2", tradeId: 2 },
    ],
  });
  assert.equal(result.outcome.state, "FILLED");
  assert.equal(result.outcome.filledQuantity, "0.3");
  assert.equal(result.averagePriceUsd, 149);
  assert.equal(result.feeUsd, 0.03);
});

test("rejects a client-id collision with the wrong symbol or side", () => {
  assert.throws(() => summarizeBackpackExecution({
    clientOrderId: 42,
    symbol: "SPCX.US_USDC_PERP",
    side: "Ask",
    openOrders: [],
    orderHistory: [],
    fills: [{ clientId: 42, fee: "0", feeSymbol: "USDC", orderId: "other", price: "150", quantity: "0.1", side: "Bid", symbol: "SPCX.US_USDC_PERP", timestamp: "1", tradeId: 1 }],
  }), /persisted hedge command/);
});

test("combines factual spot, short, and Backpack fee PnL", () => {
  assert.deepEqual(calculateHedgedRealizedPnl({
    spotSpentUsd: 50,
    spotReceivedUsd: 49,
    hedgeQuantity: "0.3",
    entryHedgePriceUsd: 170,
    exitHedgePriceUsd: 165,
    entryHedgeFeeUsd: 0.02,
    exitHedgeFeeUsd: 0.02,
  }), {
    spotRealizedPnlUsd: -1,
    perpRealizedPnlUsd: 1.46,
    realizedPnlUsd: 0.46,
  });
});
