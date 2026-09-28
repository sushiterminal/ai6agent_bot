import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import type { PairSymbol } from "./types.js";
import { CANARY_SIZE } from "./types.js";
import type { TradeIntentStatus } from "./trade-intents.js";
import { buildIocLimitPreview } from "./canary-write-adapter.js";

export type RecoveryAction =
  | "COMPLETE_HEDGE"
  | "CLOSE_HEDGE"
  | "FINALIZE_OPEN"
  | "RECONCILE_ONLY"
  | "MANUAL_INTERVENTION";

export interface RecoveryPreview {
  tradeId: string;
  pair: PairSymbol;
  sourceStatus: TradeIntentStatus;
  sizeUsd: typeof CANARY_SIZE;
  createdAt: Date;
  expiresAt: Date;
  exposure: {
    spotQuantity: string;
    perpNetQuantity: string;
    shortQuantity: string;
    unhedgedSpotQuantity: string;
  };
  action: RecoveryAction;
  requestedQuantity: string;
  quantity: string;
  order: ReturnType<typeof buildIocLimitPreview> | null;
  executable: boolean;
  blockers: string[];
}

const supportedStatuses: readonly TradeIntentStatus[] = [
  "SPOT_ONLY",
  "PARTIALLY_HEDGED",
  "PERP_ONLY",
  "UNCERTAIN",
];

function quantity(value: string, label: string) {
  const parsed = new Decimal(value);
  if (!parsed.isFinite() || parsed.lt(0)) throw new Error(`${label} must be a non-negative quantity`);
  return parsed;
}

export function buildRecoveryPreview(input: {
  tradeId: string;
  pair: PairSymbol;
  sourceStatus: TradeIntentStatus;
  spotQuantity: string;
  perpNetQuantity: string;
  now?: Date;
  ttlMs: number;
  market?: {
    bestBid: string;
    bestAsk: string;
    tickSize: string;
    quantityStep: string;
    minimumQuantity: string;
    maximumQuantity: string | null;
    slippagePct: number;
  };
}): RecoveryPreview {
  if (!supportedStatuses.includes(input.sourceStatus)) {
    throw new Error(`Recovery preview is not supported from ${input.sourceStatus}`);
  }
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error("Recovery preview TTL must be a positive integer");
  }
  const spot = quantity(input.spotQuantity, "Spot exposure");
  const perpNet = new Decimal(input.perpNetQuantity);
  if (!perpNet.isFinite()) throw new Error("Perp exposure must be finite");
  const short = Decimal.max(perpNet.negated(), 0);
  const unhedged = Decimal.max(spot.minus(short), 0);
  const blockers: string[] = [];
  let action: RecoveryAction = "MANUAL_INTERVENTION";
  let actionQuantity = new Decimal(0);
  let orderQuantity = new Decimal(0);
  let order: RecoveryPreview["order"] = null;

  if (input.sourceStatus === "UNCERTAIN") {
    action = "RECONCILE_ONLY";
    blockers.push("unknownExternalOutcome");
  } else if (perpNet.gt(0)) {
    blockers.push("unexpectedLongPerpExposure");
  } else if (spot.gt(0) && short.eq(spot)) {
    action = "FINALIZE_OPEN";
  } else if (spot.gt(short)) {
    action = "COMPLETE_HEDGE";
    actionQuantity = spot.minus(short);
  } else if (short.gt(spot) && spot.eq(0)) {
    action = "CLOSE_HEDGE";
    actionQuantity = short;
  } else if (short.gt(spot)) {
    blockers.push("overHedgedExposure");
  } else {
    blockers.push("noRecoverableExposure");
  }

  if (action === "COMPLETE_HEDGE" || action === "CLOSE_HEDGE") {
    if (!input.market) {
      blockers.push("missingMarketBounds");
    } else {
      const step = quantity(input.market.quantityStep, "Quantity step");
      const minimum = quantity(input.market.minimumQuantity, "Minimum quantity");
      const maximum = input.market.maximumQuantity === null
        ? null
        : quantity(input.market.maximumQuantity, "Maximum quantity");
      if (step.isZero()) throw new Error("Quantity step must be positive");
      orderQuantity = actionQuantity.div(step).floor().mul(step);
      if (orderQuantity.lt(minimum)) blockers.push("quantityBelowMinimum");
      if (maximum && orderQuantity.gt(maximum)) blockers.push("quantityAboveMaximum");
      order = buildIocLimitPreview({
        side: action === "COMPLETE_HEDGE" ? "Ask" : "Bid",
        bestPrice: action === "COMPLETE_HEDGE" ? input.market.bestBid : input.market.bestAsk,
        tickSize: input.market.tickSize,
        slippagePct: input.market.slippagePct,
      });
    }
  }

  const createdAt = input.now ?? new Date();
  return {
    tradeId: input.tradeId,
    pair: input.pair,
    sourceStatus: input.sourceStatus,
    sizeUsd: CANARY_SIZE,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + input.ttlMs),
    exposure: {
      spotQuantity: spot.toString(),
      perpNetQuantity: perpNet.toString(),
      shortQuantity: short.toString(),
      unhedgedSpotQuantity: unhedged.toString(),
    },
    action,
    requestedQuantity: actionQuantity.toString(),
    quantity: orderQuantity.toString(),
    order,
    executable: blockers.length === 0,
    blockers,
  };
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function fingerprintRecoveryPreview(preview: RecoveryPreview) {
  return createHash("sha256").update(JSON.stringify(canonical(preview))).digest("hex");
}

export function expectedRecoveryApprovalText(tradeId: string, fingerprint: string) {
  return `APPROVE RECOVERY $${CANARY_SIZE} ${tradeId} ${fingerprint}`;
}

export function assertRecoveryApproval(input: {
  preview: RecoveryPreview;
  fingerprint: string;
  approval: string;
  now?: Date;
}) {
  if (fingerprintRecoveryPreview(input.preview) !== input.fingerprint) {
    throw new Error("Recovery preview fingerprint mismatch");
  }
  if ((input.now ?? new Date()).getTime() >= input.preview.expiresAt.getTime()) {
    throw new Error("Recovery preview has expired");
  }
  if (!input.preview.executable) throw new Error("Recovery preview is not executable");
  if (input.approval !== expectedRecoveryApprovalText(input.preview.tradeId, input.fingerprint)) {
    throw new Error("Recovery approval text mismatch");
  }
}
