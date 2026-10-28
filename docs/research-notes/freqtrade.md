# Research note: freqtrade (source-code study)

Studied 21 October 2026 for the paper-trading organisation. We copy no code. freqtrade is GPL-3.0, so this note
describes its mechanisms in our own words. Short identifiers and file paths are given only so a reader can find them.

**How it was read.** The files were read-only web fetches of `raw.githubusercontent.com/freqtrade/freqtrade/develop/...`
and the GitHub tree pages. Nothing was cloned, downloaded or installed. Each fetch went through a summarising reader, so
small details (a default value, a `>` against a `>=`) may be wrong. Anything that matters should be re-read in the file
before we build on it.

---

## 1. What it is

- **What it does.** freqtrade is an open-source crypto trading bot in Python, with:
  - live trading, and dry-run (paper) trading;
  - an event-driven backtester;
  - parameter optimisation ("hyperopt", now on Optuna);
  - bias checks (lookahead and recursive analysis);
  - an ML add-on (FreqAI);
  - Telegram, Discord, webhook and REST/websocket control.
- **Licence.** GPL-3.0.
- **Branch and date studied.** `develop` on 21 Oct 2026. No commit hash was captured; see section 6.
- **Edge is gone.** The `freqtrade/edge` directory no longer exists on `develop`. `docs/deprecated.md` says Edge was
  deprecated in 2023.9 and removed in 2025.6. The Edge mechanism was read from the `2024.12` tag
  (`freqtrade/edge/edge_positioning.py`) for history only.

### Source files read (44) and docs (10)

Besides the table below, `constants.py`, `configuration/configuration.py` and `optimize/hyperopt/hyperopt_interface.py`
were read for defaults.

| Area | Files (all under `freqtrade/` unless noted) |
| --- | --- |
| Main loop | `worker.py`, `freqtradebot.py` (both halves) |
| Strategy | `strategy/interface.py` |
| Protections | `plugins/protectionmanager.py`, `plugins/protections/iprotection.py`, `stoploss_guard.py`, `max_drawdown_protection.py`, `low_profit_pairs.py`, `cooldown_period.py` |
| Locks | `persistence/pairlock_middleware.py` |
| Pairlists | `plugins/pairlist/VolumePairList.py`, `AgeFilter.py`, `VolatilityFilter.py`, `rangestabilityfilter.py`, `PerformanceFilter.py` (and the directory listing) |
| Backtesting | `optimize/backtesting.py`, `optimize/optimize_reports/optimize_reports.py`, `data/metrics.py` |
| Bias analysis | `optimize/analysis/base_analysis.py`, `lookahead.py`, `lookahead_helpers.py`, `recursive.py` |
| Hyperopt | `optimize/hyperopt/hyperopt.py`, `hyperopt_optimizer.py`, `optimize/hyperopt_epoch_filters.py`, `optimize/hyperopt_loss/hyperopt_loss_interface.py`, `hyperopt_loss_sharpe.py`, `hyperopt_loss_sharpe_daily.py`, `hyperopt_loss_calmar.py`, `hyperopt_loss_multi_metric.py`, `hyperopt_loss_short_trade_dur.py`, `hyperopt_loss_profit_drawdown.py`, `hyperopt_loss_max_drawdown_per_pair.py` |
| Edge (2024.12 tag) | `edge/edge_positioning.py` |
| FreqAI | `freqai/freqai_interface.py`, `freqai/data_kitchen.py` (two passes) |
| Orders, persistence, wallet | `exchange/exchange.py` (first 100k characters: dry-run order simulation), `persistence/trade_model.py`, `wallets.py` |
| Notifications | `rpc/rpc_manager.py`, `rpc/telegram.py` |
| CLI defaults | `commands/cli_options.py` |
| Docs | `docs/backtesting.md`, `docs/lookahead-analysis.md`, `docs/recursive-analysis.md`, `docs/includes/protections.md`, `docs/hyperopt.md`, `docs/advanced-backtesting.md`, `docs/strategy-customization.md`, `docs/freqai-running.md`, `docs/freqai-feature-engineering.md`, `docs/deprecated.md` |

---

## 2. Architecture and the main control loop

### Worker (`worker.py`), verified in code

- **The state machine.** A `Worker` owns one `FreqtradeBot` and loops forever on its state: `RUNNING`, `PAUSED`,
  `STOPPED` or `RELOAD_CONFIG`.
  - A state change sends a status notification.
  - Entering `RUNNING` or `PAUSED` calls `startup()`.
  - Entering `STOPPED` calls `check_for_open_trades()`.
  - `RELOAD_CONFIG` tears the bot down (`cleanup`) and builds a new one from re-read config.
- **Throttling.** Each pass is throttled to `process_throttle_secs` (default 5 s, `PROCESS_THROTTLE_SECS` in
  `constants.py`). In `RUNNING`/`PAUSED` the throttle is also aligned
  to candle boundaries: the sleep is capped so the loop wakes about 1 second after the next candle of the strategy
  timeframe opens. Decisions therefore run promptly on a fresh candle rather than at an arbitrary phase.
- **Heartbeat.** A heartbeat log line (PID, version, strategy version, state) is written every `heartbeat_interval`
  (default 60 s).
- **systemd.** With `sd_notify` on, it sends `READY`, `RELOADING`, a `WATCHDOG` ping with a status line each pass, and
  `STOPPING`.
- **Errors are split into two classes:**
  - `TemporaryError` (network or exchange hiccups): log, sleep a fixed retry timeout (`RETRY_TIMEOUT`, 30 s), keep the
    state.
  - `OperationalException` (a configuration or logic fault): send the traceback as a notification, then set the state to
    `STOPPED`, so a human must `/start` again.
  - Anything else propagates and kills the process.

### One bot pass: `FreqtradeBot.process()` (`freqtradebot.py`), verified in code

Order of work in each pass:

1. Reload exchange markets if due.
2. Backfill missing fees on trades (skipped in dry-run).
3. Load open trades.
4. Refresh the pair whitelist through the pairlist chain. Open-trade pairs are always kept, and a `WHITELIST` message is
   sent if the list changed.
5. Refresh candle data for all needed pairs, including informative pairs.
6. Strategy hook `bot_loop_start` (errors suppressed).
7. `strategy.analyze(whitelist)`: indicators and signals per pair, timed.
8. Under an exit lock, `manage_open_orders`: fetch each open order, update the trade, then cancel on timeout or full
   cancel, or re-price (`replace_order`).
9. Under the exit lock, `exit_positions`:
   - handle orders that filled on the exchange but were lost locally;
   - manage the exchange stop-loss order;
   - otherwise evaluate exits (`handle_trade` → `should_exit` → `execute_trade_exit`).
