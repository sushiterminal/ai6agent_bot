import { Decimal } from "decimal.js";
import type { BackpackClient } from "./backpack.js";
import { evaluateBackpackPreflight } from "./backpack-preflight.js";
import type { BackpackMarketData } from "./backpack-market-data.js";
import type { CanaryWriteAdapter } from "./canary-write-adapter.js";
import { evaluateCanaryRisk } from "./canary-risk.js";
import type { SpreadCollector } from "./collector.js";
import { config } from "./config.js";
import { confirmSubmittedHedge, confirmSubmittedSpot } from "./entry-confirmation.js";
import type { JupiterQuote } from "./jupiter.js";
import { pairBySymbol, USDC_MINT } from "./pairs.js";
import type { SampleRepository } from "./repository.js";
import {
  buildJupiterSwapTransaction,
  getSolanaBalanceSnapshot,
  getSolanaTransactionOutcome,
  simulateSolanaTransaction,
} from "./solana-simulation.js";
import { signJupiterTransaction } from "./solana-signer.js";
import { executeApprovedSpot, executeConfirmedHedge } from "./supervised-entry.js";
import { reconcileBackpackOrder } from "./trade-reconciliation.js";
import type { TradeIntent } from "./trade-intents.js";
import { CANARY_SIZE } from "./types.js";
import { recoverUncertainIntent } from "./uncertain-recovery.js";
import {
  buildRecoveryPreview,
  expectedRecoveryApprovalText,
  fingerprintRecoveryPreview,
} from "./recovery-preview.js";
import { submitApprovedRecoveryOrder } from "./recovery-execution.js";
import { evaluateRecoveryPreflight } from "./recovery-preflight.js";
import { confirmRecoveryOrder, reconcileRecoveryOrder } from "./recovery-confirmation.js";

interface EntryRuntimeDependencies {
  settings?: typeof config;
  repository: SampleRepository;
  backpack: BackpackClient;
  marketData: BackpackMarketData;
  collector: SpreadCollector;
  writes: CanaryWriteAdapter;
}

export class EntryRuntime {
  private readonly settings: typeof config;

  constructor(private readonly dependencies: EntryRuntimeDependencies) {
    this.settings = dependencies.settings ?? config;
  }

