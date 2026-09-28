import Fastify from "fastify";
import type { FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { BackpackClient } from "./backpack.js";
import { evaluateBackpackPreflight } from "./backpack-preflight.js";
import { BackpackMarketData } from "./backpack-market-data.js";
import { SpreadCollector } from "./collector.js";
import { pairBySymbol, TRACKED_PAIRS, USDC_DECIMALS, USDC_MINT } from "./pairs.js";
import { SampleRepository } from "./repository.js";
import { getQuote } from "./jupiter.js";
import {
  buildJupiterSwapTransaction,
  diagnoseSimulationError,
  getSolanaBalanceSnapshot,
  getSolanaTransactionOutcome,
  simulateSolanaTransaction,
} from "./solana-simulation.js";
import { signJupiterTransaction } from "./solana-signer.js";
import { CANARY_SIZE, TRACKED_SIZE, type PairSymbol, type TrackedSize } from "./types.js";
import { createTradeIntent } from "./trade-intents.js";
import {
  decideHedgeReconciliation,
  decideSpotReconciliation,
  reconcileBackpackOrder,
} from "./trade-reconciliation.js";
import {
  buildIocLimitPreview,
  CanaryWriteAdapter,
} from "./canary-write-adapter.js";
import { evaluateCanaryRisk } from "./canary-risk.js";
import {
  assertCanaryApproval,
  expectedApprovalText,
  fingerprintCanaryPreview,
  publicCanaryPreview,
  type CanaryApprovalPreview,
} from "./canary-approval.js";
import { EntryRuntime } from "./entry-runtime.js";
import { runSupervisedEntryFlow } from "./entry-flow.js";
import { JupiterRoundTripRuntime } from "./jupiter-round-trip-runtime.js";

const app = Fastify({ logger: true, trustProxy: "127.0.0.1" });
const repository = new SampleRepository(config.mongoUri, config.mongoDb);
const backpack = new BackpackClient(
  config.credentialsFile,
  config.backpackApiKey && config.backpackApiSecret
    ? { key: config.backpackApiKey, secret: config.backpackApiSecret }
    : undefined,
);
const marketData = new BackpackMarketData({
  symbols: TRACKED_PAIRS.map((pair) => pair.perpSymbol),
  fetchDepthSnapshot: (symbol) => backpack.getDepth(symbol),
  websocketUrl: config.backpackWebsocketUrl,
  defaultMaxAgeMs: config.backpackMarketMaxAgeMs,
});
const jupiterRoundTrip = new JupiterRoundTripRuntime(repository, backpack, marketData);
const collector = new SpreadCollector(repository, backpack, marketData, jupiterRoundTrip);
const canaryWrites = new CanaryWriteAdapter({
  killSwitch: config.canaryKillSwitch,
  executionEnabled: config.canaryExecutionEnabled,
}, backpack);
const entryRuntime = new EntryRuntime({
  repository,
  backpack,
  marketData,
  collector,
  writes: canaryWrites,
});

app.get("/api/health/live", async () => ({ ok: true }));

const readiness = async (_request: unknown, reply: FastifyReply) => {
  const mongo = await repository.ping();
  const ready = mongo && collector.isReady();
  return reply.code(ready ? 200 : 503).send({
    ok: ready,
    mongo,
    collector: collector.state.status,
    sources: collector.getOperationalMetrics(),
  });
};
app.get("/api/health", readiness);
app.get("/api/health/ready", readiness);

app.get("/api/monitor", async () => {
  const liveTradingSettings = jupiterRoundTrip.currentLiveTradingSettings();
  return {
  state: collector.state,
  operational: collector.getOperationalMetrics(),
  pairs: TRACKED_PAIRS,
  latest: await repository.latest(TRACKED_SIZE),
  canaryPolicy: {
    killSwitch: config.canaryKillSwitch,
    executionEnabled: config.canaryExecutionEnabled,
    notionalUsd: CANARY_SIZE,
    maxLossPerTradeUsd: config.canaryMaxLossPerTradeUsd,
    maxDailyLossUsd: config.canaryMaxDailyLossUsd,
    maxDailyAttempts: config.canaryMaxDailyAttempts,
    maxOpenPositions: config.canaryMaxOpenPositions,
    minExpectedPnlUsd: config.canaryMinExpectedPnlUsd,
    minEntryEdgePct: config.canaryMinEntryEdgePct,
    allowedPairs: config.canaryAllowedPairs,
  },
  jupiterRoundTripPolicy: {
    enabled: config.jupiterAutoExecutionEnabled,
    killSwitch: config.jupiterAutoKillSwitch,
    notionalUsd: liveTradingSettings.tradeSizeUsd,
    addNotionalUsd: liveTradingSettings.tradeSizeUsd,
    addEdgeStepPct: config.jupiterAutoAddEdgeStepPct,
    minEntryEdgePct: liveTradingSettings.minEntryEdgePct,
    exitEdgePct: liveTradingSettings.exitEdgePct,
    maxOpenPositions: config.jupiterAutoMaxOpenPositions,
    maxDailyEntries: config.jupiterAutoMaxDailyEntries,
    allowedPairs: config.jupiterAutoAllowedPairs,
    runtime: jupiterRoundTrip.status,
    livePortfolioEnabled: config.jupiterLivePortfolioEnabled,
    liveBudgetUsd: liveTradingSettings.maxBudgetUsd,
    liveMaxDailyEntries: config.jupiterLiveMaxDailyEntries,
    realizedStopLossUsd: config.jupiterLiveStopLossUsd,
    usdcReserveUsd: config.jupiterLiveUsdcReserveUsd,
  },
  jupiterLivePortfolio: config.jupiterLivePortfolioEnabled
    ? await repository.jupiterLivePortfolioStatus()
    : null,
  };
});

app.get<{ Querystring: { limit?: string } }>("/api/jupiter/round-trips", async (request) => {
  const limit = Math.min(Math.max(Number(request.query.limit ?? 500), 1), 1_000);
  return { trades: await repository.listJupiterRoundTrips(limit) };
});

app.get<{ Querystring: { limit?: string } }>("/api/canary/intents", async (request) => {
  const limit = Math.min(Math.max(Number(request.query.limit ?? 20), 1), 100);
  return repository.listTradeIntents(limit);
});

app.post<{ Body: { pair?: string; idempotencyKey?: string } }>(
  "/api/canary/intents/plan",
  async (request, reply) => {
    const pair = pairBySymbol(request.body?.pair ?? "");
    const idempotencyKey = request.body?.idempotencyKey ?? "";
    if (!pair) return reply.code(400).send({ error: "unknown pair" });
    if (!config.canaryAllowedPairs.includes(pair.symbol)) {
      return reply.code(403).send({ error: "pair is not allowed by canary policy" });
    }
    try {
      const result = await repository.createTradeIntent(createTradeIntent({
        tradeId: randomUUID(),
        idempotencyKey,
        pair: pair.symbol,
        basisRisk: pair.basisRisk,
      }));
      return reply.code(result.created ? 201 : 200).send({
        mode: "PLAN_ONLY_NO_EXTERNAL_WRITES",
        created: result.created,
        intent: result.intent,
      });
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "Could not plan trade intent",
      });
    }
  },
);