10. Futures only: liquidation warnings.
11. Position adjustment (DCA) when enabled: add to or reduce a position, with a cap on adjustments.
12. Entries (`enter_positions`), only when the state is `RUNNING` and there are free slots under `max_open_trades`.
    `PAUSED` therefore still manages exits but opens nothing.
13. Scheduled jobs (funding fees, daily wallet record), commit, then flush the strategy-to-RPC message queue.

**The entry path.**

- `enter_positions` drops pairs that already have a trade. It stops at once if a global lock (`"*"`) is active.
- `create_trade` checks, in order:
  - a free slot;
  - the entry signal;
  - the per-pair, per-side lock;
  - the stake from the wallet;
  - optionally, order-book depth.
- `execute_entry` resolves price, leverage and stake. It asks the strategy's `confirm_trade_entry` veto, places the
  order, and records partial or immediate fills on the `Trade`.

**Where protections run.** `handle_protections(pair, side)` is called when an exit order fills and the trade is closed
(`order_close_notify`, and from the exchange stop-loss path). It does three things in order:

1. Auto-locks the pair for one candle ("prevent immediate re-entries").
2. Runs per-pair protections and sends `PROTECTION_TRIGGER` if one fires.
3. Runs global protections and sends `PROTECTION_TRIGGER_GLOBAL` if one fires.

Protections are therefore **event-driven on exits**, not scheduled.

### Strategy contract (`strategy/interface.py`), verified in code

- **The pipeline.** A strategy fills three dataframe stages per pair: `populate_indicators`, then
  `populate_entry_trend`, then `populate_exit_trend`.
  - With `process_only_new_candles` (default on), analysis reruns only when a new candle appears.
  - Otherwise signals are stripped, so an old signal is not acted on twice.
- **Stale-signal guard.** When reading the latest candle, if it is older than 2 × timeframe + `outdated_offset`
  (default 5 minutes), the bot logs a warning and reads **no** signal.
- **Expired-signal guard.** `ignore_buying_expired_candle_after` (seconds) drops entry signals from candles older than
  that.
- **Exit order inside `should_exit`.** The code builds the list in this order:
  1. exit signal or `custom_exit`;
  2. stop-loss or liquidation;
  3. ROI (minutes-held to minimum-profit table; the highest key at or below the trade's age applies; the exit needs
     strictly more profit);
  4. trailing stop.
- **Stop-loss.** The stop only ratchets in the favourable direction (`Trade.adjust_stop_loss`). An exit is labelled
  "trailing" if the stop has moved from its initial value.
- **Callbacks.** These let the strategy veto or shape each action: `confirm_trade_entry`, `confirm_trade_exit`,
  `custom_stake_amount`, `custom_stoploss`, `custom_exit`, `adjust_trade_position`, `check_entry_timeout`,
  `adjust_entry_price`, `leverage`.
- **Locks.** `lock_pair` and `is_pair_locked` live on the strategy and delegate to `PairLocks`. When checked against a
  candle date, a lock is treated as lasting until the next candle time.

### Persistence (`persistence/trade_model.py`, `pairlock_middleware.py`), verified in code

- **Two trade classes.**
  - `Trade` is an SQLAlchemy model, used live and in dry-run.
  - `LocalTrade` is the in-memory twin used by the backtester. The code comments that the two "must be aligned".
- **Orders.**
  - Orders mirror the exchange (CCXT) order structure.
  - The trade's average entry price, realised profit on partial exits, and stake are recomputed from filled orders
    (`recalc_trade_from_orders`).
- **Pair locks.**
  - Locks are stored in the DB live, and in a class-level list in backtests (`use_db=False`).
  - A lock's end time is **rounded up to the next candle boundary**.
  - Side `"*"` means all sides. A lock on pair `"*"` is a global lock.
  - Locks can be deactivated by pair or by reason.

---

## 3. Key mechanisms as implemented

### 3.1 Protections (automatic, time-boxed entry locks)

**Framework (`iprotection.py`, `protectionmanager.py`).**

- **Shared settings.**
  - A lookback window, set in minutes or in candles.
  - A lock duration, set in minutes, in candles, or as `unlock_at` (a daily "HH:MM" unlock).
  - The validator rejects setting both minutes and candles for the same setting, and rejects mixing `unlock_at` with a
    duration.
- **When a lock ends.** `calculate_lock_end` takes the **latest close time among the trades that caused it**, plus the
  stop duration. With `unlock_at`, it is the next occurrence of that clock time after the last close.
  - The lock runs from the last bad trade, not from "now".
  - `PairLocks` then rounds the end up to the next candle.
- **Scope.** Each protection declares whether it can lock globally (`has_global_stop`), per pair (`has_local_stop`), or
  both.
- **Running them.** The manager runs every loaded handler in configured order.
  - It writes a lock (pair `"*"` for global) only if an equivalent active lock does not already exist.
  - Several protections can stack, and the same protection can be configured twice with different windows.

**The four built-in protections (verified in code).**

| Protection | Scope | Trigger | Lock |
| --- | --- | --- | --- |
| `StoplossGuard` | Global by default; per pair with `only_per_pair`; per side with `only_per_side` | In the lookback window, count closed trades whose exit reason is stop-loss, trailing stop-loss, exchange stop-loss or liquidation **and** whose profit is below `required_profit` (default 0, so losers only). Trigger when the count reaches `trade_limit` (default 10). | All pairs (or that pair) for the stop duration after the last such trade. The side is `"*"` unless `only_per_side`. |
| `MaxDrawdown` | Global only | Needs at least `trade_limit` closed trades in the window (default 1). **`ratios` mode (default):** max drawdown of the running sum of per-trade profit ratios. **`equity` mode:** relative drawdown of the account, starting from starting balance plus all profit closed *before* the window. Lock if drawdown > `max_allowed_drawdown` (strictly greater). | Every pair. |
| `LowProfitPairs` | Per pair only | At least `trade_limit` closed trades of that pair in the window (default 1). The plain sum of their profit ratios is below `required_profit` (default 0). | That pair (per side if `only_per_side`). |
| `CooldownPeriod` | Per pair only | Any closed trade of that pair in the window. | That pair, for the stop duration after its last close. Side is not used. |

**Notes from the code and docs.**

- **Ratios vs equity drawdown.** The docs call `ratios` a "legacy approximation" that can diverge from real account
  drawdown when position sizes change, and recommend `equity` for new setups.
- **Default auto-lock.** Separately from configured protections, every closed trade locks its pair for one candle.
- **Backtests.** Protections apply in backtests only with `--enable-protections` (default off; the help text says it is
  slow). The backtester runs them after each closed order with the starting balance, and uses in-memory locks.
