import type { SolanaTransactionOutcome } from "./solana-simulation.js";
import {
  decideHedgeReconciliation,
  decideSpotReconciliation,
  type BackpackOrderOutcome,
} from "./trade-reconciliation.js";
import type { TradeIntent, TradeIntentTransitionPatch } from "./trade-intents.js";

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

export interface UncertainRecoveryResult {
  resolved: boolean;
  leg: "SPOT" | "HEDGE" | "UNKNOWN";
  outcome: string;
  intent: TradeIntent;
}

export async function recoverUncertainIntent(input: {
  intent: TradeIntent;
  tokenDecimals: number;
  store: RecoveryStore;
  readSpot: () => Promise<SolanaTransactionOutcome>;
  readHedge: () => Promise<BackpackOrderOutcome>;
}): Promise<UncertainRecoveryResult> {
  if (input.intent.status !== "UNCERTAIN") {
    throw new Error("Uncertain recovery requires an UNCERTAIN intent");
  }

  if (input.intent.backpackClientOrderId !== null) {
    const outcome = await input.readHedge();
    if (!["FILLED", "PARTIALLY_FILLED", "CANCELLED"].includes(outcome.state)) {
      return { resolved: false, leg: "HEDGE", outcome: outcome.state, intent: input.intent };
    }
    const decision = decideHedgeReconciliation(outcome);
    const intent = await input.store.transitionTradeIntent({
      tradeId: input.intent.tradeId,
      expectedVersion: input.intent.version,
      from: "UNCERTAIN",
      to: decision.to,
      reason: `Uncertain Backpack submission resolved: ${decision.reason}`,
      patch: decision.patch,
    });
    return { resolved: true, leg: "HEDGE", outcome: outcome.state, intent };
  }

  if (input.intent.solanaSignature) {
    const outcome = await input.readSpot();
    const isFinalized = outcome.state === "CONFIRMED" && outcome.confirmationStatus === "finalized";
    if (!isFinalized && outcome.state !== "FAILED") {
      return { resolved: false, leg: "SPOT", outcome: outcome.state, intent: input.intent };
    }
    const decision = decideSpotReconciliation(outcome, input.tokenDecimals);
    const intent = await input.store.transitionTradeIntent({
      tradeId: input.intent.tradeId,
      expectedVersion: input.intent.version,
      from: "UNCERTAIN",
      to: decision.to,
      reason: `Uncertain Solana broadcast resolved: ${decision.reason}`,
      patch: decision.patch,
    });
    return { resolved: true, leg: "SPOT", outcome: outcome.state, intent };
  }

  const intent = await input.store.transitionTradeIntent({
    tradeId: input.intent.tradeId,
    expectedVersion: input.intent.version,
    from: "UNCERTAIN",
    to: "MANUAL_INTERVENTION",
    reason: "Uncertain intent has no durable external operation identifier",
    patch: { lastError: "Cannot reconcile uncertain intent without an external operation identifier" },
  });
  return { resolved: true, leg: "UNKNOWN", outcome: "MISSING_EXTERNAL_ID", intent };
}
