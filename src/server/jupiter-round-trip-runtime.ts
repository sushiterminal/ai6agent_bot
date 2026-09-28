import { Decimal } from "decimal.js";
import type { BackpackClient } from "./backpack.js";
import { evaluateBackpackPreflight } from "./backpack-preflight.js";
import type { BackpackMarketData } from "./backpack-market-data.js";
import { buildIocLimitPreview } from "./canary-write-adapter.js";
import { config } from "./config.js";
import {
  boundedHedgeQuantity,
  calculateHedgedRealizedPnl,
  summarizeBackpackExecution,
} from "./jupiter-hedge.js";
import type { JupiterLiveTradingSettings } from "./jupiter-live-settings.js";
import { getQuote, type JupiterQuote } from "./jupiter.js";
import {
  createJupiterRoundTripTrade,
  decideJupiterRoundTripExit,
  isJupiterRoundTripEntry,
  type JupiterExecutionQuote,
  type JupiterRoundTripExitReason,
  type JupiterRoundTripPolicy,
  type JupiterRoundTripTrade,
} from "./jupiter-round-trip.js";
import { hasLiveBudgetCapacity, hasLivePositionCapacity, reachedRealizedStop } from "./live-portfolio-risk.js";
import { pairBySymbol, USDC_DECIMALS, USDC_MINT } from "./pairs.js";
import { calculateProfitability, vwap } from "./profitability.js";
import { evaluateRecoveryPreflight } from "./recovery-preflight.js";
import type { SampleRepository } from "./repository.js";
import {
  buildJupiterSwapTransaction,
  getSolanaBalanceSnapshot,
  getSolanaTransactionOutcome,
  isSolanaBlockhashValid,
  sendSolanaTransactionOnce,
  simulateSolanaTransaction,
  solanaTransactionRecentBlockhash,
} from "./solana-simulation.js";
import { signJupiterTransaction } from "./solana-signer.js";
import { backpackClientOrderId } from "./supervised-entry.js";
import type { SpreadSample } from "./types.js";

export interface JupiterRoundTripRuntimeStatus {
  enabled: boolean;
  killSwitch: boolean;
  busy: boolean;
  lastActionAt: string | null;
  lastError: string | null;
}

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "Unknown hedged execution error").slice(0, 500);
}

function quoteSummary(quote: JupiterQuote): JupiterExecutionQuote {
  const minimumOutAmount = quote.quoteResponse.otherAmountThreshold;
  if (typeof minimumOutAmount !== "string" || !/^\d+$/.test(minimumOutAmount)) {
    throw new Error("Jupiter quote has no valid minimum output amount");
  }
  return {
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    minimumOutAmount,
    priceImpactPct: quote.priceImpactPct,
    route: quote.routePlan.map((part) => part.swapInfo.label),
  };
}

export class JupiterRoundTripRuntime {
  readonly status: JupiterRoundTripRuntimeStatus = {
    enabled: config.jupiterAutoExecutionEnabled,
    killSwitch: config.jupiterAutoKillSwitch,
    busy: false,
    lastActionAt: null,
    lastError: null,
  };
  private livePortfolioInitialized = false;
  private liveTradingSettings: JupiterLiveTradingSettings = {
    tradeSizeUsd: config.jupiterAutoNotionalUsd,
    minEntryEdgePct: config.jupiterAutoMinEntryEdgePct,
    exitEdgePct: config.jupiterAutoExitEdgePct,
    maxBudgetUsd: config.jupiterLiveBudgetUsd,
  };

  constructor(
    private readonly repository: SampleRepository,
    private readonly backpack: BackpackClient,
    private readonly marketData: BackpackMarketData,
  ) {}

  async initializeLivePortfolio() {
    const control = await this.repository.ensureJupiterLiveControl(
      config.jupiterLiveStopLossUsd,
      this.liveTradingSettings,
    );
    this.liveTradingSettings = control.settings;
    this.livePortfolioInitialized = config.jupiterLivePortfolioEnabled;
  }

  currentLiveTradingSettings() {
    return { ...this.liveTradingSettings };
  }

  applyLiveTradingSettings(settings: JupiterLiveTradingSettings) {
    this.liveTradingSettings = { ...settings };
  }

  async recoverInterruptedPlanning() {
    for (const trade of await this.repository.activeJupiterRoundTrips()) {
      if (trade.status !== "ENTRY_PLANNED") continue;
      await this.repository.transitionJupiterRoundTrip({
        tradeId: trade.tradeId,
        expectedVersion: trade.version,
        from: "ENTRY_PLANNED",
        to: "FAILED",
        reason: "Restart found an entry plan with no persisted signature",
        patch: { lastError: "Entry preparation was interrupted before broadcast" },
      });
    }
  }

  async onSample(sample: SpreadSample, confirmedSignal: boolean) {
    await this.onSamples([sample], confirmedSignal);
  }

