# Research note: QuantConnect Lean

Studied 21 Oct 2026. Read-only web fetches. No code was cloned, downloaded or copied. Everything below is described in our own words. Short identifiers and file paths are given only so that a reader can find the source.

## 1. What it is

- **What:** LEAN is QuantConnect's open-source algorithmic trading engine. It is written in C# and also runs Python algorithms. One engine runs backtests, paper trading and live trading against many brokerages.
- **License:** Apache-2.0. Every source file read carries the Apache 2.0 header.
- **Branch studied:** `master`, read through `github.com/QuantConnect/Lean/tree/master` and `raw.githubusercontent.com/QuantConnect/Lean/master/...` on 2026-10-21. The fetch tool showed no commit hash or date, so the exact revision is unknown.
- **How it was read:** The fetch tool returns a model-written summary of each file, not the raw text. The mechanisms below come from those summaries, prompted to describe each file's logic. Small details, such as the exact constants, should be rechecked against the file before anyone relies on them (see section 6).

Files read: 62 source files, listed in the sections where they are used, plus directory listings of `Algorithm.Framework/{Alphas,Portfolio,Execution,Risk,Selection}`, `Common/Orders/{Fees,Slippage}`, `Common/Data/UniverseSelection`, `Common/Statistics` and `Engine/Results/Analysis/Analyses`.

## 2. Architecture

### 2.1 The framework pipeline (one pass per time slice)

Universe selection → Alpha (Insights) → Portfolio construction (PortfolioTargets) → Risk management (overriding targets) → Execution (orders)

- **Orchestrator:** `Algorithm/QCAlgorithm.Framework.cs`, method `OnFrameworkData`. On each slice it does the following, in order:
  1. Refreshes universes when `UniverseSelection.GetNextRefreshTimeUtc()` is due. It disposes selection-created universes that were not returned again. Universes the user added by hand are never disposed this way.
  2. Calls `Insights.Step(utcNow)` on every slice, even an empty one, so insight scoring advances with time.
  3. Returns early if the slice has no data.
  4. Calls `Alpha.Update` to get insights.
  5. Initialises the insights. Insights for delisted securities are dropped with a warning. For the rest it stamps the generated time and the reference value: the price for a price insight, the volatility model's value for a volatility insight. It also stamps the source model name and computes the close time from exchange hours.
  6. Runs `ProcessInsights`:
     - Portfolio construction creates targets.
     - Risk management receives those targets and may return overrides. The overrides are put first and duplicates are removed by symbol, so **a risk override always beats the portfolio target for the same symbol**.
     - The merged list goes to `Execution.Execute`.
- **Security changes:** `OnFrameworkSecuritiesChanged` forwards universe additions and removals to the alpha, portfolio, execution and risk models.
- **Composites:**
  - `Algorithm/Alphas/CompositeAlphaModel.cs` runs several alpha models in order and concatenates their insights. It tags each untagged insight with the producing model's name (`SourceModel`).
  - `Algorithm/Risk/CompositeRiskManagementModel.cs` chains risk models. Each model sees the targets already adjusted by the models before it, and the last model to touch a symbol wins.
- **Defaults:** The `Add*` methods replace a `Null*` placeholder model on first use and build a composite after that.

### 2.2 The engine loop

`Engine/AlgorithmManager.cs`, method `Run`, takes time slices from a synchronizer. For each slice it:

1. Checks the time limit and cancellation. A backtest stops if portfolio value is zero or below.
2. Fires past scheduled events and scans consolidators.
3. Sets the algorithm time and applies universe security changes.
4. Updates each security with its new data and refreshes currency conversions. Hourly, it applies margin interest and settles unsettled cash.
5. Handles symbol changes. Open orders on the old ticker are cancelled.
6. Processes synchronous fills through the transaction handler, which applies the fill models.
7. Runs margin calls (every 5 minutes, and only when exchanges are open).
8. Calls `OnSecuritiesChanged`.
9. **Applies dividends and splits** to the portfolio and to open orders. They are skipped during warm-up.
10. Updates consolidators and dispatches custom data.
11. Fires `OnSplits`, `OnDividends` and `OnDelistings`.
12. Calls `OnData`, then `OnFrameworkData`.
13. Finishes with `OnEndOfTimeStep` and result processing.

Order flow:

- `Engine/TransactionHandlers/BrokerageTransactionHandler.cs` pre-checks every order. It rejects orders during warm-up, rounds quantity to the lot size and prices to the tick, checks shortability, invalidates zero quantities, checks buying power and asks the brokerage model `CanSubmitOrder`.
- `Brokerages/Backtesting/BacktestingBrokerage.cs` (`Scan`) simulates the broker:
  - It sorts orders pessimistically (stop legs first).
  - **An order placed during the current bar waits for the next bar, except market orders.**
  - It re-checks buying power, calls the security's fill model, then fills in the fee from the fee model if the fill model left it at zero.

