import { createHash } from "node:crypto";
import {
  assertCanaryPreviewIntegrity,
  assertCanaryPreviewReady,
} from "./canary-approval.js";
import {
  assertSupervisedExecution,
  type SupervisedExecutionGate,
} from "./canary-write-adapter.js";
import { submitHedgeOnce, submitSpotOnce } from "./execution-coordinator.js";
import type { TradeIntent } from "./trade-intents.js";

type SpotStore = Parameters<typeof submitSpotOnce>[0]["store"];

export async function executeApprovedSpot(input: {
  intent: TradeIntent;
  approval: string;
  gate: SupervisedExecutionGate;
  store: SpotStore;
  preflight: () => Promise<void>;
  prepare: () => Promise<{ signature: string; signedTransactionBase64: string }>;
  send: (signedTransactionBase64: string) => Promise<string>;
  now?: Date;
}) {
  if (input.intent.status !== "APPROVED") {
    throw new Error("Spot execution requires an APPROVED intent");
  }
  if (!input.intent.preview || !input.intent.previewFingerprint) {
    throw new Error("Approved intent has no immutable preview");
  }
  assertSupervisedExecution({
    gate: input.gate,
    tradeId: input.intent.tradeId,
    approval: input.approval,
  });
  assertCanaryPreviewReady({
    preview: input.intent.preview,
    fingerprint: input.intent.previewFingerprint,
    now: input.now,
  });
  await input.preflight();
  return submitSpotOnce({
    intent: input.intent,
    store: input.store,
    prepare: input.prepare,
    send: input.send,
  });
}

export function backpackClientOrderId(tradeId: string, leg: "OPEN_HEDGE" | "CLOSE_HEDGE") {
  const value = createHash("sha256").update(`${tradeId}:${leg}`).digest().readUInt32BE(0);
  return value === 0 ? 1 : value;
}

export async function executeConfirmedHedge(input: {
  intent: TradeIntent;
  approval: string;
  gate: SupervisedExecutionGate;
  store: SpotStore;
  preflight: () => Promise<void>;
  send: (clientOrderId: number) => Promise<{ orderId: string | null }>;
}) {
  if (input.intent.status !== "SPOT_CONFIRMED") {
    throw new Error("Hedge execution requires a SPOT_CONFIRMED intent");
  }
  if (!input.intent.preview || !input.intent.previewFingerprint) {
    throw new Error("Confirmed intent has no immutable preview");
  }
  if (!input.intent.spotFilledQuantity) {
    throw new Error("Confirmed intent has no actual spot fill quantity");
  }
  assertSupervisedExecution({
    gate: input.gate,
    tradeId: input.intent.tradeId,
    approval: input.approval,
  });
  assertCanaryPreviewIntegrity({
    preview: input.intent.preview,
    fingerprint: input.intent.previewFingerprint,
  });
  await input.preflight();
  return submitHedgeOnce({
    intent: input.intent,
    clientOrderId: backpackClientOrderId(input.intent.tradeId, "OPEN_HEDGE"),
    store: input.store,
    send: input.send,
  });
}