  async onSamples(samples: SpreadSample[], confirmedSignal: boolean) {
    if (this.status.busy || samples.length === 0) return;
    this.status.busy = true;
    try {
      if (!this.livePortfolioInitialized) await this.initializeLivePortfolio();
      const pending = (await this.repository.activeJupiterRoundTrips()).find((trade) => trade.status !== "OPEN");
      if (pending) {
        await this.progressTrade(pending);
        return;
      }

      let live = await this.repository.jupiterLivePortfolioStatus();
      this.liveTradingSettings = live.settings;
      if (reachedRealizedStop(live.dailyNetPnlUsd, live.stopLossUsd) && live.status === "RUNNING") {
        await this.repository.stopJupiterLivePortfolio(
          `Daily hedged PnL ${live.dailyNetPnlUsd.toFixed(6)} reached -$${live.stopLossUsd.toFixed(2)} on ${live.dayUtc} UTC`,
        );
        live = await this.repository.jupiterLivePortfolioStatus();
      }

      for (const sample of samples) {
        const active = await this.repository.findActiveJupiterRoundTrip(sample.pair);
        if (active?.status !== "OPEN") continue;
        const marked = await this.repository.updateJupiterRoundTripMark({
          tradeId: active.tradeId,
          expectedVersion: active.version,
          lastEdgePct: sample.entryEdgePct,
        });
        const exitReason = live.status === "STOPPED" && live.liquidateOnStop
          ? "PORTFOLIO_STOP" as const
          : decideJupiterRoundTripExit(sample.entryEdgePct, this.policy());
        if (!marked) throw new Error("Hedged trade mark update conflicted; reload before exit");
        if (exitReason && this.canWrite()) await this.beginExit(marked, exitReason);
        return;
      }

      if (live.status !== "RUNNING" || !this.canWrite()) return;
      const sample = samples.at(-1)!;
      if (!isJupiterRoundTripEntry(sample, confirmedSignal, this.policy())) return;
      if (!config.jupiterAutoAllowedPairs.includes(sample.pair)) return;
      const pair = pairBySymbol(sample.pair);
      if (!pair || pair.basisRisk !== "same_issuer") return;

      const active = await this.repository.activeJupiterRoundTrips();
      if (!hasLivePositionCapacity(active.length, config.jupiterAutoMaxOpenPositions)) return;
      const committedUsd = active.reduce((total, trade) => total + (trade.entrySpentUsd ?? trade.sizeUsd), 0);
      const sizeUsd = this.liveTradingSettings.tradeSizeUsd;
      if (!hasLiveBudgetCapacity(committedUsd, sizeUsd, this.liveTradingSettings.maxBudgetUsd)) return;
      const risk = await this.repository.jupiterRoundTripRiskState();
      if (risk.attemptsToday >= config.jupiterLiveMaxDailyEntries || risk.hasUnresolvedSubmission) return;

      const trade = createJupiterRoundTripTrade({ sample, sizeUsd, tokenDecimals: pair.tokenDecimals, policy: this.policy() });
      if (await this.repository.insertJupiterRoundTrip(trade)) await this.executeEntry(trade);
    } catch (error) {
      this.status.lastError = safeError(error);
    } finally {
      this.status.busy = false;
    }
  }

  private canWrite() {
    return this.status.enabled
      && !this.status.killSwitch
      && Boolean(
        config.solanaRpcUrl
        && config.solanaWalletPublicKey
        && config.solanaSignerCredentialsFile
        && config.solanaSignerPassphrase
        && config.backpackApiKey
        && config.backpackApiSecret,
      );
  }

  private policy(): JupiterRoundTripPolicy {
    const settings = this.livePortfolioInitialized
      ? this.liveTradingSettings
      : {
          tradeSizeUsd: config.jupiterAutoNotionalUsd,
          minEntryEdgePct: config.jupiterAutoMinEntryEdgePct,
          exitEdgePct: config.jupiterAutoExitEdgePct,
        };
    return {
      notionalUsd: settings.tradeSizeUsd,
      minEntryEdgePct: settings.minEntryEdgePct,
      exitEdgePct: settings.exitEdgePct,
      addNotionalUsd: settings.tradeSizeUsd,
      addEdgeStepPct: config.jupiterAutoAddEdgeStepPct,
    };
  }

  private async progressTrade(trade: JupiterRoundTripTrade) {
    if (trade.status === "ENTRY_SUBMITTED") return this.reconcileEntry(trade);
    if (trade.status === "HEDGE_PENDING" && this.canWrite()) return this.executeEntryHedge(trade);
    if (trade.status === "HEDGE_SUBMITTED") return this.reconcileEntryHedge(trade);
    if (trade.status === "HEDGE_CLOSE_PENDING" && this.canWrite()) return this.executeExitHedge(trade);
    if (trade.status === "HEDGE_CLOSE_SUBMITTED") return this.reconcileExitHedge(trade);
    if (trade.status === "EXIT_PLANNED" && this.canWrite()) return this.executeExit(trade);
    if (trade.status === "EXIT_SUBMITTED") return this.reconcileExit(trade);
  }

