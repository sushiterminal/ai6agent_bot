import assert from "node:assert/strict";
import test from "node:test";
import { createTradeIntent } from "../src/server/trade-intents.js";
import { CANARY_SIZE, TRACKED_SIZE } from "../src/server/types.js";

test("uses $3000 market quotes without increasing the $40 canary", () => {
  assert.equal(TRACKED_SIZE, 3_000);
  assert.equal(CANARY_SIZE, 40);
  assert.equal(createTradeIntent({
    tradeId: "trade-quote-size",
    idempotencyKey: "quote-size-check",
    pair: "AMD",
    basisRisk: "same_issuer",
  }).sizeUsd, 40);
});
