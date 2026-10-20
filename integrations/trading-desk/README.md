# Trading desk

> **Version 2** (9 October 2026): eight shares, session-clock meetings, forecast and news analysts, a live paper desk, automatic learning from results, fitness verdicts and the strategy tournament. Version 1, which produced `eight-weeks-v1`, was archived in `integrations/trading-desk-v1` until 14 October 2026; it is removed from the working tree and remains in the git history.

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

**Onto the organisation's bot records.** Add `--submit-bot role=ORG_BOT_ID` (repeatable) to send each mapped role's counts to the backend's [bot fitness records](../../docs/bot-fitness.md) with the single evaluator credential:
- **Counts only:** the report sends judged decisions, wins, losses, failed calls, the period and the model. The backend computes the p-value and verdict itself.
- **Baselines:** analysts are judged against always-neutral, the manager against always-hold.
- **One model per record:** pooling batches from different models is refused, because a fitness record belongs to one model.
- **Safe retries:** content-derived idempotency keys make a retry after a lost answer safe.

```cmd
integrations\skfolio\.venv\Scripts\python.exe integrations\trading-desk\fitness.py --batch eight-weeks-v1 --submit-bot trend-analyst=ORG_ID --submit-bot portfolio-manager=ORG_ID
```

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

## Daily-bar research (longer horizons)

The 5-minute work showed that about 30 bps per round trip swamps every intraday signal. `daily.py` asks the next question: over days and months, where price moves dwarf costs, does any simple rule beat simply **holding the share**? Years of daily bars also give samples large enough to mean something.

- **Realistic delivery costs** on a discount broker (illustrative; confirm with your broker):
  - STT 0.1% each side and stamp duty 0.015% on buys;
  - exchange and SEBI fees, with 18% GST on them;
  - a ₹15.93 depository charge per sell and 5 bps slippage each side.

  Fills are at the next day's open, with whole shares and ₹50,000 notional per share.
- **Entrants:**
  - 3-, 6- and 12-month momentum, rebalanced monthly;
  - 20/100 and 50/200 moving-average crossovers;
  - two short-term reversal rules;
  - a near-52-week-high rule.

  Cash and **buy-and-hold** are the baselines.
- **The same tournament discipline:**
  - Chronological periods: training, then the next year for validation, then the final year **sealed**.
  - A winner must beat **both** cash and buy-and-hold on validation.
  - The sealed year is judged once, and any change to entrants or data is refused.

```cmd
.local\replay-venv\Scripts\python.exe integrations\trading-desk\daily.py fetch --years 5
.local\replay-venv\Scripts\python.exe integrations\trading-desk\daily.py run --name daily-first
.local\replay-venv\Scripts\python.exe integrations\trading-desk\daily.py finalise --name daily-first
```

`fetch` is the only network step: one download of adjusted daily bars per universe share, kept in `.local/trading-desk/daily/`. Adjusted prices fold dividends into returns.

**First daily tournament, 9 October 2026** (`daily-first`).
- **Data:** 8 shares, 1,236 trading days each (11 October 2021 to 9 October 2026), ₹50,000 notional per share.
- **Periods:** training to 9 October 2024, validation for the following year, then a sealed final year.

| Entrant | Training (3 years) | Validation (1 year) |
| --- | ---: | ---: |
| Buy and hold | +₹3,01,929 | −₹7,755 |
| 50/200 average crossover | +₹1,93,869 | −₹24,566 |
| 6-month momentum | +₹1,71,568 | −₹8,193 |
| Reversal: buy after an 8% fall over 10 days, sell 10 days later | +₹37,631 | **+₹7,092** |
| Cash | ₹0 | ₹0 |

- **Selection:** the reversal rule was the only entrant to beat both baselines on validation, so it was selected.
- **Sealed year** (9 October 2025 to 9 October 2026), judged once:
  - reversal **−₹23,883** (worst drawdown 27%);
  - buy-and-hold −₹43,444 (worst drawdown 40%);
  - cash ₹0.
- **Verdict: `failed-on-sealed-period`.** The rule lost less than holding the shares, but it lost money, so it did not beat cash.

