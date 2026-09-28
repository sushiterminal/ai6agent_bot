import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCanaryApproval,
  expectedApprovalText,
  fingerprintCanaryPreview,
  publicCanaryPreview,
  type CanaryApprovalPreview,
} from "../src/server/canary-approval.js";

function preview(): CanaryApprovalPreview {
  return {
    tradeId: "trade-1",
    pair: "SPCX",
    basisRisk: "same_issuer",
    sizeUsd: 40,
    createdAt: new Date("2026-09-23T10:00:00Z"),
    expiresAt: new Date("2026-09-23T10:00:30Z"),
    spot: {
      inputMint: "USDC",
      outputMint: "SPCX",
      inAmount: "40000000",
      outAmount: "240000",
      minimumOutAmount: "238800",
      priceImpactPct: "0.001",
      route: ["Fixture"],
      quoteResponse: { z: 1, a: { y: 2, x: 1 } },
      simulationPassed: true,
      priorityFeeLamports: 1000,
    },
    hedge: {
      symbol: "SPCX.US_USDC_PERP",
      quantity: "0.12",
      bestBid: "165",
      worstPrice: "164.96",
      tickSize: "0.01",
      timeInForce: "IOC",
      preflightPassed: true,
    },
    economics: {
      entryEdgePct: 0.5,
      immediateLiquidationPnlUsd: -0.4,
      worstCaseLossUsd: 0.4,
    },
    risk: { pass: true, failures: [], gates: { fixedNotional: true } },
  };
}

test("fingerprints a preview canonically and hides raw Jupiter response", () => {
  const first = preview();
  const reordered = preview();
  reordered.spot.quoteResponse = { a: { x: 1, y: 2 }, z: 1 };
  assert.equal(fingerprintCanaryPreview(first), fingerprintCanaryPreview(reordered));
  assert.equal("quoteResponse" in publicCanaryPreview(first).spot, false);
});

test("approves only the exact unexpired passing preview", () => {
  const value = preview();
  const fingerprint = fingerprintCanaryPreview(value);
  assert.doesNotThrow(() => assertCanaryApproval({
    preview: value,
    fingerprint,
    approval: expectedApprovalText(value.tradeId, fingerprint),
    now: new Date("2026-09-23T10:00:20Z"),
  }));
  assert.throws(() => assertCanaryApproval({
    preview: value,
    fingerprint,
    approval: expectedApprovalText(value.tradeId, fingerprint),
    now: new Date("2026-09-23T10:00:30Z"),
  }), /expired/);
});

test("rejects tampering and failed gates", () => {
  const value = preview();
  const fingerprint = fingerprintCanaryPreview(value);
  value.hedge.worstPrice = "100";
  assert.throws(() => assertCanaryApproval({
    preview: value,
    fingerprint,
    approval: expectedApprovalText(value.tradeId, fingerprint),
  }), /fingerprint mismatch/);
  const blocked = preview();
  blocked.risk.pass = false;
  const blockedFingerprint = fingerprintCanaryPreview(blocked);
  assert.throws(() => assertCanaryApproval({
    preview: blocked,
    fingerprint: blockedFingerprint,
    approval: expectedApprovalText(blocked.tradeId, blockedFingerprint),
    now: new Date("2026-09-23T10:00:20Z"),
  }), /risk policy/);
});
