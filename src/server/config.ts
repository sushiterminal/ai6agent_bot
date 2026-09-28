import "dotenv/config";

function numberSetting(name: string, fallback: number, minimum = 0): number {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a finite number >= ${minimum}`);
  }
  return value;
}

function integerSetting(name: string, fallback: number, minimum = 0): number {
  const value = numberSetting(name, fallback, minimum);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function booleanSetting(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function listSetting(name: string, fallback: string): string[] {
  return (process.env[name]?.trim() || fallback)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

const backpackApiKey = process.env.BACKPACK_API_KEY?.trim() || null;
const backpackApiSecret = process.env.BACKPACK_API_SECRET?.trim() || null;
const jupiterApiKey = process.env.JUPITER_API_KEY?.trim() || null;
const solanaRpcUrl = process.env.SOLANA_RPC_URL?.trim() || null;
const solanaWalletPublicKey = process.env.SOLANA_WALLET_PUBLIC_KEY?.trim() || null;
const solanaSignerCredentialsFile = process.env.SOLANA_SIGNER_CREDENTIALS_FILE?.trim() || null;
const solanaSignerPassphrase = process.env.SOLANA_SIGNER_PASSPHRASE?.trim() || null;
const legacyJupiterInterval = process.env.JUPITER_REQUEST_INTERVAL_MS?.trim();
const defaultJupiterRps = legacyJupiterInterval
  ? 1_000 / numberSetting("JUPITER_REQUEST_INTERVAL_MS", 2_100, 1)
  : jupiterApiKey ? 1 : 0.5;

if ((backpackApiKey === null) !== (backpackApiSecret === null)) {
  throw new Error("BACKPACK_API_KEY and BACKPACK_API_SECRET must be set together");
}

export const config = {
  port: integerSetting("PORT", 3001, 1),
  mongoUri: process.env.MONGODB_URI?.trim() || "mongodb://127.0.0.1:27017",
  mongoDb: process.env.MONGODB_DB?.trim() || "stock_trade_bot",
  credentialsFile: process.env.BACKPACK_CREDENTIALS_FILE?.trim() || null,
  backpackApiKey,
  backpackApiSecret,
  backpackWebsocketUrl:
    process.env.BACKPACK_WEBSOCKET_URL?.trim() || "wss://ws.backpack.exchange",
  backpackMarketMaxAgeMs: integerSetting("BACKPACK_MARKET_MAX_AGE_MS", 3_000, 100),
  backpackSnapshotTimeoutMs: integerSetting("BACKPACK_SNAPSHOT_TIMEOUT_MS", 8_000, 100),
  jupiterApiKey,
  solanaRpcUrl,
  solanaWalletPublicKey,
  solanaSignerCredentialsFile,
  solanaSignerPassphrase,
  solanaRpcTimeoutMs: integerSetting("SOLANA_RPC_TIMEOUT_MS", 15_000, 100),
  solanaSendMaxRetries: integerSetting("SOLANA_SEND_MAX_RETRIES", 3, 0),
  jupiterMaxPriorityFeeLamports: integerSetting(
    "JUPITER_MAX_PRIORITY_FEE_LAMPORTS",
    100_000,
    0,
  ),
  jupiterRps: numberSetting("JUPITER_REQUESTS_PER_SECOND", defaultJupiterRps, 0.1),
  jupiterRequestTimeoutMs: integerSetting("JUPITER_REQUEST_TIMEOUT_MS", 10_000, 100),
  jupiterJobDeadlineMs: integerSetting("JUPITER_JOB_DEADLINE_MS", 30_000, 1_000),
  jupiterMaxRetries: integerSetting("JUPITER_MAX_RETRIES", 2, 0),
  jupiterExcludedDexes: listSetting("JUPITER_EXCLUDED_DEXES", "Denali"),
  jupiterAutoKillSwitch: booleanSetting("JUPITER_AUTO_KILL_SWITCH", true),
  jupiterAutoExecutionEnabled: booleanSetting("JUPITER_AUTO_EXECUTION_ENABLED", false),
  jupiterAutoNotionalUsd: numberSetting("JUPITER_AUTO_NOTIONAL_USD", 50, 1),
  jupiterAutoAddNotionalUsd: numberSetting("JUPITER_AUTO_ADD_NOTIONAL_USD", 50, 1),
  jupiterAutoAddEdgeStepPct: numberSetting("JUPITER_AUTO_ADD_EDGE_STEP_PCT", 0.1, 0.000001),
  jupiterAutoSlippageBps: integerSetting("JUPITER_AUTO_SLIPPAGE_BPS", 50, 0),
  jupiterAutoMinEntryEdgePct: numberSetting("JUPITER_AUTO_MIN_ENTRY_EDGE_PCT", 0.25, -100),
  jupiterAutoExitEdgePct: numberSetting("JUPITER_AUTO_EXIT_EDGE_PCT", 0.1, -100),
  jupiterAutoMaxOpenPositions: integerSetting("JUPITER_AUTO_MAX_OPEN_POSITIONS", 10, 1),
  jupiterAutoMaxDailyEntries: integerSetting("JUPITER_AUTO_MAX_DAILY_ENTRIES", 3, 1),
  jupiterAutoMaxExitAttempts: integerSetting("JUPITER_AUTO_MAX_EXIT_ATTEMPTS", 3, 1),
  jupiterAutoMinSolLamports: integerSetting("JUPITER_AUTO_MIN_SOL_LAMPORTS", 10_000_000, 1),
  jupiterAutoMaxUnhedgedUsd: numberSetting("JUPITER_AUTO_MAX_UNHEDGED_USD", 2, 0),
  jupiterAutoAllowedPairs: listSetting("JUPITER_AUTO_ALLOWED_PAIRS", "SPCX"),
  jupiterLivePortfolioEnabled: booleanSetting("JUPITER_LIVE_PORTFOLIO_ENABLED", false),
  jupiterLiveBudgetUsd: numberSetting("JUPITER_LIVE_BUDGET_USD", 500, 1),
  jupiterLiveMaxDailyEntries: integerSetting("JUPITER_LIVE_MAX_DAILY_ENTRIES", 50, 1),
  jupiterLiveStopLossUsd: numberSetting("JUPITER_LIVE_STOP_LOSS_USD", 30, 0.01),
  jupiterLiveUsdcReserveUsd: numberSetting("JUPITER_LIVE_USDC_RESERVE_USD", 20, 0),
  hotEdgePct: numberSetting("HOT_EDGE_PCT", -0.15, -100),
  warmEdgePct: numberSetting("WARM_EDGE_PCT", -0.35, -100),
  hotPairIntervalMs: integerSetting("HOT_PAIR_INTERVAL_MS", 1_000, 100),
  warmPairIntervalMs: integerSetting("WARM_PAIR_INTERVAL_MS", 5_000, 100),
  coldPairIntervalMs: integerSetting("COLD_PAIR_INTERVAL_MS", 60_000, 1_000),
  errorPairIntervalMs: integerSetting("ERROR_PAIR_INTERVAL_MS", 30_000, 1_000),
  collectorRestartBaseMs: integerSetting("COLLECTOR_RESTART_BASE_MS", 1_000, 100),
  collectorRestartMaxMs: integerSetting("COLLECTOR_RESTART_MAX_MS", 30_000, 1_000),
  positiveConfirmations: integerSetting("POSITIVE_CONFIRMATIONS", 2, 0),
  confirmationDelayMs: integerSetting("CONFIRMATION_DELAY_MS", 250, 0),
  safetyBufferPct: numberSetting("PROFIT_THRESHOLD_PCT", 0.15, 0),
  targetExitBasisPct: numberSetting("TARGET_EXIT_BASIS_PCT", 0, -100),
  expectedSpotSlippagePct: numberSetting("EXPECTED_SPOT_SLIPPAGE_PCT", 0.03, 0),
  expectedPerpSlippagePct: numberSetting("EXPECTED_PERP_SLIPPAGE_PCT", 0.02, 0),
  solanaTransactionFeesUsd: numberSetting("SOLANA_TRANSACTION_FEES_USD", 0.02, 0),
  priorityFeesUsd: numberSetting("PRIORITY_FEES_USD", 0.02, 0),
  partialFillReservePct: numberSetting("PARTIAL_FILL_RESERVE_PCT", 0.05, 0),
  expectedFundingPeriods: integerSetting("EXPECTED_FUNDING_PERIODS", 0, 0),
  canaryKillSwitch: booleanSetting("CANARY_KILL_SWITCH", true),
  canaryExecutionEnabled: booleanSetting("CANARY_EXECUTION_ENABLED", false),
  canaryPreviewTtlMs: integerSetting("CANARY_PREVIEW_TTL_SECONDS", 30, 5) * 1_000,
  canaryConfirmationTimeoutMs: integerSetting("CANARY_CONFIRMATION_TIMEOUT_MS", 30_000, 1_000),
  canaryConfirmationPollMs: integerSetting("CANARY_CONFIRMATION_POLL_MS", 1_000, 100),
  canaryMaxLossPerTradeUsd: numberSetting("CANARY_MAX_LOSS_PER_TRADE_USD", 1, 0),
  canaryMaxDailyLossUsd: numberSetting("CANARY_MAX_DAILY_LOSS_USD", 5, 0),
  canaryMaxDailyAttempts: integerSetting("CANARY_MAX_DAILY_ATTEMPTS", 5, 1),
  canaryMaxOpenPositions: integerSetting("CANARY_MAX_OPEN_POSITIONS", 1, 1),
  canaryMinExpectedPnlUsd: numberSetting("CANARY_MIN_EXPECTED_PNL_USD", 0, 0),
  canaryMinEntryEdgePct: numberSetting("CANARY_MIN_ENTRY_EDGE_PCT", 0, 0),
  canaryAllowedPairs: listSetting(
    "CANARY_ALLOWED_PAIRS",
    "MU,SNDK,SPCX,AMD,HOOD,INTC,SKHY,DRAM,META,MSFT,GOOGL,QQQ,SPY",
  ),
} as const;

if (config.hotEdgePct < config.warmEdgePct) {
  throw new Error("HOT_EDGE_PCT must be >= WARM_EDGE_PCT");
}
if (config.collectorRestartMaxMs < config.collectorRestartBaseMs) {
  throw new Error("COLLECTOR_RESTART_MAX_MS must be >= COLLECTOR_RESTART_BASE_MS");
}
if (config.jupiterAutoSlippageBps > 10_000) {
  throw new Error("JUPITER_AUTO_SLIPPAGE_BPS must be <= 10000");
}
if (
  config.jupiterAutoExecutionEnabled
  && !config.jupiterAutoKillSwitch
  && (
    !config.solanaRpcUrl
    || !config.solanaWalletPublicKey
    || !config.solanaSignerCredentialsFile
    || !config.solanaSignerPassphrase
    || !config.backpackApiKey
    || !config.backpackApiSecret
  )
) {
  throw new Error("Enabled hedged auto execution requires Solana signer and Backpack credentials");
}