app.post<{ Params: { tradeId: string } }>(
  "/api/canary/intents/:tradeId/preview",
  async (request, reply) => {
    const intent = await repository.findTradeIntent(request.params.tradeId);
    if (!intent) return reply.code(404).send({ error: "trade intent not found" });
    if (intent.status !== "PLANNED") {
      return reply.code(409).send({ error: `cannot replace preview in status ${intent.status}` });
    }
    const pair = pairBySymbol(intent.pair);
    if (!pair) return reply.code(409).send({ error: "trade intent has an unknown pair" });
    if (!config.solanaRpcUrl || !config.solanaWalletPublicKey) {
      return reply.code(503).send({ error: "Solana preview is not configured" });
    }
    try {
      const [sample, quote, balances, account, cashBalances, collateral, market, maxOrder, positions, openOrders, riskState] =
        await Promise.all([
          collector.runDryRunProbe(pair, CANARY_SIZE),
          getQuote(USDC_MINT, pair.tokenMint, String(CANARY_SIZE * 10 ** USDC_DECIMALS)),
          getSolanaBalanceSnapshot({
            rpcUrl: config.solanaRpcUrl,
            owner: config.solanaWalletPublicKey,
            tokenMint: USDC_MINT,
            options: { timeoutMs: config.solanaRpcTimeoutMs, maxRetries: 2 },
          }),
          backpack.getAccountSummary(),
          backpack.getBalances(),
          backpack.getCollateral(),
          backpack.getMarket(pair.perpSymbol),
          backpack.getMaxOrderQuantity(pair.perpSymbol, "Ask"),
          backpack.getPositions(pair.perpSymbol),
          backpack.getOpenOrders(pair.perpSymbol),
          repository.canaryRiskState(),
        ]);
      const requestedQuantity = Number(quote.outAmount) / 10 ** pair.tokenDecimals;
      const preflight = evaluateBackpackPreflight({
        symbol: pair.perpSymbol,
        requestedQuantity,
        account,
        balances: cashBalances,
        collateral,
        market,
        maxOrderQuantity: maxOrder.maxOrderQuantity,
        positions,
        openOrders,
      });
      const book = marketData.getMarket(pair.perpSymbol, config.backpackMarketMaxAgeMs);
      const bestBid = book.bids[0]?.[0];
      if (!bestBid) throw new Error("Backpack order book has no bid for hedge preview");
      const hedge = buildIocLimitPreview({
        side: "Ask",
        bestPrice: bestBid,
        tickSize: market.filters.price.tickSize,
        slippagePct: config.expectedPerpSlippagePct,
      });
      const transaction = await buildJupiterSwapTransaction({
        quote,
        userPublicKey: config.solanaWalletPublicKey,
        apiKey: config.jupiterApiKey,
        maxPriorityFeeLamports: config.jupiterMaxPriorityFeeLamports,
        options: {
          timeoutMs: config.jupiterRequestTimeoutMs,
          maxRetries: config.jupiterMaxRetries,
        },
      });
      const simulation = await simulateSolanaTransaction({
        rpcUrl: config.solanaRpcUrl,
        transactionBase64: transaction.swapTransaction,
        options: { timeoutMs: config.solanaRpcTimeoutMs, maxRetries: 2 },
      });
      const risk = evaluateCanaryRisk({
        killSwitch: config.canaryKillSwitch,
        maxLossPerTradeUsd: config.canaryMaxLossPerTradeUsd,
        maxDailyLossUsd: config.canaryMaxDailyLossUsd,
        maxDailyAttempts: config.canaryMaxDailyAttempts,
        maxOpenPositions: config.canaryMaxOpenPositions,
        minExpectedPnlUsd: config.canaryMinExpectedPnlUsd,
        minEntryEdgePct: config.canaryMinEntryEdgePct,
        allowedPairs: config.canaryAllowedPairs,
      }, {
        pair: pair.symbol,
        sizeUsd: CANARY_SIZE,
        worstCaseLossUsd: Math.max(0, -sample.immediateLiquidationPnlUsd),
        expectedPnlUsd: sample.estimatedConvergencePnlUsd,
        entryEdgePct: sample.entryEdgePct,
        ...riskState,
      });
      const minimumOutAmount = quote.quoteResponse.otherAmountThreshold;
      if (typeof minimumOutAmount !== "string" || !/^\d+$/.test(minimumOutAmount)) {
        throw new Error("Jupiter quote has no valid minimum output amount");
      }
      const spotBalance = balances.tokenUiAmount >= CANARY_SIZE;
      const riskFailures = [...risk.failures, ...(!spotBalance ? ["spotBalance"] : [])];
      const createdAt = new Date();
      const preview: CanaryApprovalPreview = {
        tradeId: intent.tradeId,
        pair: pair.symbol,
        basisRisk: pair.basisRisk,
        sizeUsd: CANARY_SIZE,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + config.canaryPreviewTtlMs),
        spot: {
          inputMint: USDC_MINT,
          outputMint: pair.tokenMint,
          inAmount: quote.inAmount,
          outAmount: quote.outAmount,
          minimumOutAmount,
          priceImpactPct: quote.priceImpactPct,
          route: quote.routePlan.map((part) => part.swapInfo.label),
          quoteResponse: quote.quoteResponse,
          simulationPassed: transaction.simulationError === null && simulation.err === null,
          priorityFeeLamports: transaction.prioritizationFeeLamports,
        },
        hedge: {
          symbol: pair.perpSymbol,
          quantity: preflight.quantity.order,
          bestBid: hedge.bestPrice,
          worstPrice: hedge.worstPrice,
          tickSize: hedge.tickSize,
          timeInForce: hedge.timeInForce,
          preflightPassed: preflight.pass,
        },
        economics: {
          entryEdgePct: sample.entryEdgePct,
          immediateLiquidationPnlUsd: sample.immediateLiquidationPnlUsd,
          worstCaseLossUsd: Math.max(0, -sample.immediateLiquidationPnlUsd),
        },
        risk: {
          pass: risk.pass && spotBalance,
          failures: riskFailures,
          gates: { ...risk.gates, spotBalance },
        },
      };
      const fingerprint = fingerprintCanaryPreview(preview);
      const updated = await repository.saveTradeIntentPreview({
        tradeId: intent.tradeId,
        expectedVersion: intent.version,
        preview,
        fingerprint,
      });
      return {
        mode: "IMMUTABLE_PREVIEW_NO_WRITES",
        tradeId: updated.tradeId,
        version: updated.version,
        fingerprint,
        approvalText: expectedApprovalText(updated.tradeId, fingerprint),
        preview: publicCanaryPreview(preview),
      };
    } catch (error) {
      return reply.code(503).send({
        error: error instanceof Error ? error.message : "Canary preview failed",
      });
    }
  },
);

