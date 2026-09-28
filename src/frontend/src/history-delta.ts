export interface HistoryDeltaRow {
  pair: string;
  capturedAt: string;
  confirmationIndex?: number;
}

export function historyRowKey(row: HistoryDeltaRow) {
  return `${row.pair}:${row.capturedAt}:${row.confirmationIndex ?? 0}`;
}

export function latestHistoryCursor(rows: HistoryDeltaRow[]) {
  return rows.reduce<string | null>((latest, row) =>
    latest === null || row.capturedAt > latest ? row.capturedAt : latest, null);
}

export function groupRecentHistoryByPair<T extends HistoryDeltaRow>(
  rows: T[],
  capturedAtOrAfter: number,
) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    if (Date.parse(row.capturedAt) < capturedAtOrAfter) continue;
    const pairRows = grouped.get(row.pair) ?? [];
    pairRows.push(row);
    grouped.set(row.pair, pairRows);
  }
  for (const pairRows of grouped.values()) {
    pairRows.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  }
  return grouped;
}

export function mergeHistoryDelta<T extends HistoryDeltaRow>(
  current: T[],
  incoming: T[],
  limitPerPair: number,
) {
  if (incoming.length === 0) return current;
  const rowsByKey = new Map(current.map((row) => [historyRowKey(row), row]));
  let changed = false;
  for (const row of incoming) {
    const key = historyRowKey(row);
    if (!rowsByKey.has(key)) changed = true;
    rowsByKey.set(key, row);
  }
  if (!changed) return current;

  const byPair = new Map<string, T[]>();
  for (const row of rowsByKey.values()) {
    const rows = byPair.get(row.pair) ?? [];
    rows.push(row);
    byPair.set(row.pair, rows);
  }
  return [...byPair.values()]
    .flatMap((rows) => rows
      .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
      .slice(-limitPerPair))
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
}
