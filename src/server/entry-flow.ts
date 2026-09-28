import type { SubmittedExecutionResult } from "./execution-coordinator.js";
import type { TradeIntent } from "./trade-intents.js";

export interface SupervisedEntryFlowDependencies {
  reload(tradeId: string): Promise<TradeIntent>;
  executeSpot(intent: TradeIntent): Promise<SubmittedExecutionResult>;
  confirmSpot(intent: TradeIntent): Promise<TradeIntent>;
  executeHedge(intent: TradeIntent): Promise<SubmittedExecutionResult>;
  confirmHedge(intent: TradeIntent): Promise<TradeIntent>;
  finalizeHedged(intent: TradeIntent): Promise<TradeIntent>;
  markSpotOnly(intent: TradeIntent, error: Error): Promise<TradeIntent>;
}

const resumableStatuses: readonly TradeIntent["status"][] = [
  "APPROVED",
  "SPOT_SUBMITTED",
  "SPOT_CONFIRMED",
  "HEDGE_SUBMITTED",
  "HEDGED",
  "OPEN",
];

export async function runSupervisedEntryFlow(input: {
  intent: TradeIntent;
  dependencies: SupervisedEntryFlowDependencies;
}) {
  const { dependencies } = input;
  let intent = input.intent;
  if (!resumableStatuses.includes(intent.status)) {
    throw new Error(`Cannot run entry flow from ${intent.status}`);
  }

  if (intent.status === "APPROVED") {
    const submission = await dependencies.executeSpot(intent);
    intent = await dependencies.reload(intent.tradeId);
    if (submission.status === "UNCERTAIN" || intent.status !== "SPOT_SUBMITTED") return intent;
  }

  if (intent.status === "SPOT_SUBMITTED") {
    intent = await dependencies.confirmSpot(intent);
    if (intent.status !== "SPOT_CONFIRMED") return intent;
  }

  if (intent.status === "SPOT_CONFIRMED") {
    try {
      const submission = await dependencies.executeHedge(intent);
      intent = await dependencies.reload(intent.tradeId);
      if (submission.status === "UNCERTAIN" || intent.status !== "HEDGE_SUBMITTED") return intent;
    } catch (error) {
      const current = await dependencies.reload(intent.tradeId);
      if (current.status !== "SPOT_CONFIRMED" || current.version !== intent.version) return current;
      const normalized = error instanceof Error ? error : new Error("Unknown hedge preparation error");
      return dependencies.markSpotOnly(current, normalized);
    }
  }

  if (intent.status === "HEDGE_SUBMITTED") {
    return dependencies.confirmHedge(intent);
  }

  if (intent.status === "HEDGED") {
    return dependencies.finalizeHedged(intent);
  }

  return intent;
}
