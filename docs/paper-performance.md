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
| `unrealisedPaise` | Open positions marked at the **newer** of the latest approved bid (a conservative sale value) and the latest **verified daily close** (below), minus their cost |
| `totalPaise`, `returnOnBudgetPct` | Realised plus unrealised, and that as a percentage of the bot's budget |
| `feesPaise`, `fills`, `closingTrades`, `winningClosingTrades` | Trading activity and how many closing trades made money |
| `budgetUsedPaise` | Cost of open positions plus reserved orders |
| `openPositions[]` | Per instrument: quantity, cost, market value, unrealised gain or loss, `priceAgeSeconds`, the valuation method (`latest-approved-bid`, `verified-close` or `no-quote-held-at-cost`) and `stale` |

Every number is read from the append-only ledger, positions, approved quotes and verified marks, so the report cannot drift from the books.
- A position with neither is held at cost and flagged `no-quote-held-at-cost`.
- `priceAgeSeconds` shows how old each mark is.
- `stale` is set when a live quote is over a day old, or a verified close is over four days old (a weekend plus one exchange holiday).

## Verified end-of-day marks (PAPER-02, migration 044)

Without a paid live feed there are no fresh quotes, so open positions would sit at cost and P&L would show nothing. Instead, each share is marked at its daily close, with the same two-identity control as end-of-day trading:

| Route | Who | What it does |
| --- | --- | --- |
| `POST /v1/paper/marks` `{symbol, priceEvidence: {evidenceId, pricePaise, observedAt}}` | evaluator or owner | Records the close as the share's mark. The evidence must be verified, from an approved source, state `NSE:<share> … <price> paise`, and be at most 7 days old. Marks are append-only and only move forward in time per share. Re-sending the same mark is a harmless duplicate; a different price for the same time is refused. |
| `GET /v1/paper/marks` | owner, evaluator, researcher, trader | The latest mark per share, with its evidence |

The end-of-day trader records these marks each run (step `MARK`, before review and execution), from the steward-checked daily closes. The `stale-position-prices` alert treats a recent verified close as priced.

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