Results:

- `Engine/Results/BacktestingResultHandler.cs` samples equity at a resample period: the backtest length divided by 4,000, with a 4-minute floor. It streams deltas about every 3 seconds and stores a full intermediate result about every 30 seconds.
- At the end it builds statistics through `StatisticsBuilder` and runs a post-run diagnostic analyzer (section 4).

## 3. Key mechanisms as implemented

### 3.1 Insight object and scoring

Source: `Common/Algorithm/Framework/Alphas/Insight.cs`.

An insight is one prediction about one symbol. Its fields:

- `Id` and an optional `GroupId`. `Group` assigns a shared id once and refuses to regroup.
- `SourceModel`, plus `GeneratedTimeUtc` and `CloseTimeUtc`.
- `Type` (price or volatility) and `Direction` (Up, Down or Flat).
- `Period`, and optional `Magnitude` (predicted percent change), `Confidence` and `Weight`.
- `ReferenceValue`, the value at creation, and `ReferenceValueFinal`, the value at scoring.
- `Score`, `EstimatedValue` (value in account currency) and `Tag`.

How the close time is computed:

- The period can be a time span, a resolution × bar count, an absolute close time or an expiry function. The close time is then **computed by stepping through exchange hours**, so a 5-day insight means 5 trading days, not 5 calendar days.
- A close time outside market hours moves to the next open.
- An "end of time" option creates an insight that never expires.

Expiry and cancellation:

- `IsExpired` is true strictly after the close time.
- `Expire` and `Cancel` are identical: both move the close time to just before now.

Storage:

- `Common/Algorithm/Framework/Alphas/InsightCollection.cs` keeps a per-symbol dictionary of open insights and a complete list of every insight ever added.
- `RemoveExpiredInsights` moves expired insights out of the open set but keeps them in the complete list.
- `GetNextExpiryTime` returns the earliest open close time. The portfolio model uses it to rebalance when an insight lapses.

Scoring:

- `Common/Algorithm/Framework/Alphas/InsightScore.cs` holds two scores, Direction and Magnitude. Both are clamped to 0 to 1 by `SetScore`, carry an update time, and freeze once `Finalize` is called.
- `Common/Algorithm/Framework/Alphas/Analysis/InsightManager.cs` extends the collection. `Step` calls a pluggable `IInsightScoreFunction`, defined in `Common/Algorithm/Framework/Alphas/IInsightScoreFunction.cs`.
- **No score function is set by default.** In the current code, scoring is opt-in and user-defined.
- The example `Algorithm.CSharp/InsightScoringRegressionAlgorithm.cs` scores every active insight on each step against the current price minus the reference value. It sets the final reference value and finalises the score when the insight expires.
- **Verified:** the framework provides the score slots and the time-stepping, but no opinion on what a good score is.

### 3.2 Portfolio construction

The base class is `Algorithm/Portfolio/PortfolioConstructionModel.cs`. `CreateTargets` works as follows:

1. **Rebalance gate (`IsRebalanceDue`).** It returns true when any of these holds:
   - the rebalancing function's time has arrived;
   - `RebalanceOnSecurityChanges` is on and the universe changed;
   - `RebalanceOnInsightChanges` is on and new insights arrived or the next insight expiry has passed.

   Both flags default to on. With no rebalancing function, every call rebalances.
2. **Insight selection (`GetTargetInsights`).** It keeps active insights and takes **the most recently generated insight per symbol**. It does not filter by source model.
3. **Sizing.** `DetermineTargetPercent`, implemented by each subclass, turns each insight into a target percent.
4. **Targets.** `PortfolioTarget.Percent` turns each percent into a quantity.
5. **Expiry exits.** Expired insights are removed. **Every symbol whose insights all expired gets a 0% target, which closes the position.** An expired view therefore exits automatically.

`OnSecuritiesChanged` also expires the insights of removed securities.

`Common/Algorithm/Framework/Portfolio/PortfolioTarget.cs`, method `Percent`, converts a percent into a quantity:

1. It rejects a percent above the configured maximum, or a non-zero percent below the minimum.
2. It rejects an unknown security or a zero price.
3. It scales the percent by (total value − free cash buffer) / total value.
4. It divides by leverage.
5. It asks the buying-power model for the maximum lots that fit, subject to a minimum order margin.
6. It multiplies by the lot size.

The result is returned as an absolute target, or as a delta when one is requested. Open orders are not considered here; execution handles them.

Each portfolio model's math:

