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
  "promoteCanaries": true,
  "rollbackFailingReleases": true,
  "maxActionsPerRun": 10
}
```

| Rule | What the agents may then do by themselves |
| --- | --- |
| `suspendOnRecommendation` | Suspend a bot the management review flags (no new risk; exits stay allowed) |
| `acknowledgeWatch` | Acknowledge a "watch" recommendation (it changes nothing) |
| `raiseBudget` | Accept a recommended raise of at most `maxPctPerChange`. All automatic increases in a calendar month together stay within `maxTotalPaisePerMonth`, and department ceilings and the exposure limit still apply |
| `reduceBudget` | Accept a recommended budget cut for a bot that keeps trailing the basket (a cut only lowers risk) |
| `reinstateSuspended` | Accept a recommended reinstatement of a bot the loss limit suspended (management-v4): the suspension lifts and its budget is cut by 25%, never below ₹1,000. Other suspensions are never lifted automatically |
| `approveBirths` | Approve a proposed new bot (it starts in school with zero budget) |
| `activateReleases` | Activate a release whose newest evaluation, under 180 days old, allows it |
| `qualifyBots` | Qualify a bot for paper trading on its active, freshly evaluated release |
| `startingBudgetPaise` | Give a qualified bot with no budget this amount, capped by the department ceiling. It counts toward the monthly total, so it needs `raiseBudget` |
| `trialNewReleases` | **Self-repair:** start a newly registered, freshly evaluated release of a bot that already trades as a canary, next to the active one |
| `promoteCanaries` | **Self-improvement:** promote a trial (canary) release whose own live paper calls beat holding cash significantly. The trial's live results decide; backtest evidence alone never does |
| `rollbackFailingReleases` | **Self-correction:** when an active release's own live calls lose to cash significantly, return to the previous good release, or suspend the bot if there is none |
| `maxActionsPerRun` | At most this many automatic decisions per cycle |

**How the organisation improves itself.**
1. **Trial:** a new version of a bot (a new R&D idea, model or prompt, always as a release) runs as a canary next to the active one.
2. **Judge:** live fitness judges each release on its own paper calls every day (`scripts/live-fitness.mjs`).
3. **Keep or revert:** with these two rules on, the better version is promoted and a version that turns bad is rolled back, with no owner step. The release gate guarantees only authorised code ever trades.

**Self-repair after a code update** (`scripts/release-renewal.mjs`, cycle steps `release-renewal` and `release-trial`):
1. **Detect:** when the rule bot's code changes but its rule does not (same model and rule version, a new code fingerprint), the release check refuses the old release.
2. **Prepare:** the researcher registers a release of the current code. The evaluator files the same study evidence and evaluates it.
3. **Trial:** with `trialNewReleases` on, the release starts as a canary straight away, so the bot keeps trading.
4. **Keep or drop:** its live calls are credited to the new release (the newest one matching), and the rules above keep or drop it.

A changed rule is never renewed this way: it is a new idea and goes through R&D.

Every rule is off unless set. With all of them on, an idea that R&D proves goes, without the owner, from birth to release, qualification, a starting budget and trading. The owner reads about it in the digest and can always step in.

## The starter policy

[`docs/policies/autonomy-starter.json`](policies/autonomy-starter.json) is a conservative first policy, **protective
only**:

| The agents may, by themselves | Stays with the owner |
| --- | --- |
| Suspend a bot the management review flags as losing | Budget raises and starting budgets (`raiseBudget` and `startingBudgetPaise` are null) |
| Acknowledge a watch | Births, release activation and qualification |
| Trial a same-rule code fix as a canary, and keep it if it wins live | Everything in "Never automatic" below |
| Roll back a release that loses live | |

At most 5 actions per run. To apply it (owner, with the backend running):

```
npm run autonomy -- set docs/policies/autonomy-starter.json --reason "Starter: protect, repair, roll back; money stays with me"
```

Loosen it later, one rule at a time, once the digest shows the agents acting sensibly.

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

### The autonomy rehearsal (AUTO-04)

`backend/test/rehearsal.test.ts` runs the real trading path for 8 rounds: 4 bots on 4 shares, with standing approvals on,
and checks the invariants after every round. Failures are injected on purpose:
- **retries:** duplicate proposals and doubled executions;
- **stale data:** a stale quote just before a fill;
- **wrong identity:** another bot's credential;
- **a losing bot,** which the management review flags and the policy must suspend;
- **budget raises** over the per-change limit and the monthly total;
- **a crash:** a critical incident.

The invariants checked after every round:
- **money:** journals balance, Wallet 1 never goes negative, and Wallet 2 changes only through owner or profit transfers;
- **limits:** exposure stays within the limit, and each bot's cost within its current budget;
- **trading:** each proposal executes at most once, with exactly one filled order;
- **brakes:** no buy fills for the suspended bot, and none for anyone after the kill switch. This holds for buys accepted
  before the brake, because the paper engine refuses them at execution too;
- **autonomy:** the policy covers every action taken, each raise is at most 25%, and the month's raises stay within the
  total;
- **audit:** the chain verifies.

A second test checks that the starter policy is valid and moves no money by itself.
