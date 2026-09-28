# Equity Spread Monitor

This service looks for price discrepancies between tokenized equities on Solana and their corresponding perpetual futures on Backpack. Its primary strategy is to buy spot through Jupiter while opening a matching perpetual short on Backpack, then close both legs after the price difference narrows.

> This is experimental trading software, not a guarantee of profit. It sends real transactions and orders when its safety locks are explicitly disabled. Before enabling live trading, verify every instrument, limit, wallet, and recovery procedure using the smallest practical size.

## What is included

- Live monitoring of 13 pairs using Jupiter quotes and Backpack order books.
- Round-trip profitability estimates including fees, slippage, and a partial-fill reserve.
- An automated `Jupiter spot long + Backpack perpetual short` execution path.
- A separate supervised canary flow with immutable previews and manual approval.
- Reconciliation of unknown outcomes without blind resubmission.
- A dashboard for current signals, history, and factual PnL.
- MongoDB as the only persistent data store.

## Where the profit comes from

The strategy attempts to profit from basis convergence—the narrowing difference between perpetual and spot prices—rather than predicting the direction of the underlying market.

Example before expenses:

1. A tokenized equity costs `$100` through Jupiter.
2. Its Backpack perpetual can be sold at `$101`.
3. The bot buys one spot unit for `$100` and opens a perpetual short at `$101`.
4. Both prices later converge to `$100.50`.
5. Spot earns `+$0.50`, the short earns `+$0.50`, and gross PnL is `+$1.00`.

If both prices rise or fall together, the long and short should mostly offset one another. The final result depends on how the basis changes, how both legs actually fill, and all associated costs.

Key metrics:

- `entryBasisPct = Backpack bid / Jupiter buy price - 1` — the premium available when opening the short relative to the spot purchase.
- `estimatedConvergencePnlUsd` — modeled PnL if the basis reaches `TARGET_EXIT_BASIS_PCT`.
- `immediateLiquidationPnlUsd` — modeled PnL from closing immediately at current quotes.
- `expectedReturnPct = estimatedConvergencePnlUsd / sizeUsd * 100`.
- `entryEdgePct = expectedReturnPct - PROFIT_THRESHOLD_PCT`.

`PROFIT_THRESHOLD_PCT` is an entry safety threshold, not a booked expense. A positive `entryEdgePct` means the modeled return exceeds that buffer. It is a signal, not a promise of realized profit.

The `estimatedConvergencePnlUsd` model includes:

- The spot round trip based on current Jupiter quotes.
- The short-perpetual result at the target basis.
- Backpack taker fees for opening and closing.
- Configured additional spot and perpetual slippage.
- Estimated Solana transaction and priority fees.
- A reserve for incomplete execution.
- Funding for the number of periods in `EXPECTED_FUNDING_PERIODS`, which defaults to `0`.

After a position closes, factual `realizedPnlUsd` is calculated as:

```text
spot PnL = USDC received on sale - USDC spent on purchase
perpetual PnL = (short entry price - short exit price) * quantity
                - Backpack entry fee - Backpack exit fee
realized PnL = spot PnL + perpetual PnL
```

Solana network fees are stored separately in lamports and are not deducted from `realizedPnlUsd`. Actual Backpack funding payments are also not included in that figure. The dashboard PnL is therefore not complete account-level accounting without a separate wallet and Backpack reconciliation.

## Data flow

```text
Jupiter buy/sell quotes ----+
                            +--> collector --> PnL model --> MongoDB --> API --> dashboard
Backpack WS order book -----+
Backpack funding/fees -------+
                                   |
                                   +--> confirmed signal
                                            |
                                            +--> automatic round trip, if enabled
```

The collector scans pairs sequentially. For every pair, it:

1. Requests an exact-input `USDC -> token` quote for `$3000` (`TRACKED_SIZE`).
2. Requests the reverse `token -> USDC` quote for the resulting quantity.
3. Calculates Backpack bid and ask VWAP for the same quantity using the live order book.
4. Applies prices, taker fees, funding, and configured reserves to the PnL model.
5. Stores the sample in `spread_samples`.
6. When the edge is positive and market data is fresh, takes another `POSITIVE_CONFIRMATIONS` samples separated by `CONFIRMATION_DELAY_MS`.