- **What a lock blocks.** A lock blocks **entries** only. Exits and open-trade management continue, so a protection
  never forces a sale.

### 3.2 Lookahead analysis (`optimize/analysis/lookahead.py`, `lookahead_helpers.py`, `base_analysis.py`)

How it detects bias (verified in code):

1. **Neutralise interference.** These settings could cause false alarms, so it overrides them:
   - protections off;
   - market orders for entry, exit and stop, unless limit orders are explicitly allowed;
   - unlimited slots (`max_open_trades = -1`);
   - a wallet of 1e9 and a fixed stake of 10,000;
   - the backtest cache off;
   - a timerange is required.
2. **Baseline.** Run one full backtest over the timerange.
3. **Pick trades to check.**
   - Stop once `targeted_trade_amount` trades are checked.
   - Skip forced exits and trades that close on the final candle.
   - If fewer than `minimum_trade_amount` are available, the result is "too few trades", not a pass.
4. **Truncated re-runs.** For each checked trade, two backtests on that one pair:
   - one with data ending one candle after the trade's **entry** time;
   - one with data ending one candle after its **exit** time.
5. **Compare.**
   - **Signals:** if the entry timestamp is missing from the truncated entry run, it is a biased entry. The same rule
     applies to exits.
   - **Indicators:** the full run's indicator frame is aligned to the truncated run's index, and every column that
     differs in the first compared row is reported by name.
6. **Verdict.** `has_bias` if there are any biased entries, exits or indicators. The report shows counts of biased
   entries and exits and the list of biased indicators.

Limitations stated in the docs (they fit the code):

- Only signals that actually produced trades are checked.
- Single-pair re-runs can raise false alarms for logic that depends on the whole pairlist, such as cross-pair ranking
  or stake that depends on the whitelist length.
- Limit orders combined with custom prices can delay fills and look like bias.
- FreqAI target columns (`&`-prefixed) show up as biased and are ignored.

The docs also advise: fix entry bias before exit bias, and expect a biased strategy's profit to vanish once it is fixed.

### 3.3 Recursive analysis (`optimize/analysis/recursive.py`)

Verified in code:

- **What it computes.** Indicators only, no backtest. A benchmark is built over the full timerange. Indicators are then
  recomputed for a window that ends at the same time but starts one candle later, once for each startup-candle count in
  a list.
  - The default list is 199, 399, 499, 999 and 1999, plus the strategy's own `startup_candle_count`.
  - The docs say odd numbers fit how exchanges paginate candle data.
- **Recursive comparison.** It compares the **last row** with the benchmark and records the relative difference per
  indicator per startup count. The loop stops at the first startup count with no differences.
- **Mini lookahead check.** It also computes indicators on a short window (start plus 10 candles) and compares that
  window's last row with the same timestamp in the full run.
- **How to read it (docs).**
  - Zero variance is not required. The goal is a startup count where the remaining variance cannot flip an entry or
    exit.
  - Only indicators from `populate_indicators` and `@informative` are checked.
  - Use one liquid pair and at least 5,000 candles.

### 3.4 Backtesting assumptions

Verified in `optimize/backtesting.py`:

- **Timing.**
  - Signal columns are shifted by one row, so a signal computed on candle N is acted on in candle N+1, treated as "the
    current incomplete candle".
  - Entries happen at that candle's **open** unless a custom price is set.
  - Signal exits happen at the open too.
- **Limit orders.**
  - A limit order fills only if its price lies inside the candle's low–high range. Custom entry prices are clamped to the
    candle range.
  - An unfilled order stays open across candles, subject to the timeout check (`ft_check_timed_out`).
  - Re-pricing happens at most once per new candle.
- **Stop-loss fill.**
  - If the stop is already beyond the candle at its open (a gap), the exit is at the open. This models gap risk.
  - Otherwise the exit is exactly at the stop price.
  - A trailing stop that triggers inside the entry candle assumes the worst path: price reaches the offset and reverses
    to the stop.
- **ROI fill.** At the ROI-implied price, clamped to the candle. When a new ROI step becomes active on a candle boundary
  and the open is better, the open is used.
- **Fees.**
  - `--fee` if given, otherwise the **worse of maker and taker** fee from the exchange for the first pair.
  - The fee is charged on entry and on exit.
  - Futures funding is applied separately.
- **Slippage.** **There is no slippage model in the backtester.** Fills are at the computed price, rounded only for
  exchange precision. The docs say so too: "orders fill at the requested price with no slippage".
- **Capital.**
  - Wallets are simulated, and stake comes from the same `wallets` code as live.
  - `max_open_trades` caps concurrent trades, and a signal rejected for lack of a slot is counted (`rejected_trades`).
  - Without `position_stacking`, there is one open trade per pair.
- **Warm-up.**
  - Data is loaded with the largest `startup_candle_count` (FreqAI may raise it).
  - Indicators are computed, then the warm-up candles are trimmed before trading starts.
- **Loop order.** For each main candle, pairs with open trades come first. Then:
  1. manage open orders;
  2. check entries (respecting locks);
  3. fill entry orders;
  4. create exits;
  5. fill exits.
- **End of data.** Entries are disabled on the last row. Trades still open are force-exited at the open.
- **Detail mode (`--timeframe-detail`).**
  - Candles of a finer timeframe are walked inside each main candle for open trades and active signals, so the order
    of exits inside a main candle is resolved more realistically.
  - Detail rows reuse the main candle's signal, with a cached entry direction. The code differs slightly from its own
    comment, which says "entries only on the main candle".

Documentation claims (from `docs/backtesting.md`, not all verified line by line):

- **Within a candle:** the low is assumed to come before the high for the stop-loss (capital first), and stop-loss is
  checked before ROI. Backtests therefore show more stop-loss exits than live.
- **Evaluation order** when several fire on one candle: exit signal, stop-loss, ROI, trailing stop.
- **Exchange limits:** no historical limit or precision data exists, so current precision rules and historical prices
  are used. Minimum stakes can therefore be inflated.
- **Dynamic pairlists** reflect today's market, not history. Backtests that use them are not reproducible, and a static
  list is recommended.
- **Detail mode as a robustness check:** a strategy that performs similarly with and without detail data is "more
  likely" to hold up live.

Reports (`optimize_reports.py`, `data/metrics.py`, verified in code):

- **Risk-adjusted returns:** CAGR, Sharpe, Sortino, Calmar, SQN.
- **Profit quality:** expectancy and expectancy ratio, profit factor.
- **Significance:** a **t-test p-value** of per-trade returns against zero (`calculate_p_value`).
- **Drawdown:** account-relative and absolute max drawdown, with its start, end and duration.
- **Comparison:** market change (the average price change of the pairs).
- **Periodic breakdown:** day, week, month, year, weekday.
- **Streaks and timing:** maximum consecutive wins and losses; holding times for winners and losers.
- **Order flow:** rejected signals; timed-out, cancelled and replaced orders.
- **Breakdowns:** per pair, per entry tag, per exit reason, and per tag pair.

