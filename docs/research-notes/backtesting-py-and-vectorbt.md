# Research note: backtesting.py and vectorbt, read from the source

Date: 2026-10-21. Purpose: learn how two widely used open-source backtesters really work (code, not README), check our own
research statistics against theirs, and list ideas worth adopting in our own words.

Licences, and why no code is copied here: backtesting.py is AGPL-3.0; vectorbt is Apache-2.0 with the Commons Clause
("fair-code"). This note describes mechanisms and formulas in prose and math notation only. Nothing in our repository
may be copied from either project.

How the reading was done: read-only web fetches of github.com tree pages and raw.githubusercontent.com files. Nothing
was cloned, downloaded or installed. Large files were read in 100,000-character chunks through a fetch tool that
extracts and summarises the page, so every "verified in code" item below rests on short line quotes that tool returned
from the real source. It was not a line-by-line read in an editor. Section 6 of each part lists what could not be pinned
down.

Our code compared: `integrations/trading-desk/research_checks.py`, `rnd_scout.py`, `portfolio_daily.py`, `daily.py`.

---

## Part A: backtesting.py (kernc/backtesting.py)

### A1. What it is, licence, version studied

- An event-driven, single-instrument backtester. The user writes a `Strategy` with `init()`, which precomputes
  indicators, and `next()`, which runs once per bar. A `Backtest` runs the strategy over an OHLC DataFrame and returns
  a pandas Series of statistics.