**Forward test (pre-registered).** Every past year has now been seen, so the only honest test left is data that did not exist when a rule was chosen. `register` freezes the rules and records the latest cached day. The freeze covers the costs, the simulator and each entrant's code and settings, identified by a fingerprint. `forward` then scores each rule only on trading days after that day. If any rule changes, the test refuses to continue, so nobody can tune a rule after seeing its results.

```cmd
.local\replay-venv\Scripts\python.exe integrations\trading-desk\daily.py fetch --refresh
.local\replay-venv\Scripts\python.exe integrations\trading-desk\daily.py forward --name forward-from-2026-10-09
```

`forward-from-2026-10-09` was registered on 9 October 2026 (rules `cdb333cd8656580b`, 10 entrants, 8 shares). Re-run `fetch --refresh` from time to time to add new days. A few weeks prove nothing; months begin to.

**Reading:** no simple rule showed a durable edge. The reversal rule is out of the market most of the time. That helped in two falling years, but it earned about an eighth of buy-and-hold's return over the three rising training years. This pattern is regime exposure, not skill. Over these five years, the most valuable thing was not trading during the falls, and no rule here predicted them.

## Portfolio and risk research (the whole universe at once)

`portfolio_daily.py` studies how to hold all eight shares without deep losses.

- **Rules:**
  - buy-and-hold of equal amounts;
  - equal weights rebalanced monthly;
  - weights inversely proportional to 60-day volatility;
  - the 3 strongest shares over 6 months;
  - equal weights that move to cash while an equal-weight index of the universe is below its 200-day average.
- **Trading:** rules decide on the first trading day of each month from completed days only. They trade at the next open in whole shares, sells before buys, with daily.py's delivery costs, including the depository charge on every sell. Capital is ₹4,00,000.
- **Honesty:** the daily tournament already used every past period, so the report is labelled **`seen`**, which means descriptive, not proof. Clean evidence comes only from the pre-registered forward test.

```cmd
.local\replay-venv\Scripts\python.exe integrations\trading-desk\portfolio_daily.py report
.local\replay-venv\Scripts\python.exe integrations\trading-desk\portfolio_daily.py forward --name portfolio-forward-from-2026-10-09
```

**Report, 9 October 2026** (5 years, seen):

| Rule | 5-year CAGR | Worst drawdown | Costs (5 years) | Sealed year |
| --- | ---: | ---: | ---: | ---: |
| Top-3 momentum (6 months) | 10.2% | 22.5% | ₹20,213 | −₹45,059 |
| Buy and hold, equal amounts | 9.2% | 17.5% | ₹1,236 | −₹43,335 |
| Inverse volatility | 9.0% | 18.0% | ₹8,334 | −₹50,891 |
| Equal weight, monthly | 8.8% | 16.7% | ₹6,341 | −₹42,135 |
| Equal weight with trend filter | 6.9% | 17.3% | ₹6,946 | −₹29,310 |

- **Diversification is the robust protection.** In the sealed year, the worst single-share drawdown was 40%, against 16.9% for the equal basket.
- **No allocation rule clearly beat simply holding the basket:**
  - momentum earned slightly more over five years, with deeper drawdowns and sixteen times the costs;
  - the trend filter lost least in the two falling years and gave up return in the rising ones.
- **Forward test:** these rules were pre-registered as `portfolio-forward-from-2026-10-09` (rules `6e16a708addc8427`) and are scored only on days after 9 October 2026.

## AI allocator (can the model beat the basket?)

`ai_allocator.py` tests the language model where costs do not dominate: once a month, one call allocates the whole basket.

- **Brief:** for each share, returns over 1, 3, 6 and 12 months, 60-day volatility, drawdown from the 52-week high, and whether the price is above its 200-day average.
- **Decision:** the model gives each share a long-only weight of 0–25%. **Code does the arithmetic:** cash is the remainder, and a total above 100% is scaled down proportionally and recorded. The first version asked the model for weights summing to exactly 100, and the 4B model's first reply failed that check, so arithmetic moved into code, as with the assessment rubric. Rejected replies are saved for diagnosis.
- **No look-ahead through the model's memory:** shares appear as letters A–H in a run-specific order, with no names, dates or price levels. The model cannot recognise the period, so it cannot recall what happened next.
- **Same terms:** trades go through `portfolio_daily.py`'s simulator, costs and capital, and the report puts the AI next to the basket and every allocation rule.
- **Failures:** a failed or invalid month keeps the previous weights, or cash at the start, and is recorded.
- **Resumable:** saved months are reused, a call budget stops runs safely, and a run is bound to its model, prompt version and start date.

