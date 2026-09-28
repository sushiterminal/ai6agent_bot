import assert from "node:assert/strict";
import test from "node:test";
import {
  BackpackMarketData,
  type BackpackDepthSnapshot,
  type BackpackWebSocket,
} from "../src/server/backpack-market-data.js";

class FakeSocket implements BackpackWebSocket {
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = {
    open: [] as Array<() => void>,
    message: [] as Array<(event: { data: unknown }) => void>,
    error: [] as Array<() => void>,
    close: [] as Array<() => void>,
  };

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (() => void) | ((event: { data: unknown }) => void),
  ): void {
    if (type === "message") {
      this.listeners.message.push(listener as (event: { data: unknown }) => void);
    } else {
      this.listeners[type].push(listener as () => void);
    }
  }

  emitOpen(): void {
    for (const listener of this.listeners.open) listener();
  }

  emitMessage(data: unknown): void {
    for (const listener of this.listeners.message) listener({ data: JSON.stringify(data) });
  }

  emitClose(): void {
    for (const listener of this.listeners.close) listener();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function depthMessage(first: number, last: number, asks: string[][], bids: string[][]) {
  return {
    stream: "depth.200ms.MU.US_USDC_PERP",
    data: {
      e: "depth",
      E: 1_000_000,
      T: 999_000,
      s: "MU.US_USDC_PERP",
      U: first,
      u: last,
      a: asks,
      b: bids,
    },
  };
}

function markMessage() {
  return {
    stream: "markPrice.MU.US_USDC_PERP",
    data: {
      e: "markPrice",
      E: 1_000_000,
      T: 998_000,
      s: "MU.US_USDC_PERP",
      p: "101.5",
      i: "101.4",
      f: "0.0001",
      n: 1_700_000_000_000,
    },
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("buffers depth during snapshot bootstrap and applies absolute levels", async () => {
  const socket = new FakeSocket();
  const snapshot = deferred<BackpackDepthSnapshot>();
  let now = 1_000;
  const client = new BackpackMarketData({
    symbols: ["MU.US_USDC_PERP"],
    fetchDepthSnapshot: () => snapshot.promise,
    webSocketFactory: () => socket,
    now: () => now,
  });

  client.start();
  socket.emitOpen();
  assert.deepEqual(JSON.parse(socket.sent[0]!), {
    method: "SUBSCRIBE",
    params: ["depth.200ms.MU.US_USDC_PERP", "markPrice.MU.US_USDC_PERP"],
  });
  socket.emitMessage(depthMessage(11, 12, [["102", "3"]], [["100", "0"]]));
  socket.emitMessage(markMessage());
  snapshot.resolve({
    asks: [["103", "1"]],
    bids: [["100", "2"], ["99", "4"]],
    lastUpdateId: "10",
    timestamp: 900_000,
  });
  await flush();

  const market = client.getMarket("MU.US_USDC_PERP", 100);
  assert.deepEqual(market.asks, [["102", "3"], ["103", "1"]]);
  assert.deepEqual(market.bids, [["99", "4"]]);
  assert.equal(market.markPrice, "101.5");
  assert.equal(market.nextFundingTimestamp, 1_700_000_000_000);
  market.asks.push(["1", "1"]);
  assert.equal(client.getMarket("MU.US_USDC_PERP", 100).asks.length, 2);
  assert.equal(client.metrics.messages, 2);
  assert.equal(client.metrics.latencyMs, 0);

  now = 1_101;
  assert.throws(() => client.getMarket("MU.US_USDC_PERP", 100), /is stale/);
  assert.deepEqual(client.getMetrics(100).staleSymbols, ["MU.US_USDC_PERP"]);
  client.stop();
});

test("detects a sequence gap and race-safely resynchronizes", async () => {
  const socket = new FakeSocket();
  const resnapshot = deferred<BackpackDepthSnapshot>();
  let calls = 0;
  const client = new BackpackMarketData({
    symbols: ["MU.US_USDC_PERP"],
    fetchDepthSnapshot: async () => {
      calls += 1;
      if (calls === 1) {
        return { asks: [], bids: [["100", "1"]], lastUpdateId: "10", timestamp: 1 };
      }
      return resnapshot.promise;
    },
    webSocketFactory: () => socket,
    now: () => 1_000,
  });

  client.start();
  socket.emitOpen();
  socket.emitMessage(markMessage());
  await flush();
  socket.emitMessage(depthMessage(12, 12, [], [["101", "2"]]));
  assert.equal(client.metrics.gaps, 1);
  assert.equal(client.metrics.resyncs, 1);
  assert.throws(() => client.getMarket("MU.US_USDC_PERP", 100), /not ready/);

  socket.emitMessage(depthMessage(21, 21, [], [["102", "5"]]));
  resnapshot.resolve({ asks: [], bids: [["101", "3"]], lastUpdateId: "20", timestamp: 2 });
  await flush();
  assert.deepEqual(client.getMarket("MU.US_USDC_PERP", 100).bids, [
    ["102", "5"],
    ["101", "3"],
  ]);
  client.stop();
});

test("reconnects with bounded delay and stop prevents further reconnects", async () => {
  const sockets: FakeSocket[] = [];
  const client = new BackpackMarketData({
    symbols: ["MU.US_USDC_PERP"],
    fetchDepthSnapshot: async () => ({
      asks: [], bids: [], lastUpdateId: "1", timestamp: 1,
    }),
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    reconnectBaseMs: 1,
    reconnectMaxMs: 1,
    reconnectJitterRatio: 1,
    random: () => 1,
  });

  client.start();
  sockets[0]!.emitOpen();
  sockets[0]!.emitClose();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sockets.length, 2);
  assert.equal(client.metrics.reconnects, 1);
  sockets[1]!.emitOpen();
  assert.equal(client.metrics.connected, true);

  client.stop();
  sockets[1]!.emitClose();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sockets.length, 2);
  assert.equal(client.metrics.connected, false);
});

test("invalidates a crossed update and recovers from a fresh snapshot", async () => {
  const socket = new FakeSocket();
  const resnapshot = deferred<BackpackDepthSnapshot>();
  let calls = 0;
  const client = new BackpackMarketData({
    symbols: ["MU.US_USDC_PERP"],
    fetchDepthSnapshot: async () => {
      calls += 1;
      if (calls === 1) return {
        asks: [["102", "1"]],
        bids: [["100", "1"]],
        lastUpdateId: "10",
        timestamp: 900_000,
      };
      return resnapshot.promise;
    },
    webSocketFactory: () => socket,
    now: () => 1_000,
  });
  client.start();
  socket.emitOpen();
  socket.emitMessage(markMessage());
  await flush();
  socket.emitMessage(depthMessage(11, 11, [], [["103", "1"]]));
  assert.equal(client.metrics.gaps, 1);
  assert.equal(client.metrics.resyncs, 1);
  assert.throws(() => client.getMarket("MU.US_USDC_PERP", 100), /not ready/);
  assert.deepEqual(client.getMetrics(100).staleSymbols, ["MU.US_USDC_PERP"]);

  resnapshot.resolve({
    asks: [["102", "1"]],
    bids: [["101", "1"]],
    lastUpdateId: "11",
    timestamp: 901_000,
  });
  await flush();
  const market = client.getMarket("MU.US_USDC_PERP", 100);
  assert.deepEqual(market.asks[0], ["102", "1"]);
  assert.deepEqual(market.bids[0], ["101", "1"]);
  client.stop();
});

test("rejects a crossed REST snapshot before exposing the book", async () => {
  const socket = new FakeSocket();
  const client = new BackpackMarketData({
    symbols: ["MU.US_USDC_PERP"],
    fetchDepthSnapshot: async () => ({
      asks: [["100", "1"]],
      bids: [["101", "1"]],
      lastUpdateId: "10",
      timestamp: 900_000,
    }),
    webSocketFactory: () => socket,
    reconnectBaseMs: 10_000,
    now: () => 1_000,
  });
  client.start();
  socket.emitOpen();
  socket.emitMessage(markMessage());
  await flush();
  assert.throws(() => client.getMarket("MU.US_USDC_PERP", 100), /not ready/);
  client.stop();
});
