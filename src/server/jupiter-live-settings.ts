export interface JupiterLiveTradingSettings {
  tradeSizeUsd: number;
  minEntryEdgePct: number;
  exitEdgePct: number;
  maxBudgetUsd: number;
}

function finiteNumber(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`);
  return number;
}

export function validateJupiterLiveTradingSettings(input: {
  tradeSizeUsd?: unknown;
  minEntryEdgePct?: unknown;
  exitEdgePct?: unknown;
  maxBudgetUsd?: unknown;
}): JupiterLiveTradingSettings {
  const tradeSizeUsd = finiteNumber(input.tradeSizeUsd, "Amount per entry");
  const minEntryEdgePct = finiteNumber(input.minEntryEdgePct, "Entry edge");
  const exitEdgePct = finiteNumber(input.exitEdgePct, "Exit edge");
  const maxBudgetUsd = finiteNumber(input.maxBudgetUsd, "Maximum open budget");

  if (tradeSizeUsd < 1 || tradeSizeUsd > 100_000) {
    throw new Error("Amount per entry must be between $1 and $100,000");
  }
  if (maxBudgetUsd < tradeSizeUsd || maxBudgetUsd > 1_000_000) {
    throw new Error("Maximum open budget must be at least the entry amount and no more than $1,000,000");
  }
  if (minEntryEdgePct <= 0 || minEntryEdgePct > 100) {
    throw new Error("Entry edge must be greater than 0% and no more than 100%");
  }
  if (exitEdgePct < 0 || exitEdgePct >= minEntryEdgePct) {
    throw new Error("Exit edge must be at least 0% and lower than the entry edge");
  }

  return {
    tradeSizeUsd: Math.round(tradeSizeUsd * 100) / 100,
    minEntryEdgePct: Math.round(minEntryEdgePct * 10_000) / 10_000,
    exitEdgePct: Math.round(exitEdgePct * 10_000) / 10_000,
    maxBudgetUsd: Math.round(maxBudgetUsd * 100) / 100,
  };
}
