import assert from "node:assert/strict";
import test from "node:test";
import {
  getMarketContext,
  inferFundingIntervalMinutes,
  type BackpackMarketHoliday,
  type BackpackMarketSession,
} from "../src/server/market-context.js";

const sessions: BackpackMarketSession[] = [
  { name: "US_EQUITIES_PRE_MARKET", description: "", startTime: "04:00:00", endTime: "09:30:00", timezone: "America/New_York", startWeekday: 1, endWeekday: 5 },
  { name: "US_EQUITIES_REGULAR", description: "", startTime: "09:30:00", endTime: "16:00:00", timezone: "America/New_York", startWeekday: 1, endWeekday: 5 },
  { name: "US_EQUITIES_POST_MARKET", description: "", startTime: "16:00:00", endTime: "20:00:00", timezone: "America/New_York", startWeekday: 1, endWeekday: 5 },
  { name: "US_EQUITIES_OVERNIGHT", description: "", startTime: "20:00:00", endTime: "04:00:00", timezone: "America/New_York", startWeekday: 7, endWeekday: 4 },
];

test("classifies regular, overnight, and closed US equity sessions", () => {
  assert.equal(getMarketContext(new Date("2026-09-22T15:00:00Z"), sessions, []).session, "US_EQUITIES_REGULAR");
  assert.equal(getMarketContext(new Date("2026-09-21T01:00:00Z"), sessions, []).session, "US_EQUITIES_OVERNIGHT");
  assert.equal(getMarketContext(new Date("2026-09-19T15:00:00Z"), sessions, []).session, "CLOSED");
});

test("holiday closure overrides a regular session", () => {
  const holidays: BackpackMarketHoliday[] = [{
    market: "US_EQUITIES",
    name: "Labor Day",
    date: "2026-09-07",
    startTime: "00:00:00",
    endTime: "20:00:00",
    timezone: "America/New_York",
  }];
  const context = getMarketContext(new Date("2026-09-07T15:00:00Z"), sessions, holidays);
  assert.equal(context.session, "CLOSED");
  assert.equal(context.holiday, "Labor Day");
});

test("infers the median funding interval from actual settlement timestamps", () => {
  const rates = ["21:00", "20:00", "19:00", "18:00"].map((time) => ({
    symbol: "MU.US_USDC_PERP",
    fundingRate: "0.00000625",
    intervalEndTimestamp: `2026-09-22T${time}:00`,
  }));
  assert.equal(inferFundingIntervalMinutes(rates), 60);
  assert.throws(() => inferFundingIntervalMinutes(rates.slice(0, 1)), /Not enough/);
});
