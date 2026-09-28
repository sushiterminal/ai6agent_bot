import type { PairSymbol } from "./types.js";
import { CANARY_SIZE } from "./types.js";
import type { CanaryApprovalPreview } from "./canary-approval.js";
import type { RecoveryPreview } from "./recovery-preview.js";

export type TradeIntentStatus =
  | "PLANNED"
  | "APPROVED"
  | "SPOT_SUBMITTED"
  | "SPOT_CONFIRMED"
  | "HEDGE_SUBMITTED"
  | "HEDGED"
  | "OPEN"
  | "CLOSE_PLANNED"
  | "CLOSE_SUBMITTED"
  | "CLOSED"
  | "SPOT_ONLY"
  | "PERP_ONLY"
  | "PARTIALLY_HEDGED"
  | "UNCERTAIN"
  | "RECOVERING"
  | "MANUAL_INTERVENTION"
  | "FAILED";

export interface TradeIntent {
  tradeId: string;
  idempotencyKey: string;
  pair: PairSymbol;
  basisRisk: "same_issuer" | "cross_issuer";
  sizeUsd: typeof CANARY_SIZE;
  status: TradeIntentStatus;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  preview: CanaryApprovalPreview | null;
  previewFingerprint: string | null;
  recoveryPreview: RecoveryPreview | null;
  recoveryFingerprint: string | null;
  recoveryClientOrderId: number | null;
  recoveryOrderId: string | null;
  recoveryFilledQuantity: string | null;
  solanaSignature: string | null;
  signedTransactionBase64: string | null;
  backpackClientOrderId: number | null;
  backpackOrderId: string | null;
  spotFilledQuantity: string | null;
  hedgeFilledQuantity: string | null;
  realizedPnlUsd: number | null;
  reconciliationAttempts: number;
  lastReconciledAt: Date | null;
  lastError: string | null;
  events: TradeIntentEvent[];
}

export interface TradeIntentEvent {
  from: TradeIntentStatus | null;
  to: TradeIntentStatus;
  at: Date;
  reason: string | null;
}

export const RECOVERABLE_TRADE_INTENT_STATUSES: readonly TradeIntentStatus[] = [
  "APPROVED", "SPOT_SUBMITTED", "SPOT_CONFIRMED", "HEDGE_SUBMITTED", "HEDGED",
  "OPEN", "CLOSE_PLANNED", "CLOSE_SUBMITTED", "SPOT_ONLY", "PERP_ONLY",
  "PARTIALLY_HEDGED", "UNCERTAIN", "RECOVERING", "MANUAL_INTERVENTION",
];

const transitions: Record<TradeIntentStatus, readonly TradeIntentStatus[]> = {
  PLANNED: ["APPROVED", "FAILED"],
  APPROVED: ["SPOT_SUBMITTED", "FAILED"],
  SPOT_SUBMITTED: ["SPOT_CONFIRMED", "UNCERTAIN", "FAILED"],
  SPOT_CONFIRMED: ["HEDGE_SUBMITTED", "SPOT_ONLY", "RECOVERING"],
  HEDGE_SUBMITTED: ["HEDGED", "SPOT_ONLY", "PARTIALLY_HEDGED", "UNCERTAIN", "FAILED"],
  HEDGED: ["OPEN", "RECOVERING"],
  OPEN: ["CLOSE_PLANNED", "MANUAL_INTERVENTION"],
  CLOSE_PLANNED: ["CLOSE_SUBMITTED", "MANUAL_INTERVENTION"],
  CLOSE_SUBMITTED: ["CLOSED", "UNCERTAIN", "PARTIALLY_HEDGED"],
  SPOT_ONLY: ["RECOVERING", "MANUAL_INTERVENTION"],
  PERP_ONLY: ["RECOVERING", "MANUAL_INTERVENTION"],
  PARTIALLY_HEDGED: ["RECOVERING", "MANUAL_INTERVENTION"],
  UNCERTAIN: [
    "SPOT_CONFIRMED",
    "HEDGED",
    "OPEN",
    "CLOSED",
    "SPOT_ONLY",
    "PERP_ONLY",
    "PARTIALLY_HEDGED",
    "FAILED",
    "RECOVERING",
    "MANUAL_INTERVENTION",
  ],
  RECOVERING: [
    "OPEN",
    "CLOSED",
    "SPOT_ONLY",
    "PERP_ONLY",
    "PARTIALLY_HEDGED",
    "UNCERTAIN",
    "MANUAL_INTERVENTION",
    "FAILED",
  ],
  MANUAL_INTERVENTION: ["RECOVERING", "CLOSED", "FAILED"],
  CLOSED: [],
  FAILED: [],
};

