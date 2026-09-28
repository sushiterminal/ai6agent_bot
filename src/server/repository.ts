import { Collection, Db, MongoClient, MongoServerError } from "mongodb";
import { TRACKED_SIZE, type PairSymbol, type SpreadSample, type TrackedSize } from "./types.js";
import {
  buildTradeIntentTransition,
  RECOVERABLE_TRADE_INTENT_STATUSES,
  type TradeIntent,
  type TradeIntentStatus,
  type TradeIntentTransitionPatch,
} from "./trade-intents.js";
import type { CanaryApprovalPreview } from "./canary-approval.js";
import type { RecoveryPreview } from "./recovery-preview.js";
import {
  assertJupiterRoundTripTransition,
  summarizeJupiterRealizedPnl,
  type JupiterRoundTripEvent,
  type JupiterLivePortfolioControl,
  type JupiterRoundTripStatus,
  type JupiterRoundTripTrade,
} from "./jupiter-round-trip.js";
import { utcDayKey, utcDayRange } from "./live-portfolio-risk.js";
import { TRACKED_PAIRS } from "./pairs.js";
import type { JupiterLiveTradingSettings } from "./jupiter-live-settings.js";

export class SampleRepository {
  private readonly client: MongoClient;
  private db?: Db;
  private collection?: Collection<SpreadSample>;
  private tradeIntents?: Collection<TradeIntent>;
  private jupiterRoundTrips?: Collection<JupiterRoundTripTrade>;
  private jupiterLiveControl?: Collection<JupiterLivePortfolioControl>;

  constructor(uri: string, private readonly databaseName: string) {
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  }

  async connect() {
    await this.client.connect();
    this.db = this.client.db(this.databaseName);
    this.collection = this.db.collection<SpreadSample>("spread_samples");
    this.tradeIntents = this.db.collection<TradeIntent>("trade_intents");
    this.jupiterRoundTrips = this.db.collection<JupiterRoundTripTrade>("jupiter_round_trip_trades");
    this.jupiterLiveControl = this.db.collection<JupiterLivePortfolioControl>("jupiter_live_control");
    await this.collection.createIndex({ pair: 1, sizeUsd: 1, capturedAt: -1 });
    await this.collection.createIndex({ sizeUsd: 1, capturedAt: 1 });
    await this.tradeIntents.createIndex({ tradeId: 1 }, { unique: true });
    await this.tradeIntents.createIndex({ idempotencyKey: 1 }, { unique: true });
    await this.tradeIntents.createIndex(
      { backpackClientOrderId: 1 },
      {
        unique: true,
        partialFilterExpression: { backpackClientOrderId: { $type: "number" } },
      },
    );
    await this.tradeIntents.createIndex(
      { recoveryClientOrderId: 1 },
      {
        unique: true,
        partialFilterExpression: { recoveryClientOrderId: { $type: "number" } },
      },
    );
    await this.tradeIntents.createIndex({ createdAt: -1 });
    await this.jupiterRoundTrips.createIndex({ tradeId: 1 }, { unique: true });
    await this.jupiterRoundTrips.createIndex({ sourceTradeId: 1 }, { unique: true });
    await this.jupiterRoundTrips.createIndex(
      { entryHedgeClientOrderId: 1 },
      { unique: true, partialFilterExpression: { entryHedgeClientOrderId: { $type: "number" } } },
    );
    await this.jupiterRoundTrips.createIndex(
      { exitHedgeClientOrderId: 1 },
      { unique: true, partialFilterExpression: { exitHedgeClientOrderId: { $type: "number" } } },
    );
    await this.jupiterRoundTrips.createIndex({ campaignId: 1, entryTier: 1 });
    const indexes = await this.jupiterRoundTrips.indexes();
    const activePairIndex = indexes.find((index) => index.unique && index.key?.pair === 1);
    if (activePairIndex?.name) await this.jupiterRoundTrips.dropIndex(activePairIndex.name);
    await this.jupiterRoundTrips.createIndex({ pair: 1, active: 1, entryTier: 1 });
    await this.jupiterRoundTrips.createIndex({ createdAt: -1 });
    await this.jupiterLiveControl.createIndex({ key: 1 }, { unique: true });
  }

