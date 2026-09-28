import assert from "node:assert/strict";
import test from "node:test";
import {
  assertJupiterRoundTripTransition,
  confirmedRoundTripSourceIds,
  decideJupiterRoundTripExit,
  signalSourceId,
  highestJupiterEntryTier,
  isJupiterRoundTripEntry,
  jupiterCampaignId,
  jupiterEntrySizeUsd,
  nextJupiterEntryBatch,
  nextJupiterEntryTier,
  summarizeJupiterRealizedPnl,
} from "../src/server/jupiter-round-trip.js";

const policy = {
  minEntryEdgePct: 0.25,
  exitEdgePct: 0.1,
  addEdgeStepPct: 0.1,
  notionalUsd: 50,
  addNotionalUsd: 50,
};

test("requires a confirmed factual edge before a Jupiter round trip", () => {
  assert.equal(isJupiterRoundTripEntry({ entryEdgePct: 0.25 }, true, policy), true);
  assert.equal(isJupiterRoundTripEntry({ entryEdgePct: 0.249 }, true, policy), false);
  assert.equal(isJupiterRoundTripEntry({ entryEdgePct: 1 }, false, policy), false);
});

test("uses a stable live signal id for transaction correlation", () => {
  assert.equal(signalSourceId({
    pair: "SPCX",
    capturedAt: new Date("2026-09-23T10:20:30.000Z"),
    confirmationIndex: 0,
  }), "SPCX:2026-09-23T10:20:30.000Z:0");
});

test("derives campaign ids only from factual live samples", () => {
  const first = {
    pair: "SPCX" as const,
    capturedAt: new Date("2026-09-23T10:20:30.000Z"),
    confirmationIndex: 0,
  };
  assert.equal(jupiterCampaignId(first), "signal:SPCX:2026-09-23T10:20:30.000Z:0");
  assert.equal(jupiterCampaignId({
    ...first,
    capturedAt: new Date("2026-09-23T10:21:30.000Z"),
    confirmationIndex: 2,
  }), "signal:SPCX:2026-09-23T10:21:30.000Z:2");
});

test("allows live mirroring only for the current confirmed sample batch", () => {
  const sample = {
    pair: "SPCX" as const,
    capturedAt: new Date("2026-09-23T10:20:30.000Z"),
    confirmationIndex: 0,
  };
  assert.deepEqual([...confirmedRoundTripSourceIds([sample], false)], []);
  assert.deepEqual(
    [...confirmedRoundTripSourceIds([sample], true)],
    ["SPCX:2026-09-23T10:20:30.000Z:0"],
  );
});

test("exits when edge returns to 0.10 percent", () => {
  assert.equal(decideJupiterRoundTripExit(0.1, policy), "TARGET");
  assert.equal(decideJupiterRoundTripExit(0.099, policy), "TARGET");
  assert.equal(decideJupiterRoundTripExit(0.101, policy), null);
  assert.equal(decideJupiterRoundTripExit(Number.NaN, policy), null);
});

test("uses $50 for the base tier and additions at each further 0.1 edge", () => {
  assert.equal(highestJupiterEntryTier(0.249, policy), -1);
  assert.equal(highestJupiterEntryTier(0.25, policy), 0);
  assert.equal(highestJupiterEntryTier(0.349, policy), 0);
  assert.equal(highestJupiterEntryTier(0.35, policy), 1);
  assert.equal(highestJupiterEntryTier(0.55, policy), 3);
  assert.equal(nextJupiterEntryTier(0.55, [], policy), 0);
  assert.equal(nextJupiterEntryTier(0.55, [0], policy), 1);
  assert.equal(nextJupiterEntryTier(0.55, [0, 1, 2], policy), 3);
  assert.equal(nextJupiterEntryTier(0.34, [0], policy), null);
  assert.equal(jupiterEntrySizeUsd(0, policy), 50);
  assert.equal(jupiterEntrySizeUsd(1, policy), 50);
});

test("catches up every reached entry tier in one budget-bounded swap", () => {
  assert.deepEqual(nextJupiterEntryBatch(0.55, [], policy), {
    startTier: 0,
    endTier: 3,
    sizeUsd: 200,
  });
  assert.deepEqual(nextJupiterEntryBatch(0.55, [], {
    ...policy,
    notionalUsd: 200,
    addNotionalUsd: 200,
  }), {
    startTier: 0,
    endTier: 3,
    sizeUsd: 800,
  });
  assert.deepEqual(nextJupiterEntryBatch(0.55, [0], policy), {
    startTier: 1,
    endTier: 3,
    sizeUsd: 150,
  });
  assert.deepEqual(nextJupiterEntryBatch(0.55, [], policy, 150), {
    startTier: 0,
    endTier: 2,
    sizeUsd: 150,
  });
  assert.equal(nextJupiterEntryBatch(0.55, [0, 1, 2, 3], policy), null);
  assert.equal(nextJupiterEntryBatch(0.55, [], policy, 49), null);
});

test("permits only reconciliation-safe Jupiter round-trip transitions", () => {
  assert.doesNotThrow(() => assertJupiterRoundTripTransition("ENTRY_PLANNED", "ENTRY_SUBMITTED"));
  assert.doesNotThrow(() => assertJupiterRoundTripTransition("ENTRY_SUBMITTED", "HEDGE_PENDING"));
  assert.doesNotThrow(() => assertJupiterRoundTripTransition("HEDGE_PENDING", "HEDGE_SUBMITTED"));
  assert.doesNotThrow(() => assertJupiterRoundTripTransition("HEDGE_SUBMITTED", "OPEN"));
  assert.doesNotThrow(() => assertJupiterRoundTripTransition("OPEN", "HEDGE_CLOSE_PENDING"));
  assert.doesNotThrow(() => assertJupiterRoundTripTransition("HEDGE_CLOSE_PENDING", "HEDGE_CLOSE_SUBMITTED"));
  assert.doesNotThrow(() => assertJupiterRoundTripTransition("HEDGE_CLOSE_SUBMITTED", "EXIT_PLANNED"));
  assert.doesNotThrow(() => assertJupiterRoundTripTransition("EXIT_SUBMITTED", "CLOSED"));
  assert.doesNotThrow(() => assertJupiterRoundTripTransition("EXIT_SUBMITTED", "EXIT_PLANNED"));
  assert.throws(
    () => assertJupiterRoundTripTransition("OPEN", "CLOSED"),
    /Invalid Jupiter round-trip transition/,
  );
  assert.throws(
    () => assertJupiterRoundTripTransition("ENTRY_SUBMITTED", "ENTRY_PLANNED"),
    /Invalid Jupiter round-trip transition/,
  );
  assert.throws(
    () => assertJupiterRoundTripTransition("CLOSED", "OPEN"),
    /Invalid Jupiter round-trip transition/,
  );
});

test("reports gross factual losses without offsetting them with profitable trades", () => {
  assert.deepEqual(summarizeJupiterRealizedPnl([
    { realizedPnlUsd: -1.25 },
    { realizedPnlUsd: 0.75 },
    { realizedPnlUsd: -0.5 },
    { realizedPnlUsd: null },
  ]), {
    netUsd: -1,
    grossLossUsd: 1.75,
  });
});