Formula details:

- Sharpe, Sortino and Calmar use √365 annualisation.
- A zero or undefined denominator returns -100 as a deliberately bad score.
- Sharpe's numerator is total return divided by days, but its denominator is the per-trade standard deviation. This is
  a mixed definition worth knowing when comparing numbers.

### 3.5 Hyperopt and loss functions

The engine (`hyperopt.py`, `hyperopt_optimizer.py`, verified in code):

- **Library.** Optuna, not scikit-optimize any more. Six samplers are available: TPE, GP, CMA-ES, NSGA-II, NSGA-III and
  QMC. The first 30 points are random start-up trials. The default sampler is NSGA-III (`generate_estimator` in
  `optimize/hyperopt/hyperopt_interface.py`), and the default run is 100 epochs (`HYPEROPT_EPOCH` in `constants.py`).
- **Default search spaces** (`hyperopt_interface.py`): stop-loss from −0.35 to −0.02 at 3 decimals, and a 3-step ROI
  table whose ranges scale with the timeframe.
- **Each epoch.**
  - The sampled parameters are written onto the strategy.
  - Pre-computed indicator data is loaded from a pickle (or indicators are recomputed per epoch if asked).
  - A full backtest runs over the **same single timerange**.
  - The epoch is scored by the chosen loss.
- **Few trades.** An epoch with fewer than `--min-trades` trades (default 1) gets a loss of 100,000.
- **Other mechanics.**
  - Parallel batches use joblib.
  - Duplicate parameter sets are skipped, with a "search space exhausted?" warning.
  - Results are appended as one JSON line per epoch (`.fthypt`).
- **Optional early stop.** It stops after N epochs without improvement (`--early-stop`, default off; the docs say
  values from 1 to 19 are raised to 20).
- **No out-of-sample step.** Nothing holds out data, and nothing warns about overfitting in code. The docs only advise
  backtesting the result afterwards, note that 500–1,000 epochs rarely improve, and say more than 3 decimals of precision
  "will usually result in overfitted results".

**What each loss optimises** (verified in code unless marked).

| Loss | What it rewards | Guard against fragile results |
| --- | --- | --- |
| `ShortTradeDurHyperOptLoss` (default per docs) | A sum of three penalties: distance from 600 trades (Gaussian), total profit below 300%, and average duration up to 300 min | None beyond the trade-count term |
| `OnlyProfit` (docs) | Total profit | None |
| `Sharpe` | `calculate_sharpe` (per-trade returns, √365) | -100 if the denominator is zero |
| `SharpeDaily` | Daily summed returns after subtracting a **fixed 0.05% slippage per trade**, with empty days filled with 0, √365, ddof=1 | Score of -20 (loss +20) if the standard deviation is 0 |
| `Sortino` / `SortinoDaily` (docs) | Downside-deviation versions | — |
| `Calmar` | Return per day ÷ relative account drawdown, √365 | -100 when drawdown is 0 |
| `ProfitDrawDown` | Total profit minus relative drawdown × profit × (1 − 0.075) | A tunable drawdown weight |
| `MaxDrawDown*` (docs) | Minimise absolute, or absolute and relative, drawdown | — |
| `MaxDrawDownPerPair` | **The worst pair's** profit ÷ drawdown. A pair below 1.0 is pushed down by 20 | Every pair must work, not just the total |
| `MultiMetric` | Drawdown-adjusted profit × log(profit factor) × log(capped expectancy ratio) × log(win rate) × trade-count factor | Linear penalty below 50 trades (floor 0.1); expectancy capped at 10 |

**Epoch filters (`hyperopt_epoch_filters.py`).** When listing results, epochs can be filtered by:

- best only, or profitable only;
- min/max trades;
- min/max average duration;
- min/max average profit;
- min/max total profit;
- min/max objective.

### 3.6 Edge positioning (removed in 2025.6; read from tag 2024.12)

- **Simulation.** For each pair, over the last `calculate_since_number_of_days` (default 14), the long entry and exit
  signals are re-simulated once per stop-loss value in a grid (default −1% to −4.9% in 0.1% steps).
  - Entry is at the next open.
  - A stop fills at the stop price when the low crosses it, and the stop wins any tie.
  - A signal exit is at the next open.
  - Profit is normalised to a tiny fixed stake with fees.
- **Selection.**
  - Keep (pair, stop) groups with more than `min_trade_number` trades (default 10).
  - Optionally drop "pumps" (profit above mean + 2σ) and trades longer than `max_trade_duration_minute`.
  - Compute win rate, reward/risk (average win ÷ average loss) and expectancy (reward/risk × win rate − loss rate).
  - Pick the best stop per pair by expectancy.
  - Remove pairs from the whitelist unless expectancy > 0.2 **and** win rate > 0.6.
- **Sizing (fixed-fractional risk).** The stake is the allowed risk share of tradable capital divided by the absolute
  stop distance, capped by free and available capital. For example, with 1% risk and a 2% stop, the stake is 50% of
  capital.
- **Why it matters.** The project removed it, a cautionary data point: per-pair stop selection on a 14-day window is
  exactly the in-sample selection that walk-forward testing warns against. `docs/deprecated.md` gives no reason.

### 3.7 FreqAI

Verified in `freqai/freqai_interface.py` and `freqai/data_kitchen.py`:

- **Live mode.** It requires `process_only_new_candles`. A **background thread** walks a training queue of pairs,
  least-recently-trained first.
  - It retrains a pair when the model's age exceeds `live_retrain_hours`.
  - The training window is the last `train_period_days`, loaded with an extra warm-up buffer of
    2 × startup candles × the largest timeframe.
  - Training errors are logged and the thread survives.
  - The trading loop never waits for training.
- **Model expiry.** If a model is older than `expiration_hours`, predictions are returned as zeros with
  `do_predict = 2`. The log tells the strategy to treat that as "no opinion".
- **Backtest mode.** Sliding windows: train on `train_period_days`, predict the next `backtest_period_days`, slide
  forward, repeat.
  - Each window's model and predictions are saved and reused when the same identifier reruns.
  - A changed feature list raises an error.
  - `backtest_live_models` replays saved live predictions instead of retraining.
- **Features.**
  - Columns containing `%` are features, and columns containing `&` are labels.
  - Shifted copies (lags 1..N) are only backward-looking.
  - Features can be built for several timeframes and correlated pairs, merged with forward-fill.
  - Optional exponential recency weights: the newest sample weighs 1, the oldest about exp(−1/`weight_factor`).