| Model (file under `Algorithm.Framework/Portfolio/`) | Math as implemented |
|---|---|
| `EqualWeightingPortfolioConstructionModel.cs` | N = number of non-Flat insights that match the bias. Each gets direction × 1/N. Flat insights and insights against the bias get 0. Bias is Long, Short or LongShort. |
| `InsightWeightingPortfolioConstructionModel.cs` | Each insight gets direction × \|Weight\|. Insights without a weight are skipped. If the sum of \|weights\| exceeds 1, all targets are scaled by 1/sum. Otherwise they are left unscaled, and the rest stays in cash. |
| `ConfidenceWeightedPortfolioConstructionModel.cs` | Same as InsightWeighting, but uses `Confidence` as the weight. |
| `AccumulativeInsightPortfolioConstructionModel.cs` | Each active insight on a symbol adds or subtracts a fixed step (default 3%), from oldest to newest. A Flat insight moves the total one step toward 0. There is no cap on the portfolio total. |
| `MeanVarianceOptimizationPortfolioConstructionModel.cs` + `MinimumVariancePortfolioOptimizer.cs` | Minimise wᵀΣw subject to sum(w) = 1, an expected-return constraint w·μ = target (default 2%, enforced as an **equality** although the comment says ≥), and bounds set by the bias. Solved with the Goldfarb–Idnani quadratic solver (Accord.NET). The solver starts from equal weights and returns them if it fails. The weights are then rescaled so that the sum of \|w\| is 1. Two quirks: the returns window is warmed with price rate-of-change, but `ShouldCreateTargetForInsight` then **appends the insight's Magnitude to the same series** (`ReturnsSymbolData.cs`); and weights that conflict with the bias are zeroed afterwards. |
| `BlackLittermanOptimizationPortfolioConstructionModel.cs` | Prior Π uses equal weights (not market cap) and Σ annualised ×252, with risk aversion = (portfolio return − risk-free) / variance. **Views are formed per `SourceModel`:** each alpha model is one view. Q is the larger of the summed up-magnitudes and the summed down-magnitudes. Each P row is direction × magnitude / Q. Ω = diag(τ·PΣPᵀ), with τ defaulting to 0.05 (the class comment says 0.0025). The posterior uses the standard Black-Litterman gain formula. The posterior covariance is (Σ + M) × delta, which differs from the textbook. The default optimiser is `MaximumSharpeRatioPortfolioOptimizer`. |
| `MaximumSharpeRatioPortfolioOptimizer.cs` | Charnes–Cooper transform: minimise yᵀΣy subject to excess-return·y = 1 and bounds rewritten in y; then w = y / sum(y). It returns equal weights when the problem is infeasible, the solver fails, or sum(y) ≤ 0. |
| `RiskParityPortfolioConstructionModel.cs` + `RiskParityPortfolioOptimizer.cs` | Log-barrier risk budgeting (Spinu-style): minimise ½xᵀΣx − Σ bᵢ log xᵢ by Newton's method (tolerance 1e-11, at most 15,000 iterations), with an equal risk budget by default. The result is normalised to sum 1, then clamped to bounds. The model **ignores insight direction**: only which symbols are active matters. It rejects a Short bias. Defaults: 252 one-day returns. |
| `SectorWeighting`, `MeanReversion`, `AlphaStreams` | Listed in the directory but not read. |

### 3.3 Execution models

All execution models share these mechanics:

- Targets accumulate in a `PortfolioTargetCollection` across calls.
- Targets are processed in order of margin impact. Fulfilled targets are cleared after each pass, and unfilled ones stay for the next call.
- The remaining quantity comes from `Common/Orders/OrderSizing.cs`, `GetUnorderedQuantity`: the target minus *projected* holdings (holdings plus open orders), rounded to the lot size. `AdjustByLotSize` rounds toward zero, with a tiny tolerance for floating-point error.

| Model | Logic |
|---|---|
| `Algorithm/Execution/ImmediateExecutionModel.cs` | A market order for the remaining quantity, if it passes the minimum-order-margin check. |
| `Algorithm.Framework/Execution/VolumeWeightedAveragePriceExecutionModel.cs` | Each security has an intraday VWAP. It buys only when the bid is below VWAP and sells only when the ask is above it. Each order is capped at 1% of the current bar's volume (`OrderSizing.GetOrderSizeForPercentVolume`). |
| `Algorithm.Framework/Execution/StandardDeviationExecutionModel.cs` | Uses a 60-bar SMA and standard deviation at minute resolution. It buys only when the bid is below SMA − 2σ and sells only when the ask is above SMA + 2σ. Each order is capped at a **value** of 20,000 in account currency, not at a share of volume. |
| `Algorithm.Framework/Execution/SpreadExecutionModel.cs` | Trades only while the exchange is open and (ask − bid) / price ≤ 0.5%. The comment says daily data never satisfies "exchange open". |

### 3.4 Risk models

All risk models are under `Algorithm.Framework/Risk/`. When a model triggers, it first **cancels the symbol's insights**, so the portfolio model does not re-enter, and then emits a zero target.

