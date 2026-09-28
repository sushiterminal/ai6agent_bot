import { config } from "./config.js";

const QUOTE_URL = "https://api.jup.ag/swap/v1/quote";

export interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: Array<{ swapInfo: { label: string } }>;
  quoteResponse: Record<string, unknown>;
}

export interface JupiterMetrics {
  queueDepth: number;
  requestsTotal: number;
  requestsLastMinute: number;
  retriesTotal: number;
  rateLimitedTotal: number;
  errorsTotal: number;
  lastLatencyMs: number | null;
  averageLatencyMs: number | null;
  cooldownUntil: string | null;
  configuredRps: number;
}

export interface JupiterQuoteSchedulerOptions {
  apiKey?: string | null;
  requestsPerSecond: number;
  requestTimeoutMs: number;
  jobDeadlineMs: number;
  maxRetries: number;
  excludedDexes?: readonly string[];
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

function positiveIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function parseQuote(value: unknown): JupiterQuote {
  if (typeof value !== "object" || value === null) throw new Error("Jupiter returned invalid JSON");
  const row = value as Record<string, unknown>;
  if (!positiveIntegerString(row.inAmount) || !positiveIntegerString(row.outAmount)) {
    throw new Error("Jupiter returned invalid quote amounts");
  }
  if (!Array.isArray(row.routePlan) || row.routePlan.length === 0) {
    throw new Error("Jupiter returned no route");
  }
  const routePlan = row.routePlan.map((part) => {
    if (typeof part !== "object" || part === null) throw new Error("Jupiter returned invalid route");
    const swapInfo = (part as Record<string, unknown>).swapInfo;
    if (typeof swapInfo !== "object" || swapInfo === null) {
      throw new Error("Jupiter returned invalid route");
    }
    const label = (swapInfo as Record<string, unknown>).label;
    if (typeof label !== "string" || !label) throw new Error("Jupiter returned invalid route label");
    return { swapInfo: { label } };
  });
  const priceImpactPct = row.priceImpactPct;
  if (typeof priceImpactPct !== "string" || !Number.isFinite(Number(priceImpactPct))) {
    throw new Error("Jupiter returned invalid price impact");
  }
  return {
    inAmount: row.inAmount,
    outAmount: row.outAmount,
    priceImpactPct,
    routePlan,
    quoteResponse: row,
  };
}

export class JupiterQuoteScheduler {
  private readonly apiKey: string | null;
  private readonly spacingMs: number;
  private readonly requestTimeoutMs: number;
  private readonly jobDeadlineMs: number;
  private readonly maxRetries: number;
  private readonly excludedDexes: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private tail: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private cooldownUntil = 0;
  private queueDepth = 0;
  private requestsTotal = 0;
  private retriesTotal = 0;
  private rateLimitedTotal = 0;
  private errorsTotal = 0;
  private latencyTotalMs = 0;
  private lastLatencyMs: number | null = null;
  private readonly requestTimes: number[] = [];

  constructor(options: JupiterQuoteSchedulerOptions) {
    if (!Number.isFinite(options.requestsPerSecond) || options.requestsPerSecond <= 0) {
      throw new Error("Jupiter requestsPerSecond must be positive");
    }
    this.apiKey = options.apiKey?.trim() || null;
    this.spacingMs = Math.ceil(1_000 / options.requestsPerSecond);
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.jobDeadlineMs = options.jobDeadlineMs;
    this.maxRetries = options.maxRetries;
    this.excludedDexes = options.excludedDexes ?? [];
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
  }