- **Train/test split.** sklearn `train_test_split` with `shuffle=False` by default, so the chronological tail is the test
  set (default 10%).
- **NaN handling.**
  - In training, rows with any NaN or infinity are dropped. Live mode warns if more than 10% are dropped.
  - In prediction, NaNs are filled with 0 and the row gets `do_predict = 0`.
- **Data pipeline (`define_data_pipeline`), in order:**
  1. drop zero-variance features;
  2. MinMax scale to [−1, 1];
  3. optional PCA (99.9% variance) with a rescale;
  4. optional one-class-SVM outlier removal (nu 0.01);
  5. optional Dissimilarity Index;
  6. optional DBSCAN outlier removal;
  7. optional noise.
- **Outliers.** A row flagged as an outlier gets `do_predict = 0`, so the strategy can ignore that prediction.
- **Live label statistics.** Optionally, a normal distribution is fitted to the last N predictions per label, giving
  `labels_mean` and `labels_std` so thresholds adapt. In backtests this is recomputed per row from the preceding N rows,
  to mimic live.

From the docs (`freqai-feature-engineering.md`, `freqai-running.md`), not verified in code:

- **DI.** The distance from the new point to its nearest training point, divided by the average pairwise distance in
  the training set. A prediction is discarded above `DI_threshold`. The computation lives in the external DataSieve
  library.
- **DBSCAN.** `eps` is chosen at the elbow of the k-distance curve, and `min_samples` is a quarter of the candles.
- **Purging.** `purge_old_models` keeps the N newest models.

### 3.8 Dry-run vs live parity

Verified in `exchange/exchange.py`, `wallets.py` and `persistence/trade_model.py`:

- **The same code paths.** Dry-run uses the same bot loop, strategy, protections, locks, wallet logic and `Trade`/DB
  model as live. Only order placement and the balance source are simulated.
- **Dry-run market orders.**
  - The fill price comes from walking a 20-level L2 order book until the quantity is filled.
  - The average price is clamped to at most 5% worse than the reference rate.
  - The taker fee is charged.
  - Without order-book support, the fill is at the requested rate (no slippage).
- **Dry-run limit orders.**
  - A limit order that crosses the spread by more than 1% is converted to a market order.
  - Otherwise it fills only once the book crosses its price, checked every time the order is fetched.
  - An immediate fill pays taker, and a later fill pays maker.
- **Dry-run stop orders.** They fill when crossed, with their own limit as the worst price. A stop that would trigger
  immediately on creation is refused.
- **Dry-run wallet.** Rebuilt from scratch each time: `dry_run_wallet` start capital, plus closed profit, minus stake in
  open trades.
- **The backtester's wallet.** It uses the same `Wallets` class, with `LocalTrade`.
- **Stake sizing (`wallets.py`).**
  - The pool is (open stakes + free) × `tradable_balance_ratio`, or a fixed `available_capital`.
  - With unlimited stake, the pool is divided equally among `max_open_trades`, capped at what is free.
  - A stake below the exchange minimum is raised to the minimum unless that is more than a 30% increase, in which case
    the trade is skipped.
  - The last trade may be trimmed to the remaining balance (`amend_last_stake_amount`).

### 3.9 Notifications and control

Verified in `rpc/rpc_manager.py` and `rpc/telegram.py`:

- **Isolated handlers.**
  - Telegram, Discord, webhook and the API server are each registered only if enabled.
  - Handlers that queue get their own worker thread and a copy of each message.
  - A failing handler is logged and never blocks the others.
  - On shutdown, the queues get up to 10 s to drain.
- **Startup banner.** Startup messages state:
  - "Dry run is enabled. All trades are simulated." when in dry-run;
  - the exchange, stake, ROI, stop-loss (or trailing), timeframe and strategy;
  - the pairlist;
  - **the active protections**.
- **Message types** include entry, entry fill, entry cancel, exit, exit fill, exit cancel, whitelist change, protection
  trigger (pair and global), warnings, exceptions and status.
- **Per-type routing.**
  - Each type can be `on`, `silent` or `off`.
  - Exit messages can be routed **per exit reason**, so for example a stop-loss is loud and an ROI exit is silent.
- **Authorisation.** A chat ID, an optional topic, and an optional list of authorised user IDs. Unauthorised messages are
  ignored and logged.
- **Commands.** `/stopentry` (alias `/pause`: no new entries, exits still managed), `/stop`, `/start`, `/forceexit`,
  `/forcebuy`, `/locks`, `/unlock`, `/reload_config`, `/balance`, `/profit`, `/daily`, `/performance`, and more.
- **No confirmations.** Dangerous commands such as `/stop`, `/forceexit <id>` and `/delete` take effect with no
  confirmation step.
- **Limits and retries.** Long output is split, and there is no rate limiting. A network failure is retried once.

### 3.10 Pairlist chain (`plugins/pairlist/*`)

A generator such as `VolumePairList` produces the list, and filters prune or sort it in order. Verified in code:

- **`VolumePairList`.**
  - Ranks by quote volume, either from the ticker or summed over N candles.
  - Applies optional min/max volume bounds and keeps the top N.
  - Results are cached for `refresh_period`.
  - **Not supported in backtests.**
- **`AgeFilter`.**
  - Removes pairs listed fewer than `min_days_listed` days ago (default 10), judged by the first daily candle.
  - Optionally removes pairs listed more than `max_days_listed` days ago.
- **`VolatilityFilter`.** Mean rolling standard deviation of log returns × √period over the lookback, kept within
  [min, max]. It can also sort. Not supported in backtests.
- **`RangeStabilityFilter`.** (highest high − lowest low) ÷ lowest low over the lookback. It removes pairs that are too
  flat (default under 1%) or, optionally, too wild.
- **`PerformanceFilter`.**
  - Re-orders pairs by the bot's own realised profit over a window, with fewer trades first among ties.
  - It can drop pairs below a minimum profit.
  - Live only.
- **Others in the directory (not read):** `PrecisionFilter`, `PriceFilter`, `SpreadFilter`, `ShuffleFilter`,
  `OffsetFilter`, `DelistFilter`, `FullTradesFilter`, `MarketCapPairList`, `PercentChangePairList`, `RemotePairList`,
  `ProducerPairList`, `CrossMarketPairList`, `PairInformationFilter`.

---

## 4. Research ideas worth knowing

1. **Event-driven, self-expiring protections.**
   - What: losses, stop-outs or a drawdown inside a lookback window lock entries until the last bad trade's close plus a
     duration, rounded up to the next candle.
   - Why: they release themselves, need no human, and never force exits.
   - Source: `plugins/protections/*.py`, `plugins/protectionmanager.py`, `persistence/pairlock_middleware.py`,
     `freqtradebot.py` (`handle_protections`).