  private async entryPreflight(trade: JupiterRoundTripTrade, quote: JupiterQuote) {
    const quantity = new Decimal(quote.outAmount).div(new Decimal(10).pow(trade.tokenDecimals));
    const [sellQuote, account, balances, collateral, market, maxOrder, positions, openOrders] = await Promise.all([
      getQuote(trade.tokenMint, USDC_MINT, quote.outAmount, config.jupiterAutoSlippageBps),
      this.backpack.getAccountSummary(),
      this.backpack.getBalances(),
      this.backpack.getCollateral(),
      this.backpack.getMarket(trade.hedgeSymbol),
      this.backpack.getMaxOrderQuantity(trade.hedgeSymbol, "Ask"),
      this.backpack.getPositions(trade.hedgeSymbol),
      this.backpack.getOpenOrders(trade.hedgeSymbol),
    ]);
    const preflight = evaluateBackpackPreflight({
      symbol: trade.hedgeSymbol,
      requestedQuantity: quantity.toNumber(),
      account,
      balances,
      collateral,
      market,
      maxOrderQuantity: maxOrder.maxOrderQuantity,
      positions,
      openOrders,
    });
    if (!preflight.pass) throw new Error(`Backpack entry preflight failed: ${preflight.failures.join(",")}`);
    const book = this.marketData.getMarket(trade.hedgeSymbol, config.backpackMarketMaxAgeMs);
    const bid = vwap(book.bids, quantity.toNumber(), "bid");
    const ask = vwap(book.asks, quantity.toNumber(), "ask");
    boundedHedgeQuantity({
      spotQuantity: quantity.toString(),
      stepSize: market.filters.quantity.stepSize,
      minimumQuantity: market.filters.quantity.minQuantity,
      maximumQuantity: market.filters.quantity.maxQuantity,
      markPriceUsd: book.markPrice,
      maxUnhedgedUsd: config.jupiterAutoMaxUnhedgedUsd,
    });
    const metrics = calculateProfitability({
      sizeUsd: trade.sizeUsd,
      quantity: quantity.toNumber(),
      dexSellProceedsUsd: Number(sellQuote.outAmount) / 10 ** USDC_DECIMALS,
      backpackBidVwap: bid.price,
      backpackAskVwap: ask.price,
      backpackTakerFeePct: trade.entryModel?.backpackTakerFeePct ?? 0.05,
      fundingRatePct: Number(book.fundingRate) * 100,
      expectedFundingPeriods: config.expectedFundingPeriods,
      targetExitBasisPct: config.targetExitBasisPct,
      expectedSpotSlippagePct: config.expectedSpotSlippagePct,
      expectedPerpSlippagePct: config.expectedPerpSlippagePct,
      solanaTransactionFeesUsd: config.solanaTransactionFeesUsd,
      priorityFeesUsd: config.priorityFeesUsd,
      partialFillReservePct: config.partialFillReservePct,
      safetyBufferPct: config.safetyBufferPct,
    });
    if (metrics.entryEdgePct < this.policy().minEntryEdgePct) {
      throw new Error("Exact-size hedged entry edge is below the configured threshold");
    }
    return metrics;
  }

  private async executeEntry(trade: JupiterRoundTripTrade) {
    try {
      const inputAmount = new Decimal(trade.sizeUsd).mul(10 ** USDC_DECIMALS).toDecimalPlaces(0).toString();
      const balance = await getSolanaBalanceSnapshot({
        rpcUrl: config.solanaRpcUrl!, owner: config.solanaWalletPublicKey!, tokenMint: USDC_MINT,
        options: { timeoutMs: config.solanaRpcTimeoutMs, maxRetries: 2 },
      });
      const reserveRaw = new Decimal(config.jupiterLiveUsdcReserveUsd).mul(10 ** USDC_DECIMALS).toDecimalPlaces(0).toString();
      if (BigInt(balance.tokenRawAmount) < BigInt(inputAmount) + BigInt(reserveRaw)) {
        throw new Error("Hedged entry would consume the configured USDC reserve");
      }
      if (balance.solLamports < config.jupiterAutoMinSolLamports) throw new Error("Hedged entry has insufficient SOL fee reserve");
      const quote = await getQuote(USDC_MINT, trade.tokenMint, inputAmount, config.jupiterAutoSlippageBps);
      if (quote.inAmount !== inputAmount) throw new Error("Jupiter entry quote changed the exact input amount");
      const exactMetrics = await this.entryPreflight(trade, quote);
      const prepared = await this.prepare(quote);
      const submitted = await this.repository.transitionJupiterRoundTrip({
        tradeId: trade.tradeId, expectedVersion: trade.version, from: "ENTRY_PLANNED", to: "ENTRY_SUBMITTED",
        reason: "Signed Jupiter entry persisted before broadcast", signature: prepared.signature,
        patch: {
          entryEdgePct: exactMetrics.entryEdgePct,
          lastEdgePct: exactMetrics.entryEdgePct,
          entryQuote: quoteSummary(quote), entrySignature: prepared.signature,
          entryRecentBlockhash: prepared.recentBlockhash,
          entryLastValidBlockHeight: prepared.lastValidBlockHeight,
          entrySignedTransactionBase64: prepared.signedTransactionBase64, lastError: null,
        },
      });
      await this.broadcast(submitted, "entry", prepared.signedTransactionBase64, prepared.signature);
    } catch (error) {
      const current = await this.repository.findJupiterRoundTrip(trade.tradeId);
      if (current?.status === "ENTRY_PLANNED") {
        await this.repository.transitionJupiterRoundTrip({
          tradeId: current.tradeId, expectedVersion: current.version, from: "ENTRY_PLANNED", to: "FAILED",
          reason: "Hedged entry preparation failed before broadcast", patch: { lastError: safeError(error) },
        });
      }
      throw error;
    }
  }

