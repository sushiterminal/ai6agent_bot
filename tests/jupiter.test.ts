import assert from "node:assert/strict";
import test from "node:test";
import { JupiterQuoteScheduler } from "../src/server/jupiter.js";

const validQuote = {
  inAmount: "1000000",
  outAmount: "12345",
  priceImpactPct: "0.001",
  routePlan: [{ swapInfo: { label: "Test route" } }],
};

test("Jupiter scheduler paces concurrent quote requests", async () => {
  let now = 1_000;
  const calls: number[] = [];
  const scheduler = new JupiterQuoteScheduler({
    requestsPerSecond: 10,
    requestTimeoutMs: 1_000,
    jobDeadlineMs: 5_000,
    maxRetries: 0,
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    fetch: (async () => {
      calls.push(now);
      return Response.json(validQuote);
    }) as typeof fetch,
  });

  await Promise.all([
    scheduler.quote("a", "b", "100"),
    scheduler.quote("a", "b", "200"),
  ]);

  assert.deepEqual(calls, [1_000, 1_100]);
  assert.equal(scheduler.getMetrics().requestsTotal, 2);
  assert.equal(scheduler.getMetrics().queueDepth, 0);
});

test("Jupiter scheduler retries 429 using bounded cooldown", async () => {
  let now = 10_000;
  let calls = 0;
  const scheduler = new JupiterQuoteScheduler({
    requestsPerSecond: 100,
    requestTimeoutMs: 1_000,
    jobDeadlineMs: 5_000,
    maxRetries: 2,
    now: () => now,
    random: () => 0,
    sleep: async (milliseconds) => { now += milliseconds; },
    fetch: (async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0.5" },
      });
      return Response.json(validQuote);
    }) as typeof fetch,
  });

  const quote = await scheduler.quote("a", "b", "100");
  assert.equal(quote.outAmount, "12345");
  assert.equal(calls, 2);
  assert.equal(scheduler.getMetrics().rateLimitedTotal, 1);
  assert.equal(scheduler.getMetrics().retriesTotal, 1);
  assert.ok(now >= 10_500);
});

test("Jupiter scheduler does not retry ordinary client errors", async () => {
  let calls = 0;
  const scheduler = new JupiterQuoteScheduler({
    requestsPerSecond: 1,
    requestTimeoutMs: 1_000,
    jobDeadlineMs: 5_000,
    maxRetries: 2,
    fetch: (async () => {
      calls += 1;
      return new Response("bad request", { status: 400 });
    }) as typeof fetch,
  });

  await assert.rejects(scheduler.quote("a", "b", "100"), /returned 400/);
  assert.equal(calls, 1);
  assert.equal(scheduler.getMetrics().retriesTotal, 0);
});

test("Jupiter scheduler rejects malformed successful responses", async () => {
  const scheduler = new JupiterQuoteScheduler({
    requestsPerSecond: 1,
    requestTimeoutMs: 1_000,
    jobDeadlineMs: 5_000,
    maxRetries: 0,
    fetch: (async () => Response.json({ outAmount: "0", routePlan: [] })) as typeof fetch,
  });

  await assert.rejects(scheduler.quote("a", "b", "100"), /invalid quote amounts/);
});

test("Jupiter scheduler applies an explicit execution slippage bound", async () => {
  let requestedUrl = "";
  const scheduler = new JupiterQuoteScheduler({
    requestsPerSecond: 1,
    requestTimeoutMs: 1_000,
    jobDeadlineMs: 5_000,
    maxRetries: 0,
    fetch: (async (url) => {
      requestedUrl = String(url);
      return Response.json(validQuote);
    }) as typeof fetch,
  });
  await scheduler.quote("a", "b", "100", 25);
  assert.equal(new URL(requestedUrl).searchParams.get("slippageBps"), "25");
  await assert.rejects(scheduler.quote("a", "b", "100", 10_001), /Invalid Jupiter quote/);
});

test("Jupiter scheduler excludes configured paused DEX routes", async () => {
  let requestedUrl = "";
  const scheduler = new JupiterQuoteScheduler({
    requestsPerSecond: 1,
    requestTimeoutMs: 1_000,
    jobDeadlineMs: 5_000,
    maxRetries: 0,
    excludedDexes: ["Denali", "Other DEX"],
    fetch: (async (url) => {
      requestedUrl = String(url);
      return Response.json(validQuote);
    }) as typeof fetch,
  });
  await scheduler.quote("a", "b", "100");
  assert.equal(new URL(requestedUrl).searchParams.get("excludeDexes"), "Denali,Other DEX");
});
