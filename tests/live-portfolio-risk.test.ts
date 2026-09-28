import assert from "node:assert/strict";
import test from "node:test";
import {
  hasLiveBudgetCapacity,
  hasLivePositionCapacity,
  reachedRealizedStop,
  utcDayRange,
} from "../src/server/live-portfolio-risk.js";

test("live portfolio capacity is bounded by factual committed capital and positions", () => {
  assert.equal(hasLiveBudgetCapacity(400, 100, 500), true);
  assert.equal(hasLiveBudgetCapacity(400, 100.01, 500), false);
  assert.equal(hasLivePositionCapacity(9, 10), true);
  assert.equal(hasLivePositionCapacity(10, 10), false);
});

test("realized stop and UTC day boundaries are deterministic", () => {
  assert.equal(reachedRealizedStop(-30, 30), true);
  assert.equal(reachedRealizedStop(-29.99, 30), false);
  assert.deepEqual(utcDayRange(new Date("2026-09-26T23:59:59.000Z")), {
    start: new Date("2026-09-26T00:00:00.000Z"),
    end: new Date("2026-09-27T00:00:00.000Z"),
  });
});