- Licence: AGPL-3.0 (`LICENSE.md`; restated in `backtesting/__init__.py`).
- Branch `master`. Last commit 2026-08-05 ("BUG: Size shared memory by materialized array, not lazy Index.nbytes").
  Latest changelog entry: **0.6.6, 2026-07-22** (`CHANGELOG.md`). That release fixed the CAGR and annualised-return
  calculation (#1346).

### A2. Architecture (files read)

| File | Role |
|---|---|
| `backtesting/backtesting.py` | `Strategy`, `_Broker`, `Order`, `Trade`, `Position`, `Backtest` (`run`, `optimize`, `plot`) |
| `backtesting/_stats.py` | `compute_stats`, `compute_drawdown_duration_peaks`, `geometric_mean`: every statistic |
| `backtesting/lib.py` | helpers: `crossover`, `cross`, `barssince`, `quantile`, `resample_apply`, `random_ohlc_data`, `SignalStrategy`, `TrailingStrategy`, `FractionalBacktest`, `MultiBacktest`, `plot_heatmaps`, `compute_stats` |
| `backtesting/_util.py` | `_Data` (progressive reveal), `_Array`/`_Indicator`, `_indicator_warmup_nbars`, `_data_period`, shared-memory manager, `_batch`, `patch` |
| `backtesting/__init__.py` | package docstring, the `Pool` wrapper (fork on Linux; thread pool fallback on spawn platforms such as Windows) |
| `backtesting/test/_test.py` | regression tests with hard-coded expected statistics |
| `CHANGELOG.md` | version history |
| `doc/examples/Quick Start User Guide.py` | fill timing, commission, optimisation caveat |
| `doc/examples/Parameter Heatmap & Optimization.py` | grid, constraint, randomised grid, SAMBO, heatmaps |
| `doc/examples/Trading with Machine Learning.py` | look-ahead labels, walk-forward retraining |
| `doc/examples/Strategies Library.py` | `SignalStrategy` + `TrailingStrategy` composition |
| repository tree page | layout, licence, branch |

### A3. Key mechanisms as implemented (verified in code unless marked)

**Data reveal and warm-up.**
- `init()` sees the **full** data. The precomputed indicator arrays are then sliced each bar, and `_Data._set_length(i+1)`
  hides bars after i. `next()` therefore only sees completed bars. An indicator computed in `init()` with a centred or
  forward-looking window would still leak the future. The framework does not detect this; it trusts the user.
- Warm-up (`_util._indicator_warmup_nbars`): for every non-scatter indicator it finds the first non-NaN position and
  takes the maximum. Trading starts at bar 1 + that number. An all-NaN indicator counts as warm-up 0.
- "Buy & Hold Return" is measured from the **first tradable bar** (after warm-up) to the last close. The benchmark
  therefore covers the same span as the strategy.

**Bar loop and fill timing** (`Backtest.run`, `_Broker.next`, `_Broker._process_orders`).
- For each bar, the broker processes pending orders first, then records equity, then checks for bankruptcy. Only after
  that does `Strategy.next()` run. An order placed in `next()` on bar i is therefore filled while bar i+1 is processed.
- Market orders fill at the **next bar's open**. With `trade_on_close=True` they fill at the close of the bar on which
  they were placed, stamped to that bar (in code: the previous bar's close, seen from the processing bar).
- Stop orders trigger when high ≥ stop (long) or low ≤ stop (short). If the bar gaps through, the fill is the worse of
  open and stop.
- Limit orders fill when low ≤ limit (long) or high ≥ limit (short). If the bar opens beyond the limit, the fill is at
  the open, which is better for the trader.
- **Stop-limit in one bar:** a code comment says it "pessimistically assume[s]" the limit was hit before the stop, so the
  order is skipped for that bar.
- **SL and TP in the same bar:** SL orders are queued ahead of TP, so SL wins (pessimistic). If a contingent SL/TP would
  have fired in the same bar its parent filled, the order is deferred to the next matching bar and a warning calls the
  trade "somewhat dubious".
- **End of data:** with `finalize_trades=True`, open trades are closed by a market order processed once more on the last
  bar. By default that fills at the **last bar's open**. With `finalize_trades=False` (the default), open trades are
  left out of the trade statistics and a warning is raised.

**Costs** (`_Broker`).
- Commission is a callable `f(size, price)`, a tuple `(fixed, relative)`, or a plain relative rate. The cost is
  fixed + |size| × price × relative, charged at **entry and again at exit** (since 0.6.0; before that it was charged
  once).
- Spread: the entry price becomes price × (1 + sign(size) × spread). The code applies it to opening fills only; exits use
  the raw price.
- Margin: leverage = 1/margin. Fractional order sizes (0 < size < 1) mean a fraction of available margin, which is
  max(0, equity − Σ trade value / leverage). The unit count is floored to an integer. A zero-unit order is cancelled with
  a warning. If equity ≤ 0, the run stops: all trades close and cash is set to 0. There is no maintenance-margin model.
- Default `hedging=False`: an opposite order closes existing trades first-in, first-out. `exclusive_orders=True` closes
  everything on each new order.
- Trade P&L = size × (exit − entry) − commissions. Trade return % = signed price return − commissions / (|size| × entry).

**Statistics** (`_stats.compute_stats`). Notation: E = equity per bar; r = period returns of E resampled to the data's
frequency (daily, weekly, monthly or yearly, taking the last value of each period); N = periods a year (252 for daily
data without weekend bars, 365 with them, 52 weekly, 12 monthly, 1 yearly); rf = annual risk-free rate (default 0).

| Statistic | Exact definition in code |
|---|---|
| Return | E_last / E_0 − 1 |
| Buy & Hold | C_last / C_warmup − 1 (long only, from the first tradable bar) |
| Geometric mean g | exp(mean(ln(1+r))) − 1, with NaN returns treated as 0; returns 0 if any 1+r ≤ 0 |
| Return (Ann.) | (1+g)^N − 1 |
| Volatility (Ann.) | sqrt( (var(r; ddof=1) + (1+g)²)^N − (1+g)^(2N) ). This is the volatility of compounded annual returns (cited paper: SSRN 3054517), **not** σ·√N |
| CAGR | (E_last/E_0)^(1/years) − 1, where years = calendar duration / 365.25 |
| Sharpe | (Return(Ann.) − rf) / Volatility(Ann.), so a **geometric** numerator |
| Sortino | (Return(Ann.) − rf) / ( sqrt(mean(min(r,0)²)) · √N ), with the mean over all periods |
| Calmar | Return(Ann.) / |Max DD| |
| Max drawdown | max over bars of 1 − E/running max(E) |
| Avg drawdown | mean of the deepest point of each drawdown episode |
| DD duration | time from the peak bar to the recovery bar. The last bar is always treated as a candidate end, so an unrecovered final drawdown counts, measured to the last bar |
| Beta | cov(ln equity returns, ln market returns) / var(ln market returns), with the market = the instrument's close |
| Alpha | Return − rf − β·(Buy&Hold − rf), on **total** (not annualised) returns |
| Exposure time | share of bars with an open trade, counted from entry bar to exit bar inclusive |
| Win rate | share of closed trades with P&L > 0 |
| Avg trade | **geometric** mean of trade returns |
| Profit factor | Σ positive trade **returns** / |Σ negative trade returns|, using returns, not currency |
| Expectancy | arithmetic mean of trade returns |
| SQN | √(#trades) · mean(trade P&L) / std(trade P&L), with pandas std (ddof=1) and P&L in currency |
| Kelly | W − (1−W) / (avg winning P&L / avg losing P&L) |

The tests (`test/_test.py::test_compute_stats`) pin about 35 statistics to hard-coded values with a tolerance of 1e-8.
No test compares against an outside library (no empyrical or quantstats).

**Optimisation** (`Backtest.optimize`).
- `maximize` is a statistic name (default **'SQN'**) or a callable on the stats Series.
- `constraint` is a predicate on each parameter combination, used to drop invalid ones (e.g. fast < slow).
- `method='grid'`: an exhaustive grid, or with `max_tries` a **random subsample** of it. A float is a fraction and an
  integer is a cap; each combination is kept with that probability, so the count is approximate.
- `method='sambo'`: model-based search through the `sambo` package (`sambo.minimize`, method 'sceua', max_iter =
  max_tries, default 200). It minimises the negated objective and caches results.
- Grid runs are parallel. The data goes into shared memory and is processed in batches over a process pool (a thread
  pool on Windows unless the user overrides it). The best combination is re-run in the main process to produce the
  returned stats. Runs with no trades score NaN.
- `return_heatmap` gives the objective for every tried combination; `lib.plot_heatmaps` draws pairwise heatmaps.
- **Overfitting guards in code: none.** There is no hold-out, walk-forward or multiple-testing correction. The tutorials
  only warn in prose ("take steps to avoid overfitting"). The ML example (`Trading with Machine Learning.py`) shows
  walk-forward **retraining**: every 20 bars, a model is refit on the last 400 bars. Labels are the 48-bar-ahead return,
  and the last 48 rows of each window drop out as NaN, which acts as an implicit purge. Its standalone accuracy check
  uses a **shuffled** `train_test_split`, which is not time-ordered.

**Helpers** (`lib.py`).
- `resample_apply`: computes an indicator on a higher timeframe, labels each bin at its right edge, and forward-fills it
  onto the base index. A weekly value therefore appears only after its week closes. `closed=` is left at the pandas
  default.
- `random_ohlc_data`: a generator of synthetic price series. It **reorders whole bars and the overnight gaps** (sampling
  with replacement only if frac > 1) and rebuilds a continuous price path with a cumulative offset. Bar shapes and volume
  travel with their rows. With a fixed seed, every iteration yields the same frame.
- `SignalStrategy`: drives a vectorised entry-size / exit-portion signal through the event engine.
- `TrailingStrategy`: an ATR trailing stop (ATR default 100 periods, 6 ATRs). The stop only ratchets in the trade's
  favour.
- `MultiBacktest`: one strategy over many datasets in parallel; `optimize` loops over the datasets.
- `FractionalBacktest`: rescales prices so that fractional units can be traded.
- `quantile(series)` with no q returns the share of earlier values strictly below the last one, a percentile rank.

### A4. Research ideas worth knowing (backtesting.py)

1. **Pessimistic intra-bar ordering** (`backtesting.py`): SL before TP, and limit before stop in a single bar. When a bar
   cannot tell you the order of events, assume the worse one.
2. **Gap-aware fills** (`backtesting.py`): a stop that gaps fills at the open (worse); a limit that gaps fills at the
   open (better).
3. **Benchmark from the first tradable bar** (`_stats.py`): the strategy and buy-and-hold cover the same span.
4. **Compounding-consistent annual volatility and geometric Sharpe** (`_stats.py`): for volatile series this gives a
   lower and more honest Sharpe than the arithmetic mean·N / σ·√N.
5. **Randomised grid plus constraint plus full heatmap** (`backtesting.py`, `lib.plot_heatmaps`): look at the whole
   surface, not just the peak. A sharp, isolated peak is a warning sign.
6. **Shuffled-bar synthetic data** (`lib.random_ohlc_data`): keeps the distribution of bars but destroys their order. A
   rule that does as well on shuffled data is not exploiting time-series structure.
7. **Walk-forward retraining with an implicit label purge** (ML example).

### A5. Comparison with our system

Equivalents:

| Theirs | Ours |
|---|---|
| Next-bar-open market fills, integer units, commission at entry and exit | `daily.simulate`, `portfolio_daily.simulate`: next-day open, integer shares, Indian delivery costs on both sides plus a depository charge per sell, 5 bps slippage. Ours is richer than their (fixed, relative) commission |
| Progressive reveal, so `next()` sees completed bars only | Rules called with index i on completed days; **plus** `research_checks.check_rules`, which actually tests for look-ahead by truncating the data. backtesting.py has no such check |
| Warm-up = slowest indicator; B&H from the first tradable bar | `rnd_scout.START = 260`, so every rule is judged on the same months, and the basket covers those months too |
| `finalize_trades` | Both of our simulators always close at the final close with full sell costs |
| `optimize` heatmap | The scout scores a fixed, pre-registered catalogue (no optimiser) with Bonferroni over all ideas ever tried. Stricter |

Formula differences (backtesting.py vs ours):

| Statistic | backtesting.py | ours (`research_checks.stats`) | Verdict |
|---|---|---|---|
| Sharpe | geometric annual return / compounding-adjusted annual vol, ddof=1 | arithmetic mean·12 / (pstdev·√12), ddof=0 | Convention difference, not a bug. Ours matches vectorbt (see Part B) apart from ddof. Ours reads higher for volatile rules |
| Sortino | geometric numerator | arithmetic numerator; the downside term is the same | Convention difference |
| Calmar | annualised geometric return / |MaxDD| | CAGR / |MaxDD| | Same |
| Max drawdown | per bar (daily) | on **month-end** levels | Ours understates intra-month falls (see gaps) |
| DD duration | peak bar to recovery bar | number of periods strictly below the peak | Ours is one period shorter for recovered drawdowns; same for unrecovered |
| Profit factor | per **trade** returns | per **month** excess over the basket | Different quantity with the same name |
| Expectancy | mean trade return | mean monthly excess | Different quantity |
| SQN | √n·mean/std of **trade P&L**, ddof=1 | √(months)·mean/pstdev of monthly excess | Ours is the t-statistic of the mean monthly excess (with ddof=0), not Van Tharp's SQN |

### A6. Not verified in backtesting.py

- The body of the `Pool` wrapper's process-pool path, and SAMBO's internals (a separate package).
- Whether the 0.6.6 CAGR/annualisation fix changed anything beyond what the current `_stats.py` shows (the formulas above
  are from current master).
- The exact `closed=` behaviour of `resample_apply` for every pandas rule.

---

## Part B: vectorbt (polakowo/vectorbt, open-source edition)

### B1. What it is, licence, version studied

- A vectorised research toolkit: NumPy + Numba (optionally a Rust engine). Every parameter combination becomes a column,
  and portfolios are simulated column by column in compiled loops.
- Licence: Apache-2.0 **with Commons Clause** (`LICENSE.md`; the README calls it "fair-code").
- Branch `master`, `vectorbt/_version.py` = **1.2.0**. Last commits 2026-10-19 (README wording). The README says it is
  the community edition of VectorBT PRO (PRO features are not studied here).

### B2. Architecture (files read)

| File | Role |
|---|---|
| `vectorbt/portfolio/nb.py` (~290k chars, read in three chunks) | order execution (`buy_nb`, `sell_nb`, `execute_order_nb`, `process_order_nb`), signal conflict resolution, stop logic, the simulation loops, trade/position records, cash/asset/value series |
| `vectorbt/portfolio/base.py` (~248k chars, three chunks) | `Portfolio.from_signals`, `from_orders`, `from_holding`, `from_random_signals`, `from_order_func`, `stats` metrics, benchmark, returns |
| `vectorbt/portfolio/trades.py` | `EntryTrades`, `ExitTrades`, `Positions`; win rate, profit factor, expectancy, SQN |
| `vectorbt/_settings.py` | defaults (fees, prices, conflict modes, stops, `year_freq`, ddof) |
| `vectorbt/returns/nb.py` | every return metric formula |
| `vectorbt/returns/accessors.py` | annualisation factor, `deflated_sharpe_ratio`, returns `stats` |
| `vectorbt/returns/metrics.py` | expected maximum Sharpe and the deflated Sharpe ratio |
| `vectorbt/generic/splitters.py` | `RangeSplitter`, `RollingSplitter`, `ExpandingSplitter`, `split_ranges_into_sets` |
| `vectorbt/generic/accessors.py` | `split`, `range_split`, `rolling_split`, `expanding_split`, drawdown, crossed_above |
| `vectorbt/generic/drawdowns.py` | drawdown records (peak, valley, end, Active/Recovered) and their stats |
| `vectorbt/signals/nb.py` | entry/exit generation, random choice, `clean_enex`, stop choice in OHLC, ranking |
| `vectorbt/signals/generators.py` | RAND, RANDX, RANDNX, RPROB, RPROBX, RPROBCX, RPROBNX, STX, STCX, OHLCSTX, OHLCSTCX |
| `vectorbt/labels/nb.py`, `vectorbt/labels/generators.py` | look-ahead labels for ML (FMEAN … BOLB) |
| `vectorbt/indicators/factory.py` (first 100k chars) | `IndicatorFactory`: parameter product/zip, MultiIndex columns, caching, `run_combs` |
| `vectorbt/base/reshape_fns.py` | broadcasting rules and "flexible indexing" |
| `examples/WalkForwardOptimization.ipynb` | the walk-forward recipe |
| repository and `portfolio/` tree pages | layout |

### B3. Key mechanisms as implemented

**Simulation order** (`portfolio/nb.py`).
- Loop order: by group (blocks of columns that share cash), then by bar, then by column in `call_seq` order. With
  automatic call sequence and cash sharing, each order's value is estimated and orders are sorted ascending, so **sells
  run first** and free cash for buys ("selling comes first to release funds early"). Cash and positions update after
  every fill, so later orders see the updated cash.
- Each bar in `from_signals`: resolve the order price and the valuation price → adjust and check stops against this bar's
  OHLC → if a stop fired, the stop signal is used and the user signal is ignored for that column and bar (stop first) →
  otherwise resolve the user signals → convert them to a size → execute → update the stop state.
- **Price defaults:** `price = +inf` means **this bar's close** (the default); `-inf` means the previous close (or this
  bar's open in `from_signals`). `val_price` (used to value the portfolio for percent/target sizing) defaults to +inf,
  meaning the order price; `-inf` means the previous close.
- **Look-ahead by default:** a signal computed from bar i's close and filled at bar i's close is the vectorbt default.
  The `from_signals` docstring only hints: "If you generated signals using close price, don't forget to shift your
  signals by one tick forward" (`fshift(1)`), "make sure to use a price that comes after the signal".

**Fills and costs** (`execute_order_nb`).
- Slippage: buy fill = price·(1+s), sell fill = price·(1−s).
- Fees = percent·order value + fixed. On buys they are added to the cash required; on sells, subtracted from proceeds.
  When cash is short, the **size is reduced**: the most it can spend is (cash − fixed)/(1+fees). If nothing is left,
  the order is rejected ("CantCoverFees").
- `allow_partial`, `min_size` (default 1e-8), `max_size`, `size_granularity` (floors the size to a multiple, for integer
  shares), `lock_cash`, and **`reject_prob`** (a random rejection, used to stress-test fills).
- Size types: Amount, Value (÷ val_price), Percent (of available cash or position), TargetAmount (minus the current
  position), TargetValue, and TargetPercent (× current portfolio value at val_price). `from_signals` supports only
  Amount, Value and Percent.

**Signal conflicts** (all verified; defaults from `_settings.py`).
- Entry and exit on the same bar (`upon_long_conflict`, default **ignore both**): the modes are Entry, Exit, Adjacent
  (keep the signal that continues the current state) and Opposite.
- Long and short entry on the same bar (`upon_dir_conflict`, default ignore).
- Entry against the current position (`upon_opposite_entry`, default ReverseReduce): Ignore, Close, CloseReduce,
  Reverse.
- `accumulate` (default off) allows pyramiding and partial reductions.

**Stops** (`get_stop_price_nb`, `ohlc_stop_choice_nb`, `resolve_stop_price_and_slippage_nb`).
- SL level = entry·(1 − sl) for longs. A trailing SL follows the highest high, updated **after** the bar's check, so a
  bar is tested against the previous level.
- A hit is detected if low ≤ level ≤ high. If the **open is already beyond** the SL, the portfolio engine returns the
  open (a gap fill at the worse price). A TP that gaps fills at the open (better).
- SL is checked before TP (pessimistic). The default `stop_exit_price='stoplimit'` exits at the stop level with
  **no slippage**; 'stopmarket' keeps the slippage; 'close' uses the close.
- The default `stop_entry_price='close'` measures stops from the entry bar's close.
- Discrepancy: the signal generator `OHLCSTX` (`signals/nb.py::ohlc_stop_choice_nb`) records the **stop level** as the
  exit price even when the bar gapped through it, while the portfolio engine fills at the open. Research done only with
  OHLCSTX signal prices would overstate the results of gapped stops.

**Statistics** (`returns/nb.py`; ann = year_freq / freq; defaults ddof=1, rf=0, required_return=0).

| Statistic | Exact definition |
|---|---|
| First return | value_0 / init_cash − 1. Each later return uses the previous value; a negative base uses |base| |
| Annualised return | (Π(1+r))^(ann/n) − 1 |
| Annualised volatility | std(r; ddof=1)·ann^(1/α), with α = 2 by default, so √ann |
| Sharpe | mean(r − rf) / std(r − rf; ddof=1) · √ann, with rf per period. **Arithmetic** |
| Downside risk | sqrt(mean(min(0, r − req)²)) · √ann, with the mean over all non-NaN periods |
| Sortino | mean(r − req)·ann / downside risk |
| Calmar | annualised return / |max drawdown| |
| Omega | Σ(x>0) / −Σ(x<0), with x = r − rf − threshold |
| Max drawdown | min(C / running max(C) − 1) on cumulative returns |
| Information ratio | mean(r − b) / std(r − b), **not annualised** |
| Beta | mean(d·r) / mean(d²), with d = b − mean(b) |
| Alpha | (mean(r − rf − β(b − rf)) + 1)^ann − 1 |
| Tail ratio | |P95| / |P5| |
| VaR / CVaR | 5th percentile / mean of the worst ⌊(n−1)·0.05⌋+1 returns |
| Common sense ratio | tail ratio · (1 + annualised return) |
| Up/down capture | annualised return ratio on periods where the benchmark rose (or fell) |
| Ulcer index / Martin | sqrt(mean(dd²)); (annualised return − annual rf) / ulcer |
| **Deflated Sharpe** (`returns/metrics.py`) | SR₀ = √V·[(1−γ)·Φ⁻¹(1−1/N) + γ·Φ⁻¹(1−1/(N·e))], with γ the Euler–Mascheroni constant, V the variance of Sharpe across the N trials, and N = number of columns by default. DSR = Φ( (ŜR − SR₀)·√(T−1) / √(1 − skew·ŜR + ((kurt−1)/4)·ŜR²) ), with per-period (not annualised) Sharpe and non-excess kurtosis |

Trade statistics (`portfolio/trades.py`, closed trades by default):
- win rate = wins / all trades (breakeven trades stay in the denominator).
- profit factor = Σ winning P&L / |Σ losing P&L|, **in currency**.
- expectancy = W·avg win − L·|avg loss|, which equals mean P&L.
- SQN = √n·mean(P&L)/std(P&L).
- trade return = P&L / (size × entry price).
- P&L is net of entry and exit fees.
- Open trades are marked at the last close.

Benchmark (`base.py`): buy-and-hold of the close with the same initial cash, split evenly across a group. It ignores fees
and slippage.

**Annualisation pitfall (verified in `_settings.py`):** `year_freq` defaults to **"365 days"**. With trading-day data
(freq = 1 day), ann = 365, not 252, so Sharpe is inflated by √(365/252) ≈ 1.20 unless the user sets
`year_freq='252 days'`.

Drawdowns (`generic/drawdowns.py`): each record has peak, start, valley, end and status (Active/Recovered). The
Drawdowns `stats()` excludes active drawdowns from max/avg drawdown and duration **by default** (`incl_active` off).
The Portfolio's "Max Drawdown" calls `drawdowns.max_drawdown`, which includes active ones.

**Splitters** (`generic/splitters.py`, `generic/accessors.py`).
- `RangeSplitter`: n equal ranges, ranges of a given length, or explicit start/end indices.
- `RollingSplitter`: every window of `window_len`, stepping by 1. With `n`, n of them are chosen evenly (linspace), so
  they **overlap heavily**.
- `ExpandingSplitter`: every range starts at 0 and grows.
- `set_lens` cuts each window into sets (fractions or counts) with a remainder set. `left_to_right=False` puts the
  remainder first, so `set_lens=(180,)` means "all but the last 180 bars = train, last 180 = test".
- **No purge, gap or embargo**: the test set starts on the bar right after training ends.

The walk-forward recipe (`examples/WalkForwardOptimization.ipynb`):
- BTC daily data; 30 rolling windows of 730 days with the last 180 days of each as test.
- Every pair of MA windows from 10–49 (`run_combs`, r=2).
- In each split, the best in-sample Sharpe is chosen and applied to the test segment.
- In-sample and out-of-sample results are compared with buy-and-hold and the **grid median**.
- No significance test, no random baseline, no stated conclusion.

**Random baselines** (`signals/generators.py`, `signals/nb.py`, `Portfolio.from_random_signals`).
- RAND / RANDNX place **exactly n** entries (and alternating exits) per column. RPROB / RPROBNX place them by
  probability.
- `from_random_signals(close, n=…)` builds a portfolio whose trade count matches a strategy's, so the random
  comparison holds turnover roughly constant.
- Numba-side seeding makes the results reproducible.
- `clean_enex` keeps the first of repeated entries/exits and drops bars where both fire.

**Labels** (`labels/nb.py`, `labels/generators.py`; the module docstring warns "Do not attempt to use these functions for
building features").
- FIXLB: the n-step-ahead return.
- MEANLB: the future-window mean vs the close.
- FMEAN / FSTD / FMIN / FMAX: future-window mean, std, min and max.
- LEXLB: local extrema confirmed by ± thresholds, written back at the earlier bar.
- TRENDLB: binary, continuous, saturated or percentage trend between extrema.
- BOLB: the first of +pos_th / −neg_th hit within a window (the upper threshold is checked first). It is a
  "triple-barrier"-style label without the time-barrier return.

**Indicator factory and broadcasting** (`indicators/factory.py`, `base/reshape_fns.py`).
- Parameter lists are **zipped** by default or **crossed** with `param_product=True`. Every combination becomes a column
  under a MultiIndex level named after the parameter. `run_combs` builds combinations such as (fast, slow) pairs.
- `run_unique` skips duplicate parameter sets; `cache_func` shares precomputation across them.
- Broadcasting follows NumPy rules, extended to pandas index/column alignment and index stacking.
- "Flexible indexing" reads a scalar, row or column parameter inside the loop without materialising a full array.

### B4. Research ideas worth knowing (vectorbt)

1. **Deflated Sharpe ratio** (`returns/metrics.py`, `returns/accessors.py`): it judges the best Sharpe against the
   maximum expected from N trials, given how much the trials' Sharpes vary, and corrects for skew and fat tails.
2. **Turnover-matched random portfolios** (`from_random_signals` with n = the strategy's trade count; `RANDNX`).
3. **Stop-first, SL-before-TP, gap-at-open stops** (`portfolio/nb.py`), and the OHLCSTX discrepancy as a cautionary
   tale.
4. **Sells-before-buys call sequence with shared cash** (`portfolio/nb.py`).
5. **Random order rejection (`reject_prob`)** to test how sensitive a result is to missed fills.
6. **Drawdown records with recovery statistics** (`generic/drawdowns.py`): active drawdown, recovery duration and the
   recovery/decline ratio.
7. **Walk-forward with in-sample best vs grid median vs buy-and-hold** (the notebook). The grid median is a useful
   "typical parameter" reference.
8. **Look-ahead labels kept in a separate, labelled module** (`labels/`).
9. **Explicit annualisation factor** (`year_freq`), and the 365-day default as a trap.

### B5. Comparison with our system (vectorbt)

Equivalents: our `random_rule` = their random portfolios; our `walk_forward` = their rolling split + best-in-sample
selection; our Sharpe and Sortino = their `sharpe_ratio_1d_nb` / `sortino_ratio_1d_nb` (same arithmetic form; ours uses
ddof=0 where theirs uses ddof=1). Our sells-first in `portfolio_daily.simulate` matches their auto call sequence. Our
`months_to_prove` and Bonferroni sign test have no counterpart in either library. Their walk-forward notebook has
**no** significance test; ours applies a sign test to the out-of-sample months.

---

## Part C: formula differences and possible bugs in our code

Ordered by importance. Every item references the exact lines read on 2026-10-21. Fixes are suggestions; nothing has
been changed.

1. **`after_tax_cagr` counts the first purchase as a sale** (`research_checks.py` line 198 with
   `rnd_scout.monthly` line 151 and `scout` lines 220/224). In `monthly`, every rule starts from an empty holding, so the
   first month's turnover is the whole initial buy (≈1.0 for a fully invested rule). `after_tax_cagr` treats half of the
   year's turnover as "sold", so year 1 is charged as if about 50% of the portfolio was sold and its gain realised. That
   is wrong for every rule; it matters most for the low-turnover quarterly/yearly variants, where tax deferral is the
   whole point. `turnoverPctPerMonth` already drops `turns[0]`; the tax call does not. Fix: pass `[0] + turns[1:]`, or
   count only the sell side.

2. **Turnover ignores drift** (`rnd_scout.monthly` line 151). Turnover is |new target − previous target|, not |new
   target − drifted holdings|. A rule whose targets do not change (equal weight, trend filter while "on") is charged
   **zero** cost although real rebalancing back to equal weights trades every month. vectorbt's TargetPercent and our
   own `portfolio_daily.simulate` both trade from actual holdings. The cost and the tax turnover are therefore
   understated for rebalancing rules. Fix: drift the held weights by each share's monthly return before computing
   turnover.

3. **The scout fills at the decision day's close; the simulator fills at the next open** (`rnd_scout.monthly` lines
   147/150 vs `portfolio_daily.simulate` lines 100–118). The scout decides with day a's close and earns the return from
   that same close. This is vectorbt's default (and backtesting.py's `trade_on_close`), which vectorbt itself warns
   about. It is not reading the future, but it is not the fill we would get. The scout's numbers are mildly optimistic
   and differ from `portfolio_daily` by the overnight gap at each rebalance. Fix: measure returns from the next session's
   open (the data already has `openPaise`), or note the convention in the report.

4. **Bootstrap resolution is too coarse for the Bonferroni bar** (`research_checks.sharpe_test`, samples=1000;
   `rnd_scout.scout` line 217). With about 20+ ideas, the threshold is ≤ 0.0025. At 1000 resamples the p-value moves in
   steps of 0.001, and its Monte-Carlo standard error near p = 0.002 is about 0.0014, as large as the threshold itself.
   `wouldPassRiskBar` is therefore close to a coin flip near the bar. Fix: use samples ≥ 20/threshold (e.g. 10,000), or
   report a Monte-Carlo interval. Also, p = 1 − P(resampled difference > 0) is a percentile-bootstrap shortcut, not a
   test centred on the null. Ledoit–Wolf-style studentised, centred bootstraps are the standard for Sharpe differences.
   This is a report-only lens, so it is a quality issue, not a safety issue.

5. **`months_to_prove` uses a z/t-test, but the gate is a sign test** (`research_checks.py` lines 166–177 vs
   `rnd_scout.sign_p`). If returns were normal, the sign test needs about π/2 ≈ 1.57× more months than the t-test for the
   same power (asymptotic relative efficiency 2/π). The figure therefore **understates** the time to pass the scout's
   own bar. Ties (months equal to the basket) are dropped by the sign test but counted by `months_to_prove`. Fix: compute
   the power of the binomial test directly, from the observed share of months ahead.

6. **ddof is inconsistent** (`research_checks.py`). `stats` (vol, SQN) and `_sharpe` use the population sd (ddof=0);
   `months_to_prove` uses ddof=1; both libraries use ddof=1 for Sharpe, volatility and SQN. The effect is about 1% at 50
   months. It is cosmetic, but it makes cross-checks against vectorbt or backtesting.py disagree. Fix: use ddof=1
   everywhere.

7. **Labels that describe something different from the libraries** (`stats` keys). `profitFactor`, `expectancyPct` and
   `sqn` are computed on **monthly excess over the basket**, not on trades. Our `sqn` is the t-statistic of the mean
   monthly excess, and `sqn/√n` is the monthly information ratio. The numbers are fine, but anyone comparing them with a
   backtesting.py or vectorbt report will be misled. Fix: rename them (e.g. `monthlyExcessProfitFactor`,
   `excessTStat`), or document the definition next to the value.

8. **Max drawdown on month-end points** (`stats` → `drawdown(levels)`). Both libraries measure per bar. Monthly sampling
   hides falls that recover within a month, so `maxDrawdownPct` and the risk lens's "smaller worst fall" comparison are
   optimistic for both the rule and the basket. `portfolio_daily.simulate` already computes a daily maximum drawdown.
   Fix: use daily equity for the risk lens.

9. **Walk-forward ignores switching cost and is selected from a curated list** (`research_checks.walk_forward`). When
   the chosen idea changes at a year boundary, the turnover from the old idea's holdings to the new one's is not
   charged. The candidate list also includes ideas added on 20–21 Oct after seeing this history, so the walk-forward is
   not fully out-of-sample with respect to the idea set. This was already acknowledged in principle ("seen history"); it
   is listed here so that it stays visible.

10. **Random pickers churn more than the rules they are compared with** (`random_rule`). A fresh random 3 each month has
    much higher turnover, and so pays more cost, than a 6-month momentum rule. This makes "beats random" easier.
    vectorbt matches the number of trades. Fix: give each random picker the rule's turnover, e.g. replace each holding
    with probability equal to the rule's average monthly turnover.

Checked and found consistent: CAGR (n/12 years) = vectorbt's annualised return. Sharpe and Sortino = vectorbt's form
(arithmetic, rf=0), apart from ddof. Calmar = CAGR/|MaxDD| (same in both). Expectancy as a mean (vectorbt's
expectancy formula reduces to the mean P&L). The exact one-sided `sign_p` and the Bonferroni threshold over every idea
ever tried. `percentile` strictly below (same convention as backtesting.py's `lib.quantile`). The drawdown-length
convention (periods under water, unrecovered counted) is one period shorter than backtesting.py's peak-to-recovery for
recovered drawdowns. That is documentation, not a bug.

---

## Part D: gaps and ideas to adopt (our own design)

| Idea | Source | Why / benefit | Effort |
|---|---|---|---|
| Fix items C1–C3 (tax first-month, drift turnover, next-open returns) | — | Removes known optimism from the scout's cost, tax and fill numbers | Small (a few lines each, plus fingerprint bump `rnd-catalog-v2`) |
| **Deflated Sharpe ratio** across the whole catalogue, report-only next to Bonferroni | vectorbt `returns/metrics.py` | Uses the dispersion of Sharpe across all ideas tried plus skew/kurtosis. A second, standard multiple-testing lens that the owner can read | Small: pure formula with `statistics.NormalDist`; skew and kurtosis by hand |
| **Turnover-matched random baseline** | vectorbt `from_random_signals(n=…)`, RANDNX | A fairer "beats random" percentile | Small |
| **Parameter-neighbourhood (plateau) check**: does a passing idea's neighbours (3/6/12 months × top 2/3/4) also beat the basket? | backtesting.py heatmap / `plot_heatmaps` | A passing peak with failing neighbours is likely luck. Cheap overfitting guard on the grid we already have | Small (report-only flag) |
| **Beta and alpha vs the basket** | both (`_stats.py`; `returns/nb.py`) | Tells skill apart from simply holding higher-beta shares (momentum top-3 can carry beta > 1) | Small |
| **Daily-equity drawdown + recovery stats** (active drawdown, time to recover) for the risk lens | backtesting.py `_stats.py`; vectorbt `generic/drawdowns.py` | Honest worst fall; recovery time is what an owner feels | Small–medium (reuse `portfolio_daily.simulate` curve) |
| **Expanding-window walk-forward** as a second view next to the 36/12 rolling one; record the grid median as the reference | vectorbt `ExpandingSplitter`, WFO notebook | Shows whether the selection result depends on window length | Small |
| **Shuffled-history null** for time-series rules (reorder months or blocks, rerun the rule) | backtesting.py `lib.random_ohlc_data` | If momentum "works" on shuffled data, it is not momentum | Medium |
| **Pessimistic intra-bar rules** (SL before TP, gap fills at open, no slippage-free stop exits) if any bot ever uses stops | both | Prevents stop rules looking better than they can be | Small, when needed |
| **Random fill rejection** in the live paper or simulator stress test | vectorbt `reject_prob` | Measures how fragile a result is to missed orders | Small |
| Rename `profitFactor` / `sqn` or document them (C7); unify ddof (C6) | — | Comparability with outside tools | Trivial |

Not worth adopting:
- **The SAMBO / model-based optimiser and large grids:** we want fewer trials, not smarter searches. Every extra trial
  raises the Bonferroni bar.
- **Indicator factory and parameter broadcasting, Numba engine:** our catalogue is about 20 ideas on 8 shares. Plain
  Python is fast enough, and our idea grammar plus fingerprinting already fills the factory's role.
- **Margin, leverage, hedging, FIFO trade matching, `FractionalBacktest`:** cash-only delivery equity does not need
  them.
- **Geometric Sharpe / compounding-adjusted volatility as the primary metric:** keep the arithmetic form, which matches
  vectorbt and most literature, but state the convention.
- **ML label generators:** we are model-free. If ML research starts, borrow the concept (future-return / breakout labels
  in a separate, quarantined module, with purge equal to the label horizon between train and test), not the code.
- **vectorbt's 365-day annualisation default:** we already annualise explicitly (12 monthly, 252 daily).

---

## Part E: what could not be verified

- All reading went through a fetch tool that returns extracts and short quotes. Long files (`portfolio/nb.py`,
  `portfolio/base.py`, `indicators/factory.py`) were read in chunks. The last ~60k characters of `factory.py` (the
  `from_apply_func`, `from_custom_func` and `from_talib` bodies) and the body of vectorbt's `replace_inf_price_nb` were
  not seen directly. The price mapping above (+inf → close, −inf → previous close/open) comes from the surrounding code
  and docstrings.
- vectorbt: the ddof of `MappedArray.std` (used by trades SQN); the exact duration and coverage formulas in the `Ranges`
  base class; whether Portfolio `stats()` passes `incl_active` for drawdown duration; the Rust engine; PRO features.
- backtesting.py: SAMBO internals (a separate package) and the process-pool implementation.
- Neither project was run, so no statistic was reproduced numerically. The backtesting.py test suite pins its own
  values, and no outside reference (empyrical or quantstats) is checked in either repository's tests that were read.
- Documentation-only claims, not verified in code: backtesting.py's statement that optimisation needs overfitting
  precautions (no code guard exists), and vectorbt README claims about PRO features and performance.
