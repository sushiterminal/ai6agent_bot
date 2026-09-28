import {
  decideHedgeReconciliation,
  decideSpotReconciliation,
  type BackpackOrderOutcome,
} from "./trade-reconciliation.js";
import type { SolanaTransactionOutcome } from "./solana-simulation.js";
import type { TradeIntent, TradeIntentTransitionPatch } from "./trade-intents.js";

interface ConfirmationStore {
  transitionTradeIntent(input: {
    tradeId: string;
    expectedVersion: number;
    from: TradeIntent["status"];
    to: TradeIntent["status"];
    reason?: string;
    patch?: TradeIntentTransitionPatch;
  }): Promise<TradeIntent>;
}

interface PollOptions {
  timeoutMs: number;
  pollIntervalMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function validatePollOptions(options: PollOptions) {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Confirmation timeout must be positive");
  }
  if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    throw new Error("Confirmation poll interval must be positive");
  }
}

function boundedError(operation: string, error: unknown) {
  const message = error instanceof Error ? error.message : "unknown read error";
  return `${operation} reconciliation deadline exceeded: ${message}`.slice(0, 500);
}

export async function confirmSubmittedSpot(input: {
  intent: TradeIntent;
  tokenDecimals: number;
  store: ConfirmationStore;
  read: () => Promise<SolanaTransactionOutcome>;
  options: PollOptions;
}) {
  if (input.intent.status !== "SPOT_SUBMITTED") {
    throw new Error("Spot confirmation requires a SPOT_SUBMITTED intent");
  }
  validatePollOptions(input.options);
  const now = input.options.now ?? Date.now;
  const sleep = input.options.sleep
    ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + input.options.timeoutMs;
  let lastOutcome: SolanaTransactionOutcome | null = null;
  let lastError: unknown = null;
  while (now() < deadline) {
    try {
      lastOutcome = await input.read();
      lastError = null;
      if (lastOutcome.state === "FAILED") break;
      if (lastOutcome.state === "CONFIRMED" && lastOutcome.confirmationStatus === "finalized") break;
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(input.options.pollIntervalMs, Math.max(0, deadline - now())));
  }
  if (
    lastOutcome?.state === "CONFIRMED"
    && lastOutcome.confirmationStatus === "finalized"
  ) {
    const decision = decideSpotReconciliation(lastOutcome, input.tokenDecimals);
    return input.store.transitionTradeIntent({
      tradeId: input.intent.tradeId,
      expectedVersion: input.intent.version,
      from: "SPOT_SUBMITTED",
      to: decision.to,
      reason: decision.reason,
      patch: decision.patch,
    });
  }
  if (lastOutcome?.state === "FAILED") {
    const decision = decideSpotReconciliation(lastOutcome, input.tokenDecimals);
    return input.store.transitionTradeIntent({
      tradeId: input.intent.tradeId,
      expectedVersion: input.intent.version,
      from: "SPOT_SUBMITTED",
      to: decision.to,
      reason: decision.reason,
      patch: decision.patch,
    });
  }
  const description = lastError
    ? boundedError("Solana", lastError)
    : `Solana reconciliation deadline exceeded with ${lastOutcome?.state ?? "no result"}`;
  return input.store.transitionTradeIntent({
    tradeId: input.intent.tradeId,
    expectedVersion: input.intent.version,
    from: "SPOT_SUBMITTED",
    to: "UNCERTAIN",
    reason: "Solana transaction was not finalized before the deadline",
    patch: { lastError: description, reconciled: true },
  });
}

export async function confirmSubmittedHedge(input: {
  intent: TradeIntent;
  store: ConfirmationStore;
  read: () => Promise<BackpackOrderOutcome>;
  options: PollOptions;
}) {
  if (input.intent.status !== "HEDGE_SUBMITTED") {
    throw new Error("Hedge confirmation requires a HEDGE_SUBMITTED intent");
  }
  validatePollOptions(input.options);
  const now = input.options.now ?? Date.now;
  const sleep = input.options.sleep
    ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + input.options.timeoutMs;
  let lastOutcome: BackpackOrderOutcome | null = null;
  let lastError: unknown = null;
  while (now() < deadline) {
    try {
      lastOutcome = await input.read();
      lastError = null;
      if (["FILLED", "PARTIALLY_FILLED", "CANCELLED"].includes(lastOutcome.state)) break;
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(input.options.pollIntervalMs, Math.max(0, deadline - now())));
  }
  if (lastOutcome && ["FILLED", "PARTIALLY_FILLED", "CANCELLED"].includes(lastOutcome.state)) {
    const decision = decideHedgeReconciliation(lastOutcome);
    const transitioned = await input.store.transitionTradeIntent({
      tradeId: input.intent.tradeId,
      expectedVersion: input.intent.version,
      from: "HEDGE_SUBMITTED",
      to: decision.to,
      reason: decision.reason,
      patch: decision.patch,
    });
    if (transitioned.status !== "HEDGED") return transitioned;
    return input.store.transitionTradeIntent({
      tradeId: transitioned.tradeId,
      expectedVersion: transitioned.version,
      from: "HEDGED",
      to: "OPEN",
      reason: "Both entry legs confirmed",
    });
  }
  const description = lastError
    ? boundedError("Backpack", lastError)
    : `Backpack reconciliation deadline exceeded with ${lastOutcome?.state ?? "no result"}`;
  return input.store.transitionTradeIntent({
    tradeId: input.intent.tradeId,
    expectedVersion: input.intent.version,
    from: "HEDGE_SUBMITTED",
    to: "UNCERTAIN",
    reason: "Backpack hedge was not terminal before the deadline",
    patch: { lastError: description, reconciled: true },
  });
}