2. **Anti-churn auto-lock.** Every exit locks its pair for one candle. Source: `freqtradebot.py` (`handle_protections`).
3. **Equity drawdown, not summed ratios.** The project itself now calls ratio-sum drawdown a legacy approximation.
   Source: `max_drawdown_protection.py`, `docs/includes/protections.md`.
4. **Truncation-based lookahead test with indicator diff.**
   - What: re-run on data cut just after each entry and exit, then compare signals and every indicator column.
   - Interference (protections, limit orders, slot limits) is switched off first so it cannot cause false alarms.
   - Source: `optimize/analysis/lookahead.py`, `lookahead_helpers.py`.
5. **Recursive (warm-up) sweep.** Several history lengths are tried, and the relative difference per indicator per length
   is reported, to choose the minimum safe warm-up. Source: `optimize/analysis/recursive.py`.
6. **Stale-candle refusal.** No signal is read from a candle older than 2 × timeframe plus an offset, and entry signals
   expire after N seconds. Source: `strategy/interface.py`.
7. **Two error classes in the loop.** A transient error means retry and keep the state. An operational error means stop
   trading and notify. Source: `worker.py`.
8. **Candle-aligned scheduling.** The loop wakes just after a candle closes. Source: `worker.py` (`_throttle`).
9. **Gap-aware stop fills and worst-case intra-candle ordering in backtests.** Source: `optimize/backtesting.py`
   (`_get_close_rate_for_stoploss`), `docs/backtesting.md`.
10. **Detail-timeframe robustness check.** Re-run with finer data; similar results suggest the backtest is not exploiting
    candle ambiguity. Source: `optimize/backtesting.py`, `docs/backtesting.md`.
11. **Worst-member objective.** Optimise the worst pair's profit/drawdown, not the total. Source:
    `hyperopt_loss_max_drawdown_per_pair.py`.
12. **Trade-count penalty and capped expectancy in the objective.** Source: `hyperopt_loss_multi_metric.py`.
13. **Fixed per-trade slippage inside the objective** (0.05%), so frequent traders are penalised. Source:
    `hyperopt_loss_sharpe_daily.py`.
14. **Rejected-signal and tag analysis.** Signals that were not traded are stored and analysed by entry tag and exit
    reason. Source: `optimize_reports.py` (`rejected_signals`), `docs/advanced-backtesting.md`.
15. **Model expiry and an explicit "no opinion" flag.** An expired or uncertain model yields `do_predict` 0 or 2 rather
    than a number. Source: `freqai/freqai_interface.py`.
16. **Out-of-distribution refusal (DI, SVM, DBSCAN).** Refuse to act on inputs unlike the training data. Source:
    `freqai_interface.py` (`define_data_pipeline`), `docs/freqai-feature-engineering.md`.
17. **Least-recently-trained retraining queue on a background thread.** Source: `freqai_interface.py`
    (`_start_scanning`, `_set_train_queue`).
18. **Order-book-walk paper fills with a slippage cap; maker vs taker by fill timing.** Source: `exchange/exchange.py`
    (`get_dry_market_fill_price`, `check_dry_limit_order_filled`).
19. **Fixed-fractional risk sizing:** stake = risk budget ÷ stop distance. Source: `edge/edge_positioning.py` (2024.12).
20. **Listing-age and range-stability universe filters.** Source: `AgeFilter.py`, `rangestabilityfilter.py`.
21. **Notification routing by type and by exit reason, plus a startup banner listing active protections.** Source:
    `rpc/telegram.py`, `rpc/rpc_manager.py`.

---

## 5. Comparison with our system

### 5.1 Equivalents we already have

| freqtrade | Ours | Comment |
| --- | --- | --- |
| Lookahead analysis | `research_checks.check_rules` (lookahead): a decision on day *i* must not change when later days are removed; checked on 6 month-start days; failure blocks the idea | Same principle, applied to decisions. Ours fails hard; theirs reports. |
| Recursive analysis | `research_checks` warm-up: the decision with only the last 300 sessions must match the full-history decision; report only | One cut, not a sweep. See gaps. |
| Report metrics (Sharpe, Sortino, Calmar, SQN, expectancy, profit factor, p-value) | `research_checks.stats`, `sharpe_test` (block bootstrap), `months_to_prove`, Bonferroni sign test in `rnd_scout.py` | **Ours is statistically stricter.** They have one t-test p-value and no multiple-testing control; we have Bonferroni over every idea ever tried, a random baseline and walk-forward. |
| Hyperopt duplicate detection | `rnd_ideas.py` ledger refuses duplicate canonical specs; at most 3 new ideas a month; the bar tightens as ideas are added | Ours is the stronger anti-overfitting design. |
| Hyperopt has no out-of-sample step | `walk_forward` in `research_checks.py` | We have it; they do not. |
| Stale-signal refusal | Quotes must be under 60 s old (`paper.ts`, `trade-signals.ts`); every proposal has `expiresAt`, and lapsed proposals release their reservation (`trade-signals.ts` `lapse`) | Equivalent. |
| No-hindsight execution (signal on N, act on N+1 open) | `paper.ts` `evidencePrice`: an end-of-day fill price must be observed **after** the review that accepted it | Equivalent, and enforced in the ledger, not just the simulator. |
| Fees and costs | `feeBps` and `slippageBps` on every paper fill; `COST_BPS = 30` in call scoring; `ONE_WAY_COST_PCT = 0.15` in research | **Better than their backtester,** which has no slippage. |
| Global brake | `system_lock.halted` (new risk only); the realised-loss limit (`tradingLoss >= maxLoss`); the intraday kill switch raises a critical incident | Same "block entries, never force exits" philosophy. |
| `/stopentry` (exits only) | Suspension: "it may only reduce risk" (`paper.ts`, `trade-signals.ts`) | Equivalent per bot. |
| Per-bot drawdown and loss brakes | `management.ts` management-v1: suspend at −15% of budget, watch at −8% or a 20% equity drawdown, suspend if live calls are significantly worse than cash | We use the equity curve, which is the method they now recommend. **But ours is a daily recommendation that the owner accepts.** |
| Two error classes and a retry loop | `organisation-cycle.mjs` retries, escalating after 3 consecutive failures (`ESCALATE_AFTER`); `run-feed-cycle.mjs` backoff | Equivalent. |
| Heartbeat and watchdog | Department session leases (`department-sessions.ts`: stale or degraded) and `supervisor.mjs` | Equivalent in spirit. |
| Model expiry | `EVALUATION_VALID_DAYS` for releases; `alerts.ts` `release-evaluation-expired` | Equivalent for releases. Our forecasters have no prediction-level expiry flag. |
| Data sanity | `daily.py` data steward rejects >20% daily moves; `intraday-monitor.mjs` ignores bad prints (>20% from the previous close, or a crossed book) | Comparable to their outlier handling on prices. |
| Startup banner, routed notifications | `alerts.ts` and the local outbox, with `warning`/`critical` severities; the owner digest | Partial. See gaps. |
| `confirm_trade_entry` veto | An independent challenger with verified evidence halves conviction; a deterministic review (`signal-risk-v2`) | Ours is stronger: separate identities, recorded reasons. |
| Partial fills, average cost | PAPER-05 volume cap (`maxQuantity`, a partial fill of the review); average cost basis on sells in `paper.ts` | Equivalent for our long-only cash use. |