app.post<{
  Params: { tradeId: string };
  Body: { fingerprint?: string; approval?: string };
}>("/api/canary/intents/:tradeId/approve", async (request, reply) => {
  const intent = await repository.findTradeIntent(request.params.tradeId);
  if (!intent) return reply.code(404).send({ error: "trade intent not found" });
  if (intent.status !== "PLANNED" || !intent.preview || !intent.previewFingerprint) {
    return reply.code(409).send({ error: "trade intent has no approvable preview" });
  }
  try {
    assertCanaryApproval({
      preview: intent.preview,
      fingerprint: request.body?.fingerprint ?? "",
      approval: request.body?.approval ?? "",
    });
    if (request.body.fingerprint !== intent.previewFingerprint) {
      throw new Error("Stored canary preview fingerprint mismatch");
    }
    const updated = await repository.transitionTradeIntent({
      tradeId: intent.tradeId,
      expectedVersion: intent.version,
      from: "PLANNED",
      to: "APPROVED",
      reason: `Operator approved immutable preview ${intent.previewFingerprint}`,
    });
    return {
      mode: "APPROVED_NO_EXTERNAL_WRITES",
      tradeId: updated.tradeId,
      status: updated.status,
      version: updated.version,
      fingerprint: updated.previewFingerprint,
      expiresAt: updated.preview?.expiresAt,
    };
  } catch (error) {
    return reply.code(409).send({
      error: error instanceof Error ? error.message : "Canary approval failed",
    });
  }
});