  async purgeLegacySyntheticData() {
    if (!this.db || !this.collection || !this.jupiterRoundTrips) {
      throw new Error("MongoDB is not connected");
    }
    const syntheticSamples = await this.collection.deleteMany({
      simulationEventId: { $exists: true, $ne: null },
    } as never);
    await this.collection.updateMany(
      { actualBackpackBidVwap: { $exists: true } } as never,
      { $unset: { actualBackpackBidVwap: "" } } as never,
    );

    const legacySyntheticTrades = await this.jupiterRoundTrips.updateMany(
      { spikeEventId: { $exists: true, $ne: null } } as never,
      {
        $set: { sourceIntegrity: "LEGACY_SYNTHETIC_TRIGGER" },
        $unset: { spikeEventId: "" },
      } as never,
    );
    await this.jupiterRoundTrips.updateMany(
      { sourceIntegrity: { $exists: false } } as never,
      { $set: { sourceIntegrity: "VERIFIED_LIVE" }, $unset: { spikeEventId: "" } } as never,
    );
    await this.jupiterRoundTrips.updateMany(
      {},
      { $unset: {
        tradingPnlUsd: "",
        riskAdjustedPnlUsd: "",
        riskReserveUsd: "",
        modelPnlUsd: "",
      } },
    );

    const legacyCollections = [
      "demo_trades",
      "paper_positions",
      "price_pump_settings",
      "price_pump_events",
      "signal_observations",
    ];
    const existing = new Set(
      (await this.db.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name),
    );
    const droppedCollections: string[] = [];
    for (const name of legacyCollections) {
      if (!existing.has(name)) continue;
      await this.db.collection(name).drop();
      droppedCollections.push(name);
    }
    return {
      removedSyntheticSamples: syntheticSamples.deletedCount,
      markedLegacySyntheticTrades: legacySyntheticTrades.modifiedCount,
      droppedCollections,
    };
  }

  async close() {
    await this.client.close();
  }

