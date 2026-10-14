# Bot control: suspend, resume, budget, retire (LIFE-02)

Before this, the only way to stop a misbehaving bot was to retire it, and a bot with no verified lessons, such as the model-free rule bot, could not even be retired. Every decision here is the owner's. Alerts, fitness reports and the digest recommend; nothing is automatic.

Code: [`backend/src/bot-control.ts`](../backend/src/bot-control.ts) and `organisation.ts` (retirement). Migration: [`050_bot_control.sql`](../db/migrations/050_bot_control.sql). Tests: [`backend/test/bot-control.test.ts`](../backend/test/bot-control.test.ts).

| Route (owner only) | Body | Effect |
| --- | --- | --- |
| `POST /v1/bots/suspensions` | `{botId, suspended: true, reason}` | **Suspend.** The bot takes no new risk: entry proposals are refused, proposals already waiting are rejected at review (`bot-suspended`), and buy orders and buy fills are refused. **Exits stay allowed**, so its risk can only fall. |
| `POST /v1/bots/suspensions` | `{botId, suspended: false, reason}` | **Resume.** |
| `POST /v1/bots/budgets` | `{botId, budgetPaise, reason}` | **Change the budget.** A budget below what is already invested is allowed; it blocks new buys until positions shrink. |
| `POST /v1/bots/retirements` | `{botId, reason, transferLessonIds?}` | **Retire.** Refused while the bot holds positions or reservations, or has open proposals (unreviewed, or accepted and not yet executed or lapsed). A bot with verified lessons must transfer at least one; a bot with none may retire without a transfer. |

**History.** Suspensions and budget changes are append-only, and each is audited (`bot.suspended`, `bot.resumed`, `bot.budget.changed`). The latest suspension row decides.

**Under suspension.** The rule bot reports `suspended` instead of failing the cycle when its entries are refused.

**A note on budget changes and equity curves.** A daily snapshot records the budget of its day, so a budget change appears as a step in that bot's equity curve. Read the history around a change with that in mind.
