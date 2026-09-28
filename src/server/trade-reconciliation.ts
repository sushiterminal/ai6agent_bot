import { Decimal } from "decimal.js";
import type {
  BackpackFill,
  BackpackHistoricalOrder,
  BackpackOpenOrder,
} from "./backpack.js";
import type { SolanaTransactionOutcome } from "./solana-simulation.js";
import type {
  TradeIntentStatus,
  TradeIntentTransitionPatch,
} from "./trade-intents.js";

export interface BackpackOrderOutcome {
  state: "NOT_FOUND" | "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED";
  orderId: string | null;
  filledQuantity: string;
  fillCount: number;
  status: string | null;
}

export interface ReconciliationDecision {
  to: TradeIntentStatus;
  reason: string;
  patch: TradeIntentTransitionPatch;
}

export function decideSpotReconciliation(
  outcome: SolanaTransactionOutcome,
  tokenDecimals: number,
): ReconciliationDecision {
  if (outcome.state === "CONFIRMED" && outcome.tokenDeltaRaw !== null) {
    const quantity = new Decimal(outcome.tokenDeltaRaw).div(new Decimal(10).pow(tokenDecimals));
    if (quantity.greaterThan(0)) {
      return {
        to: "SPOT_CONFIRMED",
        reason: `Solana signature ${outcome.confirmationStatus ?? "confirmed"}`,
        patch: { spotFilledQuantity: quantity.toString(), reconciled: true },
      };
    }
    return {
      to: "UNCERTAIN",
      reason: "Solana transaction confirmed without positive target-token delta",
      patch: {
        lastError: "Confirmed Solana transaction has no positive target-token fill",
        reconciled: true,
      },
    };
  }
  if (outcome.state === "FAILED") {
    return {
      to: "FAILED",
      reason: "Solana transaction failed on chain",
      patch: { lastError: "Solana transaction failed on chain", reconciled: true },
    };
  }
  return {
    to: "UNCERTAIN",
    reason: `Solana signature is ${outcome.state.toLowerCase()}`,
    patch: {
      lastError: `Solana signature outcome is ${outcome.state}; automatic resubmission is forbidden`,
      reconciled: true,
    },
  };
}

export function decideHedgeReconciliation(outcome: BackpackOrderOutcome): ReconciliationDecision {
  const common = {
    backpackOrderId: outcome.orderId ?? undefined,
    hedgeFilledQuantity: outcome.filledQuantity,
    reconciled: true as const,
  };
  if (outcome.state === "FILLED") {
    return { to: "HEDGED", reason: "Backpack hedge fully filled", patch: common };
  }
  if (outcome.state === "PARTIALLY_FILLED") {
    return {
      to: "PARTIALLY_HEDGED",
      reason: "Backpack hedge partially filled",
      patch: common,
    };
  }
  if (outcome.state === "CANCELLED") {
    return {
      to: "SPOT_ONLY",
      reason: "Backpack hedge ended without a fill",
      patch: { ...common, lastError: "Backpack hedge was cancelled or rejected" },
    };
  }
  return {
    to: "UNCERTAIN",
    reason: `Backpack hedge is ${outcome.state.toLowerCase()}`,
    patch: {
      ...common,
      lastError: `Backpack hedge outcome is ${outcome.state}; automatic duplicate order is forbidden`,
    },
  };
}

export function reconcileBackpackOrder(input: {
  clientOrderId: number;
  openOrders: BackpackOpenOrder[];
  orderHistory: BackpackHistoricalOrder[];
  fills: BackpackFill[];
}): BackpackOrderOutcome {
  const clientId = String(input.clientOrderId);
  const fills = input.fills.filter((fill) => String(fill.clientId) === clientId);
  const filledQuantity = fills.reduce(
    (total, fill) => total.plus(new Decimal(fill.quantity)),
    new Decimal(0),
  );
  const openOrder = input.openOrders.find((order) => String(order.clientId) === clientId);
  const historicalOrder = input.orderHistory.find((order) => String(order.clientId) === clientId);
  const order = openOrder ?? historicalOrder;
  const executed = historicalOrder?.executedQuantity
    ? new Decimal(historicalOrder.executedQuantity)
    : filledQuantity;
  const quantity = order?.quantity ? new Decimal(order.quantity) : null;
  if (quantity && executed.greaterThanOrEqualTo(quantity) && executed.greaterThan(0)) {
    return {
      state: "FILLED",
      orderId: order?.id ?? fills[0]?.orderId ?? null,
      filledQuantity: executed.toString(),
      fillCount: fills.length,
      status: historicalOrder?.status ?? openOrder?.status ?? null,
    };
  }
  if (openOrder) {
    return {
      state: executed.greaterThan(0) ? "PARTIALLY_FILLED" : "OPEN",
      orderId: openOrder.id,
      filledQuantity: executed.toString(),
      fillCount: fills.length,
      status: openOrder.status ?? null,
    };
  }
  if (historicalOrder) {
    const endedWithoutFill = /cancel|expire|reject/i.test(historicalOrder.status);
    return {
      state: executed.greaterThan(0)
        ? "PARTIALLY_FILLED"
        : endedWithoutFill ? "CANCELLED" : "NOT_FOUND",
      orderId: historicalOrder.id,
      filledQuantity: executed.toString(),
      fillCount: fills.length,
      status: historicalOrder.status,
    };
  }
  if (fills.length > 0) {
    return {
      state: "PARTIALLY_FILLED",
      orderId: fills[0]?.orderId ?? null,
      filledQuantity: filledQuantity.toString(),
      fillCount: fills.length,
      status: null,
    };
  }
  return {
    state: "NOT_FOUND",
    orderId: null,
    filledQuantity: "0",
    fillCount: 0,
    status: null,
  };
}
