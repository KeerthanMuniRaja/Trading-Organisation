# Trading desk

> **Version 2** (9 October 2026): eight shares, session-clock meetings, forecast and news analysts, a live paper desk, automatic learning from results, fitness verdicts and the strategy tournament. Version 1, which produced `eight-weeks-v1`, is archived unchanged in [trading-desk-v1](../trading-desk-v1/README.md) so its walk-forward learning test can still be run.

The first team of distinct bots that make decisions together. It trades one share at a time on paper, on historical replay data or on delayed live 5-minute bars, for a small universe of liquid NSE shares. It is research only: it uses no wallets, broker orders, backend writes or real money.

**Universe** (`datasets.UNIVERSE`, owner-editable): RELIANCE, HDFCBANK, ICICIBANK, INFY, SBIN, ITC, AXISBANK and NTPC. Each normally costs less than the desk's ₹2,000 position cap per share.

## The bots

| Bot | Kind | Sees only | Can do | Judged on |
| --- | --- | --- | --- | --- |
| Data steward | Rule | Continuity and volume of the last hour of bars | Mark data unusable, which stops the meeting before any model is asked | Correct blocking |
| Trend analyst | Model | 1-hour and 15-minute returns, 5-minute volatility, volume ratio, minutes to close | Bullish, bearish or neutral view with reasons and an invalidation | Did its view match the next hour's move beyond the 30 bps round-trip cost? |
| Reversion analyst | Model | Distance from session VWAP, from the day's high and low, range position, opening gap | Same as the trend analyst | Same as the trend analyst |
| Forecast analyst | Numerical model (Kronos) | Up to 400 completed bars of this share (needs at least 72) | A stance from fixed rules: forecast 1-hour move beyond ±30 bps is bullish or bearish (conviction by size), otherwise neutral. No language-model call | Same as the trend analyst. Consulted only when a forecaster is configured |
| News analyst | Model | Headline titles about this share published in the 24 hours before the bar completed (at most 8, with their age); no prices | Same as the trend analyst | Same as the trend analyst. Consulted only when owner-supplied headlines exist for that moment |
| Portfolio manager | Model | The consulted analysts' opinions (not their data), its position, its last 3 decisions | Choose among the actions currently allowed: buy or hold when flat, sell or hold when holding | Desk result after costs against the baselines |
| Risk officer | Rule | Limits, data status, time to close, losses | **Veto** entries; force a 0.5% stop-loss exit on any bar | Losses avoided by its vetoes |

**Rules of the meeting**
- **Independence:** each analyst forms a view from its own inputs and never sees the other's opinion. Only the manager sees both.
- **Hard limits:** the deterministic bots own the data checks and risk limits, so no model reply can bypass them.
- **Failures:** a failed or malformed model reply is recorded as an abstention (neutral, or hold for the manager) and never guessed.

**Meetings**
- Held on the **session clock**: first on the bar completing at 10:15, after one hour of the session, then every `--every` bars (default 12, so 11:15, 12:15, 13:15, 14:15 and 15:15), up to `--max-decisions`. The analysts' one-hour lookback therefore never spans the overnight gap. Version 1 counted bars across days, so the data steward blocked about one meeting in six.
- Decisions use completed bars only and fill at the next bar's open.
- Fills, costs (5 bps slippage plus 10 bps fee per side), the one-share and 20% position caps, the ₹100 loss limit and the 20-trade limit are identical to the momentum baseline in `integrations/market-replay`. A parity test reproduces that baseline exactly, including on the saved real datasets.

## Run

Start the local model (`npm run model:local -- serve qwen3.5-4b-q4km`), then:

```cmd
integrations\skfolio\.venv\Scripts\python.exe integrations\trading-desk\desk.py --dataset .local\trading-desk\datasets\INFY.NS-5m-2026-10-09.json --every 12 --max-decisions 12
```

Add `--news headlines.json` to consult the news analyst. The file is a list of `{publishedAt, source, title, symbols}`: times must carry a UTC offset, symbols must be in the universe, and titles are treated as untrusted data. No news publisher has been chosen; choosing one, and confirming its terms allow this use, is the owner's decision.

The desk reads only the three `HERMES_MODEL*` settings, from the environment or the private `.env`, and never prints the key. Non-loopback endpoints require `--allow-remote-cost`.

