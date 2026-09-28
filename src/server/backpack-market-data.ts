const DEFAULT_WS_URL = "wss://ws.backpack.exchange";

export type PriceLevel = [price: string, quantity: string];

export interface BackpackDepthSnapshot {
  asks: PriceLevel[];
  bids: PriceLevel[];
  lastUpdateId: string | number | bigint;
  timestamp: number;
}

export interface BackpackWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
}

export interface BackpackMarketDataOptions {
  symbols: readonly string[];
  fetchDepthSnapshot: (symbol: string) => Promise<BackpackDepthSnapshot>;
  webSocketFactory?: (url: string) => BackpackWebSocket;
  websocketUrl?: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  reconnectJitterRatio?: number;
  defaultMaxAgeMs?: number;
  maxBufferedEvents?: number;
  now?: () => number;
  random?: () => number;
}

export interface BackpackMarket {
  symbol: string;
  asks: PriceLevel[];
  bids: PriceLevel[];
  markPrice: string;
  indexPrice: string;
  fundingRate: string;
  nextFundingTimestamp: number;
  depthTimestamp: number;
  markTimestamp: number;
  depthReceivedAt: number;
  markReceivedAt: number;
  lastUpdateId: string;
}

export interface BackpackMarketDataMetrics {
  connected: boolean;
  reconnects: number;
  messages: number;
  gaps: number;
  resyncs: number;
  lastMessageAt: number | null;
  latencyMs: number | null;
  staleSymbols: string[];
}

interface DepthUpdate {
  asks: PriceLevel[];
  bids: PriceLevel[];
  firstUpdateId: bigint;
  lastUpdateId: bigint;
  timestamp: number;
  receivedAt: number;
}

interface MarkState {
  markPrice: string;
  indexPrice: string;
  fundingRate: string;
  nextFundingTimestamp: number;
  timestamp: number;
  receivedAt: number;
}

interface SymbolState {
  symbol: string;
  asks: Map<string, string>;
  bids: Map<string, string>;
  buffered: DepthUpdate[];
  lastUpdateId: bigint | null;
  depthTimestamp: number | null;
  depthReceivedAt: number | null;
  bookReady: boolean;
  syncing: boolean;
  syncGeneration: number;
  snapshotRetry?: NodeJS.Timeout;
  mark?: MarkState;
}

interface MutableMetrics {
  connected: boolean;
  reconnects: number;
  messages: number;
  gaps: number;
  resyncs: number;
  lastMessageAt: number | null;
  latencyMs: number | null;
}