  quote(inputMint: string, outputMint: string, amount: string, slippageBps = 50): Promise<JupiterQuote> {
    if (
      !inputMint
      || !outputMint
      || !positiveIntegerString(amount)
      || !Number.isInteger(slippageBps)
      || slippageBps < 0
      || slippageBps > 10_000
    ) {
      return Promise.reject(new Error("Invalid Jupiter quote parameters"));
    }
    const deadline = this.now() + this.jobDeadlineMs;
    this.queueDepth += 1;
    const task = this.tail.then(async () => {
      this.queueDepth -= 1;
      return this.executeQuote(inputMint, outputMint, amount, slippageBps, deadline);
    });
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  getMetrics(): JupiterMetrics {
    const cutoff = this.now() - 60_000;
    while (this.requestTimes[0] !== undefined && this.requestTimes[0] < cutoff) {
      this.requestTimes.shift();
    }
    return {
      queueDepth: this.queueDepth,
      requestsTotal: this.requestsTotal,
      requestsLastMinute: this.requestTimes.length,
      retriesTotal: this.retriesTotal,
      rateLimitedTotal: this.rateLimitedTotal,
      errorsTotal: this.errorsTotal,
      lastLatencyMs: this.lastLatencyMs,
      averageLatencyMs: this.requestsTotal > 0 ? this.latencyTotalMs / this.requestsTotal : null,
      cooldownUntil: this.cooldownUntil > this.now()
        ? new Date(this.cooldownUntil).toISOString()
        : null,
      configuredRps: 1_000 / this.spacingMs,
    };
  }

  private async executeQuote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
    deadline: number,
  ): Promise<JupiterQuote> {
    let lastError: Error = new Error("Jupiter quote failed");
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (this.now() >= deadline) {
        this.errorsTotal += 1;
        throw new Error("Jupiter quote deadline exceeded");
      }
      await this.waitForSlot(deadline);
      const startedAt = this.now();
      let requestRecorded = false;
      try {
        const url = new URL(QUOTE_URL);
        url.searchParams.set("inputMint", inputMint);
        url.searchParams.set("outputMint", outputMint);
        url.searchParams.set("amount", amount);
        url.searchParams.set("slippageBps", String(slippageBps));
        url.searchParams.set("restrictIntermediateTokens", "true");
        if (this.excludedDexes.length > 0) {
          url.searchParams.set("excludeDexes", this.excludedDexes.join(","));
        }
        const remaining = Math.max(1, deadline - this.now());
        const response = await this.fetchImpl(url, {
          signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, remaining)),
          headers: this.apiKey ? { "x-api-key": this.apiKey } : undefined,
        });
        this.recordRequest(startedAt);
        requestRecorded = true;
        if (response.ok) return parseQuote(await response.json());

        lastError = new Error(`Jupiter quote returned ${response.status}`);
        const retryable = response.status === 429 || [502, 503, 504].includes(response.status);
        if (!retryable || attempt === this.maxRetries) break;
        if (response.status === 429) {
          this.rateLimitedTotal += 1;
          this.cooldownUntil = Math.max(this.cooldownUntil, this.retryAt(response));
        }
      } catch (error) {
        if (!requestRecorded) this.recordRequest(startedAt);
        lastError = error instanceof Error ? error : new Error("Jupiter quote request failed");
        if (attempt === this.maxRetries) break;
      }
      this.retriesTotal += 1;
      const backoff = Math.min(2_000, 200 * 2 ** attempt) + Math.floor(this.random() * 100);
      this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + backoff);
    }
    this.errorsTotal += 1;
    throw lastError;
  }

  private async waitForSlot(deadline: number): Promise<void> {
    const now = this.now();
    const requestAt = Math.max(now, this.nextRequestAt, this.cooldownUntil);
    if (requestAt >= deadline) throw new Error("Jupiter quote deadline exceeded while queued");
    this.nextRequestAt = requestAt + this.spacingMs;
    if (requestAt > now) await this.sleep(requestAt - now);
  }

  private recordRequest(startedAt: number): void {
    const completedAt = this.now();
    const latency = Math.max(0, completedAt - startedAt);
    this.requestsTotal += 1;
    this.requestTimes.push(completedAt);
    this.lastLatencyMs = latency;
    this.latencyTotalMs += latency;
  }

  private retryAt(response: Response): number {
    const now = this.now();
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return now + Math.max(0, seconds * 1_000);
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) return date;
    }
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) {
      if (reset > 1_000_000_000_000) return reset;
      if (reset > 1_000_000_000) return reset * 1_000;
      return now + reset * 1_000;
    }
    return now + 1_000;
  }
}

const scheduler = new JupiterQuoteScheduler({
  apiKey: config.jupiterApiKey,
  requestsPerSecond: config.jupiterRps,
  requestTimeoutMs: config.jupiterRequestTimeoutMs,
  jobDeadlineMs: config.jupiterJobDeadlineMs,
  maxRetries: config.jupiterMaxRetries,
  excludedDexes: config.jupiterExcludedDexes,
});

export const getQuote = (
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps = 50,
) => scheduler.quote(inputMint, outputMint, amount, slippageBps);

export const getJupiterMetrics = () => scheduler.getMetrics();
