# Self-expiring loss brakes (PROTECT-01, migration 054)

The top-ranked gap in the [source review](research-notes/README.md) was brakes that work by themselves. A bot's
**new buys** pause after losses, and the pause **lifts by itself**, so nobody has to remember to resume anything.
**Exits are never blocked**, so risk can only fall while a pause holds. The ideas come from freqtrade's protections and
the trading-skills circuit breaker; the code is our own.

**Nothing is paused until the owner sets a policy.** The thresholds are the owner's decision (founder review B3).

## The rules

| Rule | Pauses new buys while |
| --- | --- |
| `dailyLossPct`, `weeklyLossPct`, `monthlyLossPct` (0.1–50) | the bot's loss over the last 1, 7 or 30 days is at least this share of its budget |
| `measure`: `realised` (default) or `equity` | what those loss windows count (below) |
| `losingExits: {inARow (2–10), pauseDays (1–30)}` | its last `inARow` exits all lost, for `pauseDays` after the last one |
| `shareCooldownDays` (1–30) | for a share it sold within that many days (that share only) |

How it is measured:
- **`realised`** counts the ledger: fees, sales and dividends, per bot, over rolling calendar days. Open losses are not
  counted. A loss window lifts when the losing sales roll out of it.
- **`equity`** (27 Oct 2026) counts the fall in the bot's total P&L, open positions marked now, since its recorded
  daily mark at the window's start. It pauses buying *during* a fall, even with nothing sold, and lifts once the window
  starts after the fall stopped.
- **A streak or cooldown** lifts at the time shown in the status.

## The sector limit (PROTECT-02, 27 Oct 2026)

`sectorLimit: {maxPct, sectors}` caps how much of a bot's budget may sit in one sector: what it holds, what it has
reserved and what the review has accepted but not yet executed, all at cost. It is not a pause: the review **sizes a buy
down** to the room left in its sector and records `sized-by-sector-limit`; with no room left, the buy is turned down as
`size-below-one-share` with `sector-limit`. Exits are never limited. `sectors` maps each share to its NSE industry, from the
NIFTY 500 constituent file (`datasets.industries()`); a share not in the map is not limited.

Why: four of our eight shares are banks, their daily moves correlate 0.47 with each other against 0.26 with the rest
(the mentor's first lesson), and the live momentum bot once held three of them at once: closer to one bet than three.
The suggested value is in founder review B29.

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

The suggested thresholds are in
[`docs/policies/protections-suggested.json`](policies/protections-suggested.json), revised on 27 Oct 2026:
- measured on value (`equity`);
- 3% of budget in a day;
- 6% in a week;
- no monthly window and no losing-streak brake.

**Why they changed (2020 crash replay, Feb–May, ₹5,000 budget).** The first suggestion (realised losses: 2% a day, 5% a
week, 8% a month, and a 1-day pause after 2 losing exits) made the bot −15.0%. With no brakes it made −7.5%, and with
the revised set −6.7%. The basket made −20.6%. The monthly window and the streak brake tripped when the bot's planned
April rebalance sold March's losers, after the fall was over. They then turned down every retry of the new entries
until 4 May, through most of the rebound. For a bot that trades once a month, brakes over a month only hurt. No brake
changed the worst fall (33% in every run), because brakes never touch shares already held. That needs a drawdown rule
(founder review B4).

## Where you see it

- **The digest:** "Loss brakes: not set", or "set; nothing paused", or each paused bot with its brakes and when each
  lifts.
- **`POST /v1/protections/status`** (owner, evaluator): the policy, and the bots paused now.
- **The review scorecard:** shows over time whether calls turned down by a brake would have paid off.