function nativeWebSocketFactory(url: string): BackpackWebSocket {
  return new globalThis.WebSocket(url) as unknown as BackpackWebSocket;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function bookIsCrossed(state: SymbolState): boolean {
  const bestAsk = Math.min(...[...state.asks.keys()].map(Number).filter(Number.isFinite));
  const bestBid = Math.max(...[...state.bids.keys()].map(Number).filter(Number.isFinite));
  return Number.isFinite(bestAsk) && Number.isFinite(bestBid) && bestBid >= bestAsk;
}

function parseLevels(value: unknown): PriceLevel[] | null {
  if (!Array.isArray(value)) return null;
  const levels: PriceLevel[] = [];
  for (const level of value) {
    if (
      !Array.isArray(level)
      || level.length < 2
      || typeof level[0] !== "string"
      || typeof level[1] !== "string"
    ) {
      return null;
    }
    levels.push([level[0], level[1]]);
  }
  return levels;
}

function parseInteger(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    return null;
  }
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function applyLevels(book: Map<string, string>, levels: PriceLevel[]): void {
  for (const [price, quantity] of levels) {
    if (Number(quantity) === 0) book.delete(price);
    else book.set(price, quantity);
  }
}

function sortedLevels(book: Map<string, string>, descending: boolean): PriceLevel[] {
  return [...book.entries()]
    .map(([price, quantity]): PriceLevel => [price, quantity])
    .sort((left, right) => descending
      ? Number(right[0]) - Number(left[0])
      : Number(left[0]) - Number(right[0]));
}

export class BackpackMarketData {
  private readonly states = new Map<string, SymbolState>();
  private readonly fetchDepthSnapshot: BackpackMarketDataOptions["fetchDepthSnapshot"];
  private readonly webSocketFactory: (url: string) => BackpackWebSocket;
  private readonly websocketUrl: string;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly reconnectJitterRatio: number;
  private readonly defaultMaxAgeMs: number;
  private readonly maxBufferedEvents: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private socket?: BackpackWebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private started = false;
  private stopped = false;
  private readonly counters: MutableMetrics = {
    connected: false,
    reconnects: 0,
    messages: 0,
    gaps: 0,
    resyncs: 0,
    lastMessageAt: null,
    latencyMs: null,
  };

  constructor(options: BackpackMarketDataOptions) {
    if (options.symbols.length === 0) throw new Error("At least one Backpack symbol is required");
    for (const symbol of new Set(options.symbols)) {
      if (!symbol) throw new Error("Backpack symbols must not be empty");
      this.states.set(symbol, {
        symbol,
        asks: new Map(),
        bids: new Map(),
        buffered: [],
        lastUpdateId: null,
        depthTimestamp: null,
        depthReceivedAt: null,
        bookReady: false,
        syncing: false,
        syncGeneration: 0,
      });
    }
    this.fetchDepthSnapshot = options.fetchDepthSnapshot;
    this.webSocketFactory = options.webSocketFactory ?? nativeWebSocketFactory;
    this.websocketUrl = options.websocketUrl ?? DEFAULT_WS_URL;
    this.reconnectBaseMs = Math.max(1, options.reconnectBaseMs ?? 500);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, options.reconnectMaxMs ?? 30_000);
    this.reconnectJitterRatio = Math.min(1, Math.max(0, options.reconnectJitterRatio ?? 0.2));
    this.defaultMaxAgeMs = Math.max(0, options.defaultMaxAgeMs ?? 5_000);
    this.maxBufferedEvents = Math.max(1, options.maxBufferedEvents ?? 10_000);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (this.started && !this.stopped) return;
    if (this.stopped) throw new Error("Backpack market data client has been stopped");
    this.started = true;
    this.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.counters.connected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    for (const state of this.states.values()) {
      state.syncGeneration += 1;
      if (state.snapshotRetry) clearTimeout(state.snapshotRetry);
      state.snapshotRetry = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "client stopped");
  }

  get metrics(): BackpackMarketDataMetrics {
    return this.getMetrics();
  }

  getMetrics(maxAgeMs = this.defaultMaxAgeMs): BackpackMarketDataMetrics {
    const now = this.now();
    const staleSymbols = [...this.states.values()]
      .filter((state) => {
        if (!state.bookReady || !state.mark || state.depthReceivedAt === null) return true;
        return now - state.mark.receivedAt > maxAgeMs || bookIsCrossed(state);
      })
      .map((state) => state.symbol);
    return { ...this.counters, staleSymbols };
  }

  getMarket(symbol: string, maxAgeMs: number): BackpackMarket {
    const state = this.states.get(symbol);
    if (!state) throw new Error(`Unknown Backpack market symbol: ${symbol}`);
    if (
      !this.counters.connected
      || !state.bookReady
      || state.lastUpdateId === null
      || state.depthTimestamp === null
      || state.depthReceivedAt === null
      || !state.mark
    ) {
      throw new Error(`Backpack market data for ${symbol} is not ready`);
    }
    const age = this.now() - state.mark.receivedAt;
    if (age > maxAgeMs) {
      throw new Error(`Backpack market data for ${symbol} is stale (${age}ms > ${maxAgeMs}ms)`);
    }
    if (bookIsCrossed(state)) {
      throw new Error(`Backpack order book for ${symbol} is crossed`);
    }
    const asks = sortedLevels(state.asks, false);
    const bids = sortedLevels(state.bids, true);
    return {
      symbol,
      asks,
      bids,
      markPrice: state.mark.markPrice,
      indexPrice: state.mark.indexPrice,
      fundingRate: state.mark.fundingRate,
      nextFundingTimestamp: state.mark.nextFundingTimestamp,
      depthTimestamp: state.depthTimestamp,
      markTimestamp: state.mark.timestamp,
      depthReceivedAt: state.depthReceivedAt,
      markReceivedAt: state.mark.receivedAt,
      lastUpdateId: state.lastUpdateId.toString(),
    };
  }

  private connect(): void {
    if (this.stopped) return;
    let socket: BackpackWebSocket;
    try {
      socket = this.webSocketFactory(this.websocketUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => this.handleOpen(socket));
    socket.addEventListener("message", (event) => this.handleMessage(socket, event.data));
    socket.addEventListener("error", () => this.handleDisconnect(socket));
    socket.addEventListener("close", () => this.handleDisconnect(socket));
  }

  private handleOpen(socket: BackpackWebSocket): void {
    if (this.socket !== socket || this.stopped) return;
    this.counters.connected = true;
    this.reconnectAttempt = 0;
    const params = [...this.states.keys()].flatMap((symbol) => [
      `depth.200ms.${symbol}`,
      `markPrice.${symbol}`,
    ]);
    socket.send(JSON.stringify({ method: "SUBSCRIBE", params }));
    for (const state of this.states.values()) this.beginSnapshotSync(state, false);
  }

  private handleDisconnect(socket: BackpackWebSocket): void {
    if (this.socket !== socket || this.stopped) return;
    this.socket = undefined;
    this.counters.connected = false;
    for (const state of this.states.values()) {
      state.syncGeneration += 1;
      state.bookReady = false;
      state.syncing = false;
      state.buffered = [];
      if (state.snapshotRetry) clearTimeout(state.snapshotRetry);
      state.snapshotRetry = undefined;
    }
    try {
      socket.close();
    } catch {
      // The connection is already unusable.
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const exponential = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** Math.min(this.reconnectAttempt, 30),
    );
    this.reconnectAttempt += 1;
    const jitter = (this.random() * 2 - 1) * this.reconnectJitterRatio;
    const delay = Math.max(0, Math.min(this.reconnectMaxMs, exponential * (1 + jitter)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) return;
      this.counters.reconnects += 1;
      this.connect();
    }, delay);
  }

  private handleMessage(socket: BackpackWebSocket, raw: unknown): void {
    if (this.socket !== socket || this.stopped) return;
    const receivedAt = this.now();
    this.counters.messages += 1;
    this.counters.lastMessageAt = receivedAt;
    let envelope: unknown;
    try {
      const text = typeof raw === "string"
        ? raw
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString("utf8")
          : ArrayBuffer.isView(raw)
            ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8")
            : null;
      if (text === null) return;
      envelope = JSON.parse(text) as unknown;
    } catch {
      return;
    }
    if (!isRecord(envelope) || !isRecord(envelope.data)) return;
    const payload = envelope.data;
    const eventTimestamp = typeof payload.E === "number" ? payload.E : null;
    if (eventTimestamp !== null) {
      this.counters.latencyMs = Math.max(0, receivedAt - eventTimestamp / 1_000);
    }
    if (payload.e === "depth") this.handleDepth(payload, receivedAt);
    else if (payload.e === "markPrice") this.handleMark(payload, receivedAt);
  }

  private handleDepth(payload: Record<string, unknown>, receivedAt: number): void {
    const state = typeof payload.s === "string" ? this.states.get(payload.s) : undefined;
    const asks = parseLevels(payload.a);
    const bids = parseLevels(payload.b);
    const firstUpdateId = parseInteger(payload.U);
    const lastUpdateId = parseInteger(payload.u);
    if (
      !state
      || !asks
      || !bids
      || firstUpdateId === null
      || lastUpdateId === null
      || lastUpdateId < firstUpdateId
      || typeof payload.T !== "number"
    ) return;
    const update: DepthUpdate = {
      asks,
      bids,
      firstUpdateId,
      lastUpdateId,
      timestamp: payload.T,
      receivedAt,
    };
    if (state.syncing) {
      state.buffered.push(update);
      if (state.buffered.length > this.maxBufferedEvents) {
        this.counters.gaps += 1;
        this.beginSnapshotSync(state, true);
      }
      return;
    }
    if (!state.bookReady || state.lastUpdateId === null) {
      this.beginSnapshotSync(state, true);
      state.buffered.push(update);
      return;
    }
    if (!this.applyUpdate(state, update)) {
      this.counters.gaps += 1;
      this.beginSnapshotSync(state, true);
      state.buffered.push(update);
    }
  }

  private applyUpdate(state: SymbolState, update: DepthUpdate): boolean {
    if (state.lastUpdateId === null) return false;
    if (update.lastUpdateId <= state.lastUpdateId) return true;
    const nextUpdateId = state.lastUpdateId + 1n;
    if (update.firstUpdateId > nextUpdateId || update.lastUpdateId < nextUpdateId) return false;
    applyLevels(state.asks, update.asks);
    applyLevels(state.bids, update.bids);
    state.lastUpdateId = update.lastUpdateId;
    state.depthTimestamp = update.timestamp;
    state.depthReceivedAt = update.receivedAt;
    return !bookIsCrossed(state);
  }

  private beginSnapshotSync(state: SymbolState, resync: boolean): void {
    if (this.stopped) return;
    if (state.snapshotRetry) clearTimeout(state.snapshotRetry);
    state.snapshotRetry = undefined;
    state.syncGeneration += 1;
    const generation = state.syncGeneration;
    state.syncing = true;
    state.bookReady = false;
    state.buffered = [];
    if (resync) this.counters.resyncs += 1;
    void this.fetchDepthSnapshot(state.symbol).then((snapshot) => {
      if (this.stopped || generation !== state.syncGeneration) return;
      const lastUpdateId = parseInteger(snapshot.lastUpdateId);
      if (lastUpdateId === null) throw new Error("Invalid Backpack depth lastUpdateId");
      state.asks = new Map();
      state.bids = new Map();
      applyLevels(state.asks, snapshot.asks);
      applyLevels(state.bids, snapshot.bids);
      if (bookIsCrossed(state)) throw new Error("Backpack depth snapshot is crossed");
      state.lastUpdateId = lastUpdateId;
      state.depthTimestamp = snapshot.timestamp;
      state.depthReceivedAt = this.now();
      state.syncing = false;
      state.bookReady = true;
      const buffered = state.buffered;
      state.buffered = [];
      for (const update of buffered) {
        if (!this.applyUpdate(state, update)) {
          this.counters.gaps += 1;
          this.beginSnapshotSync(state, true);
          state.buffered.push(update);
          return;
        }
      }
    }).catch(() => {
      if (this.stopped || generation !== state.syncGeneration) return;
      state.syncing = false;
      state.bookReady = false;
      state.snapshotRetry = setTimeout(() => {
        state.snapshotRetry = undefined;
        this.beginSnapshotSync(state, true);
      }, this.reconnectBaseMs);
    });
  }

  private handleMark(payload: Record<string, unknown>, receivedAt: number): void {
    const state = typeof payload.s === "string" ? this.states.get(payload.s) : undefined;
    if (
      !state
      || typeof payload.p !== "string"
      || typeof payload.i !== "string"
      || typeof payload.f !== "string"
      || typeof payload.n !== "number"
      || typeof payload.T !== "number"
    ) return;
    state.mark = {
      markPrice: payload.p,
      indexPrice: payload.i,
      fundingRate: payload.f,
      nextFundingTimestamp: payload.n,
      timestamp: payload.T,
      receivedAt,
    };
  }
}