  private async reconcileEntry(trade: JupiterRoundTripTrade) {
    if (!trade.entrySignature) return this.toManualIntervention(trade, "Submitted entry has no signature");
    const [tokenOutcome, usdcOutcome] = await Promise.all([
      this.outcome(trade.entrySignature, trade.tokenMint), this.outcome(trade.entrySignature, USDC_MINT),
    ]);
    if (tokenOutcome.state === "NOT_FOUND" && usdcOutcome.state === "NOT_FOUND") {
      if (await this.submittedTransactionExpired(trade, "entry")) {
        await this.repository.transitionJupiterRoundTrip({
          tradeId: trade.tradeId, expectedVersion: trade.version, from: "ENTRY_SUBMITTED", to: "FAILED",
          reason: "Jupiter entry expired without appearing on chain",
          patch: { entrySignedTransactionBase64: null, lastError: "Entry expired without a wallet change" },
        });
      }
      return;
    }
    if (tokenOutcome.state === "FAILED" || usdcOutcome.state === "FAILED") {
      await this.repository.transitionJupiterRoundTrip({
        tradeId: trade.tradeId, expectedVersion: trade.version, from: "ENTRY_SUBMITTED", to: "FAILED",
        reason: "Jupiter entry failed on chain", patch: { lastError: "Entry transaction failed on chain" },
      });
      return;
    }
    const finalized = [tokenOutcome, usdcOutcome].every((row) => row.state === "CONFIRMED" && row.confirmationStatus === "finalized");
    if (!finalized) return;
    const tokenDelta = BigInt(tokenOutcome.tokenDeltaRaw ?? "0");
    const usdcDelta = BigInt(usdcOutcome.tokenDeltaRaw ?? "0");
    if (tokenDelta <= 0n || usdcDelta >= 0n) return this.toManualIntervention(trade, "Finalized entry has unexpected wallet deltas");
    const spentUsd = Number(-usdcDelta) / 10 ** USDC_DECIMALS;
    const tokenQuantity = Number(tokenDelta) / 10 ** trade.tokenDecimals;
    const pending = await this.repository.transitionJupiterRoundTrip({
      tradeId: trade.tradeId, expectedVersion: trade.version, from: "ENTRY_SUBMITTED", to: "HEDGE_PENDING",
      reason: "Jupiter entry finalized; factual spot quantity is ready to hedge", signature: trade.entrySignature,
      patch: {
        entryTokenAmountRaw: tokenDelta.toString(), entrySpentUsd: spentUsd,
        entryPriceUsd: spentUsd / tokenQuantity, entryFeeLamports: tokenOutcome.feeLamports,
        entrySignedTransactionBase64: null, lastError: null,
      },
    });
    if (this.canWrite()) await this.executeEntryHedge(pending);
  }

