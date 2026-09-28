import assert from "node:assert/strict";
import test from "node:test";
import {
  groupRecentHistoryByPair,
  latestHistoryCursor,
  mergeHistoryDelta,
  type HistoryDeltaRow,
} from "../src/frontend/src/history-delta.js";

function row(pair: string, second: number, confirmationIndex = 0): HistoryDeltaRow {
  return {
    pair,
    capturedAt: new Date(Date.UTC(2026, 8, 24, 12, 0, second)).toISOString(),
    confirmationIndex,
  };
}

test("uses the latest captured timestamp as the next history cursor", () => {
  assert.equal(latestHistoryCursor([row("AMD", 1), row("MU", 3), row("SPY", 2)]), row("MU", 3).capturedAt);
  assert.equal(latestHistoryCursor([]), null);
});

test("merges overlapping deltas without duplicates", () => {
  const initial = [row("AMD", 1), row("MU", 1)];
  const merged = mergeHistoryDelta(initial, [row("AMD", 1), row("AMD", 2)], 1_000);
  assert.deepEqual(merged, [row("AMD", 1), row("MU", 1), row("AMD", 2)]);
});

test("keeps only the newest configured number of rows per pair", () => {
  const merged = mergeHistoryDelta(
    [row("AMD", 1), row("AMD", 2), row("MU", 1)],
    [row("AMD", 3), row("MU", 2)],
    2,
  );
  assert.deepEqual(merged, [row("MU", 1), row("AMD", 2), row("MU", 2), row("AMD", 3)]);
});

test("groups recent history once per pair in chronological order", () => {
  const grouped = groupRecentHistoryByPair(
    [row("AMD", 3), row("MU", 2), row("AMD", 1)],
    Date.parse(row("AMD", 2).capturedAt),
  );

  assert.deepEqual(grouped.get("AMD"), [row("AMD", 3)]);
  assert.deepEqual(grouped.get("MU"), [row("MU", 2)]);
});
