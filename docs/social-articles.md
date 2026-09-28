# Social articles

This document contains the editorial rules, topic backlog, and approved drafts for short project articles published on X and other social platforms.

## Editorial rules

1. Every finished article must have both Russian and English versions.
2. Each article should contain four or five short paragraphs and focus on one idea.
3. Do not use the em dash character in either language. Rewrite the sentence with a period, comma, colon, or parentheses instead.
4. Keep paragraphs readable as separate social posts, even when the article is published as a single piece.
5. Explain technical terms through their role in the product. Avoid unnecessary blockchain terminology.
6. Use `spot`, `perpetual`, `spread`, `funding`, `PnL`, `Jupiter`, `Backpack`, and `Solana` consistently in both languages.
7. Do not describe spot and hedge execution as simultaneous or atomic. The current system executes them sequentially.
8. Clearly separate estimates from confirmed results. A signal or modeled PnL is not guaranteed profit.
9. Mention material limitations when they are relevant to the topic. Examples include leg risk, basis risk, partial fills, stale data, fees, and funding.
10. Do not claim that the project removes trading risk. The system measures, limits, and exposes risk.

## Publication order

1. Where Does the Profit Come From? `Published`
2. Why Seeing a Spread Is Not Enough
3. Why a Two Leg Trade Is Not Atomic
4. Why a Timeout Does Not Mean Failure
5. How a Signal Becomes a Trade
6. Modeled PnL and Realized PnL
7. Why the Same Ticker Does Not Guarantee the Same Instrument
8. How We Monitor 13 Pairs
9. Why We Built a Canary Execution Flow
10. Why We Started With a Modular Monolith

## Topic backlog and outlines

### 3. Why a Two Leg Trade Is Not Atomic

Russian title: `Почему сделка из двух частей не может быть атомарной`

Core idea: Jupiter and Backpack are independent venues. The system must buy spot, confirm the factual result, and only then size and submit the hedge.

Outline:

1. Explain why the spot purchase and perpetual hedge cannot be one atomic operation.
2. Describe the directional exposure window between the two legs.
3. Explain why the hedge uses the factual spot quantity instead of the quoted quantity.
4. Describe partial fills and the `MANUAL_INTERVENTION` state.
5. Conclude that explicit failure states are safer than reporting a false success.

### 4. Why a Timeout Does Not Mean Failure

Russian title: `Почему таймаут не означает, что операция не состоялась`

Core idea: An external venue can accept an operation even when the application does not receive a trustworthy response.

Outline:

1. Explain the difference between a failed request and an unknown outcome.
2. Show how a blind retry can create a duplicate transaction or order.
3. Describe persistence of the Solana signature before broadcast.
4. Describe the deterministic Backpack client order ID and reconciliation.
5. Conclude with the rule: reconcile first, act second.

### 5. How a Signal Becomes a Trade

Russian title: `Как торговый сигнал превращается в сделку`

Core idea: A positive sample is only the beginning of the decision process.

Outline:

1. Start with repeated signal confirmation and fresh market data.
2. Explain recalculation using fresh quotes for the actual trade size.
3. List the portfolio, balance, collateral, and market limit checks.
4. Explain the execution flag, kill switch, and pair allowlist.
5. Conclude that detection can be automatic while permission to trade remains explicit.

### 6. Modeled PnL and Realized PnL

Russian title: `Чем модельный PnL отличается от фактического`

Core idea: Expected profitability before execution and confirmed results after execution are different data products.

Outline:

1. Define modeled PnL as a scenario based on current quotes and a target basis.
2. Explain which estimated costs are included before entry.
3. Define realized spot PnL using factual wallet deltas.
4. Define realized perpetual PnL using confirmed fills and fees.
5. Explain why estimates and factual results are displayed separately.

### 7. Why the Same Ticker Does Not Guarantee the Same Instrument

Russian title: `Почему одинаковый тикер не гарантирует одинаковый инструмент`

Core idea: Matching symbols do not prove economic equivalence across venues.

Outline:

1. Explain that the token and perpetual may have different issuers or pricing structures.
2. Introduce issuer, custody, redemption, and tracking risks.
3. Explain the distinction between `same_issuer` and `cross_issuer` pairs.
4. State that cross issuer pairs can be monitored without being eligible for automatic execution.
5. Conclude that instrument verification comes before spread analysis.

### 8. How We Monitor 13 Pairs

Russian title: `Как мы отслеживаем 13 торговых пар`

Core idea: Monitoring combines executable Jupiter routes with live Backpack order book depth.

Outline:

1. Describe the direct and reverse Jupiter quotes for each pair.
2. Explain VWAP calculation for the same quantity on Backpack.
3. Describe stale data rejection and repeated confirmation.
4. Explain adaptive scheduling, pair level backoff, and collector recovery.
5. Explain how samples stored in MongoDB support history and analysis.

### 9. Why We Built a Canary Execution Flow

Russian title: `Зачем мы сделали отдельный canary режим`

Core idea: Small supervised trades validate the real execution path before broader automation.

Outline:

1. Explain why simulations and tests cannot fully reproduce live venues.
2. Describe the immutable preview with route, simulation, preflight, and risk checks.
3. Explain approval of an exact fingerprint before expiration.
4. Describe separate recovery paths for spot only, perpetual only, and partial hedge states.
5. Conclude that canary execution reduces rollout risk without removing market risk.

