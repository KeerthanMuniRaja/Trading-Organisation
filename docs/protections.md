# Self-expiring loss brakes (PROTECT-01, migration 054)

The top-ranked gap in the [source review](research-notes/README.md) was brakes that work by themselves. A bot's
**new buys** pause after losses, and the pause **lifts by itself**, so nobody has to remember to resume anything.
**Exits are never blocked**, so risk can only fall while a pause holds. The ideas come from freqtrade's protections and
the trading-skills circuit breaker; the code is our own.

**Nothing is paused until the owner sets a policy.** The thresholds are the owner's decision (founder review B3).

## The rules

| Rule | Pauses new buys while |
| --- | --- |
| `dailyLossPct`, `weeklyLossPct`, `monthlyLossPct` (0.1–50) | the bot's realised loss over the last 1, 7 or 30 days is at least this share of its budget |
| `losingExits: {inARow (2–10), pauseDays (1–30)}` | its last `inARow` exits all lost, for `pauseDays` after the last one |
| `shareCooldownDays` (1–30) | for a share it sold within that many days (that share only) |

How it is measured:
- **Realised loss** comes from the ledger: fees, sales and dividends, per bot, over rolling calendar days. Open losses
  are not counted; a drawdown halt on marked value is a separate decision (B4).
- **A loss window** lifts when the losing sales roll out of it.
- **A streak or cooldown** lifts at the time shown in the status.

## Where it is enforced

The brakes are checked in the same three places as the halt:
1. **The risk review:** each pause is a recorded reason, such as `protection-daily-loss`, `protection-losing-streak` or
   `protection-share-cooldown`. The review rules are now `signal-risk-v3`, which is exactly v2 while no policy is set.
2. **Reserving a paper buy:** refused with "New buys are paused by protection (...)". The refusal is kept in
   `order_refusals`.
3. **Filling a paper buy:** the same check, so a pause that starts between review and the next open still holds.

## Who sets it

- Only the owner credential can set the policy, and never the standing-approvals agent (`autonomy-policy`).
- The history is append-only and the latest policy decides.
- An empty policy (`{}`) turns every brake off.

```
npm run protections                                                        the policy and who is paused now
npm run protections -- set docs/policies/protections-suggested.json --reason "Founder thresholds"
```

The suggested starting thresholds are in
[`docs/policies/protections-suggested.json`](policies/protections-suggested.json):
- 2% of budget in a day;
- 5% in a week;
- 8% in a month;
- a 1-day pause after 2 losing exits in a row.

## Where you see it

- **The digest:** "Loss brakes: not set", or "set; nothing paused", or each paused bot with its brakes and when each
  lifts.
- **`POST /v1/protections/status`** (owner, evaluator): the policy, and the bots paused now.
- **The review scorecard:** shows over time whether calls turned down by a brake would have paid off.