  async executeSpot(intent: TradeIntent, approval: string) {
    const pair = this.pair(intent);
    const settings = this.settings;
    if (
      !settings.solanaRpcUrl
      || !settings.solanaWalletPublicKey
      || !settings.solanaSignerCredentialsFile
      || !settings.solanaSignerPassphrase
    ) {
      throw new Error("Canary Solana execution is not configured");
    }
    return executeApprovedSpot({
      intent,
      approval,
      gate: {
        killSwitch: settings.canaryKillSwitch,
        executionEnabled: settings.canaryExecutionEnabled,
      },
      store: this.dependencies.repository,
      preflight: async () => {
        if (!intent.preview) throw new Error("Approved intent has no preview");
        const [sample, balance, account, cashBalances, collateral, market, maxOrder, positions, openOrders, riskState] =
          await Promise.all([
            this.dependencies.collector.runDryRunProbe(pair, CANARY_SIZE),
            getSolanaBalanceSnapshot({
              rpcUrl: settings.solanaRpcUrl!,
              owner: settings.solanaWalletPublicKey!,
              tokenMint: USDC_MINT,
              options: { timeoutMs: settings.solanaRpcTimeoutMs, maxRetries: 2 },
            }),
            this.dependencies.backpack.getAccountSummary(),
            this.dependencies.backpack.getBalances(),
            this.dependencies.backpack.getCollateral(),
            this.dependencies.backpack.getMarket(pair.perpSymbol),
            this.dependencies.backpack.getMaxOrderQuantity(pair.perpSymbol, "Ask"),
            this.dependencies.backpack.getPositions(pair.perpSymbol),
            this.dependencies.backpack.getOpenOrders(pair.perpSymbol),
            this.dependencies.repository.canaryRiskState(new Date(), intent.tradeId),
          ]);
        const preflight = evaluateBackpackPreflight({
          symbol: pair.perpSymbol,
          requestedQuantity: Number(intent.preview.spot.outAmount) / 10 ** pair.tokenDecimals,
          account,
          balances: cashBalances,
          collateral,
          market,
          maxOrderQuantity: maxOrder.maxOrderQuantity,
          positions,
          openOrders,
        });
        if (!preflight.pass) {
          throw new Error(`Fresh Backpack preflight failed: ${preflight.failures.join(",")}`);
        }
        const book = this.dependencies.marketData.getMarket(
          pair.perpSymbol,
          settings.backpackMarketMaxAgeMs,
        );
        const bestBid = book.bids[0]?.[0];
        if (!bestBid || new Decimal(bestBid).lt(intent.preview.hedge.worstPrice)) {
          throw new Error("Fresh Backpack bid is below the approved worst price");
        }
        const risk = evaluateCanaryRisk({
          killSwitch: settings.canaryKillSwitch,
          maxLossPerTradeUsd: settings.canaryMaxLossPerTradeUsd,
          maxDailyLossUsd: settings.canaryMaxDailyLossUsd,
          maxDailyAttempts: settings.canaryMaxDailyAttempts,
          maxOpenPositions: settings.canaryMaxOpenPositions,
          minExpectedPnlUsd: settings.canaryMinExpectedPnlUsd,
          minEntryEdgePct: settings.canaryMinEntryEdgePct,
          allowedPairs: settings.canaryAllowedPairs,
        }, {
          pair: pair.symbol,
          sizeUsd: CANARY_SIZE,
          worstCaseLossUsd: Math.max(0, -sample.immediateLiquidationPnlUsd),
          expectedPnlUsd: sample.estimatedConvergencePnlUsd,
          entryEdgePct: sample.entryEdgePct,
          ...riskState,
        });
        const failures = [
          ...risk.failures,
          ...(balance.tokenUiAmount < CANARY_SIZE ? ["spotBalance"] : []),
        ];
        if (failures.length > 0) {
          throw new Error(`Fresh canary risk failed: ${failures.join(",")}`);
        }
      },
      prepare: async () => {
        if (!intent.preview) throw new Error("Approved intent has no preview");
        const raw = intent.preview.spot.quoteResponse;
        if (
          raw.inputMint !== intent.preview.spot.inputMint
          || raw.outputMint !== intent.preview.spot.outputMint
          || raw.inAmount !== intent.preview.spot.inAmount
          || raw.outAmount !== intent.preview.spot.outAmount
          || raw.otherAmountThreshold !== intent.preview.spot.minimumOutAmount
        ) {
          throw new Error("Stored Jupiter quote does not match approved preview");
        }
        const quote: JupiterQuote = {
          inAmount: intent.preview.spot.inAmount,
          outAmount: intent.preview.spot.outAmount,
          priceImpactPct: intent.preview.spot.priceImpactPct,
          routePlan: intent.preview.spot.route.map((label) => ({ swapInfo: { label } })),
          quoteResponse: raw,
        };
        const transaction = await buildJupiterSwapTransaction({
          quote,
          userPublicKey: settings.solanaWalletPublicKey!,
          apiKey: settings.jupiterApiKey,
          maxPriorityFeeLamports: settings.jupiterMaxPriorityFeeLamports,
          options: {
            timeoutMs: settings.jupiterRequestTimeoutMs,
            maxRetries: settings.jupiterMaxRetries,
          },
        });
        if (transaction.simulationError !== null) {
          throw new Error("Jupiter rejected the approved quote during transaction build");
        }
        const signed = await signJupiterTransaction({
          transactionBase64: transaction.swapTransaction,
          credentialsPath: settings.solanaSignerCredentialsFile!,
          passphrase: settings.solanaSignerPassphrase!,
          expectedPublicKey: settings.solanaWalletPublicKey!,
        });
        const simulation = await simulateSolanaTransaction({
          rpcUrl: settings.solanaRpcUrl!,
          transactionBase64: signed.signedTransactionBase64,
          options: { timeoutMs: settings.solanaRpcTimeoutMs, maxRetries: 2 },
          sigVerify: true,
          replaceRecentBlockhash: false,
        });
        if (simulation.err !== null) throw new Error("Signed Solana transaction simulation failed");
        return signed;
      },
      send: (signedTransactionBase64) => this.dependencies.writes.sendSpot({
        tradeId: intent.tradeId,
        approval,
        rpcUrl: settings.solanaRpcUrl!,
        transactionBase64: signedTransactionBase64,
        timeoutMs: settings.solanaRpcTimeoutMs,
      }),
    });
  }

