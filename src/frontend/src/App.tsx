import { memo, useEffect, useMemo, useRef, useState } from "react";
import { groupRecentHistoryByPair, latestHistoryCursor, mergeHistoryDelta } from "./history-delta";
import { DashboardHero, SiteNav } from "./LandingPage";

type Size = 3000;
type ScannerSortKey = "ticker" | "price" | "funding" | "spread" | "trades" | "profit" | "chart";
type SortDirection = "asc" | "desc";
type PairSymbol =
  | "MU" | "SNDK" | "SPCX" | "AMD" | "HOOD" | "INTC" | "SKHY"
  | "DRAM" | "META" | "MSFT" | "GOOGL" | "QQQ" | "SPY";

interface Pair {
  symbol: PairSymbol;
  name: string;
  tokenMint: string;
  perpSymbol: string;
  basisRisk: "same_issuer" | "cross_issuer";
}

interface Sample {
  pair: PairSymbol;
  sizeUsd: Size;
  capturedAt: string;
  quantity: number;
  dexBuyPrice: number;
  dexSellPrice: number;
  backpackBidVwap: number;
  backpackAskVwap: number;
  entryBasisPct?: number;
  targetExitBasisPct?: number;
  immediateExitBasisPct?: number;
  expectedReturnPct?: number;
  entryEdgePct?: number;
  safetyBufferPct: number;
  estimatedConvergencePnlUsd?: number;
  immediateLiquidationPnlUsd?: number;
  estimatedFundingPnlUsd?: number;
  estimatedBackpackFeesUsd?: number;
  estimatedSlippageUsd?: number;
  solanaAndPriorityFeesUsd?: number;
  partialFillReserveUsd?: number;
  // Legacy fields keep previously stored MongoDB samples readable.
  grossEntrySpreadPct?: number;
  netOpportunityPct?: number;
  immediateRoundTripPnlUsd?: number;
  dexRoundTripCostPct?: number;
  backpackRoundTripFeePct?: number;
  fundingRatePct?: number;
  fundingIntervalMinutes?: number;
  nextFundingAt?: string;
  fundingRateHourlyPct?: number;
  marketSession?: string;
  marketHoliday?: string | null;
  markPrice: number;
  indexPrice: number;
  jupiterBuyRoute: string[];
  backpackDataAgeMs?: number;
  quoteDurationMs?: number;
  confirmationIndex?: number;
}

interface JupiterRoundTripTrade {
  tradeId: string;
  sourceTradeId: string;
  campaignId?: string;
  sourceIntegrity?: "VERIFIED_LIVE" | "LEGACY_SYNTHETIC_TRIGGER";
  pair: PairSymbol;
  status: "ENTRY_PLANNED" | "ENTRY_SUBMITTED" | "OPEN" | "EXIT_PLANNED" | "EXIT_SUBMITTED" | "CLOSED" | "FAILED" | "MANUAL_INTERVENTION";
  sizeUsd: number;
  entryTierStart?: number;
  entryTier?: number;
  entrySpentUsd: number | null;
  realizedPnlUsd: number | null;
  entrySignature: string | null;
  exitSignature: string | null;
  openedAt?: string | null;
  closedAt?: string | null;
  events?: Array<{
    to: string;
    at: string;
    signature?: string;
  }>;
  lastError: string | null;
  createdAt?: string;
}

interface JupiterRoundTripsResponse {
  trades: JupiterRoundTripTrade[];
  campaignExits: JupiterCampaignExit[];
}

interface JupiterCampaignExit {
  campaignId: string;
  status: "PLANNED" | "SUBMITTED" | "CONFIRMED" | "MANUAL_INTERVENTION";
  signature: string | null;
  settledAt: string | null;
}

interface DashboardCampaignRow {
  campaignId: string;
  pair: PairSymbol;
  fills: JupiterRoundTripTrade[];
  entryAt: string | null;
  exitAt: string | null;
  amountUsd: number | null;
  realizedPnlUsd: number | null;
  sourceIntegrity: "VERIFIED_LIVE" | "LEGACY_SYNTHETIC_TRIGGER";
  status: JupiterRoundTripTrade["status"];
}

interface HistoryChangesResponse {
  samples: Sample[];
  cursor: string;
  hasMore: boolean;
}

interface MonitorResponse {
  state: {
    status: "starting" | "collecting" | "ready" | "error";
    lastCycleAt: string | null;
    nextCycleAt: string | null;
    lastError: string | null;
    futuresMakerFeePct: number | null;
    futuresTakerFeePct: number | null;
    activePair: PairSymbol | null;
    completedPairs: number;
    totalPairs: number;
    pairErrors: Partial<Record<PairSymbol, string>>;
    schedulerLagMs: number;
    confirmedSignals: number;
    marketSession: string;
    marketHoliday: string | null;
    marketContextUpdatedAt: string | null;
    fundingIntervalMinutes: Partial<Record<PairSymbol, number>>;
  };
  operational: {
    backpack: {
      connected: boolean;
      reconnects: number;
      messages: number;
      gaps: number;
      resyncs: number;
      lastMessageAt: number | null;
      latencyMs: number | null;
      staleSymbols: string[];
    };
    jupiter: {
      queueDepth: number;
      requestsTotal: number;
      requestsLastMinute: number;
      retriesTotal: number;
      rateLimitedTotal: number;
      errorsTotal: number;
      lastLatencyMs: number | null;
      averageLatencyMs: number | null;
      cooldownUntil: string | null;
      configuredRps: number;
    };
    schedulerLagMs: number;
  };
  pairs: Pair[];
  latest: Sample[];
  canaryPolicy: {
    killSwitch: boolean;
    notionalUsd: number;
    maxLossPerTradeUsd: number;
    maxDailyLossUsd: number;
    maxDailyAttempts: number;
    maxOpenPositions: number;
    allowedPairs: string[];
  };
}