  async ping() {
    if (!this.db) return false;
    try {
      await this.db.command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async insertMany(samples: SpreadSample[]) {
    if (!this.collection) throw new Error("MongoDB is not connected");
    await this.collection.insertMany(samples);
  }

  async latest(sizeUsd: TrackedSize) {
    if (!this.collection) throw new Error("MongoDB is not connected");
    return this.collection
      .aggregate<SpreadSample>([
        { $match: { sizeUsd } },
        { $sort: { capturedAt: -1 } },
        {
          $group: {
            _id: { pair: "$pair", sizeUsd: "$sizeUsd" },
            sample: { $first: "$$ROOT" },
          },
        },
        { $replaceRoot: { newRoot: "$sample" } },
        { $sort: { pair: 1, sizeUsd: 1 } },
        { $project: { _id: 0 } },
      ])
      .toArray();
  }

  async history(pair: PairSymbol, sizeUsd: TrackedSize, limit: number) {
    if (!this.collection) throw new Error("MongoDB is not connected");
    return this.collection
      .find({ pair, sizeUsd }, { projection: { _id: 0 } })
      .sort({ capturedAt: -1 })
      .limit(limit)
      .toArray();
  }

  async historyAll(sizeUsd: TrackedSize, limitPerPair: number) {
    if (!this.collection) throw new Error("MongoDB is not connected");
    const histories = await Promise.all(TRACKED_PAIRS.map(({ symbol }) =>
      this.history(symbol, sizeUsd, limitPerPair)));
    return histories
      .flat()
      .sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime());
  }

  async historyChanges(sizeUsd: TrackedSize, since: Date, limit: number) {
    if (!this.collection) throw new Error("MongoDB is not connected");
    return this.collection
      .find({ sizeUsd, capturedAt: { $gte: since } }, { projection: { _id: 0 } })
      .sort({ capturedAt: 1 })
      .limit(limit)
      .toArray();
  }

  async insertJupiterRoundTrip(trade: JupiterRoundTripTrade) {
    if (!this.jupiterRoundTrips) throw new Error("MongoDB is not connected");
    try {
      await this.jupiterRoundTrips.insertOne(trade);
      return true;
    } catch (error) {
      if (
        error instanceof MongoServerError
        && error.code === 11000
        && error.keyPattern?.sourceTradeId === 1
      ) return false;
      throw error;
    }
  }

  async ensureJupiterLiveControl(
    stopLossUsd: number,
    defaultSettings: JupiterLiveTradingSettings,
  ) {
    if (!this.jupiterLiveControl) throw new Error("MongoDB is not connected");
    const now = new Date();
    const control = await this.jupiterLiveControl.findOneAndUpdate(
      { key: "global" },
      {
        $set: { stopLossUsd, updatedAt: now },
        $setOnInsert: {
          status: "RUNNING",
          startedAt: now,
          stoppedAt: null,
          stopReason: null,
          stopMode: null,
          liquidateOnStop: false,
          statusDayUtc: utcDayKey(now),
          settings: defaultSettings,
          settingsUpdatedAt: now,
        },
      },
      { upsert: true, returnDocument: "after", projection: { _id: 0 } },
    );
    if (!control) throw new Error("Cannot initialize Jupiter live portfolio control");
    const missingSettings = !control.settings;
    const missingStopControl = typeof control.liquidateOnStop !== "boolean";
    if (missingSettings || missingStopControl) {
      const stopMode = control.status === "STOPPED" ? "DAILY_LOSS" as const : null;
      await this.jupiterLiveControl.updateOne(
        { key: "global" },
        { $set: {
          ...(missingSettings ? { settings: defaultSettings, settingsUpdatedAt: now } : {}),
          ...(missingStopControl ? {
            stopMode,
            liquidateOnStop: control.status === "STOPPED",
          } : {}),
        } },
      );
      return {
        ...control,
        ...(missingSettings ? { settings: defaultSettings, settingsUpdatedAt: now } : {}),
        ...(missingStopControl ? {
          stopMode,
          liquidateOnStop: control.status === "STOPPED",
        } : {}),
      };
    }
    return control;
  }

  async updateJupiterLiveTradingSettings(settings: JupiterLiveTradingSettings) {
    if (!this.jupiterLiveControl) throw new Error("MongoDB is not connected");
    const now = new Date();
    const control = await this.jupiterLiveControl.findOneAndUpdate(
      { key: "global" },
      { $set: { settings, settingsUpdatedAt: now, updatedAt: now } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (!control) throw new Error("Jupiter live portfolio control is not initialized");
    return control;
  }

  async jupiterLivePortfolioStatus() {
    if (!this.jupiterLiveControl || !this.jupiterRoundTrips) {
      throw new Error("MongoDB is not connected");
    }
    const now = new Date();
    const today = utcDayKey(now);
    let control = await this.jupiterLiveControl.findOne(
      { key: "global" },
      { projection: { _id: 0 } },
    );
    if (!control) throw new Error("Jupiter live portfolio control is not initialized");
    if (control.statusDayUtc !== today) {
      const resetDailyStop = control.status === "STOPPED"
        && (control.stopMode === "DAILY_LOSS" || !control.stopMode);
      control = await this.jupiterLiveControl.findOneAndUpdate(
        { key: "global" },
        { $set: {
          statusDayUtc: today,
          updatedAt: now,
          ...(resetDailyStop ? {
            status: "RUNNING" as const,
            stoppedAt: null,
            stopReason: null,
            stopMode: null,
            liquidateOnStop: false,
          } : {}),
        } },
        { returnDocument: "after", projection: { _id: 0 } },
      );
      if (!control) throw new Error("Jupiter live portfolio control disappeared during UTC reset");
    }
    const day = utcDayRange(now);
    const [dailyClosed, lifetimeClosed, activePositions, lifetimeEntrySpend] = await Promise.all([
      this.jupiterRoundTrips.find({
        status: "CLOSED",
        closedAt: { $gte: day.start, $lt: day.end },
      }, { projection: { _id: 0, realizedPnlUsd: 1 } }).toArray(),
      this.jupiterRoundTrips.find({
        status: "CLOSED",
      }, {
        projection: {
          _id: 0,
          realizedPnlUsd: 1,
          entryFeeLamports: 1,
          exitFeeLamports: 1,
          closedAt: 1,
        },
      }).toArray(),
      this.jupiterRoundTrips.countDocuments({
        createdAt: { $gte: control.startedAt },
        active: true,
      }),
      this.jupiterRoundTrips.aggregate<{ _id: null; totalUsd: number }>([
        { $match: { entrySpentUsd: { $type: "number" } } },
        { $group: { _id: null, totalUsd: { $sum: "$entrySpentUsd" } } },
      ]).next(),
    ]);
    const dailyPnl = summarizeJupiterRealizedPnl(dailyClosed);
    const lifetimePnl = summarizeJupiterRealizedPnl(lifetimeClosed);
    const dailyNetPnlUsd = dailyPnl.netUsd;
    const lifetimeNetPnlUsd = lifetimePnl.netUsd;
    const dailyFeeLamports = lifetimeClosed
      .filter((trade) => trade.closedAt && trade.closedAt >= day.start && trade.closedAt < day.end)
      .reduce((total, trade) => total
        + (trade.entryFeeLamports ?? 0)
        + (trade.exitFeeLamports ?? 0), 0);
    const lifetimeFeeLamports = lifetimeClosed.reduce((total, trade) => total
      + (trade.entryFeeLamports ?? 0)
      + (trade.exitFeeLamports ?? 0), 0);
    return {
      ...control,
      dayUtc: today,
      dailyNetPnlUsd,
      lostTodayUsd: dailyPnl.grossLossUsd,
      lifetimeNetPnlUsd,
      lifetimeLostUsd: lifetimePnl.grossLossUsd,
      dailyFeeLamports,
      dailyFeeSol: dailyFeeLamports / 1_000_000_000,
      lifetimeFeeLamports,
      lifetimeFeeSol: lifetimeFeeLamports / 1_000_000_000,
      lifetimeEntrySpentUsd: Number(lifetimeEntrySpend?.totalUsd ?? 0),
      remainingLossBudgetUsd: Math.max(0, control.stopLossUsd + dailyNetPnlUsd),
      activePositions,
      closedPositionsToday: dailyClosed.length,
    };
  }

  async stopJupiterLivePortfolio(
    reason: string,
    stopMode: "DAILY_LOSS" | "MANUAL" | "SELL_ALL" = "DAILY_LOSS",
  ) {
    if (!this.jupiterLiveControl) throw new Error("MongoDB is not connected");
    const now = new Date();
    const control = await this.jupiterLiveControl.findOneAndUpdate(
      {
        key: "global",
        ...(stopMode === "MANUAL" ? { status: "RUNNING" as const } : {}),
      },
      {
        $set: {
          status: "STOPPED",
          stoppedAt: now,
          updatedAt: now,
          stopReason: reason.slice(0, 500),
          stopMode,
          liquidateOnStop: stopMode !== "MANUAL",
          statusDayUtc: utcDayKey(now),
        },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    return control ?? this.jupiterLiveControl.findOne(
      { key: "global" },
      { projection: { _id: 0 } },
    );
  }

  async findActiveJupiterRoundTrip(pair: PairSymbol) {
    if (!this.jupiterRoundTrips) throw new Error("MongoDB is not connected");
    return this.jupiterRoundTrips.findOne({ pair, active: true }, { projection: { _id: 0 } });
  }

  async startJupiterLivePortfolio() {
    if (!this.jupiterLiveControl) throw new Error("MongoDB is not connected");
    const now = new Date();
    const control = await this.jupiterLiveControl.findOneAndUpdate(
      { key: "global" },
      { $set: {
        status: "RUNNING",
        stoppedAt: null,
        stopReason: null,
        stopMode: null,
        liquidateOnStop: false,
        statusDayUtc: utcDayKey(now),
        updatedAt: now,
      } },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (!control) throw new Error("Jupiter live portfolio control is not initialized");
    return control;
  }

  async activeJupiterRoundTripsForPair(pair: PairSymbol) {
    if (!this.jupiterRoundTrips) throw new Error("MongoDB is not connected");
    return this.jupiterRoundTrips.find(
      { pair, active: true },
      { projection: { _id: 0 } },
    ).sort({ entryTier: 1, createdAt: 1 }).toArray();
  }

  async updateJupiterRoundTripMark(input: {
    tradeId: string;
    expectedVersion: number;
    lastEdgePct: number;
  }) {
    if (!this.jupiterRoundTrips) throw new Error("MongoDB is not connected");
    return this.jupiterRoundTrips.findOneAndUpdate(
      { tradeId: input.tradeId, version: input.expectedVersion, status: "OPEN" },
      {
        $set: {
          lastEdgePct: input.lastEdgePct,
          updatedAt: new Date(),
        },
        $inc: { version: 1 },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
  }

  async requestJupiterPairExit(pair: PairSymbol, edgePct: number, requestedAt = new Date()) {
    if (!this.jupiterRoundTrips) throw new Error("MongoDB is not connected");
    return this.jupiterRoundTrips.updateMany(
      {
        pair,
        active: true,
        status: "OPEN",
        $or: [
          { exitRequestedAt: null },
          { exitRequestedAt: { $exists: false } },
        ],
      },
      {
        $set: {
          exitRequestedAt: requestedAt,
          exitRequestedEdgePct: edgePct,
          updatedAt: requestedAt,
        },
        $inc: { version: 1 },
      },
    );
  }

  async findJupiterRoundTrip(tradeId: string) {
    if (!this.jupiterRoundTrips) throw new Error("MongoDB is not connected");
    return this.jupiterRoundTrips.findOne({ tradeId }, { projection: { _id: 0 } });
  }

  async activeJupiterRoundTrips() {
    if (!this.jupiterRoundTrips) throw new Error("MongoDB is not connected");
    return this.jupiterRoundTrips.find(
      { active: true },
      { projection: { _id: 0 } },
    ).sort({ createdAt: 1 }).toArray();
  }

  async jupiterRoundTripRiskState(now = new Date()) {
    if (!this.jupiterRoundTrips) throw new Error("MongoDB is not connected");
    const startOfDay = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    ));
    const [active, attemptsToday, uncertain] = await Promise.all([
      this.jupiterRoundTrips.countDocuments({ active: true }),
      this.jupiterRoundTrips.countDocuments({ createdAt: { $gte: startOfDay } }),
      this.jupiterRoundTrips.countDocuments({
        status: { $in: [
          "ENTRY_SUBMITTED",
          "HEDGE_SUBMITTED",
          "HEDGE_CLOSE_SUBMITTED",
          "EXIT_SUBMITTED",
          "MANUAL_INTERVENTION",
        ] },
      }),
    ]);
    return {
      active,
      attemptsToday,
      hasUnresolvedSubmission: uncertain > 0,
    };
  }

  async listJupiterRoundTrips(limit = 500) {
    if (!this.jupiterRoundTrips) throw new Error("MongoDB is not connected");
    return this.jupiterRoundTrips.find({}, {
      projection: {
        _id: 0,
        entrySignedTransactionBase64: 0,
        exitSignedTransactionBase64: 0,
      },
    }).sort({ createdAt: -1 }).limit(limit).toArray();
  }

  async transitionJupiterRoundTrip(input: {
    tradeId: string;
    expectedVersion: number;
    from: JupiterRoundTripStatus;
    to: JupiterRoundTripStatus;
    reason: string;
    at?: Date;
    patch?: Partial<Omit<JupiterRoundTripTrade, "tradeId" | "version" | "events">>;
    signature?: string;
  }) {
    if (!this.jupiterRoundTrips) throw new Error("MongoDB is not connected");
    assertJupiterRoundTripTransition(input.from, input.to);
    const at = input.at ?? new Date();
    const event: JupiterRoundTripEvent = {
      from: input.from,
      to: input.to,
      at,
      reason: input.reason,
      ...(input.signature ? { signature: input.signature } : {}),
    };
    const terminal = input.to === "CLOSED" || input.to === "FAILED";
    const result = await this.jupiterRoundTrips.findOneAndUpdate(
      { tradeId: input.tradeId, version: input.expectedVersion, status: input.from },
      {
        $set: {
          ...input.patch,
          status: input.to,
          active: terminal ? false : true,
          updatedAt: at,
        },
        $inc: { version: 1 },
        $push: { events: event },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (!result) throw new Error("Jupiter round-trip transition conflict; reload before retrying");
    return result;
  }

  async recordJupiterRoundTripError(input: {
    tradeId: string;
    expectedVersion: number;
    status: JupiterRoundTripStatus;
    message: string;
  }) {
    if (!this.jupiterRoundTrips) throw new Error("MongoDB is not connected");
    const result = await this.jupiterRoundTrips.findOneAndUpdate(
      { tradeId: input.tradeId, version: input.expectedVersion, status: input.status },
      {
        $set: { lastError: input.message.slice(0, 500), updatedAt: new Date() },
        $inc: { version: 1 },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (!result) throw new Error("Jupiter round-trip error update conflict; reload before retrying");
    return result;
  }

  async createTradeIntent(intent: TradeIntent) {
    if (!this.tradeIntents) throw new Error("MongoDB is not connected");
    try {
      await this.tradeIntents.insertOne(intent);
      return { intent, created: true };
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error;
      const existing = await this.tradeIntents.findOne(
        { idempotencyKey: intent.idempotencyKey },
        { projection: { _id: 0 } },
      );
      if (!existing) throw error;
      if (existing.pair !== intent.pair || existing.sizeUsd !== intent.sizeUsd) {
        throw new Error("idempotencyKey is already used for different trade parameters");
      }
      return { intent: existing, created: false };
    }
  }

  async listTradeIntents(limit = 20) {
    if (!this.tradeIntents) throw new Error("MongoDB is not connected");
    return this.tradeIntents
      .find({}, {
        projection: {
          _id: 0,
          signedTransactionBase64: 0,
          "preview.spot.quoteResponse": 0,
        },
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async findTradeIntent(tradeId: string) {
    if (!this.tradeIntents) throw new Error("MongoDB is not connected");
    return this.tradeIntents.findOne({ tradeId }, { projection: { _id: 0 } });
  }

  async saveTradeIntentPreview(input: {
    tradeId: string;
    expectedVersion: number;
    preview: CanaryApprovalPreview;
    fingerprint: string;
  }) {
    if (!this.tradeIntents) throw new Error("MongoDB is not connected");
    const result = await this.tradeIntents.findOneAndUpdate(
      { tradeId: input.tradeId, version: input.expectedVersion, status: "PLANNED" },
      {
        $set: {
          preview: input.preview,
          previewFingerprint: input.fingerprint,
          expiresAt: input.preview.expiresAt,
          updatedAt: input.preview.createdAt,
        },
        $inc: { version: 1 },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (!result) throw new Error("Trade intent preview conflict; reload before retrying");
    return result;
  }

  async saveTradeIntentRecoveryPreview(input: {
    tradeId: string;
    expectedVersion: number;
    sourceStatus: TradeIntentStatus;
    preview: RecoveryPreview;
    fingerprint: string;
  }) {
    if (!this.tradeIntents) throw new Error("MongoDB is not connected");
    const result = await this.tradeIntents.findOneAndUpdate(
      {
        tradeId: input.tradeId,
        version: input.expectedVersion,
        status: input.sourceStatus,
      },
      {
        $set: {
          recoveryPreview: input.preview,
          recoveryFingerprint: input.fingerprint,
          updatedAt: input.preview.createdAt,
        },
        $inc: { version: 1 },
      },
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (!result) throw new Error("Recovery preview conflict; reload before retrying");
    return result;
  }

  async transitionTradeIntent(input: {
    tradeId: string;
    expectedVersion: number;
    from: TradeIntentStatus;
    to: TradeIntentStatus;
    reason?: string;
    patch?: TradeIntentTransitionPatch;
  }) {
    if (!this.tradeIntents) throw new Error("MongoDB is not connected");
    const transition = buildTradeIntentTransition(input);
    const update: Record<string, unknown> = {
      $set: transition.set,
      $inc: {
        version: 1,
        ...(transition.incrementReconciliationAttempts ? { reconciliationAttempts: 1 } : {}),
      },
      $push: { events: transition.event },
    };
    const result = await this.tradeIntents.findOneAndUpdate(
      {
        tradeId: input.tradeId,
        version: input.expectedVersion,
        status: input.from,
      },
      update,
      { returnDocument: "after", projection: { _id: 0 } },
    );
    if (!result) {
      throw new Error("Trade intent transition conflict; reload before retrying");
    }
    return result;
  }

  async recoverableTradeIntents() {
    if (!this.tradeIntents) throw new Error("MongoDB is not connected");
    return this.tradeIntents.find(
      { status: { $in: [...RECOVERABLE_TRADE_INTENT_STATUSES] } },
      { projection: { _id: 0 } },
    ).sort({ updatedAt: 1 }).toArray();
  }

  async canaryRiskState(now = new Date(), excludeTradeId?: string) {
    if (!this.tradeIntents) throw new Error("MongoDB is not connected");
    const startOfDay = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    ));
    const unknownStatuses: TradeIntentStatus[] = [
      "SPOT_ONLY", "PERP_ONLY", "PARTIALLY_HEDGED", "UNCERTAIN",
      "RECOVERING", "MANUAL_INTERVENTION",
    ];
    const openStatuses: TradeIntentStatus[] = [
      "SPOT_SUBMITTED", "SPOT_CONFIRMED", "HEDGE_SUBMITTED", "HEDGED",
      "OPEN", "CLOSE_PLANNED", "CLOSE_SUBMITTED",
    ];
    const exclude = excludeTradeId ? { tradeId: { $ne: excludeTradeId } } : {};
    const [attemptsToday, openPositions, unknownIntents, closed] = await Promise.all([
      this.tradeIntents.countDocuments({
        ...exclude,
        events: { $elemMatch: { to: "APPROVED", at: { $gte: startOfDay } } },
      }),
      this.tradeIntents.countDocuments({ ...exclude, status: { $in: openStatuses } }),
      this.tradeIntents.countDocuments({ ...exclude, status: { $in: unknownStatuses } }),
      this.tradeIntents.find(
        { ...exclude, status: "CLOSED", updatedAt: { $gte: startOfDay } },
        { projection: { _id: 0, realizedPnlUsd: 1 } },
      ).toArray(),
    ]);
    const pnlKnown = closed.every((intent) => Number.isFinite(intent.realizedPnlUsd));
    const realizedPnlTodayUsd = closed.reduce(
      (total, intent) => total + (Number.isFinite(intent.realizedPnlUsd)
        ? Number(intent.realizedPnlUsd)
        : 0),
      0,
    );
    return {
      attemptsToday,
      openPositions,
      realizedPnlTodayUsd,
      hasUnknownIntent: unknownIntents > 0 || !pnlKnown,
    };
  }

  async latestForPair(pair: PairSymbol, sizeUsd: TrackedSize) {
    if (!this.collection) throw new Error("MongoDB is not connected");
    return this.collection.findOne(
      { pair, sizeUsd },
      { projection: { _id: 0 }, sort: { capturedAt: -1 } },
    );
  }

}