| Model | Trigger as implemented |
|---|---|
| `MaximumDrawdownPercentPerSecurity.cs` | Unrealised P&L percent of a holding below −5% (default) → liquidate that symbol. |
| `MaximumUnrealizedProfitPercentPerSecurity.cs` | Unrealised profit above +5% (default) → liquidate, taking the profit. |
| `TrailingStopRiskManagementModel.cs` | Per symbol, tracks the high-water mark of holdings value for longs and the low-water mark for shorts, starting from the cost basis. A fall of more than 5% from the mark liquidates. State resets when the position closes or flips direction. |
| `MaximumDrawdownPercentPortfolio.cs` | Measures portfolio value against the start value, or against a high-water mark if `isTrailing` is set. A drop of more than 5% zeroes **only the symbols present in the incoming targets**, so nothing is emitted if there are no targets. After triggering, it **re-baselines** on the next call, although the doc comment says a restart is needed. |
| `MaximumSectorExposureRiskManagementModel.cs` | Groups holdings by industry code from fundamentals, using the new target quantity when there is one and the current holding otherwise. If a sector's gross value exceeds 20% (default) of portfolio value, every position in that sector is scaled down by the same factor. Relative weights within the sector are kept. |

### 3.5 Fill, fee, slippage and brokerage models

**Fills** (`Common/Orders/Fills/FillModel.cs`, `EquityFillModel.cs`):

- **Market orders** fill at the ask for buys and the bid for sells, plus or minus slippage. The fill model chooses its data source from what the security subscribes to; the summaries of the two files disagree on how (see section 6).
- **Stale data:** if the last price is older than the stale tolerance, the order *waits* when the data is daily or hourly, or more than one bar old. Otherwise it fills with a warning.
- **Limit orders** need a bar that ends after the order time and must trade strictly through the limit. They fill at the limit, or at the open if the bar gapped through it. No slippage is applied.
- **Stop orders** fill at the open on a gap, otherwise at the stop, with slippage in the unfavourable direction.
- **Market-on-open** prefers the official opening print, then the first bar's open. The order must have been submitted before that bar; an order placed during the same session waits for the next day.
- **Market-on-close** uses the official closing print or the bar close.
- **No partial fills:** every fill is for the full quantity, and partial fills are left as TODOs.
- **Fees:** the base fill model creates fills with a zero fee, and the backtesting brokerage fills in the fee afterwards.

**Slippage** (`Common/Orders/Slippage/`):

- `VolumeShareSlippageModel.cs`: slippage fraction = 0.1 × (order quantity / bar volume)². The volume share is capped at 2.5%, so slippage is at most 0.0625%. Bar volume is the trade-bar volume, or the bid or ask size for quote bars. With no volume, equities take the maximum slippage.
- `MarketImpactSlippageModel.cs`: an Almgren-style model. It uses daily σ from 252 closes, average daily volume over 10 days, permanent and temporary impact terms with exponents 0.891 and 0.6, seeded Gaussian noise, a random fraction of the realised impact, and a floor at 0.
- `ConstantSlippageModel.cs` (listed, not read).

**Fees** (`Common/Orders/Fees/`):

- `ConstantFeeModel.cs`: a flat amount per order.
- `InteractiveBrokersFeeModel.cs`, US equities: 0.005 USD per share, minimum 1 USD, maximum 0.5% of trade value.
- `IndiaFeeModel.cs`: a **component model** in INR. Each component is rounded to the paisa:
  - brokerage = value × rate, capped per order;
  - STT on sells only;
  - exchange transaction charge;
  - "state tax" (GST) on brokerage plus the exchange charge;
  - SEBI charge;
  - stamp duty on buys only.
- `ZerodhaFeeModel.cs` sets the rates:

  | Component | Rate |
  |---|---|
  | Brokerage | 0.03% of value, capped at Rs 20 per order |
  | STT | 0.025% |
  | Exchange charge | 0.00345% |
  | Tax on brokerage and exchange charge | 18% |
  | SEBI charge | 0.0001% |
  | Stamp duty | 0.003% |

  These rates look like **intraday** equity rates (see section 6).
- `SamcoFeeModel` and `RBIFeeModel` also exist (not read).

**Brokerage model** (`Common/Brokerages/DefaultBrokerageModel.cs`) picks the defaults per security type:

- fill model, fee model (Interactive Brokers for equities);
- **slippage: none by default**;
- settlement: delayed settlement for equities in a cash account;
- leverage: 1× in a cash account, 2× for equities in a margin account;
- buying-power model;
- order-validity hooks.

`ApplySplit` rescales open orders by the split factor.

### 3.6 Universe selection and point-in-time data

`Common/Data/UniverseSelection/Universe.cs`:

- `SelectSymbols` returns the new member set, or the `Unchanged` sentinel to skip work.
- Each member records the time it was added. A member can be removed only after `MinimumTimeInUniverse`, rounded to a coarse interval to tolerate timing jitter in live trading.
- **Delisted securities cannot be added and can always be removed.**

