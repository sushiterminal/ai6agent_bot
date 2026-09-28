import { readFile } from "node:fs/promises";
import { createPrivateKey, sign } from "node:crypto";
import { config } from "./config.js";
import type {
  BackpackMarketHoliday,
  BackpackMarketSession,
  FundingIntervalRate,
} from "./market-context.js";

const API_URL = "https://api.backpack.exchange";

class BackpackHttpError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

interface Credentials {
  key: string;
  secret: string;
}

type SignedValue = string | number | boolean;

export interface BackpackAccountSummary {
  futuresMakerFee: string;
  futuresTakerFee: string;
  leverageLimit: string;
  limitOrders: number;
  liquidating: boolean;
  positionLimit: string;
  triggerOrders: number;
}

export interface BackpackBalance {
  available: string;
  locked: string;
  staked?: string;
}

export interface BackpackCollateralSummary {
  netEquity: string;
  netEquityAvailable: string;
  netEquityLocked: string;
  netExposureFutures: string;
  pnlUnrealized: string;
}

export interface BackpackMarket {
  symbol: string;
  marketType: string;
  orderBookState: string;
  visible: boolean;
  filters: {
    price: { tickSize: string };
    quantity: { minQuantity: string; maxQuantity: string | null; stepSize: string };
  };
}

export interface BackpackPosition {
  symbol: string;
  netQuantity: string;
  netExposureNotional: string;
}

export interface BackpackOpenOrder {
  id: string;
  clientId?: number;
  symbol: string;
  side: string;
  quantity?: string;
  executedQuantity?: string;
  status?: string;
}

export interface BackpackFill {
  clientId: string | number;
  fee: string;
  feeSymbol: string;
  orderId: string;
  price: string;
  quantity: string;
  side: string;
  symbol: string;
  timestamp: string;
  tradeId: number;
}

export interface BackpackHistoricalOrder extends BackpackOpenOrder {
  createdAt: string;
  executedQuantity: string;
  executedQuoteQuantity: string;
  status: string;
}

export interface BackpackOrderRequest extends Record<string, SignedValue> {
  clientId: number;
  orderType: "Limit";
  price: string;
  quantity: string;
  reduceOnly: boolean;
  selfTradePrevention: "RejectTaker";
  side: "Bid" | "Ask";
  symbol: string;
  timeInForce: "IOC";
}

export function feeBasisPointsToPercent(value: string): number {
  const basisPoints = Number(value);
  if (!Number.isFinite(basisPoints) || basisPoints < 0) {
    throw new Error("Backpack returned an invalid fee rate");
  }
  return basisPoints / 100;
}

function decodeValue(value: string): string {
  return value.replace(/&#x20;/gi, " ").replace(/&amp;/gi, "&").trim();
}

async function loadCredentials(path: string | null): Promise<Credentials> {
  if (!path) {
    throw new Error("Set BACKPACK_API_KEY/BACKPACK_API_SECRET or BACKPACK_CREDENTIALS_FILE");
  }
  const raw = await readFile(path, "utf8");
  const values = Object.fromEntries(
    raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), decodeValue(line.slice(separator + 1))];
      }),
  );

  if (!values.KEY || !values.SECRET) {
    throw new Error("BACKPACK_CREDENTIALS_FILE must contain KEY and SECRET");
  }

  return { key: values.KEY, secret: values.SECRET };
}

function privateKeyFromSeed(secret: string) {
  const seed = Buffer.from(secret, "base64");
  if (seed.length !== 32) throw new Error("Backpack secret must decode to 32 bytes");
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({
    key: Buffer.concat([prefix, seed]),
    format: "der",
    type: "pkcs8",
  });
}

export class BackpackClient {
  constructor(
    private readonly credentialsPath: string | null,
    private readonly environmentCredentials?: Credentials,
  ) {}

