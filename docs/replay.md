# Fast-forward replay (REPLAY-01 to 03)

Weeks of live running are the real test, but they take weeks. The replay runs **the real backend, the real daily cycle
and the real desk scripts** over a past stretch of trading days, in an afternoon. It shows how the organisation behaves
over many days, live testing aside: proposals, reviews, fills at the next open, scoring, management, brakes and digests.

## How it works

| Piece | What it does |
| --- | --- |
| **Replay clock** (`scripts/replay-clock.mjs`, `integrations/replay/sitecustomize.py`) | Every process lives at a virtual time, set in a small clock file. Nothing in the backend changes: the clock is preloaded, and the embedded database's `now()` reads the same clock (checked 27 Oct 2026) |
| **Replay prices** (`scripts/replay-prices.mjs`) | Each replayed day sees only the sessions that had closed by then (from 16:00 IST), cut from the full history. No network |
| **Replay driver** (`scripts/replay-org.mjs`) | Builds the workspace, sets up the organisation at the start date, runs the real cycle after each session's close, and reports |

**At the start date the driver builds the organisation exactly as the live one was built:**
1. registers the approved price source;
2. makes a signed deposit of ₹10,000;
3. runs the regime study on the data up to that day;
4. creates the rule bot's credential, release and evaluation, then activates and qualifies it, with a ₹5,000 budget.

It uses the live limits: ₹5,000 order, ₹5,000 exposure, ₹1,000 realised loss, 10 bps fees and 5 bps slippage.

## Safety: it can never touch the live organisation

- Everything lives in `.local/replay/`:
  - a separate checkout of the committed code (a git worktree);
  - its own database (`.data/replay-paper`);
  - its own freshly generated credentials and owner key;
  - its own copy of the prices.
- Its backend listens on **port 3100**; the live one uses 3000.
- **The clock refuses** any database whose path doesn't contain "replay", and any Python run outside a replay
  workspace.
- No feed is enabled, no model is used, and the live forward tests are skipped.

## Running it

```
node scripts/replay-org.mjs prepare                                   once: the workspace from the committed code
node scripts/replay-org.mjs run --from 2025-04-01 --to 2025-06-30     the replay (about a minute or two per day)
node scripts/replay-org.mjs report                                    the last result (.local/replay/report.json)
node scripts/replay-org.mjs clean                                     remove it (then prepare again for new code)
```

The report gives:
- the days that failed;
- the money, by bot;
- the trading counts over the whole run (proposed, accepted, rejected with reasons, executed), and the last month's
  from the digest (also scored and refused);
- each bot against the basket;
- the protections and the loaded limits;
- the audit chain's integrity.

Each replayed day's own cycle journal and digest are in the workspace's `.local/cycles/` and `.local/digests/`.

## First runs, 27 Oct 2026

- **One week, 1–8 April 2025:**
  - The organisation was set up, and the rule bot proposed 3 buys; all were accepted and executed at the next open.
  - The audit chain was valid, and the bot was ahead of the basket (−0.71% against −1.60%).
  - **It found one fault:** the cycle's two forward-test steps failed every day, because they score the live forward
    tests (from 9 Oct 2026). They are now skipped in a replay.
- **Three months, April–June 2025:** 61 trading days in 46 minutes, with **no failed day**. The audit chain is valid
  across 1,653 events, and the last digest's self-check said "Yes".
  - **1 April:** the rule bot proposed its 3 opening buys, executed at the next open.
  - **Its May rebalance:** a sale on 2 May (filled 5 May), then the replacement buy on 6 May (filled 7 May).
  - **June:** no trade, because its top three were unchanged.
  - **Totals:** 5 proposals, all accepted, 5 executed and 5 scored.
  - **Result:** momentum-rules **+6.64% against the basket's +8.58%, 1.94 points behind.** Worst fall 3.6%, Sharpe
    2.0. The same picture as the research: no edge over holding the basket.
  - **Seen:** a rebalance takes about three sessions end to end (exit, then buy once the cash is free), so the money
    waits in cash for two sessions. That is safe, but it costs a little in a rising market. The cycle now has a
    second rule-bot pass after the exits fill, so the buys go in a session sooner.

## The 2020 crash, February–May 2020 (77 trading days, ₹5,000 budget)

Each run had no failed day and a valid audit chain. The basket made −20.6% in every run.

| Brakes | momentum-rules | What happened |
| --- | --- | --- |
| None | −7.5% | Held the banks into the March fall; the April rebalance moved to INFY and NTPC |
| The first suggested set (realised losses: 2% a day, 5% a week, 8% a month, a pause after 2 losing exits) | **−15.0%** | The April rebalance sold March's losers and tripped the monthly and streak brakes. Every new buy was turned down until 4 May, so the money sat in cash through the rebound |
| The same, with the rule bot retrying refused buys | −15.0% | The retries worked (one a day), but the monthly brake turned each one down until 4 May |
| Value-based, daily and weekly only (now suggested) | −6.7% | Never needed to act: the bot buys monthly, and by the April rebalance the fall had stopped |

The worst fall was 33% in every run: brakes stop new buys and never touch shares already held. Two settings would
have stopped an unattended organisation for good:
- **the charter's first last-resort stop (₹1,500):** the bot's worst point was −₹1,542, at the bottom on 23 March;
- **the `.env` lifetime realised-loss limit (₹1,000):** the run used ₹947 of it.

Both are revised or flagged in the [charter](charter.md) (founder review B3 and B27).

**Report changes from these runs.** `tradingWholeRun` counts every proposal of the run, with rejections by reason.
The digest's own counts (`tradingLast31Days`) cover only the last month. `prepare --limits KEY=VALUE,...` tries
`.env` limits other than the live ones.