  async executeHedge(intent: TradeIntent, approval: string) {
    const pair = this.pair(intent);
    const settings = this.settings;
    let command: { quantity: string; worstPrice: string } | null = null;
    return executeConfirmedHedge({
      intent,
      approval,
      gate: {
        killSwitch: settings.canaryKillSwitch,
        executionEnabled: settings.canaryExecutionEnabled,
      },
      store: this.dependencies.repository,
      preflight: async () => {
        if (!intent.preview || !intent.spotFilledQuantity) {
          throw new Error("Confirmed intent is missing preview or spot fill");
        }
        const [account, balances, collateral, market, maxOrder, positions, openOrders] =
          await Promise.all([
            this.dependencies.backpack.getAccountSummary(),
            this.dependencies.backpack.getBalances(),
            this.dependencies.backpack.getCollateral(),
            this.dependencies.backpack.getMarket(pair.perpSymbol),
            this.dependencies.backpack.getMaxOrderQuantity(pair.perpSymbol, "Ask"),
            this.dependencies.backpack.getPositions(pair.perpSymbol),
            this.dependencies.backpack.getOpenOrders(pair.perpSymbol),
          ]);
        const preflight = evaluateBackpackPreflight({
          symbol: pair.perpSymbol,
          requestedQuantity: Number(intent.spotFilledQuantity),
          account,
          balances,
          collateral,
          market,
          maxOrderQuantity: maxOrder.maxOrderQuantity,
          positions,
          openOrders,
        });
        if (!preflight.pass) {
          throw new Error(`Fresh Backpack hedge preflight failed: ${preflight.failures.join(",")}`);
        }
        const book = this.dependencies.marketData.getMarket(
          pair.perpSymbol,
          settings.backpackMarketMaxAgeMs,
        );
        const bestBid = book.bids[0]?.[0];
        if (!bestBid || new Decimal(bestBid).lt(intent.preview.hedge.worstPrice)) {
          throw new Error("Fresh Backpack bid is below the approved hedge price");
        }
        const priceInTicks = new Decimal(intent.preview.hedge.worstPrice)
          .div(market.filters.price.tickSize);
        if (!priceInTicks.isInteger()) {
          throw new Error("Approved hedge price no longer matches the market tick size");
        }
        command = {
          quantity: preflight.quantity.order,
          worstPrice: intent.preview.hedge.worstPrice,
        };
      },
      send: async (clientOrderId) => {
        if (!command) throw new Error("Hedge command was not prepared");
        const order = await this.dependencies.writes.submitHedge({
          tradeId: intent.tradeId,
          approval,
          clientId: clientOrderId,
          symbol: pair.perpSymbol,
          quantity: command.quantity,
          worstPrice: command.worstPrice,
        });
        return { orderId: order.id ?? null };
      },
    });
  }

  async confirmSpot(intent: TradeIntent) {
    const pair = this.pair(intent);
    const settings = this.settings;
    if (!settings.solanaRpcUrl || !settings.solanaWalletPublicKey || !intent.solanaSignature) {
      throw new Error("Intent has no reconcilable Solana signature");
    }
    return confirmSubmittedSpot({
      intent,
      tokenDecimals: pair.tokenDecimals,
      store: this.dependencies.repository,
      read: () => getSolanaTransactionOutcome({
        rpcUrl: settings.solanaRpcUrl!,
        signature: intent.solanaSignature!,
        owner: settings.solanaWalletPublicKey!,
        tokenMint: pair.tokenMint,
        options: { timeoutMs: settings.solanaRpcTimeoutMs, maxRetries: 2 },
      }),
      options: {
        timeoutMs: settings.canaryConfirmationTimeoutMs,
        pollIntervalMs: settings.canaryConfirmationPollMs,
      },
    });
  }

