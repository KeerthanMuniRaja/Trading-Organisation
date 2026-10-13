# Scale and load

Part of **SCALE-01** in the [remaining-work assessment](remaining-work-assessment.md). Test: [`backend/test/load.test.ts`](../backend/test/load.test.ts), which runs in every full verification.

## What the load test does

Five bots each propose 12 trades across three shares, all at once. Every proposal is then reviewed concurrently. Every accepted proposal is executed **twice at the same moment**, to imitate a retry storm. Afterwards the test proves:
- each accepted proposal was executed exactly once, with no extra orders;
- the duplicate calls resumed rather than failing;
- every journal is balanced, and no wallet went negative;
- exposure is within the limit, and each bot is within its per-share target weight;
- the audit chain is intact.

## Measured (13 October 2026, office laptop, embedded PGlite)

| | |
| --- | --- |
| Workload | 60 proposals, 60 reviews, 30 execution attempts |
| Wall time | about 2.1 s |
| Throughput | **about 72 serialised operations per second** |

Every write takes the global lock (`system_lock FOR UPDATE`). That is the design that rules out double-spending, so throughput is bounded by one-at-a-time writes. For an organisation that decides daily or monthly, this leaves orders of magnitude of headroom. A high-frequency path would need a different design, and that is out of scope here, as is the DEX track.

## A real bug the load test found, now fixed

When a bot's proposals were reviewed concurrently, each review sized its trade as if the others did not exist. Accepted intents that were not yet executed were not counted, so four 5% target-weight proposals in one share could each be approved for 5%, making 20% in total.

Reviews now treat **accepted buy intents not yet executed** (and not expired) as committed. They count against:
- the per-share target weight;
- the bot's budget;
- available capital;
- the exposure limit.

The money invariants held even before the fix, because the paper engine re-checks limits at order time; the bug was in sizing, not in money. A reservation left after a failed fill may be counted twice for a while, which errs on the safe side.

## Pagination of trade proposals

`POST /v1/trading/signals/query` returns `nextBefore` whenever more rows exist. Passing it back as `before` gets the next page. The cursor is the creation time to the **microsecond** plus the id, so rows created in the same instant are neither skipped nor repeated; a test uses identical timestamps to prove it. `pending: 'unscored'` returns only reviewed proposals still waiting for an outcome.

**The bug this fixed.** The signal scorer used to read only the newest 200 proposals. Past that point, older proposals awaiting an outcome would never have been scored, and track records, fitness and releases would have gone stale. It now walks every page of unscored proposals, which is proven end to end against the real backend.

## Still open

- **Pagination** on the other list views, such as alerts and births. These are capped at their newest rows today.
- **Retention and archival** of old journals and audit events.
- **Long soak tests** that run for hours.
- **Tests against external PostgreSQL**, the multi-connection path.
