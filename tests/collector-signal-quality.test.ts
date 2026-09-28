import assert from "node:assert/strict";
import test from "node:test";
import {
  isFreshPositiveSample,
  restoredNextCheckAt,
} from "../src/server/collector.js";

test("accepts only positive signals backed by a fresh Backpack book", () => {
  assert.equal(isFreshPositiveSample({ entryEdgePct: 0.1, backpackDataAgeMs: 2_999 }, 3_000), true);
  assert.equal(isFreshPositiveSample({ entryEdgePct: 0.1, backpackDataAgeMs: 3_001 }, 3_000), false);
  assert.equal(isFreshPositiveSample({ entryEdgePct: 0, backpackDataAgeMs: 100 }, 3_000), false);
  assert.equal(isFreshPositiveSample({ entryEdgePct: 0.1, backpackDataAgeMs: -1 }, 3_000), false);
});

test("restores the next pair check from Mongo time without replaying elapsed delay", () => {
  const capturedAt = new Date("2026-09-23T06:00:00Z");
  assert.equal(
    restoredNextCheckAt(capturedAt, 60_000, Date.parse("2026-09-23T06:00:30Z")),
    Date.parse("2026-09-23T06:01:00Z"),
  );
  assert.equal(
    restoredNextCheckAt(capturedAt, 60_000, Date.parse("2026-09-23T06:02:00Z")),
    Date.parse("2026-09-23T06:02:00Z"),
  );
});
