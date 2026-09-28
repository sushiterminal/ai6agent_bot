import { createHash } from "node:crypto";
import {
  assertSupervisedExecution,
  type SupervisedExecutionGate,
} from "./canary-write-adapter.js";
import { assertRecoveryApproval } from "./recovery-preview.js";
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

export interface RecoverySubmissionResult {
  tradeId: string;
  status: "RECOVERING" | "UNCERTAIN";
  clientOrderId: number;
  orderId: string | null;
  requiresReconciliation: true;
}

export function recoveryClientOrderId(fingerprint: string) {
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) throw new Error("Invalid recovery fingerprint");
  const value = createHash("sha256")
    .update(`${fingerprint}:BACKPACK_RECOVERY`)
    .digest()
    .readUInt32BE(0);
  return value === 0 ? 1 : value;
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown response";
  return `Backpack recovery submission outcome is unknown: ${message}`.slice(0, 500);
}

export async function submitApprovedRecoveryOrder(input: {
  intent: TradeIntent;
  recoveryApproval: string;
  executionApproval: string;
  gate: SupervisedExecutionGate;
  store: RecoveryStore;
  preflight: () => Promise<void>;
  send: (clientOrderId: number) => Promise<{ orderId: string | null }>;
  now?: Date;
}): Promise<RecoverySubmissionResult> {
  if (!(["SPOT_ONLY", "PARTIALLY_HEDGED", "PERP_ONLY"] as const).includes(
    input.intent.status as "SPOT_ONLY" | "PARTIALLY_HEDGED" | "PERP_ONLY",
  )) {
    throw new Error(`Recovery order cannot start from ${input.intent.status}`);
  }
  if (!input.intent.recoveryPreview || !input.intent.recoveryFingerprint) {
    throw new Error("Trade intent has no immutable recovery preview");
  }
  if (input.intent.recoveryPreview.sourceStatus !== input.intent.status) {
    throw new Error("Recovery preview source status mismatch");
  }
  if (!["COMPLETE_HEDGE", "CLOSE_HEDGE"].includes(input.intent.recoveryPreview.action)) {
    throw new Error(`Recovery action ${input.intent.recoveryPreview.action} is not an order action`);
  }
  assertSupervisedExecution({
    gate: input.gate,
    tradeId: input.intent.tradeId,
    approval: input.executionApproval,
  });
  assertRecoveryApproval({
    preview: input.intent.recoveryPreview,
    fingerprint: input.intent.recoveryFingerprint,
    approval: input.recoveryApproval,
    now: input.now,
  });
  await input.preflight();
  const clientOrderId = recoveryClientOrderId(input.intent.recoveryFingerprint);
  const recovering = await input.store.transitionTradeIntent({
    tradeId: input.intent.tradeId,
    expectedVersion: input.intent.version,
    from: input.intent.status,
    to: "RECOVERING",
    reason: `Recovery ${input.intent.recoveryPreview.action} client id persisted before submission`,
    patch: { recoveryClientOrderId: clientOrderId },
  });
  try {
    const response = await input.send(clientOrderId);
    return {
      tradeId: recovering.tradeId,
      status: "RECOVERING",
      clientOrderId,
      orderId: response.orderId,
      requiresReconciliation: true,
    };
  } catch (error) {
    const uncertain = await input.store.transitionTradeIntent({
      tradeId: recovering.tradeId,
      expectedVersion: recovering.version,
      from: "RECOVERING",
      to: "UNCERTAIN",
      reason: "Recovery order submission did not return a trustworthy result",
      patch: { lastError: safeError(error) },
    });
    return {
      tradeId: uncertain.tradeId,
      status: "UNCERTAIN",
      clientOrderId,
      orderId: null,
      requiresReconciliation: true,
    };
  }
}