`UniverseSettings.cs`:

- `DataNormalizationMode` defaults to `Adjusted`.
- It also holds the schedule, resolution, leverage, fill-forward and extended-hours settings.

Point-in-time fundamentals:

- `CoarseFundamental.cs` is now obsolete in favour of `Fundamental`.
- `CoarseFundamentalDataProvider.cs` shows how fundamentals are stored: one CSV **per trading date** (`equity/usa/fundamental/coarse/yyyyMMdd.csv`). Each row holds the security id, ticker, price, volume, dollar volume, price factor and split factor.
- A lookup reads the file for that date, or the previous trading day's file when that date has no file. Values are therefore "as known that day".
- **Not verified in code:** that each date's file includes companies later delisted. That claim comes from QuantConnect's documentation.

Example universe: `Algorithm.Framework/Selection/QC500UniverseSelectionModel.cs`.

1. **Coarse stage:** keep securities with fundamentals, price > 0 and volume > 0, then take the top 1,000 by dollar volume.
2. **Fine stage:** require a USA headquarters, a NYSE or NASDAQ listing, an IPO more than 180 days ago and a market cap above 500 million.
3. **Selection:** sector-proportional, keeping the 500 with the highest dollar volume.
4. **Cadence:** runs monthly and returns `Unchanged` otherwise.

Survivorship and renames:

- `Common/Data/Auxiliary/MapFile.cs` keeps one file per permanent security identity. The rows map dates to the ticker used on each date, and the last row is the **delisting date**.
- `GetMappedSymbol(date)` resolves renames, and `HasData` skips dates outside the listed life.
- Delisted companies keep their full history, which is how backtests stay free of survivorship bias.

### 3.7 Corporate actions

Factor files (`Common/Data/Auxiliary/CorporateFactorProvider.cs`):

- Each row holds a date, a price factor (dividends), a split factor and a reference raw close.
- Prices are normalised by mode:
  - `Raw`: no adjustment;
  - `SplitAdjusted` and `TotalReturn`: split factor;
  - `Adjusted` and `ScaledRaw`: price scale factor.
- Split and dividend events are *derived* from changes between consecutive rows.
- `Apply` adds new events and returns a new provider, leaving the original untouched.

On-the-fly adjustment (`Engine/DataFeeds/Enumerators/PriceScaleFactorEnumerator.cs`):

- Raw bars are stored, and the scale factor is applied as each bar is read.
- The factor is looked up by the bar's own date and refreshed daily.
- In live mode, an offset lets newly published factor files arrive.
- So the data is stored raw and adjusted when read.

Portfolio effects (`Common/Securities/SecurityPortfolioManager.cs`):

- **ApplyDividend:**
  - Live mode: does nothing, because the brokerage's cash sync handles it.
  - Raw or SplitAdjusted mode in a backtest: credits quantity × dividend to cash (a negative amount for shorts), then adjusts the price so the dividend is not counted twice.
  - Adjusted mode: credits no cash, because the dividend is already in the price series.
- **ApplySplit:**
  - Applies only to equities, in Raw mode or live mode.
  - Divides quantity by the factor and multiplies the average price by it.
  - **Truncates fractional shares and pays cash in lieu.**
- **Delisting:** `BrokerageTransactionHandler.HandleDelistingNotification` creates a market order for the whole position. It is tagged "Liquidate from delisting" and filled synthetically at the security's last price. `BacktestingBrokerage.ProcessDelistings` cancels open orders and removes the symbol from every universe.

## 4. Research ideas worth knowing

1. **Insight with exchange-hour expiry, with exit on lapse.** Every position is backed by a dated view. When the view lapses with no replacement, the base portfolio model zeroes the position.
   - Source: `Insight.cs`, `Algorithm/Portfolio/PortfolioConstructionModel.cs`.
2. **Separation of stages with a fixed precedence.** Risk overrides beat construction targets, and composite risk models chain, with the last model winning.
   - Source: `QCAlgorithm.Framework.cs`, `CompositeRiskManagementModel.cs`.
3. **Cancel the view when risk exits**, so construction does not immediately re-enter.
   - Source: all `Algorithm.Framework/Risk/*.cs`.
4. **Each alpha source is one Black-Litterman view.** Several models' opinions are blended with a covariance prior.
   - Source: `BlackLittermanOptimizationPortfolioConstructionModel.cs`.
5. **Proportional sector de-risking.** The whole sector is scaled down by one factor, which keeps the intra-sector ranking.
   - Source: `MaximumSectorExposureRiskManagementModel.cs`.
6. **Slippage that grows quadratically with participation, and a volume cap in execution.**
   - Source: `VolumeShareSlippageModel.cs`, `OrderSizing.cs`, `VolumeWeightedAveragePriceExecutionModel.cs`.
