import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRecoveryApproval,
  buildRecoveryPreview,
  expectedRecoveryApprovalText,
  fingerprintRecoveryPreview,
} from "../src/server/recovery-preview.js";

const now = new Date("2026-09-23T10:00:00Z");

function preview(status: "SPOT_ONLY" | "PARTIALLY_HEDGED" | "PERP_ONLY" | "UNCERTAIN", spot: string, perp: string) {
  return buildRecoveryPreview({
    tradeId: "trade-1",
    pair: "SPCX",
    sourceStatus: status,
    spotQuantity: spot,
    perpNetQuantity: perp,
    now,
    ttlMs: 30_000,
    market: {
      bestBid: "165",
      bestAsk: "165.1",
      tickSize: "0.01",
      quantityStep: "0.001",
      minimumQuantity: "0.001",
      maximumQuantity: "10",
      slippagePct: 0.05,
    },
  });
}

test("plans the exact residual hedge from factual exposure", () => {
  const value = preview("PARTIALLY_HEDGED", "0.119", "-0.03");
  assert.equal(value.action, "COMPLETE_HEDGE");
  assert.equal(value.quantity, "0.089");
  assert.equal(value.order?.side, "Ask");
  assert.equal(value.exposure.unhedgedSpotQuantity, "0.089");
  assert.equal(value.executable, true);
});

test("plans closing an orphan short and finalizing balanced exposure", () => {
  const perpOnly = preview("PERP_ONLY", "0", "-0.12");
  assert.equal(perpOnly.action, "CLOSE_HEDGE");
  assert.equal(perpOnly.quantity, "0.12");
  assert.equal(perpOnly.order?.side, "Bid");
  const balanced = preview("PARTIALLY_HEDGED", "0.12", "-0.12");
  assert.equal(balanced.action, "FINALIZE_OPEN");
  assert.equal(balanced.quantity, "0");
});

test("never makes uncertain or inconsistent exposure executable", () => {
  const uncertain = preview("UNCERTAIN", "0.12", "0");
  assert.equal(uncertain.action, "RECONCILE_ONLY");
  assert.equal(uncertain.executable, false);
  assert.deepEqual(uncertain.blockers, ["unknownExternalOutcome"]);
  const fingerprint = fingerprintRecoveryPreview(uncertain);
  assert.throws(() => assertRecoveryApproval({
    preview: uncertain,
    fingerprint,
    approval: expectedRecoveryApprovalText(uncertain.tradeId, fingerprint),
    now: new Date("2026-09-23T10:00:20Z"),
  }), /not executable/);
  const overHedged = preview("PARTIALLY_HEDGED", "0.1", "-0.12");
  assert.equal(overHedged.action, "MANUAL_INTERVENTION");
  assert.equal(overHedged.executable, false);
});

test("approval binds the exact unexpired recovery preview", () => {
  const value = preview("SPOT_ONLY", "0.119", "0");
  const fingerprint = fingerprintRecoveryPreview(value);
  assert.doesNotThrow(() => assertRecoveryApproval({
    preview: value,
    fingerprint,
    approval: expectedRecoveryApprovalText(value.tradeId, fingerprint),
    now: new Date("2026-09-23T10:00:20Z"),
  }));
  value.quantity = "0.2";
  assert.throws(() => assertRecoveryApproval({
    preview: value,
    fingerprint,
    approval: expectedRecoveryApprovalText(value.tradeId, fingerprint),
    now: new Date("2026-09-23T10:00:20Z"),
  }), /fingerprint mismatch/);
  const fresh = preview("SPOT_ONLY", "0.119", "0");
  const freshFingerprint = fingerprintRecoveryPreview(fresh);
  assert.throws(() => assertRecoveryApproval({
    preview: fresh,
    fingerprint: freshFingerprint,
    approval: expectedRecoveryApprovalText(fresh.tradeId, freshFingerprint),
    now: fresh.expiresAt,
  }), /expired/);
});
