# Trading desk — version 1 (frozen)

> **Archived on 9 October 2026.** This is the exact desk (version `8e35c1f975849ed4`) that produced the `eight-weeks-v1` batch. It is kept unchanged so that batch and its walk-forward learning test stay reproducible:
>
> ```cmd
> integrations\skfolio\.venv\Scripts\python.exe integrations\trading-desk-v1\walkforward.py --control eight-weeks-v1 --train 4
> ```
>
> For all current work, use [version 2](../trading-desk/README.md). Do not edit `desk.py` here: the desk version is its hash.

The first team of distinct bots that make decisions together. It works on historical NSE:RELIANCE replay data and is research only: it uses no wallets, broker orders, backend writes or real money.

## The bots

| Bot | Kind | Sees only | Can do | Judged on |
| --- | --- | --- | --- | --- |
| Data steward | Rule | Continuity and volume of the last hour of bars | Mark data unusable, which stops the meeting before any model is asked | Correct blocking |
| Trend analyst | Model | 1-hour and 15-minute returns, 5-minute volatility, volume ratio, minutes to close | Bullish, bearish or neutral view with reasons and an invalidation | Did its view match the next hour's move beyond the 30 bps round-trip cost? |
| Reversion analyst | Model | Distance from session VWAP, from the day's high and low, range position, opening gap | Same as the trend analyst | Same as the trend analyst |
| Portfolio manager | Model | The analysts' opinions (not their data), its position, its last 3 decisions | Choose among the actions currently allowed: buy or hold when flat, sell or hold when holding | Desk result after costs against the baselines |
| Risk officer | Rule | Limits, data status, time to close, losses | **Veto** entries; force a 0.5% stop-loss exit on any bar | Losses avoided by its vetoes |

**Rules of the meeting**
- **Independence:** each analyst forms a view from its own inputs and never sees the other's opinion. Only the manager sees both.
- **Hard limits:** the deterministic bots own the data checks and risk limits, so no model reply can bypass them.
- **Failures:** a failed or malformed model reply is recorded as an abstention (neutral, or hold for the manager) and never guessed.

**Meetings**
- Held every `--every` 5-minute bars (default 12, so hourly) after a one-hour warm-up, up to `--max-decisions`.
- Decisions use completed bars only and fill at the next bar's open.
- Fills, costs (5 bps slippage plus 10 bps fee per side), the one-share and 20% position caps, the ₹100 loss limit and the 20-trade limit are identical to the momentum baseline in `integrations/market-replay`. A parity test reproduces that baseline exactly, including on the saved real datasets.

## Run

Start the local model (`npm run model:local -- serve qwen3.5-4b-q4km`), then:

```cmd
integrations\skfolio\.venv\Scripts\python.exe integrations\trading-desk\desk.py --dataset .local\market-replay\<run>\dataset.json --every 12 --max-decisions 12
```

The desk reads only the three `HERMES_MODEL*` settings, from the environment or the private `.env`, and never prints the key. Non-loopback endpoints require `--allow-remote-cost`.

Output goes to `.local/trading-desk/<UTC time>/`:
- `report.json`: desk result, momentum baseline, cash and one-share buy-and-hold baselines, per-bot scorecards, analyst agreement rate and model calls.
- `decisions.jsonl`: every bot's input and output at every meeting.

## Multi-period evaluation

One week proves nothing, so the desk is judged across many windows.

1. **Fetch and cache windows.** The replay downloader and validator are reused unchanged. Cached windows are never refetched, and windows with corporate actions are skipped, not repaired.

   ```cmd
   .local\replay-venv\Scripts\python.exe integrations\trading-desk\datasets.py --windows 8
   ```

2. **Run the desk over every cached window.**

   ```cmd
   integrations\skfolio\.venv\Scripts\python.exe integrations\trading-desk\batch.py --batch eight-weeks-v1 --every 24 --max-decisions 15 --max-calls 400
   ```

   - **Resumable:** each window's result is saved as soon as it finishes. Reusing the batch name continues without repeating model calls.
   - **Versioned:** results are keyed by dataset hash, desk version (a hash of `desk.py`, prompts included), model and cadence. A different model or prompt therefore never mixes with old results, which makes future comparisons with a stronger model fair.
   - **Output:** `summary.json` in `.local/trading-desk/batches/<batch>/` gives totals against the momentum and buy-and-hold baselines, the windows the desk won, analyst hit rates and manager decision quality.

**Manager decision quality.** Each manager decision is compared with the action the next hour would have rewarded after costs:
- **Flat:** buy if the move exceeded the 30 bps round trip, otherwise hold.
- **Holding:** sell if the price then fell more than the 15 bps exit cost, otherwise hold.

The scorecard also reports **always-hold accuracy**. A manager that never trades is not skilful merely because doing nothing was often right, so its accuracy must beat that base rate.

## Learning from experience (walk-forward)

The test of whether bots improve from their own results:

1. **Training weeks:** take a completed no-lesson batch, the control arm. Its oldest weeks are the training weeks, and they must end before any test week starts.
2. **Lessons are code-computed facts** about each bot's own record (`learning.py`):
   - **Analysts:** for each stance and conviction, how often the next hour rose, fell or stayed within costs.
   - **Manager:** how often it held through a rise, how its entries turned out, and how informative each analyst's bullish or bearish calls were.

   Small samples are labelled. No model writes these lessons, and no test-week data enters them.