7. **Look-ahead discipline in fills:**
   - non-market orders need a bar that ends after the order time;
   - a market-on-open order must predate the bar;
   - stale prices make the order wait.
   - Source: `FillModel.cs`, `EquityFillModel.cs`, `BacktestingBrokerage.cs`.
8. **Store raw data and adjust when read**, with explicit normalisation modes. Fills and splits use raw prices; signals can use adjusted or total-return prices.
   - Source: `CorporateFactorProvider.cs`, `PriceScaleFactorEnumerator.cs`, `SecurityPortfolioManager.cs`.
9. **Permanent identity plus a dated ticker map, a delisting date and per-date universe files**, which together remove survivorship bias.
   - Source: `MapFile.cs`, `CoarseFundamentalDataProvider.cs`, `Universe.cs`.
10. **A component Indian fee model**, asymmetric by side.
    - Source: `IndiaFeeModel.cs`, `ZerodhaFeeModel.cs`.
11. **An automatic results analyzer.** About 30 weighted diagnostic checks each return a finding plus suggested fixes, capped at 10 and ranked by weight. An in-run mode mutes a finding after three repeats.
    - Source: `Engine/Results/Analysis/ResultsAnalyzer.cs`. Checks read:
    - `StatisticalSignificanceOfDailyReturnsAnalysis.cs`: a one-sided t-test that the mean daily excess return over the benchmark is above 0, at p ≤ 0.05.
    - `CrisisEventsAnalysis.cs`: 17 named stress windows. A window is flagged if the strategy's Sharpe is below the benchmark's within it.
    - `ParameterCountAnalysis.cs`: flags more than 10 numeric parameters as an overfitting risk, with explicit rules for what counts as a parameter.
    - `MonteCarloPercentileAnalysis.cs`: a 20-day block bootstrap of daily returns, flagged if the backtest beats about 90% of paths. As coded it uses 5 paths and integer division, so it is weak.
12. **Probabilistic Sharpe Ratio.** The probability that the true Sharpe exceeds a benchmark Sharpe of 1 per year. The statistics also include parametric VaR, tracking error, information ratio and Treynor ratio.
    - Source: `Common/Statistics/PortfolioStatistics.cs`.
13. **A capacity estimate** sampled during the backtest.
    - Source: `BacktestingResultHandler.cs`. The estimator file was not found at the guessed path.

## 5. Comparison with our system

### 5.1 Equivalents

| Lean | Ours |
|---|---|
| Insight (direction, period, confidence, magnitude, weight, source model) | Trade proposal in `backend/src/trade-signals.ts`: action, horizon days, conviction, probability %, target weight %, thesis, invalidation, evidence, model, prompt version and release. Ours is richer on accountability (evidence, release, challenger) and poorer on magnitude, because a bot states no expected move. |
| Portfolio construction (`DetermineTargetPercent`) | Deterministic `review()`: size = the binding room among order limit, bot budget, available capital and exposure, × a conviction factor (1, 0.5 or 0.25), capped by target weight. Our sizing is limit-driven; Lean's is weight-driven. |
| Insight scoring (opt-in, 0..1 direction and magnitude) | `scoreCall` (a cost-adjusted binary right or wrong) + Brier score + `trackRecord` by conviction + `challengerRecord`, recorded by an **independent evaluator from verified evidence**. Ours is stronger than Lean's, which ships no default scorer. |
| Execution (Immediate; VWAP with a 1% volume cap) | `integrations/trading-desk/eod_trader.py`: fill at the next verified open, capped at 1% of session volume, as a partial fill. This is close to Lean's market-on-open and VWAP volume cap. |
| Fill look-ahead rules | Fill price evidence must be observed after the review, and the outcome must be observed after the horizon (`trade-signals.ts`). This is equivalent in spirit. |
| Fee and slippage models | `backend/src/paper.ts`: flat `PAPER_FEE_BPS` and `PAPER_SLIPPAGE_BPS`. Research uses a flat `ONE_WAY_COST_PCT = 0.15` in `rnd_scout.py`. |
| Split and dividend handling | `backend/src/corporate-actions.ts`: owner-recorded split, bonus and dividend from verified evidence. Positions are rescaled once and `restated()` adjusts reference prices for scoring (total return). Fractional entitlements are **refused**; Lean pays cash in lieu instead. |
| Statistics | `backend/src/paper-performance.ts` (return, max drawdown, volatility, Sharpe with risk-free 0, 95% historical VaR, basket benchmark) and `research_checks.py` (CAGR, Sharpe, Sortino, Calmar, SQN, profit factor, block-bootstrap Sharpe test, random-picker baseline, walk-forward, months to prove, after-tax CAGR). Our research statistics are already broader than Lean's analyzer. |
| Optimizers (MV, BL, MaxSharpe, RiskParity) | `integrations/skfolio` and `quant_advisor.py` (HRP, long-only, at most 25% per share; advisory only). |
| Universe | `datasets.NIFTY50`, with an explicit survivorship warning (`datasets.py`, `rnd_scout.py`). |