const pairSymbols: PairSymbol[] = [
  "MU", "SNDK", "SPCX", "AMD", "HOOD", "INTC", "SKHY", "DRAM",
  "META", "MSFT", "GOOGL", "QQQ", "SPY",
];
const pairColors: Record<PairSymbol, string> = {
  MU: "#65f5a5",
  SNDK: "#ffb454",
  SPCX: "#7c9cff",
  AMD: "#e879f9",
  HOOD: "#37d5e8",
  INTC: "#f47286",
  SKHY: "#d4e157",
  DRAM: "#fb923c",
  META: "#c084fc",
  MSFT: "#22c55e",
  GOOGL: "#facc15",
  QQQ: "#38bdf8",
  SPY: "#f43f5e",
};

function colorWithAlpha(color: string, alpha: number) {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

const MIN_ENTRY_EDGE_PCT = 0.25;
const TRADES_PER_PAGE = 10;
const PRICE_HISTORY_WINDOW_MS = 90 * 60_000;
const LIVE_DATA_REFRESH_INTERVAL_MS = 5_000;
const HISTORY_DELTA_INTERVAL_MS = 5_000;
const HISTORY_LIMIT_PER_PAIR = 1_000;
const EMPTY_PRICE_HISTORY: Sample[] = [];

const entryBasis = (sample: Sample) => sample.entryBasisPct ?? sample.grossEntrySpreadPct ?? 0;
const entryEdge = (sample: Sample) => sample.entryEdgePct ?? sample.netOpportunityPct ?? 0;
const fundingRate = (sample: Sample) => sample.fundingRatePct ?? sample.fundingRateHourlyPct ?? 0;
const sessionName = (value: string | undefined) => ({
  US_EQUITIES_PRE_MARKET: "PRE-MARKET",
  US_EQUITIES_REGULAR: "REGULAR",
  US_EQUITIES_POST_MARKET: "POST-MARKET",
  US_EQUITIES_OVERNIGHT: "OVERNIGHT",
  CLOSED: "CLOSED",
  UNKNOWN: "UNKNOWN",
}[value ?? "UNKNOWN"] ?? value ?? "UNKNOWN");

const pct = (value: number, digits = 3) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
const usd = (value: number, digits = 2) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
}).format(value);
const price = (value: number) => `$${value.toFixed(4)}`;
const time = (value: string | number) => new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
}).format(new Date(value));
const dateTime = (value: string | number) => new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
}).format(new Date(value));

const priceSpreadPct = (sample: Sample) => sample.dexBuyPrice === 0
  ? 0
  : (sample.backpackBidVwap - sample.dexBuyPrice) / sample.dexBuyPrice * 100;

function MarketPrice({ label, value }: { label: string; value: number }) {
  const [whole, fraction] = value.toFixed(4).split(".");
  return <span className="market-price" aria-label={`${label} ${price(value)}`}>
    <span className="market-price__label" aria-hidden="true">{label}</span>
    <span className="market-price__whole" aria-hidden="true">${whole}</span>
    <span aria-hidden="true">.</span>
    <span aria-hidden="true">{fraction}</span>
  </span>;
}

function TickerIdentity({
  symbol,
  pair,
  dataDelayed = false,
}: {
  symbol: PairSymbol;
  pair?: Pair;
  dataDelayed?: boolean;
}) {
  const extension = symbol === "MU" ? "png" : "svg";
  return <div className="ticker-identity">
    <img className="ticker-icon" src={`/tickers/${symbol.toLowerCase()}.${extension}`} alt="" />
    <div className="ticker-copy">
      <b
        className={dataDelayed ? "ticker-symbol ticker-symbol--delayed" : "ticker-symbol"}
        aria-label={dataDelayed ? `${symbol}, market data delayed` : symbol}
        title={dataDelayed ? "Market data delayed" : undefined}
      >{symbol}</b>
      {pair?.name && <span>{pair.name}</span>}
    </div>
  </div>;
}

const isMarketDataDelayError = (message: string | null | undefined) =>
  message !== null
  && message !== undefined
  && /Backpack market data .* (?:is not ready|is stale)/i.test(message);