```cmd
.local\replay-venv\Scripts\python.exe integrations\trading-desk\ai_allocator.py replay --name ai-monthly --from 2022-10-10
```

This needs the local model server. Four years is about 48 model calls, about 45 seconds each on the laptop (roughly 35 minutes).

**AI forward test.** A replay can only show how a model handles anonymised history. The cleanest evidence is the AI deciding on months that had not happened when it was registered:

```cmd
.local\replay-venv\Scripts\python.exe integrations\trading-desk\ai_allocator.py register --name ai-forward-qwen4b
.local\replay-venv\Scripts\python.exe integrations\trading-desk\daily.py fetch --refresh
.local\replay-venv\Scripts\python.exe integrations\trading-desk\ai_allocator.py forward --name ai-forward-qwen4b
```

- **`register`** freezes the model and prompt version and records the latest cached day.
- **`forward`** decides each new month from data up to that month's first trading day only. It reuses saved months, then scores the whole record against the basket and every rule.
- **A switch ends the record:** a different model or prompt version ends the test, so a new model cannot inherit an old record. It needs its own registration, and both records can then be compared in `model_compare.py`.

## Portfolio risk monitor

`risk_monitor.py` is a rule-based risk officer for the whole equal-weight basket. It **reports and never trades**. From completed days only, it measures five things, each with fixed caution and alert limits that were set in advance and not fitted to history:

| Measure | Caution | Alert |
| --- | --- | --- |
| Fall from the 1-year peak | 10% | 20% |
| 20-day volatility against its 1-year median | 1.5× | 2× |
| Shares above their 200-day average | 3 of 8 or fewer | 1 of 8 or none |
| Average pairwise 60-day correlation | 0.6 | 0.8 |
| Worst one-day fall in the last 20 days | 3% | 5% |

The day takes the most severe level, with reasons in plain words.
- **`today`** records the state in `.local/trading-desk/risk-monitor/journal.json`, with one entry per trading day.
- **`history`** shows the basket's return over the following month for each level. Those days were already seen, so it is descriptive only.

```cmd
.local\replay-venv\Scripts\python.exe integrations\trading-desk\risk_monitor.py today
.local\replay-venv\Scripts\python.exe integrations\trading-desk\risk_monitor.py history
```

**9 October 2026: `alert`.**
- **Fall from peak:** the basket is 15.1% below its 1-year peak (caution).
- **Breadth:** only 1 of 8 shares is above its 200-day average (alert).
- **Everything else normal:** volatility is 1.2× its median, average correlation is 0.18 (diversification working), and the worst day in the last 20 was a 1.7% fall.

This is a slow, broad decline, not a panic.

**History check** (963 days, seen data):

| Level | Days | Basket return over the next month | Share of days followed by a loss |
| --- | ---: | ---: | ---: |
| Normal | 711 | +0.94% | 38% |
| Caution | 191 | −0.50% | 55% |
| Alert | 61 | +2.08% | 36% |

- **Alerts did not come before further losses.** The month after an alert rose 2.1% on average, because deep, broad falls were often close to a rebound.
- **Weak evidence:** the 61 alert days come from only a few episodes, so this is thin.
- **What follows:** the monitor describes risk; it is **not a sell signal**. Selling on alerts would have hurt, consistent with the trend filter giving up returns in recoveries. Use it to size new risk carefully and to tell the owner the state, not to exit automatically.

## 4B model vs a stronger teacher (October 2026)

**Setup.** The local Qwen3.5-4B allocator made 49 monthly decisions, from October 2022 to October 2026, with no failures. For comparison, Claude Opus acted as a teacher on the **same anonymised briefs**:
- **One assistant per month**, so no teacher could see later months, whose figures would reveal what happened next.
- **No access to the backtest results:** none of the teachers had seen them.
- **Same rules, simulator and costs:** they followed the same instructions and were scored exactly like the model.

