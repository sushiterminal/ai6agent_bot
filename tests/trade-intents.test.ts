import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTradeIntentTransition,
  buildTradeIntentTransition,
  createTradeIntent,
} from "../src/server/trade-intents.js";

test("creates a fixed forty dollar planned intent", () => {
  const now = new Date("2026-09-23T10:00:00Z");
  const intent = createTradeIntent({
    tradeId: "trade-1",
    idempotencyKey: "operator:SPCX:001",
    pair: "SPCX",
    basisRisk: "same_issuer",
    now,
  });
  assert.equal(intent.sizeUsd, 40);
  assert.equal(intent.status, "PLANNED");
  assert.equal(intent.version, 1);
  assert.deepEqual(intent.events.map((event) => event.to), ["PLANNED"]);
  assert.equal(intent.expiresAt.toISOString(), "2026-09-23T10:05:00.000Z");
});

test("requires durable operation identifiers before submitted states", () => {
  assert.throws(() => buildTradeIntentTransition({
    from: "APPROVED",
    to: "SPOT_SUBMITTED",
  }), /signature and signed transaction/);
  assert.throws(() => buildTradeIntentTransition({
    from: "SPOT_CONFIRMED",
    to: "HEDGE_SUBMITTED",
  }), /client order id/);
  assert.throws(() => buildTradeIntentTransition({
    from: "SPOT_SUBMITTED",
    to: "UNCERTAIN",
  }), /explicit error/);
});

test("builds a reconciliation transition with an immutable event", () => {
  const now = new Date("2026-09-23T10:01:00Z");
  const transition = buildTradeIntentTransition({
    from: "SPOT_SUBMITTED",
    to: "SPOT_CONFIRMED",
    now,
    reason: "signature finalized",
    patch: { spotFilledQuantity: "0.12", reconciled: true },
  });
  assert.equal(transition.set.spotFilledQuantity, "0.12");
  assert.equal(transition.set.lastReconciledAt, now);
  assert.equal(transition.incrementReconciliationAttempts, true);
  assert.deepEqual(transition.event, {
    from: "SPOT_SUBMITTED",
    to: "SPOT_CONFIRMED",
    at: now,
    reason: "signature finalized",
  });
});

test("rejects unsafe idempotency keys and invalid transitions", () => {
  assert.throws(() => createTradeIntent({
    tradeId: "trade-1",
    idempotencyKey: "short",
    pair: "SPCX",
    basisRisk: "same_issuer",
  }), /idempotencyKey/);
  assert.throws(() => assertTradeIntentTransition("PLANNED", "SPOT_SUBMITTED"), /Invalid/);
  assert.doesNotThrow(() => assertTradeIntentTransition("PLANNED", "APPROVED"));
});
