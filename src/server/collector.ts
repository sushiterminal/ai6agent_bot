import type { BackpackClient } from "./backpack.js";
import type { BackpackMarketData } from "./backpack-market-data.js";
import { config } from "./config.js";
import { getJupiterMetrics, getQuote } from "./jupiter.js";
import {
  getMarketContext,
  inferFundingIntervalMinutes,
  type BackpackMarketHoliday,
  type BackpackMarketSession,
} from "./market-context.js";
import { TRACKED_PAIRS, USDC_DECIMALS, USDC_MINT } from "./pairs.js";
import { calculateProfitability, vwap } from "./profitability.js";
import type { SampleRepository } from "./repository.js";
import type {
  MonitorState,
  PairSymbol,
  SpreadSample,
  TrackedPair,
  TrackedSize,
} from "./types.js";
import { TRACKED_SIZE } from "./types.js";

const PROBE_SIZE: TrackedSize = TRACKED_SIZE;

interface PairSchedule {
  nextCheckAt: number;
  lastEdgePct: number | null;
  consecutiveErrors: number;
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function isFreshPositiveSample(
  sample: Pick<SpreadSample, "entryEdgePct" | "backpackDataAgeMs">,
  maxAgeMs: number,
) {
  return sample.entryEdgePct > 0
    && sample.backpackDataAgeMs >= 0
    && sample.backpackDataAgeMs <= maxAgeMs;
}

export function restoredNextCheckAt(capturedAt: Date, intervalMs: number, now: number) {
  if (!Number.isFinite(capturedAt.getTime()) || !Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error("Cannot restore an invalid collector schedule");
  }
  return Math.max(now, capturedAt.getTime() + intervalMs);
}

export class SpreadCollector {
  readonly state: MonitorState = {
    status: "starting",
    lastCycleAt: null,
    nextCycleAt: null,
    lastError: null,
    futuresMakerFeePct: null,
    futuresTakerFeePct: null,
    activePair: null,
    completedPairs: 0,
    totalPairs: TRACKED_PAIRS.length,
    pairErrors: {},
    schedulerLagMs: 0,
    confirmedSignals: 0,
    marketSession: "UNKNOWN",
    marketHoliday: null,
    marketContextUpdatedAt: null,
    fundingIntervalMinutes: {},
    restartAttempts: 0,
    restoredPairs: 0,
  };

  private timer?: NodeJS.Timeout;
  private stopped = false;
  private currentRun?: Promise<void>;
  private readonly initializedPairs = new Set<PairSymbol>();
  private marketSessions: BackpackMarketSession[] = [];
  private marketHolidays: BackpackMarketHoliday[] = [];
  private readonly schedules = new Map<PairSymbol, PairSchedule>(
    TRACKED_PAIRS.map((pair) => [
      pair.symbol,
      { nextCheckAt: Date.now(), lastEdgePct: null, consecutiveErrors: 0 },
    ]),
  );

  constructor(
    private readonly repository: SampleRepository,
    private readonly backpack: BackpackClient,
    private readonly marketData: BackpackMarketData,
    private readonly jupiterRoundTrip?: {
      onSamples(
        samples: SpreadSample[],
        confirmedSignal: boolean,
      ): Promise<void>;
    },
  ) {}

  async start(): Promise<void> {
    this.state.status = "starting";
    this.state.lastError = null;
    this.marketData.start();
    try {
      const fees = await this.backpack.getFeeRates();
      this.state.futuresMakerFeePct = fees.makerFeePct;
      this.state.futuresTakerFeePct = fees.takerFeePct;
      await this.loadReferenceData();
      await this.waitForMarketData();
      this.currentRun = this.runNextPair();
      await this.currentRun;
    } catch (error) {
      this.state.status = "error";
      this.state.lastError = error instanceof Error ? error.message : "Collector startup failed";
      throw error;
    }
  }

  private async loadReferenceData(): Promise<void> {
    [this.marketSessions, this.marketHolidays] = await Promise.all([
      this.backpack.getMarketSessions(),
      this.backpack.getMarketHolidays(),
    ]);
    for (const pair of TRACKED_PAIRS) {
      const rates = await this.backpack.getFundingRates(pair.perpSymbol, 5);
      this.state.fundingIntervalMinutes[pair.symbol] = inferFundingIntervalMinutes(rates);
    }
    const latestSamples = await this.repository.latest(TRACKED_SIZE);
    this.restoreSchedules(latestSamples, Date.now());
    this.updateMarketContext(new Date());
  }

