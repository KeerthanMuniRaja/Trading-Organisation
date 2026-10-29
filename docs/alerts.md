# Owner alerts

Part of **OBS-01** in the [remaining-work assessment](remaining-work-assessment.md). The existing inbox records one notification per audit event. That is a complete log, but too noisy to watch. Alerts are **conditions**:
- **Raised once** when a condition starts to hold.
- **Never repeated** while it keeps holding.
- **Escalated** as a new alert when its severity rises.
- **Resolved automatically** when the condition clears.

Code: [`backend/src/alerts.ts`](../backend/src/alerts.ts) (migration 037), worker [`scripts/deliver-alerts.mjs`](../scripts/deliver-alerts.mjs). Tests: `backend/test/alerts.test.ts`, `scripts/deliver-alerts.test.mjs`.

## Rules

| Rule | Severity | Holds when |
| --- | --- | --- |
| `system-halted` | critical | New risk is halted |
| `audit-chain-broken` | critical | The audit hash chain does not verify |
| `critical-incident-open` | critical | A critical incident is open (one alert per incident) |
| `realised-loss-limit` | warning at 75% of `MAX_REALISED_LOSS_PAISE`, critical at 100% | Net realised **trading** loss (paper buys, sells and dividends; owner operating expenses do not count) approaches or reaches the limit |
| `bot-drawdown` | warning at 10%, critical at 20% | A bot's paper equity fell that far from its peak in the last 90 days of daily snapshots |
| `fitness-review` | warning | A bot was worse than its baseline in its last two fitness reports |
| `evidence-backlog` | warning | 20 or more pieces of evidence have waited over 8 days for review: longer than the fact-checker's 7-day hold for a second publisher, so it is stuck (until 28 Oct 2026 the limit was 24 hours, which fired daily on evidence the fact-checker was deliberately holding) |
| `stale-position-prices` | warning | Open positions have neither an approved quote from the last day nor a verified daily close from the last 4 days |
| `department-proposals-pending` | info | Department proposals await the owner's decision |
| `incident-open` | warning | A warning incident is open, for example a cycle escalation |
| `compute-over-budget` | warning | A department used more model tokens in the last day than its budget |
| `source-low-reliability` | warning | An approved source scores below 0.4 over at least 10 independent decisions |
| `release-evaluation-expired` | warning | A bot's current active release (the most recently activated) has a newest evaluation older than 180 days: re-test it |
| `release-failing-evaluation` | warning | A bot's current active release is no longer active-eligible in its newest evaluation (for example worse than cash on live paper calls): the owner decides whether to roll back or revoke it |
| `budgets-exceed-capital` | warning | Active department budget ceilings add up to more than the capital available in Wallet 1 |

Alerts describe; they never halt, trade, fund or retire anything.

## Routes and worker

| Route | Who | What it does |
| --- | --- | --- |
| `POST /v1/alerts/cycles` | owner or evaluator | Evaluates the rules |
| `POST /v1/alerts/query` | owner or evaluator | Lists alerts, most severe first. `{includeResolved?, limit?}` |
| `POST /v1/alerts/acknowledgments` | **owner only** | Acknowledges alerts |
| `POST /v1/alerts/deliveries` | delivery worker | Marks alerts delivered |

`npm.cmd run alerts:deliver` runs one cycle and delivers every undelivered open alert, using the single evaluator credential:
- **Default channel:** appended to `.local/alerts/outbox.jsonl`.
- **Optional extra channel:** an HTTPS JSON POST to `ALERT_WEBHOOK_URL`, a phone-notification service of the owner's choice. The webhook must be HTTPS with no credentials in the URL, redirects are refused, and the backend credential is never sent to it.
- **Retries:** an alert is marked delivered only when every channel accepted it, so failures are retried on the next run.

## Daily owner digest

`POST /v1/owner/digest` (owner or evaluator; `{hours?}`, default 24) summarises one window:
- **Money:** paper P&L, realised and open, overall and per bot.
- **Trading:** proposals, acceptances, rejections, executions, challenges, and scored outcomes with accuracy.
- **Knowledge:** evidence received, verified and rejected, and the review backlog.
- **Needs you:** open alerts by severity, plus pending department and bot-birth decisions.
- **Bots:** best and weakest by 90-day scored accuracy.
- **Cost:** model tokens used.

`npm.cmd run digest` (`scripts/daily-digest.mjs`) writes it as a readable note to `.local/digests/<day>.md`, with what needs you listed first. When `ALERT_WEBHOOK_URL` is set, it also posts a one-line summary there, and the backend credential is never sent to the webhook. The organisation cycle runs it as its last step, `owner-digest`.

Scheduling the worker is the owner's choice. A scheduled task can run it every few minutes while the backend is up.