Scheduling is adaptive: hot pairs are checked more frequently and cold pairs less frequently. A stale Backpack order book cannot produce a valid signal. Pair-specific failures use backoff without stopping the rest of the scanner; collector-level failures trigger restart attempts with exponential delay.

## Automatic round trips

Automatic execution is disabled by two independent settings by default:

```dotenv
JUPITER_AUTO_EXECUTION_ENABLED=false
JUPITER_AUTO_KILL_SWITCH=true
```

Real writes require `JUPITER_AUTO_EXECUTION_ENABLED=true`, `JUPITER_AUTO_KILL_SWITCH=false`, a Solana RPC and signer, and Backpack API credentials. Entries are limited to `same_issuer` pairs listed in `JUPITER_AUTO_ALLOWED_PAIRS`.

### Entry

1. The signal must pass repeated confirmation and the `minEntryEdgePct` threshold.
2. The runtime checks portfolio status, the daily stop, position capacity, budget, daily entry count, and unresolved submissions.
3. Quotes are requested again for the real trade size and the edge is recalculated.
4. The runtime checks USDC and SOL reserves, Backpack collateral and market limits, and the maximum allowed unhedged remainder.
5. The signed Jupiter transaction and signature are persisted to MongoDB before broadcast.
6. After `finalized` confirmation, factual wallet deltas determine the real spot quantity used to size the short, subject to Backpack step-size rounding.
7. The short is submitted as an IOC limit order. Its command and deterministic client ID are persisted before the Backpack request.
8. The position reaches `OPEN` only after a complete, factually confirmed short fill.

This sequence creates a window of directional exposure between the spot purchase and the short fill. If the short does not fill completely, the trade moves to `MANUAL_INTERVENTION` instead of being reported as a successfully hedged position.

### Exit

The normal automatic exit currently triggers when `entryEdgePct <= exitEdgePct`. Positions can also be liquidated when the live portfolio is stopped with liquidation enabled.

1. The short is closed first with a reduce-only IOC buy.
2. Only after the full fill is confirmed does the bot sell the exact factual spot quantity through Jupiter.
3. After the Solana transaction reaches `finalized`, PnL is calculated from factual wallet deltas and Backpack fills.

Closing the short before selling spot creates another window of directional exposure. The current runtime has no separate per-trade stop-loss or timeout exit: its primary trigger is the exit-edge threshold, while the portfolio stop is based on already realized daily PnL.

Automatic trade states:

```text
ENTRY_PLANNED -> ENTRY_SUBMITTED -> HEDGE_PENDING -> HEDGE_SUBMITTED -> OPEN
OPEN -> HEDGE_CLOSE_PENDING -> HEDGE_CLOSE_SUBMITTED -> EXIT_PLANNED
EXIT_PLANNED -> EXIT_SUBMITTED -> CLOSED
```

Failures before factual submission can terminate an entry as `FAILED`. Ambiguous or invalid results, partial fills, and invariant violations can require `MANUAL_INTERVENTION`.

## Supervised canary flow

The canary is a separate operator-controlled path for small trades, currently fixed at `$40` in code. It is not automatically enabled with the automatic execution path.

Typical flow:

1. Create an idempotent trade intent.
2. Generate a fresh preview containing the Jupiter route, Solana simulation, Backpack preflight, and risk gates.
3. Approve the exact fingerprint and approval text before the preview expires.
4. Execute spot, confirm its factual outcome, and then execute the hedge.
5. Reconcile any unknown result before taking another action; blind resubmission is prohibited.
6. Use separate preview, approval, and recovery steps for `SPOT_ONLY`, `PERP_ONLY`, and partially hedged states.

Real canary writes require both:

```dotenv
CANARY_EXECUTION_ENABLED=true
CANARY_KILL_SWITCH=false
```

The canary is additionally constrained by its pair allowlist, maximum loss per trade and per day, attempt count, open-position count, and minimum expected edge and PnL.