3. **Treatment:** each bot receives **only its own** lessons, and the desk reruns on the later weeks.
4. **Comparison:** each test week is paired with its no-lesson result for net P&L, manager accuracy against always-hold, missed rises and analyst hits.

```cmd
integrations\skfolio\.venv\Scripts\python.exe integrations\trading-desk\walkforward.py --control eight-weeks-v1 --train 4
```

The lessons and `comparison.json` are saved under `.local/trading-desk/batches/<name>/`. Reusing a name with different lessons is refused.

These lessons are experiment-local. Entering organisation knowledge would still require the backend's evidence and independent review. With only a few weeks of one symbol, results are descriptive.

## Into the organisation's knowledge (governed)

Desk results reach shared knowledge only through the backend's normal review (`export_evidence.py`):

```cmd
integrations\skfolio\.venv\Scripts\python.exe integrations\trading-desk\export_evidence.py prepare --batch eight-weeks-v1 --source-id APPROVED_SOURCE_ID
integrations\skfolio\.venv\Scripts\python.exe integrations\trading-desk\export_evidence.py submit-evidence .local\trading-desk\exports\BUNDLE.json
integrations\skfolio\.venv\Scripts\python.exe integrations\trading-desk\export_evidence.py submit-lessons .local\trading-desk\exports\BUNDLE.json --bot trend-analyst=ORG_BOT_ID --bot portfolio-manager=ORG_BOT_ID
```

1. **`prepare`** is offline. It writes one bundle per finished window: factual evidence (dates, desk and baseline results, manager and analyst scorecards, limits) and each bot's own factual lessons. Read it before submitting.
2. **`submit-evidence`** sends the evidence as **unverified**, using the single researcher credential. An independent evaluator must verify it in the backend.
3. **`submit-lessons`** works only after that verification; the backend refuses lessons on unverified evidence. It proposes each mapped bot's lessons, and each one stays **unverified** until independently reviewed.

**Requirements:** the owner must have approved the source and registered the organisation bots the roles map to.

**Safety:**
- Retries reuse content-derived idempotency keys, so nothing is duplicated.
- Errors never print the credential.
- The evidence timestamp is the window's last bar, never later than the data it describes.

## Results page

```cmd
integrations\skfolio\.venv\Scripts\python.exe integrations\trading-desk\dashboard.py --control eight-weeks-v1
```

Writes `.local/trading-desk/dashboard.html`, a self-contained page with:
- totals against the baselines;
- a weekly chart, with hover details and a matching table;
- each bot's record against chance or the never-trade rate;
- the walk-forward comparison, once it exists;
- the latest week's meeting log.

It only reads saved results. Rerun it after more weeks finish, then republish the page.

## Tests

```cmd
cd integrations\trading-desk
..\skfolio\.venv\Scripts\python.exe -m unittest test_desk -v
```

The 12 tests cover:
- Exact parity with the momentum baseline.
- No look-ahead, and analyst independence.
- Schema-limited manager actions and risk vetoes.
- Unusable data skipping the models, and model failures becoming abstentions.
- Scorecard accounting, including manager decision quality.
- Batch resumption, the call budget, and version and model separation.
- Lessons that count only past decisions, per-bot lesson isolation, the strictly chronological split, and the walk-forward experiment end to end.
- Governed export: bundle limits, the evidence-first order, stable retry keys and no credential leakage.

## Limits

- **Small sample:** one symbol and a few days of 5-minute bars, so the result is not statistically meaningful. Repeat across many periods before concluding anything.
- **Shared model:** all three model bots use the same model, so their views are partly correlated. Distinct inputs and mandates reduce this but do not remove it. The scorecards' agreement rate makes it visible.
- **No news yet:** a news analyst, fed by reviewed source observations available before each meeting, is the natural next bot.
- **Not a qualification:** a desk result is not a trading qualification and grants no authority.

## First real run — 9 October 2026

The run used local Qwen3.5-4B Q4_K_M with schema-constrained output, on RELIANCE 5-minute bars from 1–7 October (`.local/market-replay/20261007T185442659553Z`). The desk held 12 hourly meetings, covering 1 and 5 October, and made 33 model calls in 16 minutes. Report: `.local/trading-desk/20261009T103518Z/`.

| Measure | Result |
| --- | ---: |
| Desk, net after costs | ₹0.00 (0 trades) |
| Momentum baseline | −₹6.14 (20 trades) |
| One-share buy-and-hold | +₹24.30 |
| Trend analyst hit rate | 4/11 (36%) |
| Reversion analyst hit rate | 3/11 (27%) |
| Analyst agreement | 45% |
| Risk-officer vetoes | 0 (the manager never proposed an entry) |

- **Process:** the data steward correctly blocked the 5 October 10:05 meeting, whose last hour spanned the weekend. Analysts formed different views more often than not.
- **Manager:** it held at every meeting, citing weak or conflicting signals, including when the trend analyst was bullish with medium conviction.
- **Analysts:** hit rates are at chance level for a three-way stance.

**Interpretation:** the organisational mechanics work (independent views, recorded reasoning, deterministic vetoes, role scorecards), but there is no evidence of trading skill. The desk "beat" momentum only by not trading in a week when momentum lost, while buy-and-hold did best. One week of one stock cannot support a conclusion either way.

**Next:**
- Run across many periods.
- Score the manager's decisions themselves, not just P&L.
- Add a news analyst.
- Repeat with a stronger model when cloud hosting is available.