  async confirmHedge(intent: TradeIntent) {
    const pair = this.pair(intent);
    const settings = this.settings;
    if (intent.backpackClientOrderId === null) {
      throw new Error("Intent has no Backpack client order id");
    }
    return confirmSubmittedHedge({
      intent,
      store: this.dependencies.repository,
      read: async () => {
        const [openOrders, orderHistory, fills] = await Promise.all([
          this.dependencies.backpack.getOpenOrders(pair.perpSymbol),
          this.dependencies.backpack.getOrderHistory(pair.perpSymbol),
          this.dependencies.backpack.getFillHistory(pair.perpSymbol),
        ]);
        return reconcileBackpackOrder({
          clientOrderId: intent.backpackClientOrderId!,
          openOrders,
          orderHistory,
          fills,
        });
      },
      options: {
        timeoutMs: settings.canaryConfirmationTimeoutMs,
        pollIntervalMs: settings.canaryConfirmationPollMs,
      },
    });
  }

  async markSpotOnly(intent: TradeIntent, error: Error) {
    return this.dependencies.repository.transitionTradeIntent({
      tradeId: intent.tradeId,
      expectedVersion: intent.version,
      from: "SPOT_CONFIRMED",
      to: "SPOT_ONLY",
      reason: "Hedge could not be safely prepared after confirmed spot fill",
      patch: { lastError: error.message.slice(0, 500) },
    });
  }

  async finalizeHedged(intent: TradeIntent) {
    return this.dependencies.repository.transitionTradeIntent({
      tradeId: intent.tradeId,
      expectedVersion: intent.version,
      from: "HEDGED",
      to: "OPEN",
      reason: "Both entry legs confirmed",
    });
  }

  async recoverUncertain(intent: TradeIntent) {
    const pair = this.pair(intent);
    const settings = this.settings;
    if (intent.recoveryClientOrderId !== null) {
      const outcome = await this.readRecoveryOrder(intent, pair.perpSymbol);
      const result = await reconcileRecoveryOrder({
        intent,
        store: this.dependencies.repository,
        outcome,
        readExposure: () => this.readRecoveryExposure(intent),
      });
      return { ...result, leg: "RECOVERY" as const };
    }
    const result = await recoverUncertainIntent({
      intent,
      tokenDecimals: pair.tokenDecimals,
      store: this.dependencies.repository,
      readSpot: () => {
        if (!settings.solanaRpcUrl || !settings.solanaWalletPublicKey || !intent.solanaSignature) {
          throw new Error("Uncertain spot reconciliation is not configured");
        }
        return getSolanaTransactionOutcome({
          rpcUrl: settings.solanaRpcUrl,
          signature: intent.solanaSignature,
          owner: settings.solanaWalletPublicKey,
          tokenMint: pair.tokenMint,
          options: { timeoutMs: settings.solanaRpcTimeoutMs, maxRetries: 2 },
        });
      },
      readHedge: async () => {
        if (intent.backpackClientOrderId === null) {
          throw new Error("Uncertain hedge has no Backpack client order id");
        }
        const [openOrders, orderHistory, fills] = await Promise.all([
          this.dependencies.backpack.getOpenOrders(pair.perpSymbol),
          this.dependencies.backpack.getOrderHistory(pair.perpSymbol),
          this.dependencies.backpack.getFillHistory(pair.perpSymbol),
        ]);
        return reconcileBackpackOrder({
          clientOrderId: intent.backpackClientOrderId,
          openOrders,
          orderHistory,
          fills,
        });
      },
    });
    if (result.intent.status !== "HEDGED") return result;
    return { ...result, intent: await this.finalizeHedged(result.intent) };
  }

