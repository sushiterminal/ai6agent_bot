import type { TradeIntent } from "./trade-intents.js";

interface TransitionStore {
  transitionTradeIntent(input: {
    tradeId: string;
    expectedVersion: number;
    from: TradeIntent["status"];
    to: TradeIntent["status"];
    reason?: string;
    patch?: {
      solanaSignature?: string;
      signedTransactionBase64?: string;
      backpackClientOrderId?: number;
      lastError?: string;
    };
  }): Promise<TradeIntent>;
}

export interface SubmittedExecutionResult {
  tradeId: string;
  status: "SPOT_SUBMITTED" | "HEDGE_SUBMITTED" | "UNCERTAIN";
  externalId: string | null;
  requiresReconciliation: true;
}

function safeError(operation: string, error: unknown) {
  const message = error instanceof Error ? error.message : "unknown response";
  return `${operation} outcome is unknown: ${message}`.slice(0, 500);
}

export async function submitSpotOnce(input: {
  intent: TradeIntent;
  store: TransitionStore;
  prepare: () => Promise<{ signature: string; signedTransactionBase64: string }>;
  send: (signedTransactionBase64: string) => Promise<string>;
}): Promise<SubmittedExecutionResult> {
  if (input.intent.status !== "APPROVED") {
    throw new Error("Spot execution requires an APPROVED intent");
  }
  const prepared = await input.prepare();
  const submitted = await input.store.transitionTradeIntent({
    tradeId: input.intent.tradeId,
    expectedVersion: input.intent.version,
    from: "APPROVED",
    to: "SPOT_SUBMITTED",
    reason: "Signed Solana transaction persisted before broadcast",
    patch: {
      solanaSignature: prepared.signature,
      signedTransactionBase64: prepared.signedTransactionBase64,
    },
  });
  try {
    const returnedSignature = await input.send(prepared.signedTransactionBase64);
    if (returnedSignature !== prepared.signature) {
      throw new Error("RPC returned a different transaction signature");
    }
    return {
      tradeId: submitted.tradeId,
      status: "SPOT_SUBMITTED",
      externalId: prepared.signature,
      requiresReconciliation: true,
    };
  } catch (error) {
    const uncertain = await input.store.transitionTradeIntent({
      tradeId: submitted.tradeId,
      expectedVersion: submitted.version,
      from: "SPOT_SUBMITTED",
      to: "UNCERTAIN",
      reason: "Solana broadcast did not return a trustworthy result",
      patch: { lastError: safeError("Solana broadcast", error) },
    });
    return {
      tradeId: uncertain.tradeId,
      status: "UNCERTAIN",
      externalId: prepared.signature,
      requiresReconciliation: true,
    };
  }
}

export async function submitHedgeOnce(input: {
  intent: TradeIntent;
  clientOrderId: number;
  store: TransitionStore;
  send: (clientOrderId: number) => Promise<{ orderId: string | null }>;
}): Promise<SubmittedExecutionResult> {
  if (input.intent.status !== "SPOT_CONFIRMED") {
    throw new Error("Hedge execution requires a SPOT_CONFIRMED intent");
  }
  if (!Number.isSafeInteger(input.clientOrderId) || input.clientOrderId <= 0) {
    throw new Error("Backpack client order id must be a positive safe integer");
  }
  const submitted = await input.store.transitionTradeIntent({
    tradeId: input.intent.tradeId,
    expectedVersion: input.intent.version,
    from: "SPOT_CONFIRMED",
    to: "HEDGE_SUBMITTED",
    reason: "Backpack client order id persisted before order submission",
    patch: { backpackClientOrderId: input.clientOrderId },
  });
  try {
    const response = await input.send(input.clientOrderId);
    return {
      tradeId: submitted.tradeId,
      status: "HEDGE_SUBMITTED",
      externalId: response.orderId,
      requiresReconciliation: true,
    };
  } catch (error) {
    const uncertain = await input.store.transitionTradeIntent({
      tradeId: submitted.tradeId,
      expectedVersion: submitted.version,
      from: "HEDGE_SUBMITTED",
      to: "UNCERTAIN",
      reason: "Backpack submission did not return a trustworthy result",
      patch: { lastError: safeError("Backpack submission", error) },
    });
    return {
      tradeId: uncertain.tradeId,
      status: "UNCERTAIN",
      externalId: String(input.clientOrderId),
      requiresReconciliation: true,
    };
  }
}
