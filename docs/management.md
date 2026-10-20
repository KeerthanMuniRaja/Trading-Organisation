# Management and the owner agenda (migration 051)

The organisation is run like a firm. Every day a management review looks at each working bot's record, the way a manager reviews staff, and raises what needs a decision. The owner is the CEO: nothing changes until the owner accepts. Every decision waiting on the owner (recommendations, new bots, departments, releases and qualifications) is collected in one **owner agenda**.

## The daily management review

The cycle step `management-review` (after the paper snapshot) has the evaluator apply fixed, published rules, `management-v1`, to every bot in paper trading. The first matching rule decides:

| Rule | When | Recommendation |
| --- | --- | --- |
| `live-worse-than-cash` | Its live paper calls lose to holding cash, significantly (sign test) | **Suspend**: no new risk; exits stay allowed |
| `loss-limit` | It has lost 15% or more of its budget | **Suspend** |
| `losing` | It has lost 8% or more of its budget | **Watch** |
| `deep-drawdown` | Its equity fell 20% or more from a peak | **Watch** |
| `not-executing` | 3 or more accepted proposals lapsed in 30 days, and none was executed | **Watch**: check its pipeline |
| `proven-skill` | Its live calls beat cash significantly, it is ahead of the basket and up on its budget, over at least 60 daily snapshots, with no budget change in 90 days | **Raise its budget by 25%**, capped by the department's unallocated ceiling and the exposure limit |
| `suspended-and-still-worse` | Suspended for 30 days or more, holds nothing, and its live calls still lose to cash | **Retire** |

How recommendations behave:
- **No repeats:** a concern is not filed again while it waits for the owner, nor within 30 days after the owner decided it.
- **Newer wins:** a newer recommendation for the same bot supersedes the older one, and only the newest can be decided.
- **Facts kept:** each recommendation keeps the facts it was based on, such as the live verdict, return on budget, worst fall and lapses.
- **History is permanent:** recommendations and decisions are append-only and audited.

## The owner agenda

```cmd
npm run agenda
npm run agenda -- accept <id> --note "why"
npm run agenda -- decline <id> --note "why"
```

The agenda lists every decision waiting on the owner. An `<id>` can be shortened to its first 8 characters, and every answer is idempotent.

| Item | Accept | Decline |
| --- | --- | --- |
| Recommendation: suspend | Suspends the bot in the same transaction | Recorded; not repeated for 30 days |
| Recommendation: raise budget | Raises the budget, after checking the department ceiling and exposure limit again | Recorded |
| Recommendation: retire | Retires the bot, handing on all its verified lessons, then records the decision | Recorded |
| Recommendation: watch | Acknowledged | Recorded |
| Birth proposal | Creates the bot in school with zero budget | Rejected |
| Department proposal | Opens it (needs `--budget-paise=<paise>`) or closes it | Rejected |
| Release ready | Activates the release | **Revokes** it for good (register a new one instead) |
| Qualification ready | The bot starts paper trading on its active release | Nothing recorded; it stays where it is |

The [owner digest](../scripts/daily-digest.mjs) also says how many recommendations, births and department proposals are waiting.

## API

| Route | Roles | Purpose |
| --- | --- | --- |
| `POST /v1/management/reviews` | evaluator | The daily review (one per day per idempotency key) |
| `POST /v1/management/decisions` | owner | `{recommendationId, outcome: accepted\|declined, note}` |
| `GET /v1/management/recommendations` | owner, evaluator | History, newest first, with outcomes |
| `GET /v1/organisation/agenda` | owner | Everything waiting on the owner |

## What it does not do

- **No automatic decisions:** it never suspends, funds or retires a bot by itself. The thresholds are deliberately simple and published, so the owner can see why each recommendation was made.
- **Not a model's opinion:** the rules are fixed code. A model-based manager would be a new release with its own evaluation.
- **No new bots:** it doesn't propose bots or departments. Research bots do that, through birth and department proposals with verified evidence.

## Verification

- **Backend:** `backend/test/management.test.ts` covers each rule and its order, the review filing once and changing nothing by itself, roles, and accepting a suspension atomically. It also covers append-only history, the department ceiling rechecked on acceptance, supersession, retirement needing the retirement route first, the agenda, and route guards.
- **Script:** `scripts/agenda.test.mjs` covers each decision going to its owner route with a stable idempotency key, retirement handing on lessons, and a department needing its budget.