  private async executeEntryHedge(trade: JupiterRoundTripTrade) {
    if (!trade.entryTokenAmountRaw) return this.toManualIntervention(trade, "Spot fill has no token quantity");
    const spotQuantity = new Decimal(trade.entryTokenAmountRaw).div(new Decimal(10).pow(trade.tokenDecimals)).toString();
    const [account, balances, collateral, market, maxOrder, positions, openOrders] = await Promise.all([
      this.backpack.getAccountSummary(), this.backpack.getBalances(), this.backpack.getCollateral(),
      this.backpack.getMarket(trade.hedgeSymbol), this.backpack.getMaxOrderQuantity(trade.hedgeSymbol, "Ask"),
      this.backpack.getPositions(trade.hedgeSymbol), this.backpack.getOpenOrders(trade.hedgeSymbol),
    ]);
    const preflight = evaluateBackpackPreflight({
      symbol: trade.hedgeSymbol, requestedQuantity: Number(spotQuantity), account, balances, collateral, market,
      maxOrderQuantity: maxOrder.maxOrderQuantity, positions, openOrders,
    });
    if (!preflight.pass) return this.toManualIntervention(trade, `Backpack hedge preflight failed: ${preflight.failures.join(",")}`);
    const book = this.marketData.getMarket(trade.hedgeSymbol, config.backpackMarketMaxAgeMs);
    const sized = boundedHedgeQuantity({
      spotQuantity, stepSize: market.filters.quantity.stepSize,
      minimumQuantity: market.filters.quantity.minQuantity, maximumQuantity: market.filters.quantity.maxQuantity,
      markPriceUsd: book.markPrice, maxUnhedgedUsd: config.jupiterAutoMaxUnhedgedUsd,
    });
    const bestBid = book.bids[0]?.[0];
    if (!bestBid) return this.toManualIntervention(trade, "Backpack hedge book has no bid");
    const limit = buildIocLimitPreview({ side: "Ask", bestPrice: bestBid, tickSize: market.filters.price.tickSize, slippagePct: config.expectedPerpSlippagePct });
    const clientId = backpackClientOrderId(trade.tradeId, "OPEN_HEDGE");
    const submitted = await this.repository.transitionJupiterRoundTrip({
      tradeId: trade.tradeId, expectedVersion: trade.version, from: "HEDGE_PENDING", to: "HEDGE_SUBMITTED",
      reason: "Exact Backpack short command persisted before submission",
      patch: {
        entryHedgeClientOrderId: clientId, entryHedgeQuantity: sized.hedgeQuantity,
        entryHedgeLimitPrice: limit.worstPrice, unhedgedSpotQuantity: sized.unhedgedSpotQuantity, lastError: null,
      },
    });
    try {
      await this.backpack.executeIocLimitOrder({
        clientId, symbol: trade.hedgeSymbol, side: "Ask", quantity: sized.hedgeQuantity,
        price: limit.worstPrice, reduceOnly: false,
      });
      this.status.lastActionAt = new Date().toISOString();
      this.status.lastError = null;
    } catch (error) {
      const message = `Backpack entry hedge outcome is unknown: ${safeError(error)}`;
      await this.repository.recordJupiterRoundTripError({
        tradeId: submitted.tradeId, expectedVersion: submitted.version, status: "HEDGE_SUBMITTED", message,
      });
      throw new Error(message);
    }
  }

  private async readHedge(trade: JupiterRoundTripTrade, leg: "entry" | "exit") {
    const clientOrderId = leg === "entry" ? trade.entryHedgeClientOrderId : trade.exitHedgeClientOrderId;
    if (clientOrderId === null) throw new Error("Persisted Backpack command has no client id");
    const [openOrders, orderHistory, fills] = await Promise.all([
      this.backpack.getOpenOrders(trade.hedgeSymbol),
      this.backpack.getOrderHistory(trade.hedgeSymbol),
      this.backpack.getFillHistory(trade.hedgeSymbol),
    ]);
    return summarizeBackpackExecution({
      clientOrderId, symbol: trade.hedgeSymbol, side: leg === "entry" ? "Ask" : "Bid",
      openOrders, orderHistory, fills,
    });
  }

  private hedgeReconciliationExpired(trade: JupiterRoundTripTrade) {
    return Date.now() - trade.updatedAt.getTime() >= config.canaryConfirmationTimeoutMs;
  }

  private async reconcileEntryHedge(trade: JupiterRoundTripTrade) {
    const summary = await this.readHedge(trade, "entry");
    const expected = new Decimal(trade.entryHedgeQuantity ?? "0");
    const filled = new Decimal(summary.outcome.filledQuantity);
    if (summary.outcome.state === "FILLED" && expected.gt(0) && filled.eq(expected)
      && summary.averagePriceUsd !== null && summary.feeUsd !== null) {
      await this.repository.transitionJupiterRoundTrip({
        tradeId: trade.tradeId, expectedVersion: trade.version, from: "HEDGE_SUBMITTED", to: "OPEN",
        reason: "Jupiter spot and Backpack short are factually confirmed",
        patch: {
          openedAt: new Date(), entryHedgeOrderId: summary.outcome.orderId,
          entryHedgeFilledQuantity: summary.outcome.filledQuantity,
          entryHedgeAveragePriceUsd: summary.averagePriceUsd, entryHedgeFeeUsd: summary.feeUsd, lastError: null,
        },
      });
      return;
    }
    if (["CANCELLED", "PARTIALLY_FILLED"].includes(summary.outcome.state) || this.hedgeReconciliationExpired(trade)) {
      await this.toManualIntervention(trade, `Backpack entry hedge ended ${summary.outcome.state.toLowerCase()} with ${summary.outcome.filledQuantity} filled`, {
        entryHedgeOrderId: summary.outcome.orderId,
        entryHedgeFilledQuantity: summary.outcome.filledQuantity,
        entryHedgeAveragePriceUsd: summary.averagePriceUsd, entryHedgeFeeUsd: summary.feeUsd,
      });
    }
  }

  private async beginExit(trade: JupiterRoundTripTrade, exitReason: JupiterRoundTripExitReason) {
    const pending = await this.repository.transitionJupiterRoundTrip({
      tradeId: trade.tradeId, expectedVersion: trade.version, from: "OPEN", to: "HEDGE_CLOSE_PENDING",
      reason: `Hedged exit triggered by ${exitReason}`, patch: { exitReason, lastError: null },
    });
    await this.executeExitHedge(pending);
  }

