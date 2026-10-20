# Standing approvals: agents act, the owner oversees (migration 052)

The organisation's agents make and carry out decisions themselves; the owner approves and oversees. Instead of answering every decision on the [agenda](management.md), the owner approves **classes** of decisions once, with limits. Every cycle the agents carry out what the policy covers, and only what is outside it waits for the owner.

## How it works

- **Policy:** the owner sets it with `npm run autonomy -- set <policy.json> --reason "why"`. A new policy replaces the old one, and the history is kept. With no policy, nothing is automatic.
- **Daily step:** the cycle's `autonomy` step (after the management review) has the evaluator trigger `POST /v1/autonomy/apply`.
- **Identity:** automatic decisions act as the identity `autonomy-policy`. Each one is recorded with the policy that allowed it (`autonomy_actions`, append-only) and is audited, so the record always shows whether the owner or the policy decided.
- **Same rules as the owner:** each decision goes through the same code and checks as the owner's own action, and is tried on its own. One that the rules refuse is reported as `leftForOwner` without undoing the others.
- **Stops:** a halt stops everything automatic.

## The policy

```json
{
  "suspendOnRecommendation": true,
  "acknowledgeWatch": true,
  "raiseBudget": { "maxPctPerChange": 25, "maxTotalPaisePerMonth": "500000" },
  "approveBirths": true,
  "activateReleases": true,
  "qualifyBots": true,
  "startingBudgetPaise": "200000",
  "maxActionsPerRun": 10
}
```

| Rule | What the agents may then do by themselves |
| --- | --- |
| `suspendOnRecommendation` | Suspend a bot the management review flags (no new risk; exits stay allowed) |
| `acknowledgeWatch` | Acknowledge a "watch" recommendation (it changes nothing) |
| `raiseBudget` | Accept a recommended raise of at most `maxPctPerChange`. All automatic increases in a calendar month together stay within `maxTotalPaisePerMonth`, and department ceilings and the exposure limit still apply |
| `approveBirths` | Approve a proposed new bot (it starts in school with zero budget) |
| `activateReleases` | Activate a release whose newest evaluation, under 180 days old, allows it |
| `qualifyBots` | Qualify a bot for paper trading on its active, freshly evaluated release |
| `startingBudgetPaise` | Give a qualified bot with no budget this amount, capped by the department ceiling. It counts toward the monthly total, so it needs `raiseBudget` |
| `maxActionsPerRun` | At most this many automatic decisions per cycle |

Every rule is off unless set. With all of them on, an idea that R&D proves goes, without the owner, from birth to release, qualification, a starting budget and trading. The owner reads about it in the digest and can always step in.

## Never automatic

Whatever the policy says, these stay with the owner:
- retirement (it settles knowledge transfer);
- opening or closing departments;
- limits, permissions and the 60/40 rule;
- deposits, transfers, withdrawals and anything else that moves real money;
- the policy itself: agents cannot write it, and `autonomy-policy` cannot set it.

## API

| Route | Roles | Purpose |
| --- | --- | --- |
| `POST /v1/autonomy/policy` | owner | `{rules, reason}` |
| `POST /v1/autonomy/apply` | evaluator | One run of the standing approvals (the cycle calls it daily) |
| `GET /v1/autonomy` | owner, evaluator | The current policy, the automatic budget used this month, and recent automatic actions |

## Verification

`backend/test/autonomy.test.ts` covers:
- nothing happening without a policy, and only the owner setting one;
- a suspension carried out as `autonomy-policy` while an uncovered watch stays on the agenda;
- append-only actions and a valid audit chain;
- raises limited per change and per month;
- a new bot going from birth to release, qualification and a ceiling-capped starting budget in two runs;
- a halt stopping everything;
- route guards.
