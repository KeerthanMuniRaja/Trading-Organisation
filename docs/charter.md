# The founder charter (CHARTER-01): set it once, let it run

The owner wants an organisation that runs itself, with nobody watching. The charter is how: **the owner writes the
boundaries once**, and every decision inside them is the organisation's own, every day, without asking.

It is one file, [`docs/policies/founder-charter.json`](policies/founder-charter.json), applied with one command:

```
npm run charter -- set docs/policies/founder-charter.json --reason "I leave the organisation to run itself"
npm run charter                                   shows what is in force
```

## What it decides by itself (the suggested values; change any before applying)

| Area | Rule in the file | What happens without anyone |
| --- | --- | --- |
| **Losing bots** | `suspendOnRecommendation` | A bot whose live calls lose to cash, or that lost 15% of its budget, is suspended. Its exits stay allowed |
| **Budget follows evidence, up** | `raiseBudget`: at most +25% a change, at most ₹2,000 of raises a month | A bot whose live calls beat cash and beat the basket over 60+ days gets more money |
| **Budget follows evidence, down** | `reduceBudget` | A bot that trails the basket by 3+ points over 60+ days, without proven skill, gets 25% less, never below ₹1,000 (management-v2) |
| **New members** | `approveBirths`, `qualifyBots`, `startingBudgetPaise` ₹1,000 | An idea that passes R&D becomes a bot, which qualifies on its release and gets a small starting budget |
| **Better versions** | `activateReleases`, `trialNewReleases`, `promoteCanaries`, `rollbackFailingReleases` | A new version runs on trial beside the old one. It takes over only if its own live calls beat cash, and a failing version is rolled back |
| **Loss brakes** | `dailyLossPct` 2, `weeklyLossPct` 5, `monthlyLossPct` 8, `losingExits` 2 → 1 day | A bot's new buys pause after losses, and lift by themselves |
| **The last-resort stop** | `organisationLossPaise` ₹1,500 | When the whole organisation's P&L, open losses included, reaches −₹1,500, all new buying halts with a critical incident. Exits stay allowed, and **you get one alert. Only you resume** |

## What it never decides, whatever the file says

- The hard limits in `.env`: maximum order, exposure and realised loss.
- Permissions and credentials, departments, retirement, and real money.

## A month with the charter in force (example)

| When | What happens |
| --- | --- |
| Day 1 | momentum-rules buys its top three shares |
| Every evening | Prices arrive, trades are checked and scored, and the digest is written |
| Day 20 | A crash day: momentum-rules loses 2% of its budget, so its new buys pause for a day |
| Day 60 | It still trails the basket by 4 points, so its budget is cut by 25% automatically |
| Some day | A bad stretch takes the organisation to −₹1,500. Everything stops buying, and you get one message |

Nothing in that table needs you, except the last row.

## How to resume after the last-resort stop

1. Read the incident in the digest and in `npm run status`.
2. Resolve it with evidence (`POST /v1/incidents/resolutions`).
3. Resume operations (`POST /v1/operations/control` with `halted: false`).

Consider lowering the bots' budgets, or tightening the charter, before you resume.

## Before trusting it

Replay a past year with the charter on and nobody touching anything:

```
node scripts/replay-org.mjs prepare
node scripts/replay-org.mjs run --from 2020-01-01 --to 2020-12-31 --charter docs/policies/founder-charter.json
```

The result is in the project log and in [replay](replay.md).