### 5.2 Gaps (verified in our code)

1. **Nothing closes a position when its view lapses.** In `trade-signals.ts`, an expired *unexecuted* proposal lapses, but a *held* position stays open until some bot proposes an `exit`. The rule bot (`rule_bot.py`) does emit exits monthly, but nothing enforces this for other bots. In Lean, an expired insight zeroes the position automatically.
2. **No risk-management stage after sizing.**
   - There is no per-position stop, trailing stop or take-profit.
   - The portfolio loss limit `tradingLoss() >= maxLoss` counts **realised** loss only, so a large unrealised drawdown does not block new longs.
   - `risk_monitor.py` watches the *basket's* drawdown, not ours.
3. **No sector or group concentration limit.** We limit only total exposure, budget and per-symbol target weight.
4. **Costs are flat basis points on both sides.** Indian costs are asymmetric (STT, stamp duty on buys, GST on brokerage) and partly fixed per order, so a flat rate misprices small orders.
5. **Slippage does not depend on order size.** A fill of 0.9% of volume costs the same as one of 0.01%. We have only the 1% cap.
6. **No point-in-time universe, ticker map or delisting handling.**
   - The research universe uses today's NIFTY 50 members.
   - There is no symbol-rename map.
   - Nothing handles a suspended or delisted holding: no automatic liquidation, no cancelling of reservations, no removal from a bot's universe.
7. **Research data is stored only as adjusted prices.** `daily.py` downloads `auto_adjust=True` and notes that history shifts after new dividends. Lean stores raw prices plus factors and derives adjusted prices on read. Fills and P&L use raw prices; signals use adjusted ones.
8. **No crisis-window test and no overfitting-parameter flag** in `research_checks.py` or the release gate.
9. **No Probabilistic Sharpe Ratio** in `paper-performance.ts`, which uses a Sharpe with risk-free 0 and needs 20 days or more.
10. **No magnitude in proposals.** We score only direction (beating costs). We cannot tell a bot that is right but expects 10% when the move is 1% from one that sizes well.
11. **No automated diagnostics list after a run.** Our checks exist but are not collected into one ranked list of findings with suggested fixes that agents can act on.

### 5.3 Ideas to adopt in our own design

Ranked by benefit for effort. All of them are deterministic and owner-approved, in keeping with our autonomy policy.

| # | Idea | Why / benefit | Effort |
|---|---|---|---|
| A | **Exit on lapse**: an evaluator job proposes an `exit` (or raises a "renew or exit" item) for any position whose latest accepted entry horizon has passed without a renewing call. The rule is stated as an owner standing policy. | Every rupee at risk has a live, scored thesis. The holding period matches the scoring horizon, so the scorecards measure what was actually held. | Small–medium: one query plus a proposal through the existing pipeline. |
| B | **Risk stage with precedence**, run after review and before execution and in each cycle:<br>• a per-position trailing stop, e.g. 8–10% from the high-water mark of holdings value, which also marks the bot's open call as cancelled so it is not re-entered the same day;<br>• a portfolio **mark-to-market** drawdown halt, using unrealised and realised P&L from the high-water mark, alongside today's realised-loss limit;<br>• **proportional sector scaling** of new buys when a sector exceeds X% (needs a static NSE industry map recorded as evidence). | Closes the largest safety gap: unrealised losses are invisible today. Lean's "cancel the view" detail stops the stop-then-rebuy loop. | Medium. The rules are pure functions; tests are straightforward. |
| C | **Component India fee model** in `paper.ts`: brokerage with a per-order cap, STT, exchange charge, SEBI charge, stamp duty on buys, GST on brokerage plus exchange charge, plus our own DP charge per sell. Rates live in config, are versioned and cite their source. **Use delivery rates, not Lean's Zerodha intraday rates.** | Realistic costs for Rs 5,000 orders, where fixed per-order charges dominate. The research `ONE_WAY_COST_PCT` can be derived from the same table. | Small. |
| D | **Size-dependent slippage**: keep the 1% volume cap, and add a term proportional to the square of (quantity / session volume) on top of the base bps, in both `eod_trader.py` and research. | Discourages illiquid names automatically, and honest costs scale as budgets grow. | Small. |
| E | **Research checks to add to `research_checks.py` and the release gate:**<br>• Probabilistic Sharpe Ratio against a stated benchmark Sharpe;<br>• **Indian crisis windows** (for example 2008, 2013 taper tantrum, 2016 demonetisation, 2020 COVID crash, 2022 rate rises), comparing rule and basket within each window;<br>• a **parameter count** per rule spec, flagged above a small number (our specs are already dicts, so counting is trivial). | Cheap, model-free guards against overfitting and fragility. They suit the R&D scout and the release gate. | Small each. |
| F | **Ranked findings report**: collect every check into one list of named findings, each with a weight and a suggested fix. Mute a finding after it repeats. | Fits the autonomy vision: agents read one prioritised list and act. The owner sees the same list. | Small–medium. |
| G | **Raw plus factor storage for research data**: keep raw daily bars plus a dated factor table from recorded corporate actions, and derive adjusted or total-return series on read. Fills and P&L stay on raw prices. | Removes the history shift after dividends. One source of truth with `corporate_actions` and `dividends` in the backend. | Medium. Needs raw data from the source plus our own recorded events. |
| H | **Point-in-time NIFTY 50 membership plus a symbol map**: a dated constituent table (additions and removals from NSE index notices, as evidence) and a ticker-rename table. Selection reads membership *as of* the decision date. | Turns the survivorship warning into a fix, which momentum and reversal results need before they are trusted. | Medium–high: mainly sourcing and verifying history. The code is simple. |
| I | **Delisting and suspension policy**: on a verified notice, cancel the symbol's reservations, exit at the last verified price, record that the exit was caused by delisting, and drop the symbol from bot universes. | A rare event with a large effect. Today it would need manual handling. | Small. |
| J | **Optional expected move in proposals**, plus a magnitude score alongside the Brier score. | Separates good direction from good size, and is a future input for view blending. | Small: schema, scoring and a report. |
| K | **Later, research only: Black-Litterman-style blending** with one view per bot, view confidence taken from the bot's Brier and accuracy record, and a covariance prior from skfolio. | A principled way to merge several bots' views into one book once many bots are live. | High. Wait until track records are long. |

