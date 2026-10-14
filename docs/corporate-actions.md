# Corporate actions: splits and bonus issues (CORP-01)

On a split or bonus issue, every `sharesBefore` shares become `sharesAfter`, and the share price falls in the same proportion. Nothing of value changes for the holder. Without handling it, though, the paper books go wrong:
- **Fake loss:** an open position keeps its old share count while it is valued at the new, lower price, so it shows a loss of half or more.
- **Wrong scores:** a call reviewed before the ex-date is scored against an exit price on the new basis. The daily data is back-adjusted by the provider; the stored reference price is not.

Our shares have done this before: HDFC Bank's 1:1 bonus in August 2025 is why it trades near ₹714.

Code: [`backend/src/corporate-actions.ts`](../backend/src/corporate-actions.ts). Migration: [`046_corporate_actions.sql`](../db/migrations/046_corporate_actions.sql). Tests: [`backend/test/corporate-actions.test.ts`](../backend/test/corporate-actions.test.ts).

## Recording one

`POST /v1/corporate-actions` (owner only), on or after the ex-date:

```json
{ "symbol": "HDFCBANK", "kind": "bonus", "sharesBefore": 1, "sharesAfter": 2, "exDate": "2025-08-26", "evidenceId": "<verified notice>" }
```

- **Evidence.** It must be verified, from an approved source, and name the share as `NSE:<share>`. A researcher submits the exchange notice and the evaluator verifies it, as with any evidence.
- **Positions.** Every open paper position in that share is rescaled once. The share count goes up by the ratio, the total cost stays the same, so the cost per share falls. Each adjustment is recorded per bot, append-only and audited.
- **Scoring.** A call reviewed **before** the ex-date and scored after it has its reference price divided by the ratio. Its move is then measured on the same basis as the exit price.
- **Reading.** `GET /v1/corporate-actions` lists every action with its adjustments, for any role.

## How you find out

You don't have to watch exchange notices. After a split or bonus, the data provider rescales the whole past by the ratio, and the data steward notices it:
1. **The steward flags it.** When a refresh rescales history by more than 20%, it adds the warning `corporate-action-suspected`, with the likely factor and ex-date (the first new session). Dividends move history by only a few percent and are not flagged. The download is accepted, because the rescaled data is correct.
2. **The cycle marks it.** The cycle's `market-data` step is marked **degraded**, with the note "possible split or bonus, record it in /v1/corporate-actions: HDFCBANK x2 from …".
3. **The readiness check asks you.** The next morning's `npm run readiness` shows a `needs-owner` warning.

Check the exchange notice, have it submitted and verified as evidence, then record the action.

## What is refused (settle by hand, then record)

- **A fractional entitlement:** for example, 3 shares under a 2→3 bonus. Real brokers pay cash in lieu, which needs the actual amount.
- **Open reservations in the share:** their quantities are on the old basis. Cancel them, or let the lapse sweep close them, first.
- **A second action** for the same share on the same ex-date.
- **An ex-date in the future.**

## Dividends (CORP-02, migration 047)

`POST /v1/corporate-actions/dividends` with `{symbol, amountPerSharePaise, exDate, evidenceId}` (owner, on or after the ex-date, with verified evidence naming the share):

- **Who is paid.** Every bot that held the share **through the ex-date**: today's holding, minus buys filled on or after the ex-date, plus sales filled on or after it.
- **How it is paid.** Each payment is one balanced ledger journal (`paper-dividend`: cash in, profit recorded). It shows as realised paper profit in `/v1/paper/performance`.
- **Why it matters.** The backtests use dividend-adjusted prices, which assume dividends were received. Live paper results are only comparable if positions receive them too.
- **Scoring.** A call reviewed before the ex-date and scored after it is judged on **total return**: the dividend is subtracted from its reference price, as the holder kept the cash. On the same ex-date, a split or bonus is applied before a dividend.

Record a dividend promptly. Fills are dated by when the paper fill was recorded, which with end-of-day trading is the evening of the session it filled at.

The steward does not flag dividends: they move adjusted history by only a few percent. Take them from the exchange's corporate-action notices.
