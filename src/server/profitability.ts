import { Decimal } from "decimal.js";

type Level = [string, string];

export interface ProfitabilityInput {
  sizeUsd: number;
  quantity: number;
  dexSellProceedsUsd: number;
  backpackBidVwap: number;
  backpackAskVwap: number;
  backpackTakerFeePct: number;
  fundingRatePct: number;
  expectedFundingPeriods: number;
  targetExitBasisPct: number;
  expectedSpotSlippagePct: number;
  expectedPerpSlippagePct: number;
  solanaTransactionFeesUsd: number;
  priorityFeesUsd: number;
  partialFillReservePct: number;
  safetyBufferPct: number;
}

function requireFinite(name: string, value: number, minimum?: number): Decimal {
  if (!Number.isFinite(value) || (minimum !== undefined && value < minimum)) {
    throw new Error(`${name} must be finite${minimum === undefined ? "" : ` and >= ${minimum}`}`);
  }
  return new Decimal(value);
}

export function vwap(levels: Level[], targetQuantity: number, side: "bid" | "ask") {
  const rows = levels
    .map(([price, quantity]) => ({ price: new Decimal(price), quantity: new Decimal(quantity) }))
    .sort((a, b) =>
      side === "bid" ? b.price.comparedTo(a.price) : a.price.comparedTo(b.price),
    );

  let remaining = new Decimal(targetQuantity);
  let notional = new Decimal(0);
  let filled = new Decimal(0);

  for (const level of rows) {
    if (remaining.lte(0)) break;
    const take = Decimal.min(remaining, level.quantity);
    notional = notional.plus(take.mul(level.price));
    filled = filled.plus(take);
    remaining = remaining.minus(take);
  }

  if (remaining.gt(0) || filled.eq(0)) throw new Error(`Insufficient ${side} depth`);
  return {
    price: notional.div(filled).toNumber(),
    notional: notional.toNumber(),
  };
}

/**
 * Estimates a long-spot/short-perpetual trade under two explicit exit scenarios.
 * Positive Backpack funding is income for the short. Safety buffer is an entry
 * threshold, not an expense, and is therefore excluded from both PnL values.
 */
export function calculateProfitability(input: ProfitabilityInput) {
  const size = requireFinite("sizeUsd", input.sizeUsd, 0.01);
  const quantity = requireFinite("quantity", input.quantity, 0.00000001);
  const dexSellProceeds = requireFinite("dexSellProceedsUsd", input.dexSellProceedsUsd, 0);
  const bid = requireFinite("backpackBidVwap", input.backpackBidVwap, 0.00000001);
  const ask = requireFinite("backpackAskVwap", input.backpackAskVwap, 0.00000001);
  const feeRate = requireFinite("backpackTakerFeePct", input.backpackTakerFeePct, 0).div(100);
  const fundingRate = requireFinite("fundingRatePct", input.fundingRatePct).div(100);
  const fundingPeriods = requireFinite("expectedFundingPeriods", input.expectedFundingPeriods, 0);
  const targetBasisRate = requireFinite("targetExitBasisPct", input.targetExitBasisPct).div(100);
  const spotSlippageRate = requireFinite(
    "expectedSpotSlippagePct",
    input.expectedSpotSlippagePct,
    0,
  ).div(100);
  const perpSlippageRate = requireFinite(
    "expectedPerpSlippagePct",
    input.expectedPerpSlippagePct,
    0,
  ).div(100);
  const solanaFees = requireFinite(
    "solanaTransactionFeesUsd",
    input.solanaTransactionFeesUsd,
    0,
  );
  const priorityFees = requireFinite("priorityFeesUsd", input.priorityFeesUsd, 0);
  const partialFillReserve = size.mul(
    requireFinite("partialFillReservePct", input.partialFillReservePct, 0).div(100),
  );
  const safetyBufferPct = requireFinite("safetyBufferPct", input.safetyBufferPct, 0);

  const dexBuyPrice = size.div(quantity);
  const dexSellPrice = dexSellProceeds.div(quantity);
  const entryBasisPct = bid.div(dexBuyPrice).minus(1).mul(100);
  const immediateExitBasisPct = ask.div(dexSellPrice).minus(1).mul(100);

  // Slippage is applied adversely to every leg, beyond the quoted route/VWAP.
  const spotEntryCost = size.mul(spotSlippageRate.plus(1));
  const spotExitProceeds = dexSellProceeds.mul(new Decimal(1).minus(spotSlippageRate));
  const perpEntryPrice = bid.mul(new Decimal(1).minus(perpSlippageRate));
  const immediatePerpExitPrice = ask.mul(perpSlippageRate.plus(1));
  const targetPerpExitPrice = dexSellPrice.mul(targetBasisRate.plus(1));
  const targetPerpExitWithSlippage = targetPerpExitPrice.mul(perpSlippageRate.plus(1));
  const fixedCosts = solanaFees.plus(priorityFees).plus(partialFillReserve);

  const immediateBackpackFees = perpEntryPrice
    .plus(immediatePerpExitPrice)
    .mul(quantity)
    .mul(feeRate);
  const immediateLiquidationPnlUsd = spotExitProceeds
    .minus(spotEntryCost)
    .plus(perpEntryPrice.minus(immediatePerpExitPrice).mul(quantity))
    .minus(immediateBackpackFees)
    .minus(fixedCosts);

  const convergenceBackpackFees = perpEntryPrice
    .plus(targetPerpExitWithSlippage)
    .mul(quantity)
    .mul(feeRate);
  const estimatedFundingPnlUsd = perpEntryPrice.mul(quantity).mul(fundingRate).mul(fundingPeriods);
  const estimatedConvergencePnlUsd = spotExitProceeds
    .minus(spotEntryCost)
    .plus(perpEntryPrice.minus(targetPerpExitWithSlippage).mul(quantity))
    .minus(convergenceBackpackFees)
    .minus(fixedCosts)
    .plus(estimatedFundingPnlUsd);
  const expectedReturnPct = estimatedConvergencePnlUsd.div(size).mul(100);
  const entryEdgePct = expectedReturnPct.minus(safetyBufferPct);

  const spotSlippageUsd = spotEntryCost.minus(size).plus(dexSellProceeds.minus(spotExitProceeds));
  const perpSlippageUsd = bid.minus(perpEntryPrice)
    .plus(targetPerpExitWithSlippage.minus(targetPerpExitPrice))
    .mul(quantity);

  return {
    dexBuyPrice: dexBuyPrice.toNumber(),
    dexSellPrice: dexSellPrice.toNumber(),
    entryBasisPct: entryBasisPct.toNumber(),
    targetExitBasisPct: new Decimal(input.targetExitBasisPct).toNumber(),
    immediateExitBasisPct: immediateExitBasisPct.toNumber(),
    expectedReturnPct: expectedReturnPct.toNumber(),
    entryEdgePct: entryEdgePct.toNumber(),
    estimatedConvergencePnlUsd: estimatedConvergencePnlUsd.toNumber(),
    immediateLiquidationPnlUsd: immediateLiquidationPnlUsd.toNumber(),
    estimatedFundingPnlUsd: estimatedFundingPnlUsd.toNumber(),
    estimatedBackpackFeesUsd: convergenceBackpackFees.toNumber(),
    estimatedSlippageUsd: spotSlippageUsd.plus(perpSlippageUsd).toNumber(),
    solanaAndPriorityFeesUsd: solanaFees.plus(priorityFees).toNumber(),
    partialFillReserveUsd: partialFillReserve.toNumber(),
  };
}
