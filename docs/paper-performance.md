# Paper performance: per-bot profit and loss

Part of **PAPER-01** in the [remaining-work assessment](remaining-work-assessment.md). It answers the owner's first question about revenue: which bots are making or losing money on paper, and how much.

Code: [`backend/src/paper-performance.ts`](../backend/src/paper-performance.ts). Tests: [`backend/test/paper-performance.test.ts`](../backend/test/paper-performance.test.ts).

`GET /v1/paper/performance`:
- **Owner:** every bot in paper trading, or that has ever placed an order, plus organisation totals.
- **Trader:** only its own bot, with no totals.

For each bot the report shows the following. All amounts are in paise, as strings.

| Field | Meaning |
| --- | --- |
| `realisedPaise` | Gains and losses on closed trades, net of all fees. This is the bot's share of the ledger's `PNL` account, which records debits, so profit is its negative. |
| `unrealisedPaise` | Open positions marked at the **latest approved bid** (a conservative sale value), minus their cost |
| `totalPaise`, `returnOnBudgetPct` | Realised plus unrealised, and that as a percentage of the bot's budget |
| `feesPaise`, `fills`, `closingTrades`, `winningClosingTrades` | Trading activity and how many closing trades made money |
| `budgetUsedPaise` | Cost of open positions plus reserved orders |
| `openPositions[]` | Per instrument: quantity, cost, market value, unrealised gain or loss, `priceAgeSeconds`, and the valuation method |

Every number is read from the append-only ledger, positions and approved quotes, so the report cannot drift from the books.
- A position with no approved quote is held at cost and flagged `no-quote-held-at-cost`.
- `priceAgeSeconds` shows how old each mark is.

The report is read-only: it cannot move money, change limits or alter a bot.

## Daily history and worst fall

| Route | Who | What it does |
| --- | --- | --- |
| `POST /v1/paper/performance/snapshots` | owner or evaluator, e.g. a nightly job after the close | Records each bot's mark once per India trading day (migration 034). The first snapshot of the day stands, and history is append-only, so an equity curve cannot be rewritten afterwards. Each row counts open positions that were unpriced or more than a day old. |
| `POST /v1/paper/performance/history` (`{botId?, days?}`) | owner, evaluator, or a trader for its own bot | Each bot's equity curve (budget plus paper P&L per day), total return and **worst peak-to-trough fall** |

The worst fall is the measure that matters before trusting a bot with more money. A bot can show a profit while having dropped deeply on the way.

**Still to come in PAPER-01:**
- partial fills;
- liquidity and volume limits;
- latency.