## Pairs and basis risk

The automatic round-trip flow supports these `same_issuer` pairs: `MU`, `SNDK`, `SPCX`, `AMD`, `HOOD`, `INTC`, `SKHY`, and `DRAM`.

The following `cross_issuer` pairs are monitored, but their spot token and Backpack perpetual may have different issuers or different legal and pricing structures: `META`, `MSFT`, `GOOGL`, `QQQ`, and `SPY`. Matching ticker symbols do not guarantee arbitrage equivalence, so the automatic path rejects these pairs.

Current mint addresses, token decimals, and Backpack symbols are defined in `src/server/pairs.ts` and must be verified before live trading.

## Primary risks

1. **Leg risk.** Spot and short execution is not atomic. The market can move sharply between fills; during exit, the short closes before the spot sale.
2. **Basis risk.** The spread may widen, may never converge, or may remain open longer than expected.
3. **Short liquidation.** The spot long is not collateral inside Backpack. Insufficient margin can liquidate the short even when the combined position is economically hedged.
4. **Partial fills and liquidity.** IOC orders can fill partially, visible depth can disappear, and realized slippage can exceed the model.
5. **Cross-venue and infrastructure risk.** Solana, Jupiter, the RPC provider, Backpack REST or WebSocket services, and MongoDB can fail or respond too slowly.
6. **Unknown outcomes.** A timeout does not mean an operation failed. The application persists signatures and client IDs for reconciliation, but some outcomes still require an operator.
7. **Funding.** Positive funding is income for the short and negative funding is an expense. The model includes zero future periods by default, and factual realized PnL does not reconcile funding payments.
8. **Fees and model error.** Quotes and VWAP are snapshots, while slippage, fees, and reserves are estimates. Solana fees and funding are excluded from final dashboard realized PnL.
9. **Token and issuer risk.** Tokenized equities carry issuer, custody, redemption, market-access, and underlying-tracking risk.
10. **Market-hours risk.** The perpetual and token may trade while the underlying equity market is closed. A reopening gap can change the basis abruptly.
11. **Credential risk.** A compromised Solana signer or Backpack API credential can expose real funds. Credential files must remain outside the repository.
12. **Stop-loss limitations.** The daily stop observes realized PnL from closed trades. Unrealized losses on open positions do not trigger it by themselves.

## Safety mechanisms

- Fail-closed kill switches and execution disabled by default.
- Pair allowlists.
- Exact-size economics recalculation immediately before entry.
- Budget, position, daily entry, USDC reserve, and SOL reserve limits.
- Backpack market-data freshness checks and repeated signal confirmation.
- Signed Solana transaction simulation before broadcast.
- Persistence-before-broadcast for signatures and Backpack commands.
- Deterministic Backpack client IDs and unique MongoDB indexes.
- Finalized wallet deltas instead of expected quote amounts.
- Reduce-only short exits.
- A bounded number of automatic spot-exit attempts.
- Explicit `MANUAL_INTERVENTION` and recovery states instead of hidden retries.

These measures reduce operational risk but do not remove market, counterparty, or technology risk.

## Architecture

The application is a modular monolith:

```text
src/server/
  index.ts                       Fastify API and application lifecycle
  collector.ts                   quote and order-book collection
  profitability.ts               edge and expected-PnL model
  jupiter*.ts                    quotes, spot execution, and automatic round trips
  backpack*.ts                   REST/WS market data and orders
  entry-*.ts, recovery-*.ts      supervised canary and recovery flows
  repository.ts                  MongoDB persistence and optimistic transitions
  pairs.ts, config.ts            instruments and environment configuration

src/frontend/
  src/App.tsx                    React dashboard

tests/                            focused unit and integration-style tests
scripts/                          watchdog and canary-wallet utilities
```

MongoDB collections:

- `spread_samples` — historical quote, order-book, and modeled-PnL snapshots.
- `trade_intents` — the supervised canary state machine.
- `jupiter_round_trip_trades` — automatic round trips, events, signatures, fills, and PnL.
- `jupiter_live_control` — live-portfolio status and settings.

