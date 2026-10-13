# Live paper testing: the daily runbook

This is how the organisation runs on real market days, in paper mode, with no live price feed and no model required. Times are IST. NSE trades 09:15–15:30.

The day's work runs **after the close**: decisions use settled daily closes, and fills use the next session's verified open (see [end-of-day execution](trade-signals.md#end-of-day-execution-at-verified-prices-no-live-feed-needed)). Nothing needs watching during market hours.

## One-time setup (before the first day)

1. **Raise the paper order limit if needed.** With `MAX_ORDER_PAISE=100000` (₹1,000), a single share of ICICI Bank (about ₹1,360) or Axis Bank (about ₹1,268) cannot be bought, so those proposals are rejected as `size-below-one-share`. The readiness check lists which shares are affected. Suggested paper values:
   - `MAX_ORDER_PAISE=500000` (₹5,000);
   - `MAX_EXPOSURE_PAISE=3000000` (₹30,000);
   - `MAX_REALISED_LOSS_PAISE=300000` (₹3,000).

   This is an owner decision. Edit `.env`, then restart the backend.
2. **Switch on the rule bot** (the model-free member, see [trade signals](trade-signals.md#the-rule-bot-a-model-free-member)):
   ```
   npm.cmd run rulebot -- plan                # read-only: shows what will happen
   npm.cmd run rulebot -- credential --yes    # adds its trader credential + RULE_BOT_ID to .env (backup kept in .local/env-backups)
   # restart the backend so it loads the new credential
   npm.cmd run rulebot -- apply --yes         # create -> fitness -> release -> evaluation -> active -> qualified for paper
   ```
   The budget defaults to ₹5,000 (`--budget-paise=500000`). Keep the total of bot budgets within deposited paper capital, otherwise the `budgets-exceed-capital` alert fires.
3. **Take a backup:** stop the API, run `npm.cmd run backup -- create`, then restart.

## Every trading day

| When (IST) | What | Command |
| --- | --- | --- |
| Before 09:15 | **Readiness check.** Go/no-go on backend, audit chain, halt, alerts, data freshness, order limit, rule bot, last cycle and backup. On NO-GO, fix what it names first. | `npm.cmd run readiness` |
| After 16:00 | **The organisation cycle.** Daily data → news → forward tests → rule bot (once a month) → end-of-day review and execution → scoring → P&L snapshot → alerts → digest. It resumes where it stopped if rerun. | `npm.cmd run cycle` |
| After the cycle | **Read the digest** in `.local/digests/<day>.md`. "Needs you" comes first. | — |
| Weekly | **Backup** (API stopped) | `npm.cmd run backup -- create` |

## What to expect on day one

- **The rule bot proposes on its first run in a month.** On day one it proposes for the current top 3, and the cycle's `eod-trading` step immediately reviews those proposals at the verified close.
- **Fills happen the next day.** Accepted proposals wait for the next session's open. They fill in the **next day's** cycle, at that open, after it is reported and verified.
- **Scoring takes a month.** Outcomes are scored after the 30-day horizon. Until then, the track record and fitness say "not enough evidence".
- **P&L moves with the closes.** The paper P&L in the digest is marked at the latest approved prices.

## When something goes wrong

- **A cycle step fails.** Rerun `npm.cmd run cycle`: completed steps are skipped. Three failed cycles in a row escalate as a warning incident.
- **The readiness check says the market data is stale on a weekday.** It may be an exchange holiday. The check warns rather than blocking until the data is over 5 days old.
- **A bot needs stopping.** The owner can halt new risk, or roll back or revoke the bot's release (`POST /v1/releases/rollbacks`, `/stages`). Proposals from a bot without an active release are refused.
