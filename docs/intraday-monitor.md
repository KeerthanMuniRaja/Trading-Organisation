# Intraday monitor (LIVE-01)

The first piece of real-time testing. During the session, the monitor watches the organisation's paper positions and pulls
the existing brake in a crash. It **never trades**: no order is placed, changed or cancelled, no position is sold and no
limit is changed.

It is **feed-agnostic**. Quotes arrive as `{symbol, time, bidPaise, askPaise}`:
- **Today:** the only source is a **replay** of the recorded 5-minute bars (`.local/trading-desk/datasets`), with bid and
  ask set at the close ± an **assumed** 5 bps spread.
- **Later:** a broker's live feed plugs in as another source. The owner has not chosen a broker yet; the options are
  Kite Connect, Upstox, Angel One SmartAPI and Dhan.

## Rules

Each rule is raised at most once a day per subject. The thresholds are constants in `scripts/intraday-monitor.mjs` and
are the owner's to change.

| Rule | When | Severity | Action |
| --- | --- | --- | --- |
| `share-drop` | A held share is 5% below yesterday's close | warning | Alert outbox |
| `portfolio-loss` | The positions lost 3% of their value since yesterday's close | warning | Alert outbox |
| `kill-switch` | Every share is priced and the basket is down 4%, or the positions are down 6% | **critical** | A critical incident (as the evaluator). It halts **new** risk until the owner resolves it and resumes. Open positions stay the owner's decision |
| `feed-stale` | No fresh quote for 120 s in a live session (600 s in a replay of 5-minute bars) | warning | Alert outbox: the monitor is blind |
| bad print | A quote over 20% from yesterday's close, or a crossed book | — | Ignored and counted, never acted on |

"Yesterday's close" is the last daily bar before the day, never the day's own.

## Records

- **Accepted quotes:** every one is appended to `.local/intraday/<live|replay>/<day>/quotes.jsonl`. Replays are kept apart
  from live sessions.
- **Summaries:** each session's summary goes to `summary.json` in that folder. The latest also goes to
  `.local/intraday/latest.json`, which `npm run status` shows.

## Running it

```
npm run intraday -- --replay 2026-10-08 --dry-run                          positions from the backend; nothing filed
npm run intraday -- --replay 2026-10-08 --positions my-positions.json --dry-run
```

Without `--dry-run`, warnings go to the alert outbox and the kill switch files the critical incident.

## Replay of 38 recorded days (14 Aug to 8 Oct 2026, dry run)

The replay used the three positions held on 20 Oct: HDFC Bank 2, Axis Bank 1 and ICICI Bank 1. It raised one warning
(Axis Bank's 5% fall on 24 Sep) and no kill switch. The worst day for the basket was −1.55% (28 Sep).

## Still needed for live intraday testing

1. **A live feed adapter** for the owner's broker, with a daily login (the broker's access token).
2. **A live run loop** during 09:15–15:30 IST, from the supervisor, with the feed-stale rule at 120 s.
3. **Office-laptop approval** to run a broker API all session.
4. **Later, and only after a strategy is proven intraday:** intraday proposals and fills at the live bid or ask with depth.