`allocator_review.py` attributes every month's gap to the basket into **cash drag**, **selection** (which shares were tilted) and **costs**, and groups months by market breadth.

| 4 years, ₹4,00,000, real costs | Net | Growth a year | Worst fall | Costs |
| --- | ---: | ---: | ---: | ---: |
| **Holding the basket** | **₹1,57,073** | **8.8%** | **17.0%** | ₹1,175 |
| 4B picks, fully invested | ₹1,56,893 | 8.8% | 19.8% | ₹18,201 |
| Opus teacher | ₹1,14,287 | 6.6% | 19.1% | ₹18,091 |
| 4B as decided | ₹1,11,136 | 6.5% | 18.3% | ₹13,283 |

**What the attribution shows** (averages per month):
- **The 4B model's gap** to the basket was −0.15%. Of that, **cash drag was −0.22%** (it held about 20% cash, 40% in broad downtrends, which were then followed by rebounds). Selection was **+0.06%**, slightly positive, and costs were −0.05%.
- **Before costs, the teacher was better:** +0.81% against +0.61% for the model and +0.76% for the basket. It stayed nearly fully invested (3.9% cash on average) and beat the model in 29 of 49 months.
- **After real costs, neither beat simply holding.** Monthly re-tilting cost both about fifteen times what the basket paid, and both ended well below it.

**Conclusions:**
1. **Information is the bottleneck, not model size.** On price-only facts at a monthly horizon, a much stronger model did not find an edge that survives costs. Training the 4B model to imitate the teacher would not help, because the teacher does not beat the basket either.
2. **Transferable rules:**
   - stay fully invested;
   - express views only as small tilts;
   - trade only when a view changes materially.

   These apply to any model. They were found on these same years, so they must be confirmed on new months, which is what the forward tests are for.
3. **Where an edge could come from:** new information, such as verified news claims, fundamentals or Kronos forecasts. Each can now be tested against the basket with the same harness.
4. **Kept for the future:** `teacher-opus.json` holds the teacher's answers, and `teacher-training.jsonl` holds brief, teacher answer, model answer and outcome for each month. Both sit beside the run and are training and evaluation data for any future model, with no dates or share names.

## Teaching the 4B model (curriculum)

The teacher's picks do not beat the basket, so the goal is not to copy them. The goal is to teach the **habits** that cost the 4B model money: cash drag and turnover. `curriculum.py` does this **without touching model weights**. The lessons are a prompt, so a future model can be given the same curriculum.

**How it stays honest:**
1. **Study months only.** `build` reads the first `--study` months of the teacher comparison. It writes a frozen lesson plan with every number computed by code, and worked examples from study months where the teacher beat the student (the widest margin in each market state). Held-out months cannot change it, and a test proves this.
2. **The taught prompt also shows `currentWeights`** (what the bot holds now), so it can actually trade less. It has its own fingerprint, so taught and untaught runs never mix. The untaught prompt is unchanged.
3. **Held-out test.** `replay` lets the same model allocate only the months after the study period, starting from cash. `compare` scores those months only, every entrant from the same day, cash and costs:
   - the taught bot;
   - the untaught bot;
   - the untaught bot's picks fully invested (the "rule instead of teaching" alternative);
   - the teacher;
   - the basket.

   It also reports cash and turnover habits.
4. **Then a forward test.** A curriculum that helps on held-out months is registered with `register` and judged on new months with `forward`.

```cmd
.local\replay-venv\Scripts\python.exe integrations\trading-desk\curriculum.py build --run ai-monthly-qwen4b-v2 --study 24 --name lessons-v1
.local\replay-venv\Scripts\python.exe integrations\trading-desk\curriculum.py replay --curriculum lessons-v1 --name ai-taught-qwen4b-v1
.local\replay-venv\Scripts\python.exe integrations\trading-desk\curriculum.py compare --curriculum lessons-v1 --name ai-taught-qwen4b-v1
```