app.post<{
  Params: { tradeId: string };
  Body: { approval?: string };
}>("/api/canary/intents/:tradeId/execute-spot", async (request, reply) => {
  const intent = await repository.findTradeIntent(request.params.tradeId);
  if (!intent) return reply.code(404).send({ error: "trade intent not found" });
  try {
    const result = await entryRuntime.executeSpot(intent, request.body?.approval ?? "");
    return { mode: "SUPERVISED_SPOT_EXECUTION", ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Supervised spot execution failed";
    const blocked = message.startsWith("Canary write blocked:");
    return reply.code(blocked ? 403 : 409).send({ error: message });
  }
});

app.post<{
  Params: { tradeId: string };
  Body: { approval?: string };
}>("/api/canary/intents/:tradeId/execute-hedge", async (request, reply) => {
  const intent = await repository.findTradeIntent(request.params.tradeId);
  if (!intent) return reply.code(404).send({ error: "trade intent not found" });
  try {
    const result = await entryRuntime.executeHedge(intent, request.body?.approval ?? "");
    return { mode: "SUPERVISED_HEDGE_EXECUTION", ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Supervised hedge execution failed";
    const blocked = message.startsWith("Canary write blocked:");
    return reply.code(blocked ? 403 : 409).send({ error: message });
  }
});

app.post<{ Params: { tradeId: string } }>(
  "/api/canary/intents/:tradeId/recover-uncertain",
  async (request, reply) => {
    const intent = await repository.findTradeIntent(request.params.tradeId);
    if (!intent) return reply.code(404).send({ error: "trade intent not found" });
    try {
      const result = await entryRuntime.recoverUncertain(intent);
      return {
        mode: "READ_ONLY_UNCERTAIN_RECOVERY_NO_RESUBMIT",
        tradeId: result.intent.tradeId,
        resolved: result.resolved,
        leg: result.leg,
        outcome: result.outcome,
        status: result.intent.status,
        version: result.intent.version,
        spotFilledQuantity: result.intent.spotFilledQuantity,
        hedgeFilledQuantity: result.intent.hedgeFilledQuantity,
        lastError: result.intent.lastError,
      };
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "Uncertain recovery failed",
      });
    }
  },
);

app.post<{ Params: { tradeId: string } }>(
  "/api/canary/intents/:tradeId/recovery-preview",
  async (request, reply) => {
    const intent = await repository.findTradeIntent(request.params.tradeId);
    if (!intent) return reply.code(404).send({ error: "trade intent not found" });
    try {
      const result = await entryRuntime.createRecoveryPreview(intent);
      return {
        mode: "IMMUTABLE_RECOVERY_PREVIEW_NO_WRITES",
        tradeId: result.intent.tradeId,
        version: result.intent.version,
        fingerprint: result.fingerprint,
        approvalText: result.approvalText,
        preview: result.preview,
      };
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "Recovery preview failed",
      });
    }
  },
);

app.post<{
  Params: { tradeId: string };
  Body: { recoveryApproval?: string; executionApproval?: string };
}>("/api/canary/intents/:tradeId/execute-recovery", async (request, reply) => {
  const intent = await repository.findTradeIntent(request.params.tradeId);
  if (!intent) return reply.code(404).send({ error: "trade intent not found" });
  try {
    const result = await entryRuntime.executeRecoveryOrder({
      intent,
      recoveryApproval: request.body?.recoveryApproval ?? "",
      executionApproval: request.body?.executionApproval ?? "",
    });
    return { mode: "SUPERVISED_RECOVERY_ORDER", ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Recovery execution failed";
    const blocked = message.startsWith("Canary write blocked:");
    return reply.code(blocked ? 403 : 409).send({ error: message });
  }
});

app.post<{ Params: { tradeId: string } }>(
  "/api/canary/intents/:tradeId/confirm-recovery",
  async (request, reply) => {
    const intent = await repository.findTradeIntent(request.params.tradeId);
    if (!intent) return reply.code(404).send({ error: "trade intent not found" });
    try {
      const result = await entryRuntime.confirmRecovery(intent);
      return {
        mode: "BOUNDED_RECOVERY_CONFIRMATION_NO_RESUBMIT",
        tradeId: result.intent.tradeId,
        resolved: result.resolved,
        outcome: result.outcome,
        status: result.intent.status,
        version: result.intent.version,
        recoveryFilledQuantity: result.intent.recoveryFilledQuantity,
        lastError: result.intent.lastError,
      };
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "Recovery confirmation failed",
      });
    }
  },
);