function TransactionReference({
  trade,
  leg,
}: {
  trade: JupiterRoundTripTrade | undefined;
  leg: "entry" | "exit";
}) {
  const signature = leg === "entry" ? trade?.entrySignature : trade?.exitSignature;
  if (!signature) return <span className="transaction-empty">—</span>;
  if (trade?.status === `${leg.toUpperCase()}_SUBMITTED`) {
    return <a
      className="transaction-link transaction-link--pending"
      href={`https://solscan.io/tx/${signature}`}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open pending ${trade.pair} ${leg} transaction in Solscan`}
    >PENDING ↗</a>;
  }
  if (trade?.status === "FAILED" && trade.lastError?.includes("expired without appearing on chain")) {
    return <span className="transaction-failed" title={trade.lastError}>EXPIRED</span>;
  }
  return <a
    className="transaction-link"
    href={`https://solscan.io/tx/${signature}`}
    target="_blank"
    rel="noreferrer"
    aria-label={`Open ${trade?.pair ?? "Jupiter"} ${leg} transaction in Solscan`}
  >SOLSCAN ↗</a>;
}

function TransactionDetails({
  trade,
  leg,
  fallbackTime,
}: {
  trade: JupiterRoundTripTrade | undefined;
  leg: "entry" | "exit";
  fallbackTime?: string | null;
}) {
  const signature = leg === "entry" ? trade?.entrySignature : trade?.exitSignature;
  const submittedStatus = `${leg.toUpperCase()}_SUBMITTED`;
  const submittedEvent = [...(trade?.events ?? [])].reverse().find((event) =>
    (signature !== null && signature !== undefined && event.signature === signature)
    || event.to === submittedStatus);
  const value = submittedEvent?.at
    ?? (leg === "entry" ? trade?.openedAt : trade?.closedAt)
    ?? fallbackTime;

  return <div className="transaction-details">
    <TransactionReference trade={trade} leg={leg} />
    {value && <time dateTime={value}>{dateTime(value)}</time>}
  </div>;
}

function CampaignTransactions({
  fills,
  leg,
  fallbackTime,
}: {
  fills: JupiterRoundTripTrade[];
  leg: "entry" | "exit";
  fallbackTime?: string | null;
}) {
  if (leg === "exit" && fills.every((fill) => !fill.exitSignature)) {
    return <span className="transaction-empty">—</span>;
  }
  if (
    leg === "exit"
    && fills[0]?.exitSignature
    && fills.every((fill) => fill.exitSignature === fills[0]!.exitSignature)
  ) {
    return <TransactionDetails trade={fills[0]} leg="exit" fallbackTime={fallbackTime} />;
  }
  if (fills.length <= 1) {
    return <TransactionDetails trade={fills[0]} leg={leg} fallbackTime={fallbackTime} />;
  }
  return <details className="campaign-fills">
    <summary>SHOW {fills.length} {leg === "entry" ? "FILLS" : "EXITS"}</summary>
    <div>{fills.map((fill) => <TransactionDetails key={fill.tradeId} trade={fill} leg={leg} />)}</div>
  </details>;
}

function TradeCard({
  symbol,
  pair,
  amountUsd,
  realizedPnlUsd,
  sourceIntegrity,
  fills,
  entryAt,
  exitAt,
  status,
  live = false,
}: {
  symbol: PairSymbol;
  pair?: Pair;
  amountUsd: number | null;
  realizedPnlUsd: number | null;
  sourceIntegrity: DashboardCampaignRow["sourceIntegrity"];
  fills: JupiterRoundTripTrade[];
  entryAt?: string | null;
  exitAt?: string | null;
  status: string;
  live?: boolean;
}) {
  return <article className={`mobile-trade-card${live ? " mobile-trade-card--live" : ""}`}>
    <header>
      <div className="mobile-trade-card__identity">
        <TickerIdentity symbol={symbol} pair={pair} />
      </div>
      <span className={`table-verdict${live ? "" : ` trade-status--${status.toLowerCase()}`}`}>
        {status.replaceAll("_", " ")}
      </span>
    </header>
    <div className="mobile-trade-card__metrics">
      <div><span>Amount</span><strong>{amountUsd === null ? "—" : usd(amountUsd)}</strong></div>
      <div>
        <span>Realized hedged PnL</span>
        <strong className={realizedPnlUsd === null ? "" : realizedPnlUsd >= 0 ? "number-positive" : "number-negative"}>
          {realizedPnlUsd === null ? "—" : usd(realizedPnlUsd)}
        </strong>
      </div>
      <div><span>Fills</span><strong>{fills.length}</strong></div>
      <div><span>Signal source</span><strong>{sourceIntegrity === "VERIFIED_LIVE" ? "LIVE MARKET" : "LEGACY SYNTHETIC TRIGGER"}</strong></div>
    </div>
    <div className="mobile-trade-card__transactions">
      <div><span>Entry transactions</span><CampaignTransactions fills={fills} leg="entry" fallbackTime={entryAt} /></div>
      <div><span>Exit transactions</span><CampaignTransactions fills={fills} leg="exit" fallbackTime={exitAt} /></div>
    </div>
  </article>;
}

const PriceSparkline = memo(function PriceSparkline({ history, symbol }: { history: Sample[]; symbol: PairSymbol }) {
  if (history.length < 2) {
    return <span className="sparkline-empty">Waiting for history</span>;
  }

  const width = 150;
  const height = 42;
  const padding = 3;
  const allPrices = history.flatMap((sample) => [
    sample.backpackBidVwap,
    sample.dexBuyPrice,
  ]);
  const min = Math.min(...allPrices);
  const max = Math.max(...allPrices);
  const range = max - min;
  const x = (index: number) => padding + index / (history.length - 1) * (width - padding * 2);
  const y = (value: number) => range === 0
    ? height / 2
    : padding + (max - value) / range * (height - padding * 2);
  const points = (priceFor: (sample: Sample) => number) => history
    .map((sample, index) => `${x(index).toFixed(2)},${y(priceFor(sample)).toFixed(2)}`)
    .join(" ");
  const jupiterStepPoints = history.flatMap((sample, index) => {
    const current = `${x(index).toFixed(2)},${y(sample.dexBuyPrice).toFixed(2)}`;
    if (index === 0) return [current];
    const previous = history[index - 1]!;
    return [
      `${x(index).toFixed(2)},${y(previous.dexBuyPrice).toFixed(2)}`,
      current,
    ];
  }).join(" ");

  return <div className="price-sparkline-wrap">
    <svg
      className="price-sparkline"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${symbol} updated Backpack and Jupiter price history`}
      preserveAspectRatio="none"
    >
      <polyline points={points((sample) => sample.backpackBidVwap)} fill="none" stroke="#8b7cff" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <polyline className="price-sparkline__jupiter" points={jupiterStepPoints} fill="none" stroke="#65f5a5" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
    <div className="price-sparkline-legend" aria-hidden="true">
      <span className="price-sparkline-legend__backpack">Backpack</span>
      <span className="price-sparkline-legend__jupiter">Jupiter</span>
    </div>
  </div>;
});

function SortableHeader({
  label,
  sortKey,
  activeKey,
  direction,
  onSort,
  title,
}: {
  label: string;
  sortKey: ScannerSortKey;
  activeKey: ScannerSortKey;
  direction: SortDirection;
  onSort: (key: ScannerSortKey) => void;
  title?: string;
}) {
  const active = activeKey === sortKey;
  return <th aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}>
    <button type="button" className={active ? "sort-button sort-button--active" : "sort-button"} onClick={() => onSort(sortKey)} title={title}>
      <span>{label}</span>
      <span className="sort-indicator" aria-hidden="true">{active ? direction === "asc" ? "↑" : "↓" : "↕"}</span>
    </button>
  </th>;
}

function roundTripEntryAt(trade: JupiterRoundTripTrade) {
  const submittedEvent = [...(trade.events ?? [])].reverse().find((event) =>
    (trade.entrySignature !== null && event.signature === trade.entrySignature)
    || event.to === "ENTRY_SUBMITTED");
  return submittedEvent?.at ?? trade.openedAt ?? null;
}

function campaignStatus(fills: JupiterRoundTripTrade[]): JupiterRoundTripTrade["status"] {
  if (fills.every((fill) => fill.status === "CLOSED")) return "CLOSED";
  const priority: JupiterRoundTripTrade["status"][] = [
    "MANUAL_INTERVENTION",
    "EXIT_SUBMITTED",
    "EXIT_PLANNED",
    "ENTRY_SUBMITTED",
    "OPEN",
    "ENTRY_PLANNED",
    "FAILED",
  ];
  return priority.find((status) => fills.some((fill) => fill.status === status)) ?? "FAILED";
}

function aggregateCampaigns(
  trades: JupiterRoundTripTrade[],
  campaignExits: JupiterCampaignExit[],
): DashboardCampaignRow[] {
  const exitsByCampaign = new Map(campaignExits.map((exit) => [exit.campaignId, exit]));
  const groups = new Map<string, JupiterRoundTripTrade[]>();
  for (const trade of trades) {
    if (trade.entrySignature === null) continue;
    const campaignId = trade.campaignId ?? `legacy:${trade.tradeId}`;
    const fills = groups.get(campaignId) ?? [];
    fills.push(trade);
    groups.set(campaignId, fills);
  }
  return [...groups].map(([campaignId, unsortedFills]) => {
    const fills = [...unsortedFills].sort((left, right) => (
      (left.entryTier ?? 0) - (right.entryTier ?? 0)
      || Date.parse(left.createdAt ?? "") - Date.parse(right.createdAt ?? "")
    ));
    const entryTimes = fills.map(roundTripEntryAt).filter((value): value is string => value !== null);
    const exitTimes = fills.map((fill) => fill.closedAt).filter((value): value is string => value !== null && value !== undefined);
    const amounts = fills.map((fill) => fill.entrySpentUsd).filter((value): value is number => value !== null);
    const pnls = fills.map((fill) => fill.realizedPnlUsd).filter((value): value is number => value !== null);
    const campaignExit = exitsByCampaign.get(campaignId);
    const status = campaignExit?.status === "MANUAL_INTERVENTION"
      ? "MANUAL_INTERVENTION"
      : campaignExit?.status === "PLANNED"
        ? "EXIT_PLANNED"
        : campaignExit?.status === "SUBMITTED" || (campaignExit?.status === "CONFIRMED" && !campaignExit.settledAt)
          ? "EXIT_SUBMITTED"
          : campaignStatus(fills);
    return {
      campaignId,
      pair: fills[0]!.pair,
      fills,
      entryAt: entryTimes.sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null,
      exitAt: exitTimes.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null,
      amountUsd: amounts.length > 0 ? amounts.reduce((total, amount) => total + amount, 0) : null,
      realizedPnlUsd: pnls.length === fills.length
        ? pnls.reduce((total, pnl) => total + pnl, 0)
        : null,
      sourceIntegrity: fills.some((fill) => fill.sourceIntegrity === "LEGACY_SYNTHETIC_TRIGGER")
        ? "LEGACY_SYNTHETIC_TRIGGER"
        : "VERIFIED_LIVE",
      status,
    };
  });
}

function MainDashboard() {
  const selectedSize: Size = 3000;
  const [selectedPair, setSelectedPair] = useState<PairSymbol>("SPCX");
  const [monitor, setMonitor] = useState<MonitorResponse | null>(null);
  const [history, setHistory] = useState<Sample[]>([]);
  const [jupiterRoundTrips, setJupiterRoundTrips] = useState<JupiterRoundTripTrade[]>([]);
  const [jupiterCampaignExits, setJupiterCampaignExits] = useState<JupiterCampaignExit[]>([]);
  const [tradePage, setTradePage] = useState(1);
  const [scannerSort, setScannerSort] = useState<{ key: ScannerSortKey; direction: SortDirection }>({
    key: "spread",
    direction: "desc",
  });
  const [liveError, setLiveError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "AI6 — Live board";
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const load = async () => {
      const startedAt = Date.now();
      controller = new AbortController();
      try {
        const [monitorResponse, roundTripsResponse] = await Promise.all([
          fetch("/api/monitor", { signal: controller.signal }),
          fetch("/api/jupiter/round-trips?limit=1000", { signal: controller.signal }),
        ]);
        if (!monitorResponse.ok || !roundTripsResponse.ok) {
          throw new Error("API is temporarily unavailable");
        }
        const nextMonitor = await monitorResponse.json() as MonitorResponse;
        const nextRoundTrips = await roundTripsResponse.json() as JupiterRoundTripsResponse;
        if (!cancelled) {
          setMonitor(nextMonitor);
          setJupiterRoundTrips(nextRoundTrips.trades);
          setJupiterCampaignExits(nextRoundTrips.campaignExits ?? []);
          setLiveError(null);
        }
      } catch (loadError) {
        if (!cancelled && !(loadError instanceof DOMException && loadError.name === "AbortError")) {
          setLiveError(loadError instanceof Error ? loadError.message : "Loading failed");
        }
      } finally {
        if (!cancelled) {
          const delayMs = Math.max(0, LIVE_DATA_REFRESH_INTERVAL_MS - (Date.now() - startedAt));
          timer = window.setTimeout(load, delayMs);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [selectedSize]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    let cursor: string | null = null;
    const loadHistory = async () => {
      const startedAt = Date.now();
      controller = new AbortController();
      try {
        const url = cursor === null
          ? `/api/history?pair=all&size=${selectedSize}&limit=${HISTORY_LIMIT_PER_PAIR}`
          : `/api/history/changes?size=${selectedSize}&since=${encodeURIComponent(cursor)}&limit=1000`;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("Market history is temporarily unavailable");
        const body = await response.json() as Sample[] | HistoryChangesResponse;
        if (!cancelled) {
          if (Array.isArray(body)) {
            setHistory(body);
            cursor = latestHistoryCursor(body);
          } else {
            setHistory((current) => mergeHistoryDelta(
              current,
              body.samples,
              HISTORY_LIMIT_PER_PAIR,
            ));
            cursor = body.cursor;
          }
          setHistoryError(null);
        }
        const hasMore = !Array.isArray(body) && body.hasMore;
        return hasMore ? 0 : Math.max(0, HISTORY_DELTA_INTERVAL_MS - (Date.now() - startedAt));
      } catch (loadError) {
        if (!cancelled && !(loadError instanceof DOMException && loadError.name === "AbortError")) {
          setHistoryError(loadError instanceof Error ? loadError.message : "History loading failed");
        }
        return HISTORY_DELTA_INTERVAL_MS;
      }
    };
    const schedule = async () => {
      const delayMs = await loadHistory();
      if (!cancelled) timer = window.setTimeout(schedule, delayMs);
    };
    void schedule();
    return () => {
      cancelled = true;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [selectedSize]);

  const error = liveError ?? historyError;

  const isEntryCandidate = (edgePct: number) => edgePct >= MIN_ENTRY_EDGE_PCT;
  const scannerRows = useMemo(
    () => (monitor?.latest ?? [])
      .filter((sample) => sample.sizeUsd === selectedSize)
      .sort((a, b) => entryEdge(b) - entryEdge(a)),
    [monitor, selectedSize],
  );
  const tradeRows = useMemo<DashboardCampaignRow[]>(() => {
    const timestamp = (value: string | null) => value === null || Number.isNaN(Date.parse(value))
      ? Number.NEGATIVE_INFINITY
      : Date.parse(value);
    return aggregateCampaigns(jupiterRoundTrips, jupiterCampaignExits).sort((left, right) =>
      timestamp(right.entryAt) - timestamp(left.entryAt)
      || left.campaignId.localeCompare(right.campaignId));
  }, [jupiterCampaignExits, jupiterRoundTrips]);
  const pairTradeStats = useMemo(() => {
    const stats: Partial<Record<PairSymbol, { trades: number; pnlUsd: number }>> = {};
    for (const campaign of tradeRows) {
      if (campaign.sourceIntegrity !== "VERIFIED_LIVE") continue;
      if (campaign.status !== "CLOSED" || campaign.realizedPnlUsd === null) continue;
      const symbol = campaign.pair;
      const current = stats[symbol] ?? { trades: 0, pnlUsd: 0 };
      stats[symbol] = {
        trades: current.trades + 1,
        pnlUsd: current.pnlUsd + (campaign.realizedPnlUsd ?? 0),
      };
    }
    return stats;
  }, [tradeRows]);
  const recentPriceHistoryByPair = useMemo(() => {
    const grouped = groupRecentHistoryByPair(history, Date.now() - PRICE_HISTORY_WINDOW_MS);
    for (const [pair, samples] of grouped) {
      grouped.set(pair, samples.filter((sample) =>
        Number.isFinite(sample.backpackBidVwap) && Number.isFinite(sample.dexBuyPrice)));
    }
    return grouped;
  }, [history]);
  const sortedScannerRows = useMemo(() => {
    const direction = scannerSort.direction === "asc" ? 1 : -1;
    const value = (sample: Sample): string | number => {
      const tradeStats = pairTradeStats[sample.pair] ?? { trades: 0, pnlUsd: 0 };
      switch (scannerSort.key) {
        case "ticker": return sample.pair;
        case "price": return sample.backpackBidVwap;
        case "funding": return fundingRate(sample);
        case "spread": return priceSpreadPct(sample);
        case "trades": return tradeStats.trades;
        case "profit": return tradeStats.pnlUsd;
        case "chart": {
          const prices = recentPriceHistoryByPair.get(sample.pair) ?? EMPTY_PRICE_HISTORY;
          if (prices.length < 2 || prices[0]!.backpackBidVwap === 0) return 0;
          return prices.at(-1)!.backpackBidVwap / prices[0]!.backpackBidVwap - 1;
        }
      }
    };
    return [...scannerRows].sort((left, right) => {
      const leftValue = value(left);
      const rightValue = value(right);
      const comparison = typeof leftValue === "string" && typeof rightValue === "string"
        ? leftValue.localeCompare(rightValue)
        : Number(leftValue) - Number(rightValue);
      return comparison * direction || left.pair.localeCompare(right.pair);
    });
  }, [pairTradeStats, recentPriceHistoryByPair, scannerRows, scannerSort]);
  const sortScanner = (key: ScannerSortKey) => {
    setScannerSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: key === "ticker" ? "asc" : "desc" });
  };
  const tradePageCount = Math.max(1, Math.ceil(tradeRows.length / TRADES_PER_PAGE));
  const visibleTradeRows = useMemo(() => {
    const start = (tradePage - 1) * TRADES_PER_PAGE;
    return tradeRows.slice(start, start + TRADES_PER_PAGE);
  }, [tradePage, tradeRows]);
  useEffect(() => {
    if (tradePage > tradePageCount) setTradePage(tradePageCount);
  }, [tradePage, tradePageCount]);
  const pairError = monitor?.state.pairErrors[selectedPair];
  const isDataDelayed = (sample: Sample, pair?: Pair) =>
    isMarketDataDelayError(monitor?.state.pairErrors[sample.pair])
    || Boolean(pair && monitor?.operational.backpack.staleSymbols.includes(pair.perpSymbol))
    || Date.now() - Date.parse(sample.capturedAt) > 180_000;

  return <>
    <SiteNav dashboard />
    <main className="dashboard-page">
      <DashboardHero />
      <div className="dashboard-board">
      {error && <div className="alert">{error}. Check the API and MongoDB.</div>}
      {monitor?.state.lastError && !isMarketDataDelayError(monitor.state.lastError) && <div className="alert">{monitor.state.lastError}</div>}
      {pairError && !isMarketDataDelayError(pairError) && <div className="alert">{selectedPair}: {pairError}</div>}
      {monitor?.state.marketHoliday && <div className="alert">US equities: {monitor.state.marketHoliday} — session closed.</div>}

      <section className="scanner-card" hidden>
        <div className="section-heading scanner-heading">
          <div><span className="eyebrow">Screener</span><h2>Tokenized equities</h2></div>
          <div className="size-switch" aria-label="Trade size"><button className="active">{usd(selectedSize, 0)}</button></div>
        </div>
        <div className="scanner-table-wrap">
          <table className="scanner-table">
            <thead><tr><th>Asset</th><th>DEX buy</th><th>Backpack bid</th><th>Entry basis</th><th>Target basis</th><th>Entry edge</th><th>Funding / interval</th><th>Signal</th></tr></thead>
            <tbody>
              {scannerRows.map((sample) => {
                const pair = monitor?.pairs.find((item) => item.symbol === sample.pair);
                const stale = !pair
                  || monitor?.operational.backpack.staleSymbols.includes(pair.perpSymbol)
                  || Date.now() - Date.parse(sample.capturedAt) > 180_000;
                return <tr key={sample.pair} className={sample.pair === selectedPair ? "selected" : ""} onClick={() => setSelectedPair(sample.pair)} tabIndex={0} onKeyDown={(event) => event.key === "Enter" && setSelectedPair(sample.pair)}>
                  <td><TickerIdentity symbol={sample.pair} pair={pair} dataDelayed={stale} /></td><td>{price(sample.dexBuyPrice)}</td><td>{price(sample.backpackBidVwap)}</td>
                  <td className={entryBasis(sample) >= 0 ? "number-positive" : "number-negative"}>{pct(entryBasis(sample))}</td><td>{sample.targetExitBasisPct === undefined ? "—" : pct(sample.targetExitBasisPct)}</td>
                  <td className={entryEdge(sample) >= MIN_ENTRY_EDGE_PCT ? "number-positive" : "number-negative"}>{pct(entryEdge(sample))}</td>
                  <td className={fundingRate(sample) >= 0 ? "number-positive" : "number-negative"}>{pct(fundingRate(sample), 4)}</td>
                  <td><span className={`table-verdict ${isEntryCandidate(entryEdge(sample)) && !stale ? "table-verdict--go" : ""}`}>{stale ? "STALE" : isEntryCandidate(entryEdge(sample)) ? "CANDIDATE" : "WAIT"}</span></td>
                </tr>;
              })}
              {scannerRows.length === 0 && <tr className="table-empty"><td colSpan={8}>Collecting initial market quotes…</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="scanner-card spread-scanner-card" aria-labelledby="spread-scanner-title">
        <div className="section-heading scanner-heading">
          <h2 id="spread-scanner-title">Backpack ↔ Jupiter spread scanner</h2>
          <span className="scanner-online"><i aria-hidden="true" />{
            liveError
              ? "Unavailable"
              : monitor?.state.status === "ready" || monitor?.state.status === "collecting"
                ? "Live"
                : "Connecting"
          }</span>
        </div>
        <div className="mobile-scanner-controls">
          <label htmlFor="mobile-scanner-sort">Sort by</label>
          <select
            id="mobile-scanner-sort"
            value={scannerSort.key}
            onChange={(event) => {
              const key = event.target.value as ScannerSortKey;
              setScannerSort({ key, direction: key === "ticker" ? "asc" : "desc" });
            }}
          >
            <option value="ticker">Ticker</option>
            <option value="price">Backpack price</option>
            <option value="funding">Funding</option>
            <option value="spread">Spread</option>
            <option value="trades">Verified trades</option>
            <option value="profit">Realized hedged PnL</option>
            <option value="chart">Backpack price trend</option>
          </select>
          <button type="button" onClick={() => sortScanner(scannerSort.key)} aria-label="Reverse sort direction">
            {scannerSort.direction === "asc" ? "Ascending ↑" : "Descending ↓"}
          </button>
        </div>
        <div className="mobile-scanner-list">
          {sortedScannerRows.map((sample) => {
            const pair = monitor?.pairs.find((item) => item.symbol === sample.pair);
            const spread = priceSpreadPct(sample);
            const tradeStats = pairTradeStats[sample.pair] ?? { trades: 0, pnlUsd: 0 };
            const dataDelayed = isDataDelayed(sample, pair);
            return <article className="mobile-market-card" key={sample.pair}>
              <header>
                <TickerIdentity symbol={sample.pair} pair={pair} dataDelayed={dataDelayed} />
                <div className="mobile-market-card__spread">
                  <span>Spread</span>
                  <strong className={spread >= 0 ? "number-positive" : "number-negative"}>{pct(spread, 3)}</strong>
                </div>
              </header>
              <div className="mobile-market-card__prices">
                <MarketPrice label="Backpack" value={sample.backpackBidVwap} />
                <MarketPrice label="Jupiter" value={sample.dexBuyPrice} />
              </div>
              <div className="mobile-market-card__stats">
                <div><span>Funding</span><strong className={fundingRate(sample) >= 0 ? "number-positive" : "number-negative"}>{pct(fundingRate(sample), 4)}</strong><small>{sample.fundingIntervalMinutes ? `Every ${sample.fundingIntervalMinutes} min` : "Interval unavailable"}</small></div>
                <div><span>Verified trades</span><strong>{tradeStats.trades}</strong></div>
                <div><span>Realized hedged PnL</span><strong className={tradeStats.pnlUsd > 0 ? "number-positive" : tradeStats.pnlUsd < 0 ? "number-negative" : ""}>{usd(tradeStats.pnlUsd)}</strong></div>
              </div>
              <div className="mobile-market-card__chart">
                <span>Price history 90min</span>
                <PriceSparkline history={recentPriceHistoryByPair.get(sample.pair) ?? EMPTY_PRICE_HISTORY} symbol={sample.pair} />
              </div>
            </article>;
          })}
          {sortedScannerRows.length === 0 && <div className="mobile-scanner-empty">Collecting initial market quotes…</div>}
        </div>
        <div className="scanner-table-wrap spread-scanner-table-wrap">
          <table className="scanner-table spread-scanner-table">
            <thead><tr>
              <SortableHeader label="Ticker" sortKey="ticker" activeKey={scannerSort.key} direction={scannerSort.direction} onSort={sortScanner} />
              <SortableHeader label="Prices" sortKey="price" activeKey={scannerSort.key} direction={scannerSort.direction} onSort={sortScanner} title="Sort by Backpack price" />
              <SortableHeader label="Funding" sortKey="funding" activeKey={scannerSort.key} direction={scannerSort.direction} onSort={sortScanner} />
              <SortableHeader label="Spread" sortKey="spread" activeKey={scannerSort.key} direction={scannerSort.direction} onSort={sortScanner} />
              <SortableHeader label="Verified trades" sortKey="trades" activeKey={scannerSort.key} direction={scannerSort.direction} onSort={sortScanner} />
              <SortableHeader label="Realized hedged PnL" sortKey="profit" activeKey={scannerSort.key} direction={scannerSort.direction} onSort={sortScanner} />
              <SortableHeader label="Price history 90min" sortKey="chart" activeKey={scannerSort.key} direction={scannerSort.direction} onSort={sortScanner} title="Sort by Backpack price change over the last 90 minutes" />
            </tr></thead>
            <tbody>
              {sortedScannerRows.map((sample) => {
                const pair = monitor?.pairs.find((item) => item.symbol === sample.pair);
                const spread = priceSpreadPct(sample);
                const tradeStats = pairTradeStats[sample.pair] ?? { trades: 0, pnlUsd: 0 };
                const dataDelayed = isDataDelayed(sample, pair);
                return <tr key={sample.pair}>
                  <td><TickerIdentity symbol={sample.pair} pair={pair} dataDelayed={dataDelayed} /></td>
                  <td className="market-prices">
                    <MarketPrice label="Backpack" value={sample.backpackBidVwap} />
                    <MarketPrice label="Jupiter" value={sample.dexBuyPrice} />
                  </td>
                  <td className={fundingRate(sample) >= 0 ? "number-positive" : "number-negative"}>
                    <b>{pct(fundingRate(sample), 4)}</b>
                    <span>{sample.fundingIntervalMinutes ? `Every ${sample.fundingIntervalMinutes} min` : "Interval unavailable"}</span>
                  </td>
                  <td className={spread >= 0 ? "number-positive" : "number-negative"}>{pct(spread, 3)}</td>
                  <td className="trade-count">{tradeStats.trades}</td>
                  <td className={tradeStats.pnlUsd > 0 ? "number-positive" : tradeStats.pnlUsd < 0 ? "number-negative" : ""}>{usd(tradeStats.pnlUsd)}</td>
                  <td><PriceSparkline history={recentPriceHistoryByPair.get(sample.pair) ?? EMPTY_PRICE_HISTORY} symbol={sample.pair} /></td>
                </tr>;
              })}
              {scannerRows.length === 0 && <tr className="table-empty"><td colSpan={7}>Collecting initial market quotes…</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="scanner-card executions-card">
        <div className="section-heading scanner-heading">
          <div><h2>Executed hedged trades</h2></div>
        </div>
        <div className="mobile-trade-list">
          {visibleTradeRows.map((row) => <TradeCard
            key={row.campaignId}
            symbol={row.pair}
            pair={monitor?.pairs.find((item) => item.symbol === row.pair)}
            amountUsd={row.amountUsd}
            realizedPnlUsd={row.realizedPnlUsd}
            sourceIntegrity={row.sourceIntegrity}
            fills={row.fills}
            entryAt={row.entryAt}
            exitAt={row.exitAt}
            status={row.status}
            live
          />)}
          {tradeRows.length === 0 && <div className="mobile-trade-empty">No executed hedged trades in the available history.</div>}
        </div>
        <div className="scanner-table-wrap trade-table-wrap">
          <table className="scanner-table executions-table">
            <thead><tr><th>Ticker</th><th>Amount</th><th>Fills</th><th>Realized hedged PnL</th><th>Signal source</th><th>Entry transactions</th><th>Exit transactions</th><th>Status</th></tr></thead>
            <tbody>
              {visibleTradeRows.map((row) => {
                const pair = monitor?.pairs.find((item) => item.symbol === row.pair);
                return <tr key={row.campaignId}>
                  <td><TickerIdentity symbol={row.pair} pair={pair} /></td>
                  <td>{row.amountUsd === null ? "—" : usd(row.amountUsd)}</td>
                  <td>{row.fills.length}</td>
                  <td className={row.realizedPnlUsd === null ? "" : row.realizedPnlUsd >= 0 ? "number-positive" : "number-negative"}>{row.realizedPnlUsd === null ? "—" : usd(row.realizedPnlUsd)}</td>
                  <td>{row.sourceIntegrity === "VERIFIED_LIVE" ? "LIVE MARKET" : "LEGACY SYNTHETIC TRIGGER"}</td>
                  <td><CampaignTransactions fills={row.fills} leg="entry" fallbackTime={row.entryAt} /></td>
                  <td><CampaignTransactions fills={row.fills} leg="exit" fallbackTime={row.exitAt} /></td>
                  <td><span className={`table-verdict trade-status--${row.status.toLowerCase()}`}>{row.status.replaceAll("_", " ")}</span></td>
                </tr>;
              })}
              {tradeRows.length === 0 && <tr className="table-empty"><td colSpan={8}>No executed hedged trades in the available history.</td></tr>}
            </tbody>
          </table>
        </div>
        <nav className="trade-pagination" aria-label="Trade pages">
          <button type="button" disabled={tradePage <= 1} onClick={() => setTradePage((page) => page - 1)}>PREVIOUS</button>
          <span>Page <b>{tradePage}</b> of <b>{tradePageCount}</b></span>
          <button type="button" disabled={tradePage >= tradePageCount} onClick={() => setTradePage((page) => page + 1)}>NEXT</button>
        </nav>
      </section>

      </div>
    </main>
  </>;
}

export function App() {
  return <MainDashboard />;
}