### 5.2 Gaps: what freqtrade has that we lack

1. **No automatic, self-expiring locks.**
   - All our bot-level brakes are either:
     - permanent until the owner acts (the halt, suspension accepted from a management recommendation); or
     - checked once a day by `Management.review` and only *recommended*.
   - freqtrade locks fire **at the moment a trade closes**, last a bounded time, and release themselves.
   - The method card `protections` in `knowledge/methods.json` says this is "covered by existing controls". The code
     reading says otherwise: we have no StoplossGuard-, LowProfitPairs- or CooldownPeriod-style rule.
2. **No per-symbol lock or cooldown.** Nothing stops a bot from re-entering a share it was just stopped out of, or one
   where it lost money N times in a window. Our limits are per order, per bot budget, per target weight and
   organisation-wide.
3. **No loss-streak or stop-out-count trigger.** management-v1 looks at return on budget, drawdown, lapses and live
   verdicts, but not at "k losing exits in the last d days".
4. **Brakes are not simulated in research.**
   - freqtrade can run protections inside backtests (`--enable-protections`).
   - Our `research_checks.py` and `rnd_scout.py` score raw rules without management-v1, the loss limit or the paper
     limits.
   - So the live system does not trade the rule that was researched. This is a parity gap between research and live,
     the same concern our own `release` method card raises.
5. **Warm-up check is one cut, not a sweep.** We test only "last 300 sessions". freqtrade sweeps several lengths and
   shows how the difference shrinks, which tells you the **minimum** safe history (the data requirement for a new share
   or a new idea).
6. **Lookahead compares decisions only.** freqtrade also diffs every indicator column, which catches future leakage in
   an intermediate value before it happens to flip a decision. We also check only 6 dates. freqtrade checks up to a
   target number of actual trades and **fails "too few checked" rather than passing**.
7. **No rejected-call counterfactual analysis.**
   - Our `scoreCall` can score any reviewed signal that has a reference price, including rejected ones.
   - No report was found that compares outcomes of rejected and accepted proposals by rejection reason. Only
     `owner-digest.ts` counts rejections.
   - freqtrade's `rejected_signals` and analysis groups by entry tag and exit reason are a way to audit the risk review
     itself: is `size-below-one-share` or `stated-probability-below-even` throwing away good calls?
8. **No exit-reason or tag breakdown of P&L per bot.** freqtrade reports profit by entry tag, exit reason and pair, plus
   consecutive wins and losses and winner versus loser holding time. Our performance views are per bot and per basket.
9. **No prediction-level "no opinion" or out-of-distribution flag for forecasters.** Our model-based forecasters
   (Kronos, `forecast.py`) do not mark a prediction as unusable when the model is stale or when today's inputs are
   unlike the training data.
10. **No startup or cycle configuration banner.** freqtrade announces paper versus live, stake, stop and **active
    protections** on start. Our alerts report problems but do not state the live limits each day, so a silently changed
    `.env` limit (the "stale process env" problem in our memory notes) would not be visible in the digest.
11. **No sizing from the invalidation distance.** Proposals state an `invalidation` as text. Size comes from conviction ×
    the tightest limit. freqtrade's (removed) Edge used risk ÷ stop distance, so the loss at the stop is a known share of
    capital.
12. **No listing-age or minimum-history gate per symbol.** The NIFTY 50 research leaves out late listers by hand
    (`docs/research-methods.md`). There is no coded rule like `AgeFilter`.

### 5.3 Ideas to adopt (in our own design)

Ordered by value for effort. None changes money or limits; all are brakes or diagnostics. That fits the method card's
lesson, "prefer a brake that pauses a bot over one that changes money or limits", and the autonomy vision, because they
need no owner action.