app.post<{ Params: { tradeId: string } }>(
  "/api/canary/intents/:tradeId/confirm-spot",
  async (request, reply) => {
    const intent = await repository.findTradeIntent(request.params.tradeId);
    if (!intent) return reply.code(404).send({ error: "trade intent not found" });
    try {
      const updated = await entryRuntime.confirmSpot(intent);
      return {
        mode: "BOUNDED_SOLANA_CONFIRMATION_NO_RESUBMIT",
        tradeId: updated.tradeId,
        status: updated.status,
        version: updated.version,
        spotFilledQuantity: updated.spotFilledQuantity,
        lastError: updated.lastError,
      };
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "Spot confirmation failed",
      });
    }
  },
);

app.post<{ Params: { tradeId: string } }>(
  "/api/canary/intents/:tradeId/confirm-hedge",
  async (request, reply) => {
    const intent = await repository.findTradeIntent(request.params.tradeId);
    if (!intent) return reply.code(404).send({ error: "trade intent not found" });
    try {
      const updated = await entryRuntime.confirmHedge(intent);
      return {
        mode: "BOUNDED_BACKPACK_CONFIRMATION_NO_RESUBMIT",
        tradeId: updated.tradeId,
        status: updated.status,
        version: updated.version,
        hedgeFilledQuantity: updated.hedgeFilledQuantity,
        backpackOrderId: updated.backpackOrderId,
        lastError: updated.lastError,
      };
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "Hedge confirmation failed",
      });
    }
  },
);