### 10. Why We Started With a Modular Monolith

Russian title: `Почему мы начали с модульного монолита`

Core idea: A trading workflow benefits from clear module boundaries without premature distributed infrastructure.

Outline:

1. Explain why traceability and state consistency matter more than service count.
2. List the collector, profitability, risk, execution, recovery, API, and dashboard modules.
3. Explain the role of MongoDB as the only persistent store.
4. Describe the operational simplicity of one application lifecycle.
5. Conclude that services should be separated only when real load or ownership requires it.

## Completed article 1

Status: `Published`

### Russian

#### Откуда берётся прибыль

Наша стратегия не пытается угадать, куда пойдёт цена акции завтра. Вместо прогнозирования направления рынка мы ищем расхождение между стоимостью токенизированной акции на Solana и ценой соответствующего perpetual фьючерса на Backpack.

Если perpetual торгуется заметно дороже токена, система покупает spot через Jupiter, а затем открывает шорт на Backpack. В результате формируется позиция из двух противоположных частей: длинной по токену и короткой по perpetual контракту.

Например, токен стоит $100, а perpetual стоит $101. Если позднее обе цены сходятся на уровне $100,50, spot позиция приносит $0,50, а шорт приносит ещё $0,50. Потенциальная прибыль появляется за счёт сужения разницы между ценами, а не за счёт роста или падения всего рынка.

При этом одного большого спреда недостаточно. Перед входом мы учитываем ликвидность и среднюю цену исполнения, комиссии Backpack, маршруты Jupiter, проскальзывание, funding, сетевые расходы Solana и резерв на случай неполного исполнения.

Поэтому такую стратегию нельзя считать безрисковым арбитражем. Спред может расшириться, одна из частей сделки может исполниться не полностью, а рынок может резко измениться между покупкой spot и открытием шорта. Задача системы состоит не в том, чтобы полностью устранить риск, а в том, чтобы заранее измерить его и не маскировать под гарантированную прибыль.

### English

#### Where Does the Profit Come From?

Our strategy does not try to predict where a stock price will move next. Instead, we look for price differences between a tokenized equity on Solana and its corresponding perpetual futures market on Backpack.

When the perpetual trades at a meaningful premium, the system buys the spot token through Jupiter and then opens a short position on Backpack. This creates two opposing positions: long spot and short perpetual.

For example, the token trades at $100 while the perpetual trades at $101. If both prices later converge at $100.50, the spot position gains $0.50 and the short gains another $0.50. The potential profit comes from the spread narrowing, not from the overall market moving up or down.

A large spread alone is not enough to justify a trade. Before entering, we account for available liquidity, average execution prices, Backpack fees, Jupiter routes, slippage, funding, Solana network costs, and a reserve for incomplete execution.

This is not risk free arbitrage. The spread can widen, one leg may fill only partially, and the market may move between the spot purchase and the hedge. Our goal is not to eliminate every risk, but to measure it before execution and never present an estimate as guaranteed profit.

## Completed article 2

### Russian

#### Почему увидеть спред недостаточно

Заметная разница между ценами на двух рынках может выглядеть как готовая торговая возможность. На практике спред на экране является только моментальным снимком. Он не показывает, получится ли исполнить всю сделку по указанным ценам.

Ликвидность важна не меньше самой котировки. По лучшей цене может быть доступен небольшой объём, а оставшаяся часть заявки исполнится на менее выгодных уровнях. Поэтому мы рассчитываем среднюю цену исполнения всего объёма с учётом маршрутов Jupiter и глубины стакана Backpack.

Мы также учитываем стоимость входа и выхода для обеих частей сделки. В расчёт входят taker fees Backpack, ожидаемое проскальзывание, стоимость транзакций Solana, priority fees, funding и резерв на случай неполного исполнения. Спред, который выглядит прибыльным до расходов, может исчезнуть после их учёта.

Свежесть данных тоже имеет значение. Котировки Jupiter и стакан Backpack могут измениться за несколько секунд. Если рыночные данные устарели, система отклоняет сигнал. Положительная возможность также должна сохраниться в ходе повторных проверок, прежде чем система рассмотрит исполнение.

Главный вопрос состоит не в том, насколько велик видимый спред. Важно понять, сколько преимущества останется после учёта ликвидности, комиссий, проскальзывания, задержек и риска исполнения. Только этот остаток может стать торговым сигналом.

### English

#### Why Seeing a Spread Is Not Enough

A visible price difference between two markets may look like an immediate trading opportunity. In practice, the spread shown on a screen is only a snapshot. It does not tell us whether the full trade can be executed at those prices.

Liquidity matters as much as the quoted price. A small amount may be available at the best bid or ask, while the rest of the order fills at worse levels. That is why we calculate the average execution price for the entire position using Jupiter routes and Backpack order book depth.

We also include the costs of entering and exiting both legs. These include Backpack taker fees, expected slippage, Solana transaction costs, priority fees, funding, and a reserve for partial execution. A spread that looks profitable before expenses can disappear once these costs are included.

Freshness matters too. Jupiter quotes and Backpack order books can change within seconds. If market data is stale, the system rejects the signal. A positive opportunity must also remain valid across repeated checks before it can be considered for execution.

The real question is not how large the visible spread is. The real question is how much value remains after liquidity, fees, slippage, timing, and execution risk are accounted for. Only that remaining edge can become a trading signal.