At startup, legacy synthetic and demo data is removed. Historical real trades triggered by the retired synthetic-price system are retained and marked `LEGACY_SYNTHETIC_TRIGGER`. New executions are marked `VERIFIED_LIVE`.

## Running the application

Node.js, npm, and an accessible MongoDB instance are required.

```powershell
npm install
Copy-Item .env.example .env
# Configure .env. Do not commit secrets or signer files.
npm run dev
```

Before running `npm run dev`, ensure no other project stack is active and ports `3001` and `5173` are free. The watchdog starts one API process and one Vite frontend process.

- Dashboard: `http://localhost:5173/dashboard`
- Liveness: `http://127.0.0.1:3001/api/health/live`
- Readiness: `http://127.0.0.1:3001/api/health/ready`
- Prometheus metrics: `http://127.0.0.1:3001/metrics`

Readiness requires MongoDB and connected, fresh Backpack feeds. The dashboard reads exclusively from the API; there is no synthetic fixture or runtime fallback.

Production build and start:

```powershell
npm run build
npm start
```

`npm start` serves the built frontend from `dist/client` through Fastify.

## Main settings

See `.env.example` for the complete list and safe defaults.

| Group | Variables |
|---|---|
| MongoDB | `MONGODB_URI`, `MONGODB_DB` |
| Market data | `BACKPACK_WEBSOCKET_URL`, `BACKPACK_MARKET_MAX_AGE_MS` |
| Signal | `PROFIT_THRESHOLD_PCT`, `TARGET_EXIT_BASIS_PCT`, `POSITIVE_CONFIRMATIONS` |
| Cost model | `EXPECTED_SPOT_SLIPPAGE_PCT`, `EXPECTED_PERP_SLIPPAGE_PCT`, `SOLANA_TRANSACTION_FEES_USD`, `PRIORITY_FEES_USD`, `PARTIAL_FILL_RESERVE_PCT` |
| Automatic entry and exit | `JUPITER_AUTO_MIN_ENTRY_EDGE_PCT`, `JUPITER_AUTO_EXIT_EDGE_PCT`, `JUPITER_AUTO_NOTIONAL_USD`, `JUPITER_AUTO_ALLOWED_PAIRS` |
| Portfolio limits | `JUPITER_LIVE_BUDGET_USD`, `JUPITER_LIVE_MAX_DAILY_ENTRIES`, `JUPITER_LIVE_STOP_LOSS_USD`, `JUPITER_LIVE_USDC_RESERVE_USD` |
| Execution safety | `JUPITER_AUTO_EXECUTION_ENABLED`, `JUPITER_AUTO_KILL_SWITCH`, `JUPITER_AUTO_MAX_UNHEDGED_USD`, `JUPITER_AUTO_MAX_EXIT_ATTEMPTS` |
| Canary | `CANARY_EXECUTION_ENABLED`, `CANARY_KILL_SWITCH`, `CANARY_MAX_*`, `CANARY_ALLOWED_PAIRS` |

Do not enable execution solely because the scanner reports a positive edge. First verify units, tick and step sizes, balances, margin, API limits, reconciliation, and recovery against the current live accounts.

## Monitoring and API

Primary read endpoints:

- `GET /api/monitor` — collector state, latest samples, execution policy, and live portfolio.
- `GET /api/history` and `GET /api/history/changes` — scanner history.
- `GET /api/jupiter/round-trips` — automatic trades and factual PnL.
- `GET /api/canary/intents` — supervised trade intents.
- `GET /metrics` — Backpack WebSocket status, Jupiter rate limits, and scheduler lag.

Research endpoints request fresh quotes and perform preflight, simulation, and signer checks without creating fabricated trades. Mutating canary endpoints require exact state, version, and approval values and are defined in `src/server/index.ts`.

## Verification

Use focused tests for ordinary changes. Run the full verification suite before a release:

```powershell
npm test
npm run build
```

Passing tests do not replace live preflight checks: external schemas, market rules, mint addresses, and account state can change.