`lessons-v1` (built 13 October 2026) studied months 1–24, October 2022 to September 2024. Its examples are months 1 and 20, and 25 held-out months start on 1 October 2024. In the study months:
- the student kept **13.8% cash**, costing about **0.34% a month**, more than its stock choices added (+0.11%);
- the teacher kept 0.6% cash;
- the student traded **18.4%** of the portfolio a month, against the teacher's **12.1%**.

**Month-by-month verdict.** Totals can come from one lucky month, so `compare` also counts the held-out months in which each bot beat the equal-weight basket after estimated costs. It leaves out the first month, which is entered from cash. It applies the bot-fitness exact sign test: 20 or more decisive months, p < 0.05. With `--submit-bot ORG_BOT_ID`, the taught bot's counts go to the backend bot-fitness record as role `portfolio-allocator`, baseline `equal-weight-basket`, using the evaluator credential. The backend computes the verdict and the lifecycle recommendation. Nothing is sent without that flag.

**Result of `lessons-v1`.** Run `ai-taught-qwen4b-v1`: 25 held-out months, October 2024 to October 2026, Qwen3.5-4B, no failed months. The held-out months were a falling market.

| From the same cash and costs, ₹4,00,000 | Net | A year | Worst fall | Costs |
| --- | ---: | ---: | ---: | ---: |
| **Taught 4B bot** | **−₹31,656** | **−4.1%** | **12.6%** | ₹3,840 |
| Top-3 momentum rule | −₹42,387 | −5.5% | 22.5% | ₹6,435 |
| Basket, buy and hold | −₹51,189 | −6.7% | 16.9% | ₹958 |
| Untaught bot's picks, fully invested | −₹57,995 | −7.6% | 19.8% | ₹7,755 |
| Teacher (Opus) | −₹58,338 | −7.6% | 19.2% | ₹7,279 |
| Trend filter (all in, or all cash below the 200-day average) | −₹59,734 | −7.8% | 14.9% | ₹3,532 |
| Untaught 4B bot | −₹61,346 | −8.0% | 17.3% | ₹5,501 |

How to read it:
1. **The lessons helped the same model.** Compared with the untaught bot on the same months:
   - it lost ₹29,690 less;
   - its turnover fell from 19.1% to 12.3% a month;
   - its worst fall dropped from 17.3% to 12.6%.
2. **The gain came mostly from defence.** As shares fell below their 200-day averages, it held more cash: 36.6% on average, peaking at 70% in March 2025. It also kept small positions in the shares still in uptrends. It beat the plain all-or-nothing trend filter, so it was not just copying one rule.
3. **Not yet proof of skill.** Month by month it was ahead of the basket in 12 months and behind in 12 (p = 0.58, no detectable skill). The total comes from avoiding a few large falls. In rising markets, the same cash habit cost money: that was the study period's main lesson.
4. **The next test is a forward test.** Register the curriculum so it is judged on months that have not happened yet:

   ```cmd
   curriculum.py register --curriculum lessons-v1 --name ai-taught-forward-v1
   ```

   Then run it monthly. A curriculum that adapts cash to market breadth should show its value across both rising and falling months before any real money depends on it.