  private restoreSchedules(samples: SpreadSample[], now: number) {
    for (const sample of samples) {
      const schedule = this.schedules.get(sample.pair);
      if (!schedule || !Number.isFinite(sample.entryEdgePct)) continue;
      schedule.lastEdgePct = sample.entryEdgePct;
      schedule.nextCheckAt = restoredNextCheckAt(
        sample.capturedAt,
        this.pairInterval(sample.entryEdgePct),
        now,
      );
      this.initializedPairs.add(sample.pair);
    }
    this.state.restoredPairs = this.initializedPairs.size;
    this.state.completedPairs = this.initializedPairs.size;
  }

  recordRestartAttempt(error: unknown) {
    this.state.restartAttempts += 1;
    this.state.status = "error";
    this.state.lastError = error instanceof Error ? error.message : "Collector restart requested";
  }

  private updateMarketContext(now: Date) {
    const context = getMarketContext(now, this.marketSessions, this.marketHolidays);
    this.state.marketSession = context.session;
    this.state.marketHoliday = context.holiday;
    this.state.marketContextUpdatedAt = now.toISOString();
    return context;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.marketData.stop();
    await this.currentRun?.catch(() => undefined);
  }

  getOperationalMetrics() {
    return {
      backpack: this.marketData.getMetrics(config.backpackMarketMaxAgeMs),
      jupiter: getJupiterMetrics(),
      schedulerLagMs: this.state.schedulerLagMs,
    };
  }

  async runDryRunProbe(pair: TrackedPair, sizeUsd: TrackedSize): Promise<SpreadSample> {
    if (this.stopped || this.state.status === "error") {
      throw new Error("Collector is not ready for a fresh dry-run probe");
    }
    return this.collectSize(pair, sizeUsd);
  }

  isReady(): boolean {
    const backpack = this.marketData.getMetrics(config.backpackMarketMaxAgeMs);
    return !this.stopped
      && this.state.status !== "error"
      && backpack.connected
      && backpack.staleSymbols.length === 0;
  }

  private async waitForMarketData(): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (!this.stopped && Date.now() < deadline) {
      const metrics = this.marketData.getMetrics(config.backpackMarketMaxAgeMs);
      if (metrics.connected && metrics.staleSymbols.length === 0) return;
      await wait(100);
    }
    throw new Error("Backpack WebSocket market data did not become ready in time");
  }

  private pairInterval(edgePct: number): number {
    if (edgePct >= config.hotEdgePct) return config.hotPairIntervalMs;
    if (edgePct >= config.warmEdgePct) return config.warmPairIntervalMs;
    return config.coldPairIntervalMs;
  }

  private nextPair(): TrackedPair {
    return TRACKED_PAIRS.reduce((winner, pair) => {
      const pairTime = this.schedules.get(pair.symbol)?.nextCheckAt ?? 0;
      const winnerTime = this.schedules.get(winner.symbol)?.nextCheckAt ?? 0;
      return pairTime < winnerTime ? pair : winner;
    });
  }

  private scheduleNextPair(): void {
    if (this.stopped) return;
    const pair = this.nextPair();
    const next = this.schedules.get(pair.symbol)?.nextCheckAt ?? Date.now();
    const delay = Math.max(0, next - Date.now());
    this.state.nextCycleAt = new Date(next).toISOString();
    this.state.status = "ready";
    this.timer = setTimeout(() => {
      this.currentRun = this.runNextPair();
      void this.currentRun;
    }, delay);
  }