Output goes to `.local/trading-desk/<UTC time>/`:
- `report.json`: desk result, momentum baseline, cash and one-share buy-and-hold baselines, per-bot scorecards, analyst agreement rate and model calls.
- `decisions.jsonl`: every bot's input and output at every meeting.

## Multi-period evaluation

One week proves nothing, so the desk is judged across many windows.

1. **Fetch and cache windows.** Bars follow the replay dataset contract, with the same provider call, checks and validator (only the symbol may differ, within the universe). Cached windows are never refetched, and windows with corporate actions are skipped, not repaired. Yahoo keeps only about 60 days of 5-minute bars, so cache the oldest weeks before they disappear.

   ```cmd
   .local\replay-venv\Scripts\python.exe integrations\trading-desk\datasets.py --windows 8 --all
   ```

   On 9 October 2026, 63 weekly windows were cached (8 shares × 8 weeks from 14 August, minus one NTPC dividend week).

2. **Run the desk over every cached window.**

   ```cmd
   integrations\skfolio\.venv\Scripts\python.exe integrations\trading-desk\batch.py --batch eight-weeks-v1 --every 24 --max-decisions 15 --max-calls 400
   ```

   `--symbol INFY.NS` (repeatable) selects other shares; the default is RELIANCE.NS.

   - **Resumable:** each window's result is saved as soon as it finishes. Reusing the batch name continues without repeating model calls.
   - **Versioned:** results are keyed by dataset hash, desk version (a hash of `desk.py`, prompts included), model and cadence. A different model or prompt therefore never mixes with old results, which makes future comparisons with a stronger model fair.
   - **Output:** `summary.json` in `.local/trading-desk/batches/<batch>/` gives totals against the momentum and buy-and-hold baselines, the windows the desk won, analyst hit rates and manager decision quality.

**Manager decision quality.** Each manager decision is compared with the action the next hour would have rewarded after costs:
- **Flat:** buy if the move exceeded the 30 bps round trip, otherwise hold.
- **Holding:** sell if the price then fell more than the 15 bps exit cost, otherwise hold.

The scorecard also reports **always-hold accuracy**. A manager that never trades is not skilful merely because doing nothing was often right, so its accuracy must beat that base rate.

The same applies to analysts. Version 2 scorecards report each analyst's **always-neutral rate**: what saying "neutral" every time would have scored on the same meetings. When most hours move less than the 30 bps cost, this rate is well above one in three. An analyst shows skill only by beating it.

## Bot fitness (survival of the fittest, on evidence)

`fitness.py` asks of every desk bot: does it beat the do-nothing version of its own job by more than luck?

```cmd
integrations\skfolio\.venv\Scripts\python.exe integrations\trading-desk\fitness.py --batch eight-weeks-v1
```

- **Baselines:** analysts are compared with **always neutral**, and the manager with **always hold**, meeting by meeting on the same data.
- **What counts:** only meetings where the bot and its baseline disagree carry information. An exact one-sided sign test on those disagreements gives the chance that the bot's wins are luck.
- **Verdicts** (at least 20 disagreements and p < 0.05 are needed for a definite verdict):

  | Verdict | Meaning |
  | --- | --- |
  | `adds-value` | Significantly more wins than losses against the baseline |
  | `worse-than-baseline` | Significantly more losses; a candidate for retraining or retirement review |
  | `no-detectable-skill` | Neither, with enough disagreements to have seen a real effect |
  | `insufficient-evidence` | Too few disagreements to judge |

- **Also reported:** accuracy by conviction (does "high" really mean more right?), failure rate, median latency and tokens. So reliability and cost count, not just hits.
- **Recommendations only:** the report never retires, promotes or changes a bot. Those remain lifecycle and owner decisions.

Reports are saved to `.local/trading-desk/fitness/`.

## Strategy tournament (the desk's hackathon)

`tournament.py` lets registered strategy entrants compete on the cached weeks of all eight shares. It is built so that a lucky winner cannot pass as skill:

1. **Chronological split, never shuffled:** training weeks (explore), validation weeks (select) and **sealed** weeks (judge once).
2. **`run`** scores every entrant on training and validation, using the desk's exact book, costs and caps. Every entrant has the same exits: a 0.5% stop, a one-hour time exit, and flat before the last 15 minutes. One winner is selected on validation only, and only if it beat holding cash there.
3. **`finalise`** scores that single winner, with the cash and momentum baselines, on the sealed weeks. It runs **once** per tournament, and is refused if the entrants or the data changed after selection.
4. **Every entrant's result is kept**, losers included, so the number of ideas tried is always visible.

