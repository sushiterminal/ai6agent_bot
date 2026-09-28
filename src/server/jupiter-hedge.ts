import { Decimal } from "decimal.js";
import type { BackpackFill, BackpackHistoricalOrder, BackpackOpenOrder } from "./backpack.js";
import { reconcileBackpackOrder, type BackpackOrderOutcome } from "./trade-reconciliation.js";

export interface BackpackExecutionSummary {
  outcome: BackpackOrderOutcome;
  averagePriceUsd: number | null;
  feeUsd: number | null;
}

export function summarizeBackpackExecution(input: {
  clientOrderId: number;
  symbol: string;
  side: "Ask" | "Bid";
  openOrders: BackpackOpenOrder[];
  orderHistory: BackpackHistoricalOrder[];
  fills: BackpackFill[];
}): BackpackExecutionSummary {
  const clientId = String(input.clientOrderId);
  const matchingFills = input.fills.filter((fill) => String(fill.clientId) === clientId);
  const mismatched = matchingFills.find((fill) => (
    fill.symbol !== input.symbol || fill.side !== input.side
  ));
  if (mismatched) throw new Error("Backpack fill does not match the persisted hedge command");

  const openOrders = input.openOrders.filter((order) => (
    String(order.clientId) !== clientId
    || (order.symbol === input.symbol && order.side === input.side)
  ));
  const orderHistory = input.orderHistory.filter((order) => (
    String(order.clientId) !== clientId
    || (order.symbol === input.symbol && order.side === input.side)
  ));
  if (
    openOrders.length !== input.openOrders.length
    || orderHistory.length !== input.orderHistory.length
  ) {
    throw new Error("Backpack order does not match the persisted hedge command");
  }

  const outcome = reconcileBackpackOrder({
    clientOrderId: input.clientOrderId,
    openOrders,
    orderHistory,
    fills: matchingFills,
  });
  if (matchingFills.length === 0) {
    return { outcome, averagePriceUsd: null, feeUsd: outcome.state === "CANCELLED" ? 0 : null };
  }
  const totals = matchingFills.reduce((summary, fill) => {
    const quantity = new Decimal(fill.quantity);
    const price = new Decimal(fill.price);
    const fee = new Decimal(fill.fee);
    if (!quantity.isFinite() || quantity.lte(0) || !price.isFinite() || price.lte(0)) {
      throw new Error("Backpack returned an invalid hedge fill");
    }
    if (!fee.isFinite() || fee.lt(0) || !["USD", "USDC"].includes(fill.feeSymbol)) {
      throw new Error("Backpack hedge fee cannot be represented in USD");
    }
    return {
      quantity: summary.quantity.plus(quantity),
      notional: summary.notional.plus(quantity.mul(price)),
      fee: summary.fee.plus(fee),
    };
  }, { quantity: new Decimal(0), notional: new Decimal(0), fee: new Decimal(0) });
  return {
    outcome,
    averagePriceUsd: totals.notional.div(totals.quantity).toNumber(),
    feeUsd: totals.fee.toNumber(),
  };
}

export function calculateHedgedRealizedPnl(input: {
  spotSpentUsd: number;
  spotReceivedUsd: number;
  hedgeQuantity: string;
  entryHedgePriceUsd: number;
  exitHedgePriceUsd: number;
  entryHedgeFeeUsd: number;
  exitHedgeFeeUsd: number;
}) {
  const quantity = new Decimal(input.hedgeQuantity);
  const spotPnl = new Decimal(input.spotReceivedUsd).minus(input.spotSpentUsd);
  const perpPnl = new Decimal(input.entryHedgePriceUsd)
    .minus(input.exitHedgePriceUsd)
    .mul(quantity)
    .minus(input.entryHedgeFeeUsd)
    .minus(input.exitHedgeFeeUsd);
  if (!quantity.isFinite() || quantity.lte(0) || !spotPnl.isFinite() || !perpPnl.isFinite()) {
    throw new Error("Cannot calculate hedged realized PnL from invalid fills");
  }
  return {
    spotRealizedPnlUsd: spotPnl.toNumber(),
    perpRealizedPnlUsd: perpPnl.toNumber(),
    realizedPnlUsd: spotPnl.plus(perpPnl).toNumber(),
  };
}

export function boundedHedgeQuantity(input: {
  spotQuantity: string;
  stepSize: string;
  minimumQuantity: string;
  maximumQuantity: string | null;
  markPriceUsd: string;
  maxUnhedgedUsd: number;
}) {
  const spot = new Decimal(input.spotQuantity);
  const step = new Decimal(input.stepSize);
  const minimum = new Decimal(input.minimumQuantity);
  const maximum = input.maximumQuantity === null ? null : new Decimal(input.maximumQuantity);
  const mark = new Decimal(input.markPriceUsd);
  const maxDust = new Decimal(input.maxUnhedgedUsd);
  if ([spot, step, minimum, mark, maxDust].some((value) => !value.isFinite())
    || spot.lte(0) || step.lte(0) || minimum.lte(0) || mark.lte(0) || maxDust.lt(0)) {
    throw new Error("Invalid hedge sizing inputs");
  }
  const hedge = spot.div(step).floor().mul(step);
  const residual = spot.minus(hedge);
  if (hedge.lt(minimum) || (maximum && hedge.gt(maximum))) {
    throw new Error("Rounded hedge quantity is outside Backpack market limits");
  }
  if (residual.lt(0) || residual.gte(step) || residual.mul(mark).gt(maxDust)) {
    throw new Error("Unhedged spot remainder exceeds the configured limit");
  }
  return { hedgeQuantity: hedge.toString(), unhedgedSpotQuantity: residual.toString() };
}
