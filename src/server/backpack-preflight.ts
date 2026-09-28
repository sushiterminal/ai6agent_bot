import { Decimal } from "decimal.js";
import type {
  BackpackAccountSummary,
  BackpackBalance,
  BackpackCollateralSummary,
  BackpackMarket,
  BackpackOpenOrder,
  BackpackPosition,
} from "./backpack.js";

export interface BackpackPreflightInput {
  symbol: string;
  requestedQuantity: number;
  account: BackpackAccountSummary;
  balances: Record<string, BackpackBalance>;
  collateral: BackpackCollateralSummary;
  market: BackpackMarket;
  maxOrderQuantity: string;
  positions: BackpackPosition[];
  openOrders: BackpackOpenOrder[];
}

function finiteDecimal(value: string, name: string): Decimal {
  const decimal = new Decimal(value);
  if (!decimal.isFinite()) throw new Error(`Backpack returned invalid ${name}`);
  return decimal;
}

export function evaluateBackpackPreflight(input: BackpackPreflightInput) {
  const requested = new Decimal(input.requestedQuantity);
  const minimum = finiteDecimal(input.market.filters.quantity.minQuantity, "minimum quantity");
  const maximum = input.market.filters.quantity.maxQuantity === null
    ? null
    : finiteDecimal(input.market.filters.quantity.maxQuantity, "maximum quantity");
  const step = finiteDecimal(input.market.filters.quantity.stepSize, "quantity step");
  if (!requested.isFinite() || requested.lte(0) || step.lte(0)) {
    throw new Error("Backpack preflight quantity must be positive");
  }
  const orderQuantity = requested.div(step).floor().mul(step);
  const maxOrderQuantity = finiteDecimal(input.maxOrderQuantity, "max order quantity");
  const cashSymbol = input.balances.USD ? "USD" : input.balances.USDC ? "USDC" : null;
  const cash = cashSymbol ? input.balances[cashSymbol] : undefined;
  const gates = {
    authenticated: true,
    accountHealthy: !input.account.liquidating,
    marketMatches: input.market.symbol === input.symbol && input.market.marketType === "PERP",
    marketOpen: input.market.visible && input.market.orderBookState === "Open",
    quantityValid: orderQuantity.gte(minimum) && (maximum === null || orderQuantity.lte(maximum)),
    orderCapacity: maxOrderQuantity.gte(orderQuantity),
    noExistingPosition: !input.positions.some((position) =>
      position.symbol === input.symbol && !finiteDecimal(position.netQuantity, "position quantity").isZero()),
    noOpenOrders: !input.openOrders.some((order) => order.symbol === input.symbol),
    collateralPositive: finiteDecimal(input.collateral.netEquityAvailable, "available equity").gt(0),
  };
  const failures = Object.entries(gates)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return {
    mode: "READ_ONLY_NO_ORDERS" as const,
    symbol: input.symbol,
    pass: failures.length === 0,
    failures,
    gates,
    quantity: {
      requested: requested.toString(),
      order: orderQuantity.toString(),
      minimum: minimum.toString(),
      maximum: maximum?.toString() ?? null,
      step: step.toString(),
      maxOrder: maxOrderQuantity.toString(),
    },
    account: {
      liquidating: input.account.liquidating,
      leverageLimit: input.account.leverageLimit,
      openLimitOrders: input.account.limitOrders,
      openTriggerOrders: input.account.triggerOrders,
    },
    balances: {
      cashSymbol,
      cashAvailable: cash?.available ?? "0",
      cashLocked: cash?.locked ?? "0",
      netEquity: input.collateral.netEquity,
      netEquityAvailable: input.collateral.netEquityAvailable,
      netExposureFutures: input.collateral.netExposureFutures,
    },
    existingPositions: input.positions.length,
    existingOrders: input.openOrders.length,
  };
}