| # | Idea | Why | Benefit | Effort |
| --- | --- | --- | --- | --- |
| A1 | **Self-expiring entry locks** (`entry_locks` table: bot or `*`, symbol or `*`, until, reason, rule version). Rules, all published as "protections-v1": (a) **cooldown**: after any sell fill, that bot and symbol is locked until the next session open, plus N sessions; (b) **loss-streak**: k losing exits for a bot in d sessions locks the bot's entries for m sessions; (c) **symbol loss**: net realised loss on a bot+symbol over d sessions below x% locks that pair; (d) **org drawdown**: organisation paper-equity drawdown over a window above y% sets a global lock until a date. Checked in `trade-signals.ts` review (a new reason, `locked-<rule>`) and again in `paper.ts` `permitNewRisk`. Written in the same transaction as the sell fill, the way freqtrade does it on exit. | Closes gaps 1–3. Brakes act within the day, not at the next management review, and expire on their own, so no owner action is needed. Exits stay allowed. | Prevents churn and revenge re-entries; limits damage from a broken bot between daily reviews; every lock is audited with its rule. | Medium: 1 table, 1 module, 2 check sites, tests. Owner approves the rule constants once, as a standing policy. |
| A2 | **Round lock ends to the next session open** and compute them from the **last bad trade's close**, not from "now" | A detail from `calculate_lock_end` and `PairLocks` that makes lock windows deterministic and replayable | No half-day ambiguity; the same result in replay and live | Trivial, part of A1 |
| A3 | **Simulate brakes in research**: apply management-v1 thresholds, the loss limit and A1 locks inside the scout's monthly simulation, as an extra column ("with brakes") | Gap 4. The organisation trades rule + brakes, so research should score rule + brakes. | Shows whether brakes help or hurt each idea (for momentum, a cooldown may cost returns); closes the parity gap | Medium: the rules must be pure functions shared by spec, not by code across TS and Python, plus a parity test on a fixture |
| A4 | **Warm-up sweep**: in `research_checks.py`, test several history lengths (for example 60, 120, 250, 500 sessions) and report the shortest length from which decisions stop changing | Gap 5 | Gives a coded "minimum history" requirement per idea, which also gives A6 for free | Small |
| A5 | **"Too few checks" is a fail, and more lookahead dates**: check every decision day (or a larger sample) and fail an idea with fewer than K decisive checks; for rules that compute intermediate scores (ranks, RSI), also compare those values, not just the final weights | Gap 6 | Catches leakage that has not yet flipped a decision; stops a pass on thin evidence | Small to medium |
| A6 | **Minimum-history gate**: a share may be proposed only with at least N verified sessions (derived from A4) | Gap 12, from `AgeFilter` | Automates today's manual exclusion of late listers and new listings, including demerger tickers | Small |
| A7 | **Rejected-call audit**: monthly, score rejected and lapsed proposals with the same `scoreCall` and compare hit rate and Brier score by rejection reason against accepted calls | Gap 7, from `rejected_signals` and the analysis groups | Tells us whether signal-risk-v2 adds value, and which rule is too strict; evidence for a v3 | Small: data exists; a query and a digest section |
| A8 | **Exit-reason and tag breakdown** per bot: P&L by why it exited (signal, management suspension, lapse, kill switch), streaks, winner and loser holding time | Gap 8 | Better input to management-v1 and to R&D lessons | Small |
| A9 | **Daily limits banner** in the owner digest and cycle journal: paper or live, maxOrder, maxExposure, maxLoss, slippage and fee bps, active locks and rule versions, as actually loaded by the running backend | Gap 10, from `startup_messages` | Makes silent `.env` or stale process-env drift visible the same day | Small |
| A10 | **Prediction-level "no opinion"**: forecasters return `usable=false` with a reason (model older than X days, or inputs outside the training range by a simple distance-to-training score) and the desk treats that as no-action | Gap 9, from `do_predict` and DI | Avoids acting on stale or out-of-distribution model outputs on the 4B or Kronos stack | Medium |
| A11 | **Risk-at-invalidation sizing (report first)**: let a proposal state an invalidation **price**; the review computes the loss at that price and caps size so it is at most r% of the bot's budget, as one more binding limit | Gap 11, from Edge's sizing (not its pair selection) | The loss when wrong becomes a known, small share of budget | Medium; begin as a shadow "would have sized" field |
| A12 | **Worst-member check in research**: report each idea's worst share (or worst year) profit/drawdown next to the total | From `MaxDrawDownPerPair` | Shows ideas that live off one share or one year; fits our survivorship worries | Small |
| A13 | **Per-reason alert routing**: route by rule and severity (kill switch is loud; share-drop warnings are digest-only) | From Telegram `notification_settings` | Less noise in the outbox; the owner sees criticals first | Small |

### 5.4 Ideas not worth adopting, and why

- **Hyperopt-style parameter search.** We trade 8 shares, monthly, and our own walk-forward already shows that picking
  the best backtest fails (33 of 37 months behind). A Bayesian search over many parameters on one timerange, with no
  hold-out (which is how freqtrade's works), would mine noise. Our grammar, ledger and Bonferroni design is the better
  answer.
- **Edge's per-pair expectancy whitelist.** Selecting stops and pairs in-sample over 14 days is the overfitting pattern
  we already guard against, and the project itself removed it in 2025.6. Only its sizing formula (A11) is worth
  keeping.
- **`PerformanceFilter`** (ranking symbols by our own recent P&L). This is performance chasing, with no evidence of
  skill. Our pre-registered, significance-gated path is the right channel.
- **ROI tables, trailing stops, DCA and position stacking.** These are intraday crypto mechanics. Our bots are monthly
  or end-of-day long-only rules. They add parameters, which means overfitting surface, without a researched need.
- **The full FreqAI stack** (PCA, SVM, DBSCAN, continual learning, RL). It is too heavy for the laptop and the 4B-model
  plan, and our model-based forecasters have not yet shown an edge. Only the cheap ideas in A10 carry over.
- **Telegram remote control** with no confirmation for `/stop`, `/forceexit` and `/delete`. It conflicts with our owner
  approval model and the office-laptop constraints. Our agenda, standing approvals and audit trail are safer.
- **Order-book-walk dry-run fills.** We have no Level 2 data for NSE in this setup. Fixed `slippageBps` plus the volume
  cap is the honest equivalent until a broker feed exists. Revisit when the live feed plugs into `intraday-monitor.mjs`.
- **Ratio-sum drawdown.** Even freqtrade calls it legacy. Keep our equity-curve drawdown.
- **Candle-aligned 1-second throttle.** Our cadence is daily with an intraday monitor. Session-aligned scheduling already
  exists in the cycle and does not need a tick loop.

---

## 6. What could not be verified

- **Exact commit.** The note is from `develop` on 21 Oct 2026. No commit SHA was recorded, so line-level details may move.
- **Reading method.** Every source file went through a summarising web reader, not a local checkout. Defaults and
  comparison operators quoted here should be re-read in the file before we rely on them.
- **`exchange/exchange.py`:** only the first 100k of about 189k characters were read (the dry-run order section). Live
  order paths, `get_fee` and the stop-loss-on-exchange internals were not read.
- **`CooldownPeriod` lookback:** the code reads the base-class lookback (default 60 minutes). The docs say it "ignores
  `lookback_period`". The interaction was not resolved.
- **The meaning of `ProtectionReturn.lock_side`** beyond its `"*"` default, and the DB query path of
  `PairLocks.get_pair_locks` (`query_pair_locks`), were not shown.
- **Lookahead analysis defaults:** `commands/cli_options.py`, `configuration/configuration.py` and `constants.py` set
  no defaults for `minimum_trade_amount` and `targeted_trade_amount`. They are probably in `config_schema/`, which was
  not read.
- **Hyperopt:**
  - `hyperopt_auto.py`;
  - the exact early-stop wiring;
  - `Sortino`, `OnlyProfit` and the other `MaxDrawDown*` losses (described from docs only).
- **FreqAI:**
  - the Dissimilarity Index computation (in the external DataSieve library);
  - `purge_old_models` and the data drawer;
  - the individual prediction models;
  - DBSCAN `eps` selection (all from docs only).
- **RPC:** Discord, webhook, the REST/websocket API and producer/consumer mode were not read.
- **Other files:** most pairlist filters (listed in 3.10) were not read. `backtest_caching.py` and the `space/` folder
  were not read.
- **Edge's removal:** the reason is not given in `docs/deprecated.md`. Its mechanism here is from the 2024.12 tag.
- **Our system:**
  - the claim that no rejected-call outcome analysis exists rests on a search for obvious patterns in `backend/src`,
    `integrations/trading-desk` and `scripts`, not a full read;
  - `bot-control.ts`, `autonomy.ts`, `bot-releases.ts` and `eod_trader.py` were not read in full for this note.
