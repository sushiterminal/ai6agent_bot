import assert from "node:assert/strict";
import test from "node:test";
import { BackpackClient, feeBasisPointsToPercent } from "../src/server/backpack.js";

test("converts Backpack account fee fixtures from basis points to percent", () => {
  assert.equal(feeBasisPointsToPercent("2"), 0.02);
  assert.equal(feeBasisPointsToPercent("5"), 0.05);
});

test("rejects malformed Backpack fee fixtures", () => {
  assert.throws(() => feeBasisPointsToPercent("unknown"), /invalid fee rate/);
  assert.throws(() => feeBasisPointsToPercent("-1"), /invalid fee rate/);
});

test("does not retry ordinary Backpack public API client errors", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("bad request", { status: 400 });
  }) as typeof fetch;
  try {
    const client = new BackpackClient(null);
    await assert.rejects(() => client.getFundingRates("UNKNOWN", 5), /returned 400/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("submits a bounded IOC limit order once", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let requestBody: any;
  globalThis.fetch = (async (_url, init) => {
    calls += 1;
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      id: "order-1",
      clientId: 42,
      symbol: "SPCX.US_USDC_PERP",
      side: "Ask",
      quantity: "0.12",
      executedQuantity: "0",
      executedQuoteQuantity: "0",
      createdAt: "1",
      status: "New",
    });
  }) as typeof fetch;
  try {
    const secret = Buffer.alloc(32, 7).toString("base64");
    const client = new BackpackClient(null, { key: "fixture", secret });
    const order = await client.executeIocLimitOrder({
      clientId: 42,
      symbol: "SPCX.US_USDC_PERP",
      side: "Ask",
      quantity: "0.12",
      price: "166.50",
    });
    assert.equal(calls, 1);
    assert.equal(order.id, "order-1");
    assert.deepEqual(requestBody, {
      clientId: 42,
      orderType: "Limit",
      price: "166.50",
      quantity: "0.12",
      reduceOnly: false,
      selfTradePrevention: "RejectTaker",
      side: "Ask",
      symbol: "SPCX.US_USDC_PERP",
      timeInForce: "IOC",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not retry a Backpack write timeout", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("timeout");
  }) as typeof fetch;
  try {
    const client = new BackpackClient(null, {
      key: "fixture",
      secret: Buffer.alloc(32, 7).toString("base64"),
    });
    await assert.rejects(() => client.executeIocLimitOrder({
      clientId: 42,
      symbol: "SPCX.US_USDC_PERP",
      side: "Ask",
      quantity: "0.12",
      price: "166.50",
    }), /timeout/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
