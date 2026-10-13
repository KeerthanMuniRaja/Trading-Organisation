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
| `realised-loss-limit` | warning at 75% of `MAX_REALISED_LOSS_PAISE`, critical at 100% | Net realised paper loss approaches or reaches the limit |
| `bot-drawdown` | warning at 10%, critical at 20% | A bot's paper equity fell that far from its peak in the last 90 days of daily snapshots |
| `fitness-review` | warning | A bot was worse than its baseline in its last two fitness reports |
| `evidence-backlog` | warning | 20 or more pieces of evidence have waited over 24 hours for review |
| `stale-position-prices` | warning | Open positions have no approved price from the last day |
| `department-proposals-pending` | info | Department proposals await the owner's decision |

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

Scheduling the worker is the owner's choice. A scheduled task can run it every few minutes while the backend is up.