### 5.4 Not worth adopting (now)

- **Margin, leverage, shorting and buying-power models.** We are a long-only cash paper account.
- **Intraday execution models** (VWAP, standard deviation, spread). They need minute data and live quotes. We trade end-of-day at the next open, and the 1% volume cap already gives the benefit that matters.
- **`MarketImpactSlippageModel`.** Its parameters are calibrated to US markets, it adds random noise, and our orders are tiny. Idea D gives most of the realism with none of the calibration risk.
- **Mean-variance and maximum-Sharpe from short sample windows.** These are well known to be unstable. Lean's version also has quirks: insight magnitudes are mixed into the returns window, and the return constraint is an equality. Our HRP advisor is the better default.
- **`AccumulativeInsightPortfolioConstructionModel`.** It has no portfolio-level cap, and our review already sizes against hard limits.
- **The capacity estimate.** It is irrelevant at Rs 5,000 per order. Revisit if budgets grow by 100×.
- **The Monte Carlo check in its current form.** Our `sharpe_test` (1,000 circular-block resamples of paired returns) is already stronger than Lean's.
- **Silent defaults.** Do not copy the pattern where `DefaultBrokerageModel` uses **zero slippage** and US fees. Every cost assumption should be explicit and sourced, as ours already are.

## 6. What could not be verified

- **The exact commit.** The fetch tool showed no commit hash or date for `master`.
- **The text of the files.** All files were read through a summarising fetch tool, so the content is a model's description, not the raw source. Constants and edge cases quoted above (5% risk defaults, 0.1 and 2.5% in volume-share slippage, τ = 0.05, Newton tolerance, Zerodha rates, 5 Monte Carlo paths with integer division) should be rechecked in the raw file before we rely on them.
- **The fill model's data source.** The summaries of `FillModel.cs` and `EquityFillModel.cs` describe how market orders choose their price source differently: by fixed priority versus most recent data.
- **Survivorship-bias-free universe files.** That the per-date universe files include later-delisted companies is a documentation claim; the code only shows the per-date file layout and map-file delisting dates.
- **Where insights are added to the InsightManager.** This was not found in `QCAlgorithm.Framework.cs`; it happens elsewhere, presumably in `QCAlgorithm`.
- **A default insight score function.** None was found. Older Lean versions had built-in scoring, which appears to have been removed. This comes from memory and the absence of a default in the code, not from a changelog.
- **Unfetched files.** The capacity estimator (`CapacityEstimate.cs` was not at the guessed path), `StatisticsBuilder.cs`, the `Fundamental` class, `SectorWeightingPortfolioConstructionModel`, `ConstantSlippageModel`, `ImmediateFillModel` and the live result handler were not read.
- **Whether `PriceScaleFactorEnumerator` in `Adjusted` mode uses factors known only later.** This is the usual backward adjustment, anchored to the latest factor file. The scaling formula lives in code that was not read.
- **Indian fee rates.** The statement that Zerodha's STT of 0.025% on sells is the *intraday* rate, and that delivery trades carry STT on both sides plus a DP charge on sells, is our own knowledge, not something Lean's code says. Confirm against current NSE and broker schedules before encoding.
