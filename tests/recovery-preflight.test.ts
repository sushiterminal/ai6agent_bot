import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRecoveryPreflight } from "../src/server/recovery-preflight.js";

function input(action: "COMPLETE_HEDGE" | "CLOSE_HEDGE") {
  return {
    action,
    symbol: "SPCX_USDC_PERP",
    quantity: "0.09",
    account: { futuresMakerFee: "0", futuresTakerFee: "0", leverageLimit: "5", limitOrders: 0, liquidating: false, positionLimit: "10", triggerOrders: 0 },
    collateral: { netEquity: "100", netEquityAvailable: "100", netEquityLocked: "0", netExposureFutures: "5", pnlUnrealized: "0" },
    market: { symbol: "SPCX_USDC_PERP", marketType: "PERP", orderBookState: "Open", visible: true, filters: { price: { tickSize: "0.01" }, quantity: { minQuantity: "0.001", maxQuantity: "10", stepSize: "0.001" } } },
    maxOrderQuantity: "1",
    positions: action === "CLOSE_HEDGE" ? [{ symbol: "SPCX_USDC_PERP", netQuantity: "-0.12", netExposureNotional: "20" }] : [{ symbol: "SPCX_USDC_PERP", netQuantity: "-0.03", netExposureNotional: "5" }],
    openOrders: [],
  };
}

test("allows adding to an existing short for residual hedge recovery", () => {
  const result = evaluateRecoveryPreflight(input("COMPLETE_HEDGE"));
  assert.equal(result.pass, true);
  assert.equal(result.netQuantity, "-0.03");
});

test("allows only bounded reduce-only quantity when closing an orphan short", () => {
  const valid = evaluateRecoveryPreflight(input("CLOSE_HEDGE"));
  assert.equal(valid.pass, true);
  const excessive = input("CLOSE_HEDGE");
  excessive.quantity = "0.2";
  assert.deepEqual(evaluateRecoveryPreflight(excessive).failures, ["exposureDirection"]);
});

test("fails closed on open orders, off-step quantity, and wrong exposure direction", () => {
  const value = input("COMPLETE_HEDGE");
  value.quantity = "0.0905";
  value.positions = [{ symbol: value.symbol, netQuantity: "0.01", netExposureNotional: "1" }];
  value.openOrders = [{ id: "order", symbol: value.symbol, side: "Ask" }];
  const result = evaluateRecoveryPreflight(value);
  assert.equal(result.pass, false);
  assert.deepEqual(result.failures, ["quantityOnStep", "noOpenOrders", "exposureDirection"]);
});
