import { Decimal } from "decimal.js";
import type { BackpackOrderOutcome } from "./trade-reconciliation.js";
import type { TradeIntent, TradeIntentStatus, TradeIntentTransitionPatch } from "./trade-intents.js";

interface RecoveryStore {
  transitionTradeIntent(input: {
    tradeId: string;
    expectedVersion: number;
    from: TradeIntent["status"];
    to: TradeIntent["status"];
    reason?: string;
    patch?: TradeIntentTransitionPatch;
  }): Promise<TradeIntent>;
}

export function classifyRecoveryExposure(input: {
  spotQuantity: string;
  perpNetQuantity: string;
  fullRecoveryFill: boolean;
}): TradeIntentStatus {
  const spot = new Decimal(input.spotQuantity);
  const net = new Decimal(input.perpNetQuantity);
  if (!spot.isFinite() || spot.lt(0) || !net.isFinite()) return "MANUAL_INTERVENTION";
  if (net.gt(0)) return "MANUAL_INTERVENTION";
  const short = net.abs();
  if (spot.isZero()) return short.isZero() ? "CLOSED" : "PERP_ONLY";
  if (short.isZero()) return "SPOT_ONLY";
  if (short.gt(spot)) return "MANUAL_INTERVENTION";
  return input.fullRecoveryFill ? "OPEN" : "PARTIALLY_HEDGED";
}

export async function reconcileRecoveryOrder(input: {
  intent: TradeIntent;
  store: RecoveryStore;
  outcome: BackpackOrderOutcome;
  readExposure: () => Promise<{ spotQuantity: string; perpNetQuantity: string }>;
}) {
  if (input.intent.status !== "RECOVERING" && input.intent.status !== "UNCERTAIN") {
    throw new Error("Recovery reconciliation requires RECOVERING or UNCERTAIN");
  }
  if (input.intent.recoveryClientOrderId === null || !input.intent.recoveryPreview) {
    throw new Error("Intent has no reconcilable recovery order");
  }
  if (!["FILLED", "PARTIALLY_FILLED", "CANCELLED"].includes(input.outcome.state)) {
    return { resolved: false, outcome: input.outcome.state, intent: input.intent };
  }
  const exposure = await input.readExposure();
  const to = classifyRecoveryExposure({
    ...exposure,
    fullRecoveryFill: input.outcome.state === "FILLED",
  });
  const patch: TradeIntentTransitionPatch = {
    recoveryOrderId: input.outcome.orderId ?? undefined,
    recoveryFilledQuantity: input.outcome.filledQuantity,
    reconciled: true,
    ...(to === "MANUAL_INTERVENTION"
      ? { lastError: "Recovery order completed with inconsistent factual exposure" }
      : {}),
  };
  const intent = await input.store.transitionTradeIntent({
    tradeId: input.intent.tradeId,
    expectedVersion: input.intent.version,
    from: input.intent.status,
    to,
    reason: `Recovery order ${input.outcome.state.toLowerCase()} and factual exposure reconciled`,
    patch,
  });
  return { resolved: true, outcome: input.outcome.state, intent };
}

export async function confirmRecoveryOrder(input: {
  intent: TradeIntent;
  store: RecoveryStore;
  read: () => Promise<BackpackOrderOutcome>;
  readExposure: () => Promise<{ spotQuantity: string; perpNetQuantity: string }>;
  timeoutMs: number;
  pollIntervalMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  if (input.intent.status !== "RECOVERING") {
    throw new Error("Recovery confirmation requires a RECOVERING intent");
  }
  if (input.timeoutMs <= 0 || input.pollIntervalMs <= 0) {
    throw new Error("Recovery confirmation timing must be positive");
  }
  const now = input.now ?? Date.now;
  const sleep = input.sleep
    ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + input.timeoutMs;
  let last: BackpackOrderOutcome | null = null;
  let lastError: unknown = null;
  while (now() < deadline) {
    try {
      last = await input.read();
      lastError = null;
      if (["FILLED", "PARTIALLY_FILLED", "CANCELLED"].includes(last.state)) {
        return reconcileRecoveryOrder({
          intent: input.intent,
          store: input.store,
          outcome: last,
          readExposure: input.readExposure,
        });
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(input.pollIntervalMs, Math.max(0, deadline - now())));
  }
  const detail = lastError instanceof Error ? lastError.message : last?.state ?? "no result";
  const intent = await input.store.transitionTradeIntent({
    tradeId: input.intent.tradeId,
    expectedVersion: input.intent.version,
    from: "RECOVERING",
    to: "UNCERTAIN",
    reason: "Recovery order was not terminal before the deadline",
    patch: {
      lastError: `Recovery reconciliation deadline exceeded with ${detail}`.slice(0, 500),
      reconciled: true,
    },
  });
  return { resolved: false, outcome: last?.state ?? "NO_RESULT", intent };
}
