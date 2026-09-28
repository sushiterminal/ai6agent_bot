export function hasLiveBudgetCapacity(
  committedUsd: number,
  candidateUsd: number,
  budgetUsd: number,
) {
  if (
    !Number.isFinite(committedUsd)
    || !Number.isFinite(candidateUsd)
    || !Number.isFinite(budgetUsd)
    || committedUsd < 0
    || candidateUsd <= 0
    || budgetUsd <= 0
  ) return false;
  return committedUsd + candidateUsd <= budgetUsd + 1e-9;
}

export function hasLivePositionCapacity(activePositions: number, maxOpenPositions: number) {
  return Number.isInteger(activePositions)
    && Number.isInteger(maxOpenPositions)
    && activePositions >= 0
    && maxOpenPositions > 0
    && activePositions < maxOpenPositions;
}

export function reachedRealizedStop(realizedPnlUsd: number, stopLossUsd: number) {
  return realizedPnlUsd <= -Math.abs(stopLossUsd);
}

export function utcDayKey(now: Date) {
  return now.toISOString().slice(0, 10);
}

export function utcDayRange(now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end: new Date(start.getTime() + 24 * 60 * 60_000) };
}