```cmd
integrations\skfolio\.venv\Scripts\python.exe integrations\trading-desk\tournament.py run --name first-rules
integrations\skfolio\.venv\Scripts\python.exe integrations\trading-desk\tournament.py finalise --name first-rules
```

**First tournament, 9 October 2026** (`first-rules`): 11 entrants on 8 shares.
- **The weeks:** 4 training weeks, 2 validation weeks, and 2 sealed weeks (25 September to 8 October).
- **No entrant beat holding cash.** All ten rules lost after costs on both training and validation.
  - The least bad was buying more than 80 bps below VWAP: −₹57.93 training, −₹58.48 validation, 37 fills.
  - The busiest momentum rules lost about ₹400 per validation fortnight.
  - Losses grew with trading frequency: on 5-minute bars, about 30 bps per round trip outweighs these signals.
- **The sealed weeks were not opened**, because there was no winner to judge. They remain available to a later tournament with new entrants, such as a Kronos forecaster or a stronger model's desk.

Results are saved in `.local/trading-desk/tournaments/<name>/`.

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

## Forecast analyst (Kronos)

Of the ten reference repositories, only [Kronos](https://github.com/shiyu-coder/Kronos) (MIT licence) ships model weights; the others are frameworks. Kronos is a pretrained candlestick forecaster, so it joins the desk as a different *kind* of bot: a numerical model next to the language-model analysts. The manager decides how much to trust it, and its lessons show the manager how informative its past bullish and bearish calls were.

The plan has three gated steps. Each step needs evidence from the one before:

1. **Zero-shot test.** Score pretrained Kronos-mini against always-neutral and a momentum rule on recent weeks (`forecast_eval.py`). This needs no language model and no training.
2. **Fine-tune (knowledge transfer to our market).** Train Kronos-mini on the oldest cached weeks of all eight shares (`kronos_finetune.py`). It uses the same objective as the Kronos repository's own fine-tuning, with the tokenizer frozen, and keeps the checkpoint with the best loss on a held-out week. If fine-tuning never beats the pretrained model on that week, no model is written.
3. **Seat on the desk.** Only a forecaster that beats always-neutral on accuracy and the momentum rule on correlation, on weeks it never saw, is worth adding to batches or the live desk with `--forecaster`.

**Setup (owner-run, on a machine where installing software is permitted):**

```cmd
git clone https://github.com/shiyu-coder/Kronos .local\kronos\repo
python -m venv .local\kronos-venv
.local\kronos-venv\Scripts\python.exe -m pip install "torch>=2.0.0" --index-url https://download.pytorch.org/whl/cpu
.local\kronos-venv\Scripts\python.exe -m pip install -r integrations\trading-desk\requirements-kronos.txt
.local\kronos-venv\Scripts\python.exe integrations\trading-desk\kronos_weights.py --variant Kronos-mini
```

`kronos_weights.py` is the only network step. It records the exact Hugging Face snapshot in `.local/kronos/weights/downloads.json`. After that, forecasts and training load local files with the Hugging Face hub set to offline. The Kronos commit is read from the local clone and stored with every fine-tuned model.

**Run:**

```cmd
rem 1. Zero-shot, on the last three weeks of all eight shares
.local\kronos-venv\Scripts\python.exe integrations\trading-desk\forecast_eval.py --name zero-shot --forecaster Kronos-mini --from 2026-09-18

rem 2. Fine-tune on weeks to 10 Sep, select on 11-17 Sep (CPU, half the cores, at most 300 steps)
.local\kronos-venv\Scripts\python.exe integrations\trading-desk\kronos_finetune.py --name nse-v1

rem 3. Compare pretrained and fine-tuned on the same unseen weeks
.local\kronos-venv\Scripts\python.exe integrations\trading-desk\forecast_eval.py --name mini-vs-nse-v1 --forecaster Kronos-mini --forecaster finetuned:nse-v1 --from 2026-09-18
```

Reports go to `.local/trading-desk/forecast-reports/` and fine-tuned models to `.local/kronos/finetuned/<name>/`, each with a `manifest.json` recording:
- the training and validation cut-offs;
- the shares used;
- the hyperparameters;
- the loss history;
- the base-weight digest and the Kronos commit.

`forecast_eval.py` refuses to test a fine-tuned model on any week it trained or was selected on.

**Guarantees:**
- **No look-ahead:** forecasts use only completed bars, and future timestamps come from the session calendar alone.
- **Reproducible:** sampling is seeded per bar, so a replay gives the same forecasts every time.
- **Separate results:** a forecaster's name includes its weight digest and sample count, and batch results, cached forecasts and live books are keyed by it.
- **Versioned rules:** the desk version covers `forecast.py`, so changing the stance rules creates a new version.

**Limits:**
- Kronos was pretrained mostly on other markets.
- Eight weeks of eight shares is a small fine-tuning set.
- Kronos-mini averages its sampled paths, so it reports no uncertainty.
- Validation loss also scores tokens before the cut-off, so it only selects checkpoints; the unseen-week evaluation is the real test.

## Live paper desk

`live.py` runs the same desk on delayed Yahoo 5-minute bars as they complete. It is paper only and owner-started:

```cmd
.local\replay-venv\Scripts\python.exe integrations\trading-desk\live.py run --book reliance-w41 --symbol RELIANCE.NS --minutes 375
.local\replay-venv\Scripts\python.exe integrations\trading-desk\live.py status --book reliance-w41
```

- **Same logic as replay:** every bar goes through `desk.decide_bar` and `desk.Book`. A parity test feeds a window one bar at a time and gets exactly the replay's prompts, decisions, fills and P&L.
- **Finite sessions:** at most 390 minutes per invocation. It is never an OS service and does not restart itself. It only polls during market hours, waking shortly after each bar completes, and stops after three consecutive data errors.
- **Resumable book:** each named book has its own directory under `.local/trading-desk/live/` with `state.json` (saved after every bar), `journal.jsonl` (meetings, risk stops, fills, skipped meetings, data errors) and a lock that prevents two sessions on one book. A book is bound to its symbol, cadence, model and desk version; changing any of them needs a new book name.
- **No trading on history:** a new book starts with the next completed bar. Bars missed while stopped still update the book (pending fills and the stop-loss) but get no meeting, because a decision is only taken within 10 minutes of its bar completing. Positions carry overnight, as in replay.
- **Data caveats:** fills use the recorded open of the next bar, and Yahoo bars may be delayed or revised, so live paper results are indicative only.
- **Automatic news:** add `--news .local\claims\auto\verified-headlines.json` to give the news analyst the fact-checker's verified headlines ([automatic knowledge](../claims/README.md#automatic-knowledge)).
  - **Fresh every poll:** the file is re-read on every poll, so newly verified news reaches the next meeting, and revoked news is gone by then.
  - **Last good copy:** an unreadable file keeps the last good copy and is journaled as `news-error`.
  - **Bound book:** a book is bound to whether it consults news.

`batch.py --news FILE` does the same for replays. The batch label carries the file's content hash, so runs with different news never mix. The call budget counts the extra news-analyst call per meeting.

## Automatic learning from results

`desk_learning.py` turns every finished batch week into verified organisation knowledge with no human step. It is the automatic counterpart of the manual export below and uses the same two-bot orchestration as [automatic news knowledge](../claims/README.md#automatic-knowledge).

- **Desk analyst** (researcher credential): reports each week's results as dataset evidence, written from the batch's own result row. After verification, it proposes each desk bot's factual lessons to the organisation bot it is mapped to.
- **Desk fact-checker** (evaluator credential) recomputes everything itself from the raw bars and the decision log:
  - the desk's P&L, by replaying the logged orders through the same book;
  - both baselines;
  - every scorecard and every lesson.

  It verifies only exact matches. It **rejects** a week whose reported results differ, so a misreported profit teaches nothing. It reads back what the backend stored and revokes on any difference.
- **Neither bot uses a model.** Each step runs as a separate process with only its own credential, and the backend independently blocks self-review.
- **What is guaranteed:** the decision log is the desk's own record of what its bots did. The fact-checker guarantees that reported results and lessons are exactly what that record and the market data imply.

**Setup:** the owner registers and approves a source for desk results, and maps desk roles to organisation bots in `.local/trading-desk/desk-learning.json`:

```json
{ "sourceId": "desk-replay", "batches": ["eight-weeks-v1"], "bots": { "trend-analyst": "ORG_BOT_ID", "portfolio-manager": "ORG_BOT_ID" } }
```

```cmd
.local\replay-venv\Scripts\python.exe integrations\trading-desk\desk_learning.py run --config .local\trading-desk\desk-learning.json --cycles 1
```

Every decision is recorded with its reason under `.local/trading-desk/auto-learning/`. Other bots find the verified lessons through knowledge discovery.

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

It only reads saved results. Open the file in a browser, and rerun it after more weeks finish.

**Public copy (owner's choice).** On 9 October 2026 the owner chose to publish the page openly, so it can be viewed from any device or account. It is served by GitHub Pages from a separate public repository, [KeerthanMuniRaja/trading-desk-results](https://github.com/KeerthanMuniRaja/trading-desk-results). The code repository stays private and untouched. The public page and repository do not use the project's name.

- **Address:** https://keerthanmuniraja.github.io/trading-desk-results/
- **Updating:** regenerate the page, scan it for anything private, then upload it as `index.html` to that repository. The upload must include the current file's `sha`.
- **Before uploading:** the page contains results and model reasoning only, never credentials, local paths or `.env` values. Check this before every upload.

## Tests

```cmd
cd integrations\trading-desk
..\..\.local\replay-venv\Scripts\python.exe -m unittest test_desk test_desk_v2 test_live test_datasets test_forecast test_desk_learning test_fitness test_dashboard test_tournament -v
```

The 51 tests cover:
- Exact parity with the momentum baseline.
- No look-ahead, and analyst independence.
- Schema-limited manager actions and risk vetoes.
- Unusable data skipping the models, and model failures becoming abstentions.
- Scorecard accounting, including manager decision quality.
- Batch resumption, the call budget, and version and model separation.
- Lessons that count only past decisions, per-bot lesson isolation, the strictly chronological split, and the walk-forward experiment end to end.
- Governed export: bundle limits, the evidence-first order, stable retry keys and no credential leakage.
- Version 2: the book resumed from saved state matches an uninterrupted run; meetings follow the session clock; the news analyst sees only past headlines about its own share and is consulted only when there are some; every prompt names its share and routes lessons to its own role.
- Live desk: bar-by-bar parity with replay, restart without reprocessing, stale bars getting no meeting, book binding and locking, finite sessions that poll only in market hours, and stopping on repeated data errors.
- Datasets: universe-only symbols, the replay bar rules, caching without refetching, and recorded skips.
- Tournament:
  - The chronological split, with every entrant recorded.
  - Sealed weeks judged once, and only on unchanged entrants and data.
  - Every entrant exiting within the hour, never holding overnight, and entering only within session limits.
- Dashboard: empty panels until data exists, pipeline summaries, and untrusted text unable to break out of the page.
- Fitness:
  - The exact sign test and its verdict thresholds.
  - A perfect analyst and manager beating their baselines, with no losses.
  - Always-neutral only tying its baseline.
  - Failed and never-consulted bots reported as such.
  - Calibration, cost accounting and reading saved batches.
- Automatic learning from results:
  - The recomputation reproduces every reported number.
  - Finished weeks become verified lessons automatically, with no repeated writes.
  - A misreported profit is rejected and teaches nothing.
  - Stored evidence that differs from the recomputation is revoked.
  - Configuration is validated.
- Forecast analyst (with a stand-in forecaster, so no PyTorch is needed):
  - Calendar-only future timestamps, history limits and the fixed stance rules.
  - Joining meetings without a language-model call, with analysts never seeing the forecast.
  - Crashes becoming abstentions, and batch results kept apart.
  - Evaluation against baselines with caching, and rank correlation with ties.
  - Fine-tuning windows that never span gaps and are normalised on their lookback only.

The live and dataset tests need the replay environment, which has the market-data library.

## Limits

- **Small sample:** one symbol and a few days of 5-minute bars, so the result is not statistically meaningful. Repeat across many periods before concluding anything.
- **Shared model:** all three model bots use the same model, so their views are partly correlated. Distinct inputs and mandates reduce this but do not remove it. The scorecards' agreement rate makes it visible.
- **No news source yet:** the news analyst exists but stays silent until the owner approves a publisher and supplies timestamped headlines. Ideally these come from reviewed source observations available before each meeting.
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