  async createRecoveryPreview(intent: TradeIntent) {
    const pair = this.pair(intent);
    const settings = this.settings;
    if (!settings.solanaRpcUrl || !settings.solanaWalletPublicKey) {
      throw new Error("Recovery exposure reconciliation is not configured");
    }
    const [balance, positions, market] = await Promise.all([
      getSolanaBalanceSnapshot({
        rpcUrl: settings.solanaRpcUrl,
        owner: settings.solanaWalletPublicKey,
        tokenMint: pair.tokenMint,
        options: { timeoutMs: settings.solanaRpcTimeoutMs, maxRetries: 2 },
      }),
      this.dependencies.backpack.getPositions(pair.perpSymbol),
      this.dependencies.backpack.getMarket(pair.perpSymbol),
    ]);
    const book = this.dependencies.marketData.getMarket(
      pair.perpSymbol,
      settings.backpackMarketMaxAgeMs,
    );
    const bestBid = book.bids[0]?.[0];
    const bestAsk = book.asks[0]?.[0];
    if (!bestBid || !bestAsk) throw new Error("Backpack order book has no recovery price bounds");
    const spotQuantity = new Decimal(balance.tokenRawAmount)
      .div(new Decimal(10).pow(balance.tokenDecimals));
    const perpNetQuantity = positions.reduce(
      (total, position) => total.plus(new Decimal(position.netQuantity)),
      new Decimal(0),
    );
    const preview = buildRecoveryPreview({
      tradeId: intent.tradeId,
      pair: intent.pair,
      sourceStatus: intent.status,
      spotQuantity: spotQuantity.toString(),
      perpNetQuantity: perpNetQuantity.toString(),
      ttlMs: settings.canaryPreviewTtlMs,
      market: {
        bestBid,
        bestAsk,
        tickSize: market.filters.price.tickSize,
        quantityStep: market.filters.quantity.stepSize,
        minimumQuantity: market.filters.quantity.minQuantity,
        maximumQuantity: market.filters.quantity.maxQuantity,
        slippagePct: settings.expectedPerpSlippagePct,
      },
    });
    const fingerprint = fingerprintRecoveryPreview(preview);
    const updated = await this.dependencies.repository.saveTradeIntentRecoveryPreview({
      tradeId: intent.tradeId,
      expectedVersion: intent.version,
      sourceStatus: intent.status,
      preview,
      fingerprint,
    });
    return {
      intent: updated,
      preview,
      fingerprint,
      approvalText: preview.executable
        ? expectedRecoveryApprovalText(intent.tradeId, fingerprint)
        : null,
    };
  }

  async executeRecoveryOrder(input: {
    intent: TradeIntent;
    recoveryApproval: string;
    executionApproval: string;
  }) {
    const { intent } = input;
    const pair = this.pair(intent);
    const settings = this.settings;
    let command: {
      quantity: string;
      worstPrice: string;
      reduceOnly: boolean;
    } | null = null;
    return submitApprovedRecoveryOrder({
      intent,
      recoveryApproval: input.recoveryApproval,
      executionApproval: input.executionApproval,
      gate: {
        killSwitch: settings.canaryKillSwitch,
        executionEnabled: settings.canaryExecutionEnabled,
      },
      store: this.dependencies.repository,
      preflight: async () => {
        const preview = intent.recoveryPreview;
        if (!preview?.order || !settings.solanaRpcUrl || !settings.solanaWalletPublicKey) {
          throw new Error("Recovery order has no executable price bound or exposure configuration");
        }
        const side = preview.action === "CLOSE_HEDGE" ? "Bid" : "Ask";
        const [balance, account, collateral, market, maxOrder, positions, openOrders] =
          await Promise.all([
            getSolanaBalanceSnapshot({
              rpcUrl: settings.solanaRpcUrl,
              owner: settings.solanaWalletPublicKey,
              tokenMint: pair.tokenMint,
              options: { timeoutMs: settings.solanaRpcTimeoutMs, maxRetries: 2 },
            }),
            this.dependencies.backpack.getAccountSummary(),
            this.dependencies.backpack.getCollateral(),
            this.dependencies.backpack.getMarket(pair.perpSymbol),
            this.dependencies.backpack.getMaxOrderQuantity(pair.perpSymbol, side),
            this.dependencies.backpack.getPositions(pair.perpSymbol),
            this.dependencies.backpack.getOpenOrders(pair.perpSymbol),
          ]);
        const spot = new Decimal(balance.tokenRawAmount)
          .div(new Decimal(10).pow(balance.tokenDecimals));
        const net = positions.reduce(
          (total, position) => total.plus(new Decimal(position.netQuantity)),
          new Decimal(0),
        );
        if (
          !spot.eq(preview.exposure.spotQuantity)
          || !net.eq(preview.exposure.perpNetQuantity)
        ) {
          throw new Error("Factual exposure changed after recovery preview");
        }
        if (
          market.filters.price.tickSize !== preview.order.tickSize
          || market.filters.quantity.stepSize === "0"
        ) {
          throw new Error("Backpack recovery market filters changed or are invalid");
        }
        const preflight = evaluateRecoveryPreflight({
          action: preview.action,
          symbol: pair.perpSymbol,
          quantity: preview.quantity,
          account,
          collateral,
          market,
          maxOrderQuantity: maxOrder.maxOrderQuantity,
          positions,
          openOrders,
        });
        if (!preflight.pass) {
          throw new Error(`Fresh recovery preflight failed: ${preflight.failures.join(",")}`);
        }
        const book = this.dependencies.marketData.getMarket(
          pair.perpSymbol,
          settings.backpackMarketMaxAgeMs,
        );
        const freshPrice = side === "Ask" ? book.bids[0]?.[0] : book.asks[0]?.[0];
        if (!freshPrice) throw new Error("Backpack order book has no recovery execution price");
        const outsideBound = side === "Ask"
          ? new Decimal(freshPrice).lt(preview.order.worstPrice)
          : new Decimal(freshPrice).gt(preview.order.worstPrice);
        if (outsideBound) throw new Error("Fresh Backpack price is outside the approved recovery bound");
        command = {
          quantity: preview.quantity,
          worstPrice: preview.order.worstPrice,
          reduceOnly: preview.action === "CLOSE_HEDGE",
        };
      },
      send: async (clientOrderId) => {
        if (!command) throw new Error("Recovery command was not prepared");
        const order = await this.dependencies.writes.submitHedge({
          tradeId: intent.tradeId,
          approval: input.executionApproval,
          clientId: clientOrderId,
          symbol: pair.perpSymbol,
          quantity: command.quantity,
          worstPrice: command.worstPrice,
          reduceOnly: command.reduceOnly,
        });
        return { orderId: order.id ?? null };
      },
    });
  }