  private async signedGet<T>(
    path: string,
    instruction: string,
    parameters: Record<string, string> = {},
    notFoundValue?: T,
  ): Promise<T> {
    return this.signedRequest(path, instruction, "GET", parameters, notFoundValue);
  }

  private async signedRequest<T>(
    path: string,
    instruction: string,
    method: "GET" | "POST",
    parameters: Record<string, SignedValue> = {},
    notFoundValue?: T,
  ): Promise<T> {
    const credentials = this.environmentCredentials ?? await loadCredentials(this.credentialsPath);
    const timestamp = Date.now().toString();
    const window = "5000";
    const entries = Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right));
    const query = new URLSearchParams(entries.map(([name, value]) => [name, String(value)]));
    const signedParameters = entries.map(([name, value]) => `${name}=${value}`).join("&");
    const payload = `instruction=${instruction}${signedParameters ? `&${signedParameters}` : ""}&timestamp=${timestamp}&window=${window}`;
    const signature = sign(
      null,
      Buffer.from(payload),
      privateKeyFromSeed(credentials.secret),
    ).toString("base64");

    const url = new URL(`${API_URL}${path}`);
    if (method === "GET") {
      for (const [name, value] of query) url.searchParams.set(name, value);
    }
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(8_000),
      headers: {
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
        "X-API-Key": credentials.key,
        "X-Signature": signature,
        "X-Timestamp": timestamp,
        "X-Window": window,
      },
      ...(method === "POST" ? { body: JSON.stringify(parameters) } : {}),
    });

    if (response.status === 404 && notFoundValue !== undefined) return notFoundValue;
    if (!response.ok) {
      throw new Error(`Backpack ${path} returned ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  private async publicGet<T>(path: string, parameters?: Record<string, string>): Promise<T> {
    const url = new URL(`${API_URL}${path}`);
    for (const [name, value] of Object.entries(parameters ?? {})) url.searchParams.set(name, value);
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(config.backpackSnapshotTimeoutMs),
        });
        if (response.ok) return response.json() as Promise<T>;
        const error = new BackpackHttpError(
          `Backpack ${path} returned ${response.status}`,
          response.status === 429 || response.status >= 500,
        );
        if (!error.retryable) throw error;
        lastError = error;
      } catch (error) {
        if (error instanceof BackpackHttpError && !error.retryable) throw error;
        lastError = error instanceof Error ? error : new Error(`Backpack ${path} failed`);
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
    throw lastError ?? new Error(`Backpack ${path} failed`);
  }

  async getFeeRates() {
    const account = await this.getAccountSummary();

    return {
      makerFeePct: feeBasisPointsToPercent(account.futuresMakerFee),
      takerFeePct: feeBasisPointsToPercent(account.futuresTakerFee),
    };
  }

  async getDepth(symbol: string) {
    const snapshot = await this.publicGet<{
      asks: [string, string][];
      bids: [string, string][];
      lastUpdateId: string;
      timestamp: number;
    }>("/api/v1/depth", { symbol, limit: "1000" });
    if (!Array.isArray(snapshot.asks) || !Array.isArray(snapshot.bids) || !snapshot.lastUpdateId) {
      throw new Error("Backpack returned an invalid depth snapshot");
    }
    return snapshot;
  }

  async getAccountSummary() {
    return this.signedGet<BackpackAccountSummary>("/api/v1/account", "accountQuery");
  }

  async getBalances() {
    return this.signedGet<Record<string, BackpackBalance>>("/api/v1/capital", "balanceQuery");
  }

  async getCollateral() {
    return this.signedGet<BackpackCollateralSummary>(
      "/api/v1/capital/collateral",
      "collateralQuery",
    );
  }

  async getMaxOrderQuantity(symbol: string, side: "Bid" | "Ask", price?: string) {
    const parameters = { symbol, side, ...(price ? { price } : {}) };
    return this.signedGet<{
      maxOrderQuantity: string;
      side: string;
      symbol: string;
    }>("/api/v1/account/limits/order", "maxOrderQuantity", parameters);
  }

  async getPositions(symbol?: string) {
    return this.signedGet<BackpackPosition[]>(
      "/api/v1/position",
      "positionQuery",
      symbol ? { symbol } : {},
      [],
    );
  }

  async getOpenOrders(symbol?: string) {
    return this.signedGet<BackpackOpenOrder[]>(
      "/api/v1/orders",
      "orderQueryAll",
      symbol ? { symbol } : {},
    );
  }

  async getFillHistory(symbol: string, limit = 1000) {
    return this.signedGet<BackpackFill[]>(
      "/wapi/v1/history/fills",
      "fillHistoryQueryAll",
      { symbol, limit: String(limit), fillType: "User", sortDirection: "Desc" },
    );
  }

  async getOrderHistory(symbol: string, limit = 1000) {
    return this.signedGet<BackpackHistoricalOrder[]>(
      "/wapi/v1/history/orders",
      "orderHistoryQueryAll",
      { symbol, limit: String(limit), sortDirection: "Desc" },
    );
  }

  async executeIocLimitOrder(input: {
    clientId: number;
    symbol: string;
    side: "Bid" | "Ask";
    quantity: string;
    price: string;
    reduceOnly?: boolean;
  }) {
    if (!Number.isInteger(input.clientId) || input.clientId <= 0 || input.clientId > 0xffff_ffff) {
      throw new Error("Backpack client order id must be a positive uint32");
    }
    if (!/^\d+(?:\.\d+)?$/.test(input.quantity) || Number(input.quantity) <= 0) {
      throw new Error("Backpack order quantity must be positive");
    }
    if (!/^\d+(?:\.\d+)?$/.test(input.price) || Number(input.price) <= 0) {
      throw new Error("Backpack order price must be positive");
    }
    const request: BackpackOrderRequest = {
      clientId: input.clientId,
      orderType: "Limit",
      price: input.price,
      quantity: input.quantity,
      reduceOnly: input.reduceOnly ?? false,
      selfTradePrevention: "RejectTaker",
      side: input.side,
      symbol: input.symbol,
      timeInForce: "IOC",
    };
    return this.signedRequest<BackpackHistoricalOrder>(
      "/api/v1/order",
      "orderExecute",
      "POST",
      request,
    );
  }

  async getMarket(symbol: string) {
    return this.publicGet<BackpackMarket>("/api/v1/market", { symbol });
  }

  async getFundingRates(symbol: string, limit = 10): Promise<FundingIntervalRate[]> {
    const rates = await this.publicGet<FundingIntervalRate[]>("/api/v1/fundingRates", {
      symbol,
      limit: String(limit),
    });
    if (!Array.isArray(rates)) throw new Error("Backpack returned invalid funding rates");
    return rates;
  }

  async getMarketSessions(): Promise<BackpackMarketSession[]> {
    const sessions = await this.publicGet<BackpackMarketSession[]>("/api/v1/market-sessions");
    if (!Array.isArray(sessions) || sessions.length === 0) {
      throw new Error("Backpack returned invalid market sessions");
    }
    return sessions;
  }

  async getMarketHolidays(): Promise<BackpackMarketHoliday[]> {
    const holidays = await this.publicGet<BackpackMarketHoliday[]>("/api/v1/market-holidays");
    if (!Array.isArray(holidays)) throw new Error("Backpack returned invalid market holidays");
    return holidays;
  }

  async getMarkPrice(symbol: string) {
    const url = new URL(`${API_URL}/api/v1/markPrices`);
    url.searchParams.set("symbol", symbol);
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Backpack mark price returned ${response.status}`);
    const rows = (await response.json()) as Array<{
      fundingRate: string;
      indexPrice: string;
      markPrice: string;
      nextFundingTimestamp: number;
    }>;
    if (!rows[0]) throw new Error("Backpack returned no mark price");
    return rows[0];
  }
}
