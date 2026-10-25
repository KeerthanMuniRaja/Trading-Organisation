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
| **Loss brakes** | `measure` equity, `dailyLossPct` 3, `weeklyLossPct` 6 | A bot's new buys pause while its value (open positions included) is falling fast, and lift by themselves |
| **The last-resort stop** | `organisationLossPaise` ₹2,000 | When the whole organisation's P&L, open losses included, reaches −₹2,000, all new buying halts with a critical incident. Exits stay allowed, and **you get one alert. Only you resume** |

**Why these numbers (2020 crash replay, Feb–May, 27 Oct 2026).** On a ₹5,000 budget:

| Brakes | Bot | Basket |
| --- | --- | --- |
| None | −7.5% | −20.6% |
| The earlier set: realised losses, with a monthly window and a losing-streak brake | **−15.0%** | −20.6% |
| These: value-based, daily and weekly only | −6.7% | −20.6% |

The earlier set tripped on the planned April rebalance, when the March losses were finally sold. It then kept the bot
out of the rebound for a month. The bot's worst point was −₹1,542, so the earlier ₹1,500 stop would have halted the
organisation at the very bottom, and the stop never resumes by itself. Brakes never reduce a fall in shares already
held (the worst fall was 33% in every run). That needs a drawdown rule (founder review B4).

## What it never decides, whatever the file says

- The hard limits in `.env`: maximum order, exposure and realised loss.
- Permissions and credentials, departments, retirement, and real money.

**Check the `.env` realised-loss limit before leaving it alone.** `MAX_REALISED_LOSS_PAISE` counts the organisation's
net realised loss over its **whole life**. When it is reached, every new buy stops until you raise it. At today's ₹1,000,
the 2020 crash alone used ₹947 of it. Over a year with nobody watching, one more bad month would freeze all trading. The
layering that works: the charter's stop (₹2,000, open losses included) fires first, so the `.env` limit sits above it,
for example ₹2,500 (`MAX_REALISED_LOSS_PAISE=250000`). That is your decision (founder review B27).

## A month with the charter in force (example)

| When | What happens |
| --- | --- |
| Day 1 | momentum-rules buys its top three shares |
| Every evening | Prices arrive, trades are checked and scored, and the digest is written |
| Day 20 | A crash day: momentum-rules' value falls 3% of its budget, so its new buys pause for a day |
| Day 60 | It still trails the basket by 4 points, so its budget is cut by 25% automatically |
| Some day | A bad stretch takes the organisation to −₹2,000. Everything stops buying, and you get one message |

Nothing in that table needs you, except the last row.

## How to resume after the last-resort stop

1. Read the incident in the digest and in `npm run status`.
2. Resolve it with evidence (`POST /v1/incidents/resolutions`).
3. Resume operations (`POST /v1/operations/control` with `halted: false`).

Consider lowering the bots' budgets, or tightening the charter, before you resume.

## Before trusting it

Replay a past year with the charter on and nobody touching anything:

```
node scripts/replay-org.mjs prepare --limits MAX_REALISED_LOSS_PAISE=250000
node scripts/replay-org.mjs run --from 2020-01-01 --to 2020-12-31 --charter docs/policies/founder-charter.json
```

`--limits` tries `.env` limits other than the live ones. Leave it out to replay with today's.

The result is in the project log and in [replay](replay.md).