  private async collectSize(
    pair: TrackedPair,
    sizeUsd: TrackedSize,
    confirmationIndex = 0,
  ): Promise<SpreadSample> {
    const quoteStartedAt = new Date();
    const buy = await getQuote(
      USDC_MINT,
      pair.tokenMint,
      String(sizeUsd * 10 ** USDC_DECIMALS),
    );
    const sell = await getQuote(pair.tokenMint, USDC_MINT, buy.outAmount);
    const quoteCompletedAt = new Date();
    const market = this.marketData.getMarket(pair.perpSymbol, config.backpackMarketMaxAgeMs);
    const quantity = Number(buy.outAmount) / 10 ** pair.tokenDecimals;
    const sellProceedsUsd = Number(sell.outAmount) / 10 ** USDC_DECIMALS;
    const bid = vwap(market.bids, quantity, "bid");
    const ask = vwap(market.asks, quantity, "ask");
    const fundingRatePct = Number(market.fundingRate) * 100;
    const metrics = calculateProfitability({
      sizeUsd,
      quantity,
      dexSellProceedsUsd: sellProceedsUsd,
      backpackBidVwap: bid.price,
      backpackAskVwap: ask.price,
      backpackTakerFeePct: this.state.futuresTakerFeePct ?? 0.05,
      fundingRatePct,
      expectedFundingPeriods: config.expectedFundingPeriods,
      targetExitBasisPct: config.targetExitBasisPct,
      expectedSpotSlippagePct: config.expectedSpotSlippagePct,
      expectedPerpSlippagePct: config.expectedPerpSlippagePct,
      solanaTransactionFeesUsd: config.solanaTransactionFeesUsd,
      priorityFeesUsd: config.priorityFeesUsd,
      partialFillReservePct: config.partialFillReservePct,
      safetyBufferPct: config.safetyBufferPct,
    });
    const capturedAt = new Date();
    const marketContext = this.updateMarketContext(capturedAt);
    const oldestMarketReceivedAt = Math.min(market.depthReceivedAt, market.markReceivedAt);

    return {
      pair: pair.symbol,
      basisRisk: pair.basisRisk,
      sizeUsd,
      capturedAt,
      tokenMint: pair.tokenMint,
      perpSymbol: pair.perpSymbol,
      quantity,
      ...metrics,
      backpackBidVwap: bid.price,
      backpackAskVwap: ask.price,
      backpackTakerFeePct: this.state.futuresTakerFeePct ?? 0.05,
      safetyBufferPct: config.safetyBufferPct,
      fundingRatePct,
      fundingIntervalMinutes: this.state.fundingIntervalMinutes[pair.symbol]!,
      // Unlike event timestamps, Backpack sends next funding timestamp in milliseconds.
      nextFundingAt: new Date(market.nextFundingTimestamp),
      marketSession: marketContext.session,
      marketHoliday: marketContext.holiday,
      markPrice: Number(market.markPrice),
      indexPrice: Number(market.indexPrice),
      jupiterBuyRoute: buy.routePlan.map((part) => part.swapInfo.label),
      jupiterSellRoute: sell.routePlan.map((part) => part.swapInfo.label),
      bookUpdateId: market.lastUpdateId,
      bookTimestamp: new Date(market.depthTimestamp / 1_000),
      backpackDataAgeMs: Math.max(0, capturedAt.getTime() - oldestMarketReceivedAt),
      quoteStartedAt,
      quoteCompletedAt,
      quoteDurationMs: quoteCompletedAt.getTime() - quoteStartedAt.getTime(),
      confirmationIndex,
    };
  }

  private async runNextPair(): Promise<void> {
    const pair = this.nextPair();
    const schedule = this.schedules.get(pair.symbol);
    if (!schedule || this.stopped) return;

    const dueAt = schedule.nextCheckAt;
    this.state.schedulerLagMs = Math.max(0, Date.now() - dueAt);
    this.state.status = "collecting";
    this.state.activePair = pair.symbol;
    this.state.lastError = null;

    try {
      const probe = await this.collectSize(pair, PROBE_SIZE);
      const samples = [probe];
      const confirmationEdges: number[] = [];
      let confirmedSignal = false;
      delete this.state.pairErrors[pair.symbol];

      const probeIsFreshPositive = isFreshPositiveSample(probe, config.backpackMarketMaxAgeMs);
      if (probeIsFreshPositive) {
        for (let index = 1; index <= config.positiveConfirmations; index += 1) {
          if (config.confirmationDelayMs > 0) await wait(config.confirmationDelayMs);
          const confirmation = await this.collectSize(pair, PROBE_SIZE, index);
          samples.push(confirmation);
          confirmationEdges.push(confirmation.entryEdgePct);
        }
        if (confirmationEdges.length === config.positiveConfirmations
          && samples.every((sample) =>
            isFreshPositiveSample(sample, config.backpackMarketMaxAgeMs))) {
          this.state.confirmedSignals += 1;
          confirmedSignal = true;
        }
      }

      await this.repository.insertMany(samples);
      await this.jupiterRoundTrip?.onSamples(samples, confirmedSignal);
      const schedulingEdge = confirmationEdges.length > 0
        ? Math.min(probe.entryEdgePct, ...confirmationEdges)
        : probe.entryEdgePct;
      schedule.lastEdgePct = schedulingEdge;
      schedule.nextCheckAt = Date.now() + this.pairInterval(schedulingEdge);
      schedule.consecutiveErrors = 0;
      if (!this.initializedPairs.has(pair.symbol)) {
        this.initializedPairs.add(pair.symbol);
        this.state.completedPairs = this.initializedPairs.size;
      }
      this.state.lastCycleAt = new Date().toISOString();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown pair error";
      schedule.consecutiveErrors += 1;
      const errorDelay = Math.min(
        config.coldPairIntervalMs,
        config.errorPairIntervalMs * 2 ** Math.min(schedule.consecutiveErrors - 1, 4),
      );
      this.state.pairErrors[pair.symbol] = message;
      schedule.nextCheckAt = Date.now() + errorDelay;
      this.state.lastError = `${pair.symbol}: ${message}`;
    } finally {
      this.state.activePair = null;
      this.scheduleNextPair();
    }
  }
}