app.post<{
  Params: { tradeId: string };
  Body: { approval?: string };
}>("/api/canary/intents/:tradeId/execute-entry", async (request, reply) => {
  const intent = await repository.findTradeIntent(request.params.tradeId);
  if (!intent) return reply.code(404).send({ error: "trade intent not found" });
  const approval = request.body?.approval ?? "";
  try {
    const updated = await runSupervisedEntryFlow({
      intent,
      dependencies: {
        reload: async (tradeId) => {
          const current = await repository.findTradeIntent(tradeId);
          if (!current) throw new Error("Trade intent disappeared during entry flow");
          return current;
        },
        executeSpot: (current) => entryRuntime.executeSpot(current, approval),
        confirmSpot: (current) => entryRuntime.confirmSpot(current),
        executeHedge: (current) => entryRuntime.executeHedge(current, approval),
        confirmHedge: (current) => entryRuntime.confirmHedge(current),
        finalizeHedged: (current) => entryRuntime.finalizeHedged(current),
        markSpotOnly: (current, error) => entryRuntime.markSpotOnly(current, error),
      },
    });
    return {
      mode: "SUPERVISED_RESUMABLE_ENTRY",
      tradeId: updated.tradeId,
      status: updated.status,
      version: updated.version,
      spotFilledQuantity: updated.spotFilledQuantity,
      hedgeFilledQuantity: updated.hedgeFilledQuantity,
      lastError: updated.lastError,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Supervised entry flow failed";
    const blocked = message.startsWith("Canary write blocked:");
    return reply.code(blocked ? 403 : 409).send({ error: message });
  }
});

app.post<{ Params: { tradeId: string } }>(
  "/api/canary/intents/:tradeId/reconcile",
  async (request, reply) => {
    const intent = await repository.findTradeIntent(request.params.tradeId);
    if (!intent) return reply.code(404).send({ error: "trade intent not found" });
    const pair = pairBySymbol(intent.pair);
    if (!pair) return reply.code(409).send({ error: "trade intent has an unknown pair" });
    try {
      let decision;
      if (intent.status === "SPOT_SUBMITTED") {
        if (!config.solanaRpcUrl || !config.solanaWalletPublicKey || !intent.solanaSignature) {
          return reply.code(503).send({ error: "Solana reconciliation is not configured" });
        }
        const outcome = await getSolanaTransactionOutcome({
          rpcUrl: config.solanaRpcUrl,
          signature: intent.solanaSignature,
          owner: config.solanaWalletPublicKey,
          tokenMint: pair.tokenMint,
          options: { timeoutMs: config.solanaRpcTimeoutMs, maxRetries: 2 },
        });
        decision = decideSpotReconciliation(outcome, pair.tokenDecimals);
      } else if (intent.status === "HEDGE_SUBMITTED") {
        if (intent.backpackClientOrderId === null) {
          return reply.code(409).send({ error: "trade intent has no Backpack client order id" });
        }
        const [openOrders, orderHistory, fills] = await Promise.all([
          backpack.getOpenOrders(pair.perpSymbol),
          backpack.getOrderHistory(pair.perpSymbol),
          backpack.getFillHistory(pair.perpSymbol),
        ]);
        decision = decideHedgeReconciliation(reconcileBackpackOrder({
          clientOrderId: intent.backpackClientOrderId,
          openOrders,
          orderHistory,
          fills,
        }));
      } else {
        return reply.code(409).send({
          error: `status ${intent.status} does not support submitted-operation reconciliation`,
        });
      }
      const updated = await repository.transitionTradeIntent({
        tradeId: intent.tradeId,
        expectedVersion: intent.version,
        from: intent.status,
        to: decision.to,
        reason: decision.reason,
        patch: decision.patch,
      });
      return {
        mode: "READ_ONLY_EXTERNAL_RECONCILIATION",
        tradeId: updated.tradeId,
        previousStatus: intent.status,
        status: updated.status,
        version: updated.version,
        spotFilledQuantity: updated.spotFilledQuantity,
        hedgeFilledQuantity: updated.hedgeFilledQuantity,
        backpackOrderId: updated.backpackOrderId,
        lastError: updated.lastError,
      };
    } catch (error) {
      return reply.code(503).send({
        error: error instanceof Error ? error.message : "Trade intent reconciliation failed",
      });
    }
  },
);

app.post<{ Querystring: { pair?: string; size?: string } }>(
  "/api/research/probe",
  async (request, reply) => {
    const pair = pairBySymbol(request.query.pair ?? "SPCX");
    const size = Number(request.query.size ?? TRACKED_SIZE);
    if (!pair) return reply.code(400).send({ error: "unknown pair" });
    if (size !== TRACKED_SIZE) {
      return reply.code(400).send({ error: `size must be ${TRACKED_SIZE}` });
    }
    let sample;
    try {
      sample = await collector.runDryRunProbe(pair, size as TrackedSize);
    } catch (error) {
      return reply.code(503).send({
        error: error instanceof Error ? error.message : "fresh dry-run probe failed",
      });
    }
    return {
      mode: "QUOTE_ONLY_NO_ORDERS",
      sample,
    };
  },
);

app.post<{ Querystring: { pair?: string; size?: string } }>(
  "/api/research/jupiter-simulation",
  async (request, reply) => {
    const pair = pairBySymbol(request.query.pair ?? "SPCX");
    const size = Number(request.query.size ?? TRACKED_SIZE);
    if (!pair) return reply.code(400).send({ error: "unknown pair" });
    if (size !== TRACKED_SIZE) {
      return reply.code(400).send({ error: `size must be ${TRACKED_SIZE}` });
    }
    if (!config.solanaRpcUrl || !config.solanaWalletPublicKey) {
      return reply.code(503).send({
        error: "Set SOLANA_RPC_URL and SOLANA_WALLET_PUBLIC_KEY for RPC simulation",
      });
    }
    try {
      const [quote, balances] = await Promise.all([
        getQuote(USDC_MINT, pair.tokenMint, String(size * 10 ** USDC_DECIMALS)),
        getSolanaBalanceSnapshot({
          rpcUrl: config.solanaRpcUrl,
          owner: config.solanaWalletPublicKey,
          tokenMint: USDC_MINT,
          options: { timeoutMs: config.solanaRpcTimeoutMs, maxRetries: 2 },
        }),
      ]);
      const transaction = await buildJupiterSwapTransaction({
        quote,
        userPublicKey: config.solanaWalletPublicKey,
        apiKey: config.jupiterApiKey,
        maxPriorityFeeLamports: config.jupiterMaxPriorityFeeLamports,
        options: {
          timeoutMs: config.jupiterRequestTimeoutMs,
          maxRetries: config.jupiterMaxRetries,
        },
      });
      const simulation = await simulateSolanaTransaction({
        rpcUrl: config.solanaRpcUrl,
        transactionBase64: transaction.swapTransaction,
        options: { timeoutMs: config.solanaRpcTimeoutMs, maxRetries: 2 },
      });
      return {
        mode: "UNSIGNED_RPC_SIMULATION_NO_SEND",
        pair: pair.symbol,
        sizeUsd: size,
        quote: {
          inAmount: quote.inAmount,
          outAmount: quote.outAmount,
          priceImpactPct: quote.priceImpactPct,
          route: quote.routePlan.map((part) => part.swapInfo.label),
        },
        transaction: {
          lastValidBlockHeight: transaction.lastValidBlockHeight,
          prioritizationFeeLamports: transaction.prioritizationFeeLamports,
          computeUnitLimit: transaction.computeUnitLimit,
          jupiterSimulationError: transaction.simulationError,
        },
        simulation: {
          ...simulation,
          logs: simulation.logs.slice(-100),
        },
        balances: {
          sol: balances.solLamports / 1_000_000_000,
          usdc: balances.tokenUiAmount,
        },
        diagnosis: diagnoseSimulationError(transaction.simulationError, simulation.err),
        success: transaction.simulationError === null && simulation.err === null,
      };
    } catch (error) {
      return reply.code(503).send({
        error: error instanceof Error ? error.message : "Jupiter RPC simulation failed",
      });
    }
  },
);

app.post<{ Querystring: { pair?: string } }>(
  "/api/research/backpack-preflight",
  async (request, reply) => {
    const pair = pairBySymbol(request.query.pair ?? "SPCX");
    if (!pair) return reply.code(400).send({ error: "unknown pair" });
    if (pair.basisRisk !== "same_issuer") {
      return reply.code(400).send({ error: "Backpack preflight requires a same-issuer pair" });
    }
    try {
      const quote = await getQuote(
        USDC_MINT,
        pair.tokenMint,
        String(CANARY_SIZE * 10 ** USDC_DECIMALS),
      );
      const requestedQuantity = Number(quote.outAmount) / 10 ** pair.tokenDecimals;
      const [account, balances, collateral, market, maxOrder, positions, openOrders] =
        await Promise.all([
          backpack.getAccountSummary(),
          backpack.getBalances(),
          backpack.getCollateral(),
          backpack.getMarket(pair.perpSymbol),
          backpack.getMaxOrderQuantity(pair.perpSymbol, "Ask"),
          backpack.getPositions(pair.perpSymbol),
          backpack.getOpenOrders(pair.perpSymbol),
        ]);
      const liveBook = marketData.getMarket(pair.perpSymbol, config.backpackMarketMaxAgeMs);
      const bestBid = liveBook.bids[0]?.[0];
      if (!bestBid) throw new Error("Backpack order book has no bid for hedge preview");
      const orderPreview = buildIocLimitPreview({
        side: "Ask",
        bestPrice: bestBid,
        tickSize: market.filters.price.tickSize,
        slippagePct: config.expectedPerpSlippagePct,
      });
      return {
        pair: pair.symbol,
        sizeUsd: CANARY_SIZE,
        quoteRoute: quote.routePlan.map((part) => part.swapInfo.label),
        orderPreview: {
          ...orderPreview,
          reduceOnly: false,
          symbol: pair.perpSymbol,
        },
        ...evaluateBackpackPreflight({
          symbol: pair.perpSymbol,
          requestedQuantity,
          account,
          balances,
          collateral,
          market,
          maxOrderQuantity: maxOrder.maxOrderQuantity,
          positions,
          openOrders,
        }),
      };
    } catch (error) {
      return reply.code(503).send({
        error: error instanceof Error ? error.message : "Backpack preflight failed",
      });
    }
  },
);

app.post<{ Querystring: { pair?: string } }>(
  "/api/research/signer-check",
  async (request, reply) => {
    const pair = pairBySymbol(request.query.pair ?? "SPCX");
    if (!pair) return reply.code(400).send({ error: "unknown pair" });
    if (
      !config.solanaRpcUrl
      || !config.solanaWalletPublicKey
      || !config.solanaSignerCredentialsFile
      || !config.solanaSignerPassphrase
    ) {
      return reply.code(503).send({ error: "Canary signer is not configured" });
    }
    try {
      const quote = await getQuote(
        USDC_MINT,
        pair.tokenMint,
        String(CANARY_SIZE * 10 ** USDC_DECIMALS),
      );
      const transaction = await buildJupiterSwapTransaction({
        quote,
        userPublicKey: config.solanaWalletPublicKey,
        apiKey: config.jupiterApiKey,
        maxPriorityFeeLamports: config.jupiterMaxPriorityFeeLamports,
        options: {
          timeoutMs: config.jupiterRequestTimeoutMs,
          maxRetries: config.jupiterMaxRetries,
        },
      });
      const signed = await signJupiterTransaction({
        transactionBase64: transaction.swapTransaction,
        credentialsPath: config.solanaSignerCredentialsFile,
        passphrase: config.solanaSignerPassphrase,
        expectedPublicKey: config.solanaWalletPublicKey,
      });
      const simulation = await simulateSolanaTransaction({
        rpcUrl: config.solanaRpcUrl,
        transactionBase64: signed.signedTransactionBase64,
        options: { timeoutMs: config.solanaRpcTimeoutMs, maxRetries: 2 },
        sigVerify: true,
        replaceRecentBlockhash: false,
      });
      return {
        mode: "AUTO_SIGNED_SIMULATION_NO_SEND",
        publicKey: signed.publicKey,
        pair: pair.symbol,
        sizeUsd: CANARY_SIZE,
        signatureVerified: true,
        simulation: {
          err: simulation.err,
          unitsConsumed: simulation.unitsConsumed,
          slot: simulation.slot,
        },
        success: simulation.err === null,
      };
    } catch (error) {
      return reply.code(503).send({
        error: error instanceof Error ? error.message : "Signer check failed",
      });
    }
  },
);

app.get("/metrics", async (_request, reply) => {
  const metrics = collector.getOperationalMetrics();
  const lines = [
    "# TYPE backpack_ws_connected gauge",
    `backpack_ws_connected ${metrics.backpack.connected ? 1 : 0}`,
    "# TYPE backpack_ws_reconnects_total counter",
    `backpack_ws_reconnects_total ${metrics.backpack.reconnects}`,
    "# TYPE backpack_ws_messages_total counter",
    `backpack_ws_messages_total ${metrics.backpack.messages}`,
    "# TYPE backpack_book_sequence_gaps_total counter",
    `backpack_book_sequence_gaps_total ${metrics.backpack.gaps}`,
    "# TYPE backpack_book_stale gauge",
    `backpack_book_stale ${metrics.backpack.staleSymbols.length}`,
    "# TYPE jupiter_queue_depth gauge",
    `jupiter_queue_depth ${metrics.jupiter.queueDepth}`,
    "# TYPE jupiter_requests_total counter",
    `jupiter_requests_total ${metrics.jupiter.requestsTotal}`,
    "# TYPE jupiter_retries_total counter",
    `jupiter_retries_total ${metrics.jupiter.retriesTotal}`,
    "# TYPE jupiter_rate_limited_total counter",
    `jupiter_rate_limited_total ${metrics.jupiter.rateLimitedTotal}`,
    "# TYPE collector_scheduler_lag_milliseconds gauge",
    `collector_scheduler_lag_milliseconds ${metrics.schedulerLagMs}`,
  ];
  return reply.type("text/plain; version=0.0.4").send(`${lines.join("\n")}\n`);
});

app.get<{ Querystring: { pair?: string; size?: string; limit?: string } }>(
  "/api/history",
  async (request, reply) => {
    const size = Number(request.query.size ?? TRACKED_SIZE);
    const pair = request.query.pair ?? "SPCX";
    const limit = Math.min(Math.max(Number(request.query.limit ?? 300), 1), 1000);
    if (size !== TRACKED_SIZE) {
      return reply.code(400).send({ error: `size must be ${TRACKED_SIZE}` });
    }
    if (pair !== "all" && !pairBySymbol(pair)) {
      return reply.code(400).send({ error: "unknown pair" });
    }
    if (pair === "all") {
      return repository.historyAll(size as TrackedSize, limit);
    }
    const samples = await repository.history(pair as PairSymbol, size as TrackedSize, limit);
    return samples.reverse();
  },
);

app.get<{ Querystring: { size?: string; since?: string; limit?: string } }>(
  "/api/history/changes",
  async (request, reply) => {
    const size = Number(request.query.size ?? TRACKED_SIZE);
    const since = new Date(request.query.since ?? "");
    const requestedLimit = Number(request.query.limit ?? 1_000);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 1_000)
      : 1_000;
    if (size !== TRACKED_SIZE) {
      return reply.code(400).send({ error: `size must be ${TRACKED_SIZE}` });
    }
    if (!Number.isFinite(since.getTime())) {
      return reply.code(400).send({ error: "since must be a valid ISO timestamp" });
    }
    const samples = await repository.historyChanges(size as TrackedSize, since, limit);
    const cursor = samples.at(-1)?.capturedAt ?? since;
    return {
      samples,
      cursor: cursor.toISOString(),
      hasMore: samples.length === limit,
    };
  },
);