export function assertTradeIntentTransition(from: TradeIntentStatus, to: TradeIntentStatus) {
  if (!transitions[from].includes(to)) {
    throw new Error(`Invalid trade intent transition ${from} -> ${to}`);
  }
}

export function createTradeIntent(input: {
  tradeId: string;
  idempotencyKey: string;
  pair: PairSymbol;
  basisRisk: TradeIntent["basisRisk"];
  now?: Date;
  ttlMs?: number;
}): TradeIntent {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) {
    throw new Error("idempotencyKey must contain 8-128 safe characters");
  }
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? 5 * 60_000;
  return {
    tradeId: input.tradeId,
    idempotencyKey: input.idempotencyKey,
    pair: input.pair,
    basisRisk: input.basisRisk,
    sizeUsd: CANARY_SIZE,
    status: "PLANNED",
    version: 1,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
    preview: null,
    previewFingerprint: null,
    recoveryPreview: null,
    recoveryFingerprint: null,
    recoveryClientOrderId: null,
    recoveryOrderId: null,
    recoveryFilledQuantity: null,
    solanaSignature: null,
    signedTransactionBase64: null,
    backpackClientOrderId: null,
    backpackOrderId: null,
    spotFilledQuantity: null,
    hedgeFilledQuantity: null,
    realizedPnlUsd: null,
    reconciliationAttempts: 0,
    lastReconciledAt: null,
    lastError: null,
    events: [{ from: null, to: "PLANNED", at: now, reason: null }],
  };
}

export interface TradeIntentTransitionPatch {
  solanaSignature?: string;
  signedTransactionBase64?: string;
  backpackClientOrderId?: number;
  backpackOrderId?: string;
  spotFilledQuantity?: string;
  hedgeFilledQuantity?: string;
  recoveryClientOrderId?: number;
  recoveryOrderId?: string;
  recoveryFilledQuantity?: string;
  realizedPnlUsd?: number;
  lastError?: string;
  reconciled?: boolean;
}

export function buildTradeIntentTransition(input: {
  from: TradeIntentStatus;
  to: TradeIntentStatus;
  now?: Date;
  reason?: string;
  patch?: TradeIntentTransitionPatch;
}) {
  assertTradeIntentTransition(input.from, input.to);
  const patch = input.patch ?? {};
  if (input.to === "SPOT_SUBMITTED" && (!patch.solanaSignature || !patch.signedTransactionBase64)) {
    throw new Error("SPOT_SUBMITTED requires a signature and signed transaction");
  }
  if (input.to === "HEDGE_SUBMITTED" && patch.backpackClientOrderId === undefined) {
    throw new Error("HEDGE_SUBMITTED requires a Backpack client order id");
  }
  if (input.to === "RECOVERING" && patch.recoveryClientOrderId === undefined) {
    throw new Error("RECOVERING requires a recovery client order id");
  }
  if (input.to === "UNCERTAIN" && !patch.lastError) {
    throw new Error("UNCERTAIN requires an explicit error");
  }
  const at = input.now ?? new Date();
  const set: Record<string, unknown> = { status: input.to, updatedAt: at };
  for (const [key, value] of Object.entries(patch)) {
    if (key !== "reconciled") set[key] = value;
  }
  if (patch.reconciled) set.lastReconciledAt = at;
  return {
    set,
    incrementReconciliationAttempts: patch.reconciled === true,
    event: {
      from: input.from,
      to: input.to,
      at,
      reason: input.reason ?? null,
    } satisfies TradeIntentEvent,
  };
}
