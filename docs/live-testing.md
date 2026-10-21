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
4. **Optional: the NSE holiday calendar.** Copy this year's trading holidays from NSE's official holiday circular into `.local/nse-holidays.json`:
   ```json
   { "source": "NSE circular <number and date>", "years": [2026], "days": ["YYYY-MM-DD", "..."] }
   ```
   Readiness then skips holidays when it works out the latest session, and says so on a holiday. Without the file, holidays stay unknown and readiness only warns. A malformed file, or one that doesn't cover the current year, is reported and never trusted. Nobody types these dates from memory: they must come from the circular.
5. **Standing approvals (recommended).** Apply the protective starter policy, so the agents can suspend losing bots, roll
   back failing releases and trial code fixes without waiting for you. It moves no money:
   `npm.cmd run autonomy -- set docs/policies/autonomy-starter.json --reason "Starter: protect, repair, roll back"` ([autonomy](autonomy.md#the-starter-policy)).
6. **Optional: read the world's news.** Central banks, regulators and publishers in the US, Europe, the UK and China are in a catalogue ([world news](world-news.md)). With the backend running:
   - `npm.cmd run world -- probe --all` reads each feed once with the cycle's own reader;
   - `npm.cmd run world -- enable <id...> --yes` registers and approves the sources that passed, and the cycle collects them from then on.
7. **Optional: let R&D propose new bots.** Register and approve a research source once (`POST /v1/sources`, for example id `desk-research`). Then set `RND_SOURCE=desk-research` in `.env` ([R&D scout](rnd-scout.md)).

## Every trading day

| When (IST) | What | Command |
| --- | --- | --- |
| Before 09:15 | **Readiness check.** Go/no-go on backend, audit chain, halt, alerts, data freshness, order limit, rule bot, last cycle and backup. On NO-GO, fix what it names first. | `npm.cmd run readiness` |
| After 16:00 | **The organisation cycle.** Daily data → news → forward tests → rule bot (once a month) → end-of-day review and execution → scoring → P&L snapshot → management review → alerts → digest. It resumes where it stopped if rerun. | `npm.cmd run cycle` |
| After the cycle | **Read the digest** in `.local/digests/<day>.md`. "Needs you" comes first. | — |
| Any time | **Oversee the organisation on one screen**: health, standing approvals, agenda, every member (state, release, P&L, against the basket, risk, live verdict), money, the last cycle, the next jobs, R&D and TradingAgents. Read-only. | `npm.cmd run status` |
| When the digest says so | **Answer the owner agenda**: management recommendations, new bots, departments, releases and qualifications ([management](management.md)). | `npm.cmd run agenda`, then `npm.cmd run agenda -- accept <id>` or `decline <id>` |
| Weekly | **Backup** (API stopped) | `npm.cmd run backup -- create` |

## Or let the supervisor run the day

`npm run supervisor` runs the day without anyone at the keyboard. It is never installed by itself: run it in a terminal that stays open, or register it with Windows Task Scheduler if you choose to.
- **Readiness:** 09:00 IST on trading days. Weekends are skipped, and so are holidays in `.local/nse-holidays.json`.
- **Cycle:** 16:05 IST, with the local model when one is configured and answering.
- **Backup:** Fridays at 16:45 IST, but only when the backend isn't running. It never stops a backend it didn't start.
- **Backend:** if it's down for a job, the supervisor starts it directly, with only the `.env` settings, and stops it afterwards. A backend you started is left alone.
- **Model:** with `MODEL_AUTOSTART=qwen3.5-4b-q4km` in `.env`, the supervisor starts the pinned local model for the cycle if it isn't running, and stops it afterwards. The cycle then runs with the model, so the news fact-checker, learning, R&D invention, the debate desk and the TradingAgents member all work. A model you started yourself is used and left running. Whether the model is up is checked on llama.cpp's public `/health` endpoint.
- **Log:** every step goes to `.local/supervisor/<day>.jsonl`.
- **Catch-up:** if the laptop slept through a job's time, or the supervisor started late, it runs today's jobs that still
  help when it starts or wakes:
  - readiness, if it is before the close;
  - the cycle, if it is after 16:05 IST and hasn't run, including by hand.

  Each job gets at most two attempts a day, so a broken setup is never retried forever.
- **Survives errors:** a job that fails unexpectedly is logged as `crashed`, and the supervisor carries on.
- **Heartbeat:** `.local/supervisor/heartbeat.json` is refreshed every minute, also during a long cycle. `npm run status`
  shows a Supervisor line. Readiness warns when a supervisor that ran has stopped beating for over 5 minutes.
- **Keep it running without a terminal** (owner-run, once, per user, no administrator rights):
  `pwsh -File scripts\install-supervisor-task.ps1 -WhatIf` shows the plan, and running it without `-WhatIf` registers a
  scheduled task. The task starts the supervisor at logon and restarts it within 5 minutes whenever it stops.
  `-Remove` takes it away. Check your IT policy first on an office laptop.

Useful options:
- `npm run supervisor -- --plan` shows the next jobs and changes nothing.
- `npm run supervisor -- --once cycle` runs one job now.

## What to expect on day one

- **The rule bot proposes on its first run in a month.** On day one it proposes for the current top 3, and the cycle's `eod-trading` step immediately reviews those proposals at the verified close.
- **Fills happen the next day.** Accepted proposals wait for the next session's open. They fill in the **next day's** cycle, at that open, after it is reported and verified.
- **Scoring takes a month.** Outcomes are scored after the 30-day horizon. Until then, the track record and fitness say "not enough evidence".
- **P&L moves with the closes.** The paper P&L in the digest is marked at the latest approved prices.

## When something goes wrong

- **A cycle step fails.** Rerun `npm.cmd run cycle`: completed steps are skipped. Three failed cycles in a row escalate as a warning incident.
- **The readiness check says the market data is stale on a weekday.** It may be an exchange holiday. The check warns rather than blocking until the data is over 5 days old.
- **The readiness check shows an old limit, or says the rule bot has no credential, although `.env` is right.** Settings already present as environment variables win over `.env`; terminals opened from an editor can carry old copies. Open a fresh terminal, or clear them first (`set MAX_ORDER_PAISE=` and so on for `MAX_EXPOSURE_PAISE`, `PRINCIPALS_JSON`, `DATABASE_PATH`), then restart the backend.
- **The readiness check says `needs-owner` with "possible split or bonus".** A share's history was rescaled. Check the exchange notice and record the action ([corporate actions](corporate-actions.md)), so paper positions are rescaled too.
- **The alert `release-failing-evaluation` appears.** A bot's live paper calls are now worse than staying in cash. Decide whether to roll back or revoke its release ([releases](releases.md#judged-on-live-paper-calls-fitness-02)).
- **A bot needs stopping.** The owner can halt new risk, or roll back or revoke the bot's release (`POST /v1/releases/rollbacks`, `/stages`). Proposals from a bot without an active release are refused.
