import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBackpackPreflight } from "../src/server/backpack-preflight.js";

const fixture = {
  symbol: "SPCX.US_USDC_PERP",
  requestedQuantity: 0.12967,
  account: {
    futuresMakerFee: "2", futuresTakerFee: "5", leverageLimit: "5",
    limitOrders: 0, liquidating: false, positionLimit: "100000", triggerOrders: 0,
  },
  balances: { USD: { available: "50", locked: "0" } },
  collateral: {
    netEquity: "50", netEquityAvailable: "45", netEquityLocked: "5",
    netExposureFutures: "0", pnlUnrealized: "0",
  },
  market: {
    symbol: "SPCX.US_USDC_PERP", marketType: "PERP", orderBookState: "Open", visible: true,
    filters: {
      price: { tickSize: "0.01" },
      quantity: { minQuantity: "0.01", maxQuantity: "100", stepSize: "0.001" },
    },
  },
  maxOrderQuantity: "2",
  positions: [],
  openOrders: [],
};

test("passes read-only Backpack preflight and rounds quantity down to step", () => {
  const result = evaluateBackpackPreflight(fixture);
  assert.equal(result.pass, true);
  assert.equal(result.quantity.order, "0.129");
  assert.equal(result.mode, "READ_ONLY_NO_ORDERS");
  assert.equal(result.balances.cashSymbol, "USD");
});

test("fails closed for insufficient capacity and an existing position", () => {
  const result = evaluateBackpackPreflight({
    ...fixture,
    maxOrderQuantity: "0.01",
    positions: [{ symbol: fixture.symbol, netQuantity: "-0.1", netExposureNotional: "15" }],
  });
  assert.equal(result.pass, false);
  assert.deepEqual(result.failures, ["orderCapacity", "noExistingPosition"]);
});