  async confirmRecovery(intent: TradeIntent) {
    const pair = this.pair(intent);
    return confirmRecoveryOrder({
      intent,
      store: this.dependencies.repository,
      read: () => this.readRecoveryOrder(intent, pair.perpSymbol),
      readExposure: () => this.readRecoveryExposure(intent),
      timeoutMs: this.settings.canaryConfirmationTimeoutMs,
      pollIntervalMs: this.settings.canaryConfirmationPollMs,
    });
  }

  private async readRecoveryOrder(intent: TradeIntent, symbol: string) {
    if (intent.recoveryClientOrderId === null) {
      throw new Error("Intent has no recovery client order id");
    }
    const [openOrders, orderHistory, fills] = await Promise.all([
      this.dependencies.backpack.getOpenOrders(symbol),
      this.dependencies.backpack.getOrderHistory(symbol),
      this.dependencies.backpack.getFillHistory(symbol),
    ]);
    return reconcileBackpackOrder({
      clientOrderId: intent.recoveryClientOrderId,
      openOrders,
      orderHistory,
      fills,
    });
  }

  private async readRecoveryExposure(intent: TradeIntent) {
    const pair = this.pair(intent);
    const settings = this.settings;
    if (!settings.solanaRpcUrl || !settings.solanaWalletPublicKey) {
      throw new Error("Recovery exposure reconciliation is not configured");
    }
    const [balance, positions] = await Promise.all([
      getSolanaBalanceSnapshot({
        rpcUrl: settings.solanaRpcUrl,
        owner: settings.solanaWalletPublicKey,
        tokenMint: pair.tokenMint,
        options: { timeoutMs: settings.solanaRpcTimeoutMs, maxRetries: 2 },
      }),
      this.dependencies.backpack.getPositions(pair.perpSymbol),
    ]);
    return {
      spotQuantity: new Decimal(balance.tokenRawAmount)
        .div(new Decimal(10).pow(balance.tokenDecimals))
        .toString(),
      perpNetQuantity: positions.reduce(
        (total, position) => total.plus(new Decimal(position.netQuantity)),
        new Decimal(0),
      ).toString(),
    };
  }

  private pair(intent: TradeIntent) {
    const pair = pairBySymbol(intent.pair);
    if (!pair) throw new Error("Trade intent has an unknown pair");
    return pair;
  }
}