  private async executeExitHedge(trade: JupiterRoundTripTrade) {
    const quantity = trade.entryHedgeFilledQuantity;
    if (!quantity) return this.toManualIntervention(trade, "Open trade has no confirmed short quantity");
    const [account, collateral, market, maxOrder, positions, openOrders] = await Promise.all([
      this.backpack.getAccountSummary(), this.backpack.getCollateral(), this.backpack.getMarket(trade.hedgeSymbol),
      this.backpack.getMaxOrderQuantity(trade.hedgeSymbol, "Bid"), this.backpack.getPositions(trade.hedgeSymbol),
      this.backpack.getOpenOrders(trade.hedgeSymbol),
    ]);
    const preflight = evaluateRecoveryPreflight({
      action: "CLOSE_HEDGE", symbol: trade.hedgeSymbol, quantity, account, collateral, market,
      maxOrderQuantity: maxOrder.maxOrderQuantity, positions, openOrders,
    });
    if (!preflight.pass) return this.toManualIntervention(trade, `Backpack close preflight failed: ${preflight.failures.join(",")}`);
    const book = this.marketData.getMarket(trade.hedgeSymbol, config.backpackMarketMaxAgeMs);
    const bestAsk = book.asks[0]?.[0];
    if (!bestAsk) return this.toManualIntervention(trade, "Backpack hedge book has no ask");
    const limit = buildIocLimitPreview({ side: "Bid", bestPrice: bestAsk, tickSize: market.filters.price.tickSize, slippagePct: config.expectedPerpSlippagePct });
    const clientId = backpackClientOrderId(trade.tradeId, "CLOSE_HEDGE");
    const submitted = await this.repository.transitionJupiterRoundTrip({
      tradeId: trade.tradeId, expectedVersion: trade.version, from: "HEDGE_CLOSE_PENDING", to: "HEDGE_CLOSE_SUBMITTED",
      reason: "Exact Backpack reduce-only command persisted before submission",
      patch: {
        exitHedgeClientOrderId: clientId, exitHedgeQuantity: quantity,
        exitHedgeLimitPrice: limit.worstPrice, lastError: null,
      },
    });
    try {
      await this.backpack.executeIocLimitOrder({
        clientId, symbol: trade.hedgeSymbol, side: "Bid", quantity, price: limit.worstPrice, reduceOnly: true,
      });
      this.status.lastActionAt = new Date().toISOString();
      this.status.lastError = null;
    } catch (error) {
      const message = `Backpack hedge close outcome is unknown: ${safeError(error)}`;
      await this.repository.recordJupiterRoundTripError({
        tradeId: submitted.tradeId, expectedVersion: submitted.version, status: "HEDGE_CLOSE_SUBMITTED", message,
      });
      throw new Error(message);
    }
  }

  private async reconcileExitHedge(trade: JupiterRoundTripTrade) {
    const summary = await this.readHedge(trade, "exit");
    const expected = new Decimal(trade.exitHedgeQuantity ?? "0");
    const filled = new Decimal(summary.outcome.filledQuantity);
    if (summary.outcome.state === "FILLED" && expected.gt(0) && filled.eq(expected)
      && summary.averagePriceUsd !== null && summary.feeUsd !== null) {
      const planned = await this.repository.transitionJupiterRoundTrip({
        tradeId: trade.tradeId, expectedVersion: trade.version, from: "HEDGE_CLOSE_SUBMITTED", to: "EXIT_PLANNED",
        reason: "Backpack short is factually closed; spot exit may proceed",
        patch: {
          exitHedgeOrderId: summary.outcome.orderId,
          exitHedgeFilledQuantity: summary.outcome.filledQuantity,
          exitHedgeAveragePriceUsd: summary.averagePriceUsd, exitHedgeFeeUsd: summary.feeUsd, lastError: null,
        },
      });
      if (this.canWrite()) await this.executeExit(planned);
      return;
    }
    if (["CANCELLED", "PARTIALLY_FILLED"].includes(summary.outcome.state) || this.hedgeReconciliationExpired(trade)) {
      await this.toManualIntervention(trade, `Backpack hedge close ended ${summary.outcome.state.toLowerCase()} with ${summary.outcome.filledQuantity} filled`, {
        exitHedgeOrderId: summary.outcome.orderId,
        exitHedgeFilledQuantity: summary.outcome.filledQuantity,
        exitHedgeAveragePriceUsd: summary.averagePriceUsd, exitHedgeFeeUsd: summary.feeUsd,
      });
    }
  }