const clientRoot = join(process.cwd(), "dist", "client");
if (existsSync(clientRoot)) {
  await app.register(fastifyStatic, { root: clientRoot });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

const shutdown = async () => {
  shuttingDown = true;
  await collector.stop();
  await app.close();
  await repository.close();
};
let shuttingDown = false;
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await repository.connect();
const legacyCleanup = await repository.purgeLegacySyntheticData();
if (
  legacyCleanup.removedSyntheticSamples > 0
  || legacyCleanup.markedLegacySyntheticTrades > 0
  || legacyCleanup.droppedCollections.length > 0
) {
  app.log.warn(legacyCleanup, "Removed legacy synthetic data and fabricated PnL fields");
}
await jupiterRoundTrip.recoverInterruptedPlanning();
await jupiterRoundTrip.initializeLivePortfolio();
const recoverableIntents = await repository.recoverableTradeIntents();
if (recoverableIntents.length > 0) {
  app.log.warn(
    { tradeIds: recoverableIntents.map((intent) => intent.tradeId) },
    "Recoverable trade intents require reconciliation before new execution",
  );
}
await app.listen({ port: config.port, host: "127.0.0.1" });
void (async () => {
  let failures = 0;
  while (!shuttingDown) {
    try {
      await collector.start();
      return;
    } catch (error) {
      if (shuttingDown) return;
      failures += 1;
      collector.recordRestartAttempt(error);
      const delay = Math.min(
        config.collectorRestartMaxMs,
        config.collectorRestartBaseMs * 2 ** Math.min(failures - 1, 5),
      );
      app.log.error({ error, delay, failures }, "Collector failed; restart scheduled");
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
})();