**Trial ledger** (from Qanat's trial-accounting pattern): every distinct curriculum judged on a held-out period is appended to `.local/trading-desk/curriculum/trials.jsonl`. When the same months have judged more than one curriculum, the report says how many and warns that the best of several tries looks better than it is.

The study months contained no broad downtrend, and the lesson says so instead of pretending its cash rule was tested.

### What the reference repositories add to the teaching (13 October 2026)

`docs/knowledge-base/07-repository-map.md` lists ten repositories. Before anything a repository offers is taught to the bot, it must beat the basket on the same simulator, costs and capital. Only the parts that need no new downloads were tried:

| Repository | What was taken | Result | Taught to the bot? |
| --- | --- | --- | --- |
| skfolio (installed) | Hierarchical Risk Parity advisor, max 25% per share, 1-year window, monthly (`quant_advisor.py`) | 4 years: 5.7% a year vs basket 9.2%. Held-out 2 years: −9.4% vs −6.7% | **No**, it would teach a losing habit |
| Awesome Systematic Trading (catalogue) | 12-1 month momentum factor, as a gentle tilt (18.75% / 6.25%), fixed in advance | 4 years: 8.4% vs 9.2%. Held-out: −8.1% vs −6.7% | **No** |
| Qanat (pattern) | Trial ledger for held-out months | In use | Not applicable (a control, not a signal) |
| Kronos | Forecast analyst code already exists (`forecast.py`) | Not run: needs PyTorch and model weights (owner approval to download) | Pending |
| Freqtrade / FreqAI, Vibe-Trading | Retraining and skill patterns: the curriculum is a versioned, testable skill | Pattern only | Not applicable |
| NautilusTrader, Hummingbot | Order execution and crypto venues | Not relevant to paper monthly allocation | Not applicable |
| Hermes, Ruflo | Agent runtime and coordination (already integrated) | Not applicable | Not applicable |

For the record, from 2022-10-03 to 2026-10-09 on ₹4,00,000:

| Entrant | Net | Growth a year | Worst drawdown |
| --- | ---: | ---: | ---: |
| Basket buy-and-hold | ₹1,65,116 | 9.2% | 17.0% |
| Inverse volatility | ₹1,62,286 | 9.0% | 17.9% |
| Momentum tilt | ₹1,49,656 | 8.4% | 18.3% |
| Risk parity (HRP) | ₹97,943 | 5.7% | 21.3% |

Because no price-only tool beat holding, the curriculum teaches **habits** (stay invested, small tilts, low turnover), not any tool's picks. An edge, if one exists, needs new information: verified news claims, fundamentals, or Kronos once installed and proven.

```cmd
integrations\skfolio\.venv\Scripts\python.exe integrations\trading-desk\quant_advisor.py evaluate --from 2022-10-03 --from 2024-10-01
``` Files are in `.local/trading-desk/curriculum/`. The replay needs the local model server, about one call per held-out month.

## Data steward: no bad download replaces good data (MARKET-01)

`daily.py fetch --refresh` no longer overwrites price files blindly. `data_steward.py` reviews every new download against the previous version and the other shares:

| Check | Verdict | Why |
| --- | --- | --- |
| A close-to-close move beyond 20% in one session | **reject** | Most likely an unadjusted split or bonus, or a bad print. Large NSE shares rarely move that much. |
| History rewritten: more than 4 adjustment steps, or a blip shorter than 5 sessions | **reject** | Dividends and splits rescale the past in a few clean steps. Anything else means the past changed. |
| History shrank by more than 5 bars | **reject** | Data was lost |
| Last bar more than 7 days old | warning | Stale feed |
| Sessions missing where most other shares traded | warning | Provider gap |

**A rejected download leaves the previous file untouched** (state `kept-previous`). An accepted one archives the version it replaces in `.local/trading-desk/daily/history/<symbol>-1d-<fingerprint>.json`, so any earlier result can be reproduced on the exact data it used. Every refresh reports each file's quality and fingerprint.

**Check on 13 October 2026:** all eight cached files pass, with no extreme moves, no gaps and current data. The 2024 Reliance 1:1 bonus, for example, is correctly adjusted, so earlier research ran on clean prices.

```cmd
.local\replay-venv\Scripts\python.exe integrations\trading-desk\data_steward.py report
```

## Regime study: which behaviour pays in which market (13 October 2026)

`regime_study.py` asks whether any rule's edge over the basket holds in every kind of market or only in some. It needs no model and no network. Each month, every rule's weights are decided from completed days only and held to the next month. The month is grouped by breadth at the decision: how many of the eight shares were above their 200-day average. Returns are gross, to isolate behaviour. Covers 50 months, August 2022 to September 2026: 28 broad uptrend, 16 mixed, 6 broad downtrend.

| Rule, average monthly excess over the basket (months ahead/behind) | Broad uptrend | Mixed | Broad downtrend | All |
| --- | ---: | ---: | ---: | ---: |
| Top-3 momentum (6 months) | +0.42% (20/8) | +0.37% (8/8) | −0.56% (4/2) | +0.28% (32/18) |
| Trend filter (cash below 200-day average) | 0.00% | +0.54% (3/2) | −1.50% (2/4) | −0.01% |
| Holding cash | −1.07% | +0.04% | −1.50% | −0.77% |
| Inverse volatility | +0.06% | −0.13% | +0.16% | +0.01% |
| Momentum 12-1 tilt | −0.02% | −0.03% | −0.06% | −0.03% |

Findings:
1. **Cash in broad downtrends has been wrong on this basket.** After breadth fell to 0–2, the basket rebounded on average, so cash trailed by 1.5% a month. This agrees with the risk-monitor finding that alerts were followed by gains. `lessons-v1`'s untested rule ("hold more cash when 6 or more of 8 shares are below their 200-day average") is exactly this. The sample is only 6 months, so it is a warning, not a verdict. The taught bot's held-out gain came mostly from cutting single weakening shares in mixed months, not from broad cash.
2. **Top-3 momentum is the most consistent rule, and it survives real costs, but it is not proven.**
   - After costs it beat the basket in every window checked: from August 2022 (+₹37,641), from October 2022 (+₹26,615), and in the falling held-out stretch (+₹8,802).
   - Its worst fall was deeper: 22.6% against 17%.
   - Its 32 to 18 monthly record has p = 0.03. That is not significant after allowing for 6 rules compared (Bonferroni threshold 0.008).
   - It is already part of the pre-registered portfolio forward test (`portfolio-forward-from-2026-10-09`), so new months will judge it without any choice made after the fact.
3. **Hypothesis for a future lesson (`lessons-v2`), not yet tested:** stay invested in broad downtrends, tilt toward 6-month momentum leaders, and accept somewhat deeper falls. It was formed after seeing all 50 months, including `lessons-v1`'s held-out stretch. So it may only be judged in a new forward test, never on those months (see the trial ledger).

```cmd
.local\replay-venv\Scripts\python.exe integrations\trading-desk\regime_study.py
```

## Into the backend's trade-proposal path (`signals_bridge.py`)

Bot decisions become structured proposals in the backend (`/v1/trading/signals`, see `docs/trade-signals.md`). There they get the deterministic risk review, sizing and outcome scoring, whichever model made them.
- **A monthly allocation:** each share raised by 3 or more points becomes `enter-long`, with its new weight as the target. The risk review never sizes beyond it. A share cut to zero becomes `exit`.
- **A desk meeting:** buy, sell and hold become `enter-long`, `exit` and an explicit `no-action`. Conviction and invalidation come from the strongest analyst who agrees.

The allocator states no invalidation of its own, so the bridge writes a fixed one and labels it "Rule-derived". Each proposal is sent with the credential bound to its own bot. Proposals cite verified evidence and expire within days, so only current decisions, such as the forward test, can be sent. Use `--dry-run` to see them first.

```cmd
.local\replay-venv\Scripts\python.exe integrations\trading-desk\signals_bridge.py allocator --run ai-taught-forward-v1 --bot ORG_BOT_ID --evidence EVIDENCE_ID --dry-run
```

## Information gathering: lead traders and information chains (validated before use)

Gathering information builds wealth only if the information arrives **before** the price moves and actually predicts something. So every new kind of information is first tested against the basket, with the same no-hindsight rules, before any bot relies on it. Neither tool below contacts the internet. Choosing sources and confirming that their terms allow this use is the owner's decision (docs: "Information access and reuse must respect source terms").

**Following lead traders (`participants.py`).** This is the participant-activity department from the organisation design. The exchanges publish every **bulk deal** (one client trading over 0.5% of a company in a day) and **block deal**, with the client's name, side, quantity and price.

1. **Collect:** save the exchange's deal report CSVs in `.local/trading-desk/participants/inbox/`. A file whose name contains "block" is read as block deals. `ingest` merges them without duplicates, keeps the source file name, and counts unreadable rows instead of guessing.
2. **Measure:** for each deal, `study` takes the follower's return from the **next session's open**, because deals are published after the close, over about one month, minus the basket's return. Copying a sale means staying out.
3. **Choose leaders without hindsight:** a client becomes a candidate "leader" only from deals **before** `--split`. It needs at least 3 events, more months ahead of the basket than behind, and a positive average. Leaders are then judged only on deals **after** the split, with the bot-fitness sign test. Following all deals is the baseline in both periods.
4. **Coverage:** price data currently covers the eight shares, so deals in other companies are counted as "without price data". A wider price download would widen the study, but needs the owner's approval.

```cmd
.local\replay-venv\Scripts\python.exe integrations\trading-desk\participants.py ingest
.local\replay-venv\Scripts\python.exe integrations\trading-desk\participants.py study --split 2025-01-01
```

**Information chains (`chains.py`, `impact_links.json`).** This implements the knowledge design's transmission map, driver → affected companies, with every inference labelled.
- **The links:** `impact_links.json` holds nine reviewed links, each with its reason. Examples:
  - crude oil → Reliance;
  - repo rate and loan quality → the four banks;
  - rupee and IT spending → Infosys;
  - tobacco tax → ITC;
  - power demand → NTPC;
  - foreign flows → all eight.
- **What a link says:** a driver *may affect* a share. It never says the direction.
- **`expand`:** adds linked shares to the fact-checker's verified headlines, titled `[inferred link: <driver>]`. The output is in the desk's headline format, so the news analyst reads it unchanged.
- **`study`:** asks whether each link carries information. After headlines about a driver, do the linked shares move further from the basket over the next 5 sessions than their usual median move? It measures from the next open and applies the sign test.
- **What happens to links:** a link that shows no effect should be removed, and a new link must pass `study` before bots use it.

```cmd
.local\replay-venv\Scripts\python.exe integrations\trading-desk\chains.py expand --headlines .local\claims\auto\verified-headlines.json
.local\replay-venv\Scripts\python.exe integrations\trading-desk\chains.py study --headlines <dated headline history>.json
```

**Source plan (13 October 2026).** The owner left the choice of sources to the developer and deferred collection ("Not now"), so nothing has been downloaded. When collection starts, it comes first from primary, official sources:
1. the exchange's bulk and block deal reports, for `participants.py`;
2. exchange company announcements, such as results, orders and board decisions. The fact-checker can trust these as primary sources (`primarySourceIds`).

After those: one Indian business-news RSS feed, for the claims pipeline and `chains.py`, and the daily foreign- and domestic-institution flows. Each source is registered and approved in the backend before use, and its terms are checked first.

**Still missing:**
- **An approved Indian news source:** the RSS reader, fact-checker and claims pipeline are built, but no publisher is chosen yet.
- **Headline history** for `chains.py study`.
- **Exchange deal files** for `participants.py`.
- **Other disclosures:** insider-trading and substantial-acquisition disclosures, and daily foreign- and domestic-institution flows, can be added the same way once a source is approved.

## Switching models: what carries over, and the comparison

Nothing here trains model weights, so almost everything carries over to a future model unchanged:
- verified knowledge in the backend (evidence, lessons, claims), which reaches bots as context;
- the cached market data;
- every test: desk replays, fitness, tournaments, forward tests and the allocator;
- the decision logs;
- all rules, limits and fact-checkers.

**What does not carry over:**
- **Fine-tuned weights:** if the 4B model were fine-tuned, that knowledge would stay locked inside it. This is why the project does not fine-tune it.
- **Track-record lessons:** lessons describing a bot's own past calls describe the old model's behaviour, so they should be re-earned after a switch. Market facts and verified news stay valid.

To switch, point the three `HERMES_MODEL*` settings at the new model, run the model checks, and rerun the same tests. Results are keyed by model, so nothing mixes. `model_compare.py` then lists every saved result by model, so old and new appear side by side on identical tests:

```cmd
.local\replay-venv\Scripts\python.exe integrations\trading-desk\model_compare.py
```

It writes `.local/trading-desk/model-comparison.json`. Compare only rows of the same test: the same batch data and desk version, or the same allocator start and prompt. A model earns its cost only by beating both the simple baselines and the cheaper model.

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

The curriculum tests (`test_curriculum`) check three things:
- lessons and examples ignore held-out months;
- the untaught prompt fingerprint is unchanged;
- a taught run sees its current weights and is compared from the same start and costs.

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
