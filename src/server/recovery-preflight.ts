import { Decimal } from "decimal.js";
import type {
  BackpackAccountSummary,
  BackpackCollateralSummary,
  BackpackMarket,
  BackpackOpenOrder,
  BackpackPosition,
} from "./backpack.js";
import type { RecoveryAction } from "./recovery-preview.js";

function finite(value: string, label: string) {
  const parsed = new Decimal(value);
  if (!parsed.isFinite()) throw new Error(`Backpack returned invalid ${label}`);
  return parsed;
}

export function evaluateRecoveryPreflight(input: {
  action: RecoveryAction;
  symbol: string;
  quantity: string;
  account: BackpackAccountSummary;
  collateral: BackpackCollateralSummary;
  market: BackpackMarket;
  maxOrderQuantity: string;
  positions: BackpackPosition[];
  openOrders: BackpackOpenOrder[];
}) {
  if (input.action !== "COMPLETE_HEDGE" && input.action !== "CLOSE_HEDGE") {
    throw new Error(`${input.action} is not a Backpack recovery order action`);
  }
  const quantity = finite(input.quantity, "recovery quantity");
  const step = finite(input.market.filters.quantity.stepSize, "quantity step");
  const minimum = finite(input.market.filters.quantity.minQuantity, "minimum quantity");
  const maximum = input.market.filters.quantity.maxQuantity === null
    ? null
    : finite(input.market.filters.quantity.maxQuantity, "maximum quantity");
  const maxOrder = finite(input.maxOrderQuantity, "max order quantity");
  const net = input.positions
    .filter((position) => position.symbol === input.symbol)
    .reduce((total, position) => total.plus(finite(position.netQuantity, "position quantity")), new Decimal(0));
  const gates = {
    accountHealthy: !input.account.liquidating,
    marketMatches: input.market.symbol === input.symbol && input.market.marketType === "PERP",
    marketOpen: input.market.visible && input.market.orderBookState === "Open",
    quantityPositive: quantity.gt(0),
    quantityOnStep: step.gt(0) && quantity.div(step).isInteger(),
    quantityWithinFilters: quantity.gte(minimum) && (maximum === null || quantity.lte(maximum)),
    orderCapacity: maxOrder.gte(quantity),
    noOpenOrders: !input.openOrders.some((order) => order.symbol === input.symbol),
    collateralPositive: finite(input.collateral.netEquityAvailable, "available equity").gt(0),
    exposureDirection: input.action === "COMPLETE_HEDGE"
      ? net.lte(0)
      : net.lt(0) && net.abs().gte(quantity),
  };
  const failures = Object.entries(gates)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return { pass: failures.length === 0, failures, gates, netQuantity: net.toString() };
}
