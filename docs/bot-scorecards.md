# Bot scorecards: which bots earn their keep

Part of **FITNESS-01** in the [remaining-work assessment](remaining-work-assessment.md). Code: [`backend/src/bot-scorecards.ts`](../backend/src/bot-scorecards.ts). Tests: `backend/test/bot-scorecards.test.ts`.

`POST /v1/bots/scorecards` with `{botId?, days?}` (default 90 days) is open to the owner and evaluators, and to a trader for its own bot only. It assembles each active bot's **net contribution** from records the bot cannot write about itself:

| Part | Source |
| --- | --- |
| Fitness | Latest backend-computed verdict per role and baseline |
| Proposals | Made, accepted, executed, scored, accuracy, and mean Brier score of stated probabilities |
| Challenges | Scored challenges and their accuracy. An opposition is right when the call was wrong. |
| Money | Realised net paper P&L from the bot's linked executions: sells' realised P&L minus buy fees |
| Compute | Model tokens in the window, and realised paise per million tokens |
| Overlap | Other bots that mirror at least half of this bot's actionable proposals (same share, same action, within a day; at least 5 proposals) |

**Plain-language flags:**
- no evidence of contribution yet;
- worse than its baseline in a fitness report;
- fewer than 40% of scored calls right (with at least 10 scored);
- stated probabilities worse than always saying 50% (with at least 10);
- mostly mirrors another bot: little independent information;
- spends compute and loses money.

Scorecards inform the owner, lifecycle and release decisions. They never promote, retire, fund or deactivate a bot themselves.