  private async executeExit(trade: JupiterRoundTripTrade) {
    if (!trade.entryTokenAmountRaw) return this.toManualIntervention(trade, "Exit has no factual spot quantity");
    if (trade.exitAttempts >= config.jupiterAutoMaxExitAttempts) return this.toManualIntervention(trade, "Automatic Jupiter exit attempt limit reached");
    try {
      const balance = await getSolanaBalanceSnapshot({
        rpcUrl: config.solanaRpcUrl!, owner: config.solanaWalletPublicKey!, tokenMint: trade.tokenMint,
        options: { timeoutMs: config.solanaRpcTimeoutMs, maxRetries: 2 },
      });
      if (BigInt(balance.tokenRawAmount) < BigInt(trade.entryTokenAmountRaw)) throw new Error("Wallet token balance is below the confirmed spot position");
      if (balance.solLamports < config.jupiterAutoMinSolLamports) throw new Error("Spot exit has insufficient SOL fee reserve");
      const quote = await getQuote(trade.tokenMint, USDC_MINT, trade.entryTokenAmountRaw, config.jupiterAutoSlippageBps);
      if (quote.inAmount !== trade.entryTokenAmountRaw) throw new Error("Jupiter exit changed the exact input amount");
      const prepared = await this.prepare(quote);
      const submitted = await this.repository.transitionJupiterRoundTrip({
        tradeId: trade.tradeId, expectedVersion: trade.version, from: "EXIT_PLANNED", to: "EXIT_SUBMITTED",
        reason: "Signed Jupiter exit persisted after confirmed hedge close", signature: prepared.signature,
        patch: {
          exitAttempts: trade.exitAttempts + 1, exitQuote: quoteSummary(quote), exitSignature: prepared.signature,
          exitRecentBlockhash: prepared.recentBlockhash, exitLastValidBlockHeight: prepared.lastValidBlockHeight,
          exitSignedTransactionBase64: prepared.signedTransactionBase64, lastError: null,
        },
      });
      await this.broadcast(submitted, "exit", prepared.signedTransactionBase64, prepared.signature);
    } catch (error) {
      const current = await this.repository.findJupiterRoundTrip(trade.tradeId);
      if (current?.status === "EXIT_PLANNED") {
        await this.repository.recordJupiterRoundTripError({
          tradeId: current.tradeId, expectedVersion: current.version, status: "EXIT_PLANNED", message: safeError(error),
        });
      }
      throw error;
    }
  }

  private async reconcileExit(trade: JupiterRoundTripTrade) {
    if (!trade.exitSignature || !trade.entryTokenAmountRaw || trade.entrySpentUsd === null) {
      return this.toManualIntervention(trade, "Submitted spot exit lacks reconciliation data");
    }
    const [tokenOutcome, usdcOutcome] = await Promise.all([
      this.outcome(trade.exitSignature, trade.tokenMint), this.outcome(trade.exitSignature, USDC_MINT),
    ]);
    if (tokenOutcome.state === "NOT_FOUND" && usdcOutcome.state === "NOT_FOUND") {
      if (await this.submittedTransactionExpired(trade, "exit")) {
        await this.repository.transitionJupiterRoundTrip({
          tradeId: trade.tradeId, expectedVersion: trade.version, from: "EXIT_SUBMITTED", to: "EXIT_PLANNED",
          reason: "Jupiter exit expired without appearing on chain",
          patch: {
            exitQuote: null, exitSignature: null, exitRecentBlockhash: null, exitLastValidBlockHeight: null,
            exitSignedTransactionBase64: null, lastError: "Spot exit expired and is safe to prepare again",
          },
        });
      }
      return;
    }
    if (tokenOutcome.state === "FAILED" || usdcOutcome.state === "FAILED") {
      await this.repository.transitionJupiterRoundTrip({
        tradeId: trade.tradeId, expectedVersion: trade.version, from: "EXIT_SUBMITTED", to: "EXIT_PLANNED",
        reason: "Jupiter exit failed on chain",
        patch: {
          exitQuote: null, exitSignature: null, exitRecentBlockhash: null, exitLastValidBlockHeight: null,
          exitSignedTransactionBase64: null, lastError: "Spot exit failed on chain and is safe to prepare again",
        },
      });
      return;
    }
    const finalized = [tokenOutcome, usdcOutcome].every((row) => row.state === "CONFIRMED" && row.confirmationStatus === "finalized");
    if (!finalized) return;
    const tokenDelta = BigInt(tokenOutcome.tokenDeltaRaw ?? "0");
    const usdcDelta = BigInt(usdcOutcome.tokenDeltaRaw ?? "0");
    if (tokenDelta !== -BigInt(trade.entryTokenAmountRaw) || usdcDelta <= 0n) {
      return this.toManualIntervention(trade, "Finalized spot exit has unexpected wallet deltas");
    }
    if (!trade.entryHedgeFilledQuantity || trade.entryHedgeAveragePriceUsd === null
      || trade.exitHedgeAveragePriceUsd === null || trade.entryHedgeFeeUsd === null
      || trade.exitHedgeFeeUsd === null) {
      return this.toManualIntervention(trade, "Hedged PnL inputs are incomplete");
    }
    const proceeds = Number(usdcDelta) / 10 ** USDC_DECIMALS;
    const pnl = calculateHedgedRealizedPnl({
      spotSpentUsd: trade.entrySpentUsd, spotReceivedUsd: proceeds,
      hedgeQuantity: trade.entryHedgeFilledQuantity,
      entryHedgePriceUsd: trade.entryHedgeAveragePriceUsd,
      exitHedgePriceUsd: trade.exitHedgeAveragePriceUsd,
      entryHedgeFeeUsd: trade.entryHedgeFeeUsd, exitHedgeFeeUsd: trade.exitHedgeFeeUsd,
    });
    const tokenQuantity = Number(trade.entryTokenAmountRaw) / 10 ** trade.tokenDecimals;
    await this.repository.transitionJupiterRoundTrip({
      tradeId: trade.tradeId, expectedVersion: trade.version, from: "EXIT_SUBMITTED", to: "CLOSED",
      reason: "Both hedged legs are factually closed", signature: trade.exitSignature,
      patch: {
        closedAt: new Date(), exitReceivedUsd: proceeds, exitPriceUsd: proceeds / tokenQuantity,
        exitFeeLamports: tokenOutcome.feeLamports, ...pnl, exitSignedTransactionBase64: null, lastError: null,
      },
    });
  }

  private async prepare(quote: JupiterQuote) {
    const transaction = await buildJupiterSwapTransaction({
      quote, userPublicKey: config.solanaWalletPublicKey!, apiKey: config.jupiterApiKey,
      maxPriorityFeeLamports: config.jupiterMaxPriorityFeeLamports,
      options: { timeoutMs: config.jupiterRequestTimeoutMs, maxRetries: config.jupiterMaxRetries },
    });
    if (transaction.simulationError !== null) throw new Error("Jupiter transaction build simulation failed");
    const signed = await signJupiterTransaction({
      transactionBase64: transaction.swapTransaction, credentialsPath: config.solanaSignerCredentialsFile!,
      passphrase: config.solanaSignerPassphrase!, expectedPublicKey: config.solanaWalletPublicKey!,
    });
    const simulation = await simulateSolanaTransaction({
      rpcUrl: config.solanaRpcUrl!, transactionBase64: signed.signedTransactionBase64,
      options: { timeoutMs: config.solanaRpcTimeoutMs, maxRetries: 2 }, sigVerify: true, replaceRecentBlockhash: false,
    });
    if (simulation.err !== null) throw new Error("Signed Jupiter transaction simulation failed");
    return { ...signed, lastValidBlockHeight: transaction.lastValidBlockHeight };
  }

  private async broadcast(trade: JupiterRoundTripTrade, leg: "entry" | "exit", transactionBase64: string, expectedSignature: string) {
    try {
      const returned = await sendSolanaTransactionOnce({
        rpcUrl: config.solanaRpcUrl!, transactionBase64, maxRpcRetries: config.solanaSendMaxRetries,
        options: { timeoutMs: config.solanaRpcTimeoutMs },
      });
      if (returned !== expectedSignature) throw new Error("RPC returned a different Solana signature");
      this.status.lastActionAt = new Date().toISOString();
      this.status.lastError = null;
    } catch (error) {
      const message = `${leg} broadcast outcome is unknown: ${safeError(error)}`;
      await this.repository.recordJupiterRoundTripError({
        tradeId: trade.tradeId, expectedVersion: trade.version, status: trade.status, message,
      });
      throw new Error(message);
    }
  }

  private outcome(signature: string, tokenMint: string) {
    return getSolanaTransactionOutcome({
      rpcUrl: config.solanaRpcUrl!, signature, owner: config.solanaWalletPublicKey!, tokenMint,
      options: { timeoutMs: config.solanaRpcTimeoutMs, maxRetries: 2 },
    });
  }

  private async submittedTransactionExpired(trade: JupiterRoundTripTrade, leg: "entry" | "exit") {
    const persistedBlockhash = leg === "entry" ? trade.entryRecentBlockhash : trade.exitRecentBlockhash;
    const signedTransaction = leg === "entry" ? trade.entrySignedTransactionBase64 : trade.exitSignedTransactionBase64;
    const blockhash = persistedBlockhash ?? (signedTransaction ? solanaTransactionRecentBlockhash(signedTransaction) : null);
    if (!blockhash) {
      await this.toManualIntervention(trade, `Submitted Jupiter ${leg} has no blockhash for reconciliation`);
      return false;
    }
    return !await isSolanaBlockhashValid({
      rpcUrl: config.solanaRpcUrl!, blockhash,
      options: { timeoutMs: config.solanaRpcTimeoutMs, maxRetries: 2 },
    });
  }

  private async toManualIntervention(
    trade: JupiterRoundTripTrade,
    message: string,
    patch: Partial<JupiterRoundTripTrade> = {},
  ) {
    if (["CLOSED", "FAILED", "MANUAL_INTERVENTION"].includes(trade.status)) return;
    await this.repository.transitionJupiterRoundTrip({
      tradeId: trade.tradeId, expectedVersion: trade.version, from: trade.status, to: "MANUAL_INTERVENTION",
      reason: message, patch: { ...patch, lastError: message.slice(0, 500) },
    });
  }
}
