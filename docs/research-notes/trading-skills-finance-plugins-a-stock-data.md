# Research note: claude-trading-skills, financial-services-plugins, a-stock-data

Studied 2026-10-21. Everything below is written in our own words. No code or text was copied. Paths are given so a
reader can check the original. Each finding is marked **[file]** when it was read in a skill, script or reference
file, and **[README]** when only the README or a directory page says it.

How the files were read: GitHub tree pages and raw.githubusercontent.com files on branch `main`, through a fetch tool
that summarises each page. Numbers were pulled out by asking for exact values. Nothing was cloned, downloaded or
installed. In total, 56 files were read: 37 from repository 1, 16 from repository 2 and 3 from repository 3. The large
`SKILL.md` in repository 3 was read in four passes. Section 6 of each part lists the limits of this method.

Our files compared: `integrations/trading-desk/market_regime.py`, `rnd_ideas.py`, `research_checks.py`,
`reflections.py`, `debate.py`, `scenario_panel.py`, `live_knowledge.py`, `knowledge/methods.json`,
`knowledge/problems.json`, `backend/src/management.ts`, `backend/src/paper.ts` (with `config.ts`, `trade-signals.ts`
for `scoreCall`), `scripts/world-news.mjs`, `integrations/publisher-feeds/world-sources.json` and `feed-client.mjs`,
and `scripts/daily-digest.mjs`.

---

## Part 1: tradermonty/claude-trading-skills

### 1. What it is
- This is a set of about 74 Claude skills for discretionary and systematic US equity traders. Each skill is a
  `SKILL.md` with Python scripts and reference documents. Most market data comes from the FMP API (the free tier
  allows 250 calls a day). Some breadth data comes from CSV files published on the author's GitHub Pages.
- License: MIT (`LICENSE`). The README says the material is for education and research.
- Repository layout **[README/tree]**: `skills/<id>/` (`SKILL.md`, `scripts/`, `references/`), plus `agents/`,
  `workflows/`, `skillsets/`, `state/` (git-tracked trader state), `config/default.yaml` and `skills-index.yaml`.

### 2. Structure (files read)
| Area | Files read |
|---|---|
| Market regime | `skills/ibd-distribution-day-monitor/SKILL.md`; `skills/market-breadth-analyzer/SKILL.md`, `.../references/breadth_analysis_methodology.md`; `skills/market-top-detector/SKILL.md`, `.../scripts/scorer.py`, `.../scripts/calculators/distribution_day_calculator.py`, `.../references/distribution_day_guide.md`; `skills/ftd-detector/SKILL.md`, `.../references/ftd_methodology.md`; `skills/exposure-coach/SKILL.md`, `.../scripts/calculate_exposure.py`; `skills/macro-regime-detector/SKILL.md` |
| Screeners | `skills/vcp-screener/SKILL.md`, `.../references/vcp_methodology.md`, `.../references/scoring_system.md`; `skills/canslim-screener/SKILL.md`; `skills/pead-screener/SKILL.md`, `.../references/entry_exit_rules.md`; `skills/earnings-trade-analyzer/SKILL.md`, `.../references/scoring_methodology.md`; `skills/dividend-growth-pullback-screener/SKILL.md` |
| Risk and discipline | `skills/position-sizer/SKILL.md`; `skills/drawdown-circuit-breaker/SKILL.md`, `.../references/circuit_breaker_framework.md`; `skills/pre-trade-discipline-gate/SKILL.md` |
| Learning | `skills/signal-postmortem/SKILL.md`, `.../references/outcome-classification.md`; `skills/trader-memory-core/SKILL.md` |
| Research pipeline | `skills/backtest-expert/SKILL.md`; `skills/edge-candidate-agent/SKILL.md`; `skills/edge-concept-synthesizer/SKILL.md`; `skills/edge-strategy-designer/SKILL.md`; `skills/edge-strategy-reviewer/SKILL.md`, `.../references/overfitting_checklist.md`; `skills/edge-pipeline-orchestrator/SKILL.md` |
| Other | `skills/scenario-analyzer/SKILL.md`; `skills/data-quality-checker/SKILL.md` |

### 3. Key mechanisms as specified in the files

**Distribution days, two versions that differ slightly** [file]
- `ibd-distribution-day-monitor/SKILL.md`:
  - **Definition:** a close at least 0.2% below the prior close, on volume above the prior day's volume.
  - **Removal:** a day drops out after more than 25 sessions, or once the index rallies 5% above that day's close.
    The default measures the rally from the high reached after the distribution day; a close-based option exists.
  - **Counts:** d5, d15 and d25 count records aged 0 to N, so each window covers N+1 sessions.
  - **Risk levels:**
    - NORMAL: d25 ≤ 2.
    - CAUTION: d25 ≥ 3.
    - HIGH: d25 ≥ 5, or d15 ≥ 3, or d5 ≥ 2.
    - SEVERE: d25 ≥ 6, or d15 ≥ 4, or (index below its 21-day EMA or 50-day SMA and d25 ≥ 5).
  - **Combining QQQ and SPY:** any SEVERE makes the whole result SEVERE. A HIGH reading on either index makes it HIGH.
  - **Exposure policy for TQQQ (3x leveraged):** 100 / 75 / 50 / 25%, with trailing stops of base, 7%, 5% and 3%.
  - **Exposure policy for unlevered QQQ:** HIGH 75%, SEVERE 50%.
  - **Data rule:** missing volume is an audit warning, never a distribution day.
- `market-top-detector/scripts/calculators/distribution_day_calculator.py`:
  - **Window:** a fixed 25-session window, with no 5% rally removal.
  - **Stalling day:** volume up and a gain from 0% up to (but not including) 0.1%. It counts as 0.5.
  - **Effective count:** distribution days plus half the stalling days. The worse of the S&P 500 and NASDAQ is used.
  - **Points by effective count:** ≥6 = 100, 5 = 90, 4 = 75, 3 = 55, 2 = 30, 1 = 15, below 1 = 0.
  - **Clustering:** the score is multiplied by 1.15 (capped at 100) when the effective count is at least 2 and more
    than half of the events fall in the last 5 sessions.

**Market top detector** [file: `scorer.py`]
- **Six components:**
  - distribution days 25%;
  - leading-stock health 20% (growth ETFs);
  - defensive rotation 15%;
  - breadth divergence 15%;
  - index technicals 15%;
  - sentiment 10%.
- **Correlation discount:** if distribution days and defensive rotation both score 80 or more, defensive rotation is
  multiplied by 0.8.
- **Missing components:** their weights are spread over the components that are present.
- **Zones and risk budgets:**

  | Score | Zone | Risk budget |
  |---|---|---|
  | 0–20 | Green | 100% |
  | 21–40 | Yellow | 80–90% |
  | 41–60 | Orange | 60–75% |
  | 61–80 | Red | 40–55% |
  | 81–100 | Critical | 20–35% |

- **Data completeness label:** Complete (6 components), Partial (4–5) or Limited (3 or fewer).
- **Honesty rule:** the score is a heuristic, not a probability. The report says "no comparable episode" when any
  component is missing or the nearest past pattern is more than 15 points away (RMS).

**Market breadth analyzer** [file]
- **Weights:** level and trend 25%, 8MA/200MA crossover 20%, peak/trough cycle 20%, bearish signal 15%, historical
  percentile 10%, S&P 500 vs breadth divergence 10%.
- **8MA level bands:** above 0.70, 0.60, 0.50 and 0.40, below 0.40, and below 0.20 (crisis).
- **Divergence:** a 60-day score weighted 0.6 plus a 20-day score weighted 0.4.
- **Bearish-signal table:** 85, 50, 30 or 10, depending on whether the signal is off or on and the trend is up or
  down.
- **Missing components:** their weight is redistributed. If everything is missing, the score defaults to 50.
- **Score history:** the last 20 scores are kept and labelled improving, deteriorating or stable.
- **Zones:** 80+ Strong (90–100% exposure), 60–79 Healthy (75–90%), 40–59 Neutral (60–75%), 20–39 Weakening
  (40–60%), below 20 Critical (25–40%).

**Exposure coach** [file: `calculate_exposure.py`]
- **Eight inputs and weights:** regime 0.25, top risk 0.20, breadth 0.15, uptrend 0.15, institutional flow 0.10,
  sector 0.05, theme 0.05, FTD 0.05. Weights are renormalised over the inputs that are present.
- **Missing inputs:** each missing critical input (regime, top risk or breadth) takes 10 points off the composite.
  With no inputs at all, the composite is 50.
- **Regime baselines:** broadening 80, concentration 60, transitional 50, inflationary 40, contraction 20.
- **Top risk is inverted:** the score is 100 minus the top-detector score. If only a distribution-day count is given:
  ≤2 → 90, ≤4 → 65, ≤6 → 40, otherwise 15.
- **Ceiling from composite C** (piecewise):

  | Composite | Ceiling |
  |---|---|
  | C ≥ 80 | 90 + (C − 80), at most 100 |
  | 65–80 | 70 + 1.3 × (C − 65) |
  | 50–65 | 50 + 1.3 × (C − 50) |
  | 35–50 | 30 + 1.3 × (C − 35) |
  | 20–35 | 10 + 1.3 × (C − 20) |
  | below 20 | C / 2 |

- **Recommendation**, checked in order:
  - CASH_PRIORITY if the composite is below 30 or top risk is below 25;
  - REDUCE_ONLY if the composite is below 50, top risk is below 40, or two or more critical inputs are missing;
  - NEW_ENTRY_ALLOWED otherwise.
- **Confidence:** HIGH needs 6 or more inputs with no critical input missing.
- **Strict provenance mode** (`SKILL.md`): the run is refused before any report is written unless producers share a
  run id, the data is no more than 3 days old, and the retrieval time is not after the evaluation time.

**Follow-through day** [file: `ftd_methodology.md`]
- **Correction:** a swing low on closes, after a fall of 3% or more from a high within 40 sessions and at least 3 down
  days.
- **Day 1:** an up close, or a close in the top half of the day's range.
- **FTD window:** day 4 to day 10. Days 4–7 have a base score of 60; days 8–10 have 50.
- **FTD requirements:** a gain of at least 1.25% (1.5% recommended, 2% strong), on volume above the prior day's.
- **Quality points:**
  - gain: +15, +10 or +5;
  - volume above the 50-day average: +10;
  - both indices confirm: +15;
  - no distribution day in the 5 days after: +10;
  - a distribution day soon after: −5, −15 or −30.
- **Bands:** 80+ strong (75–100% exposure), 60–79 moderate, 40–59 weak, below 40 failed (0–25%).
- **Gap in the file:** the parts can add up to more than 100, and the file states no cap.

**Macro regime** [file: `macro-regime-detector/SKILL.md`]
- **Ratios and weights:** RSP/SPY 25%, 10y–2y spread 20%, HYG/LQD 15%, IWM/SPY 15%, SPY/TLT with correlation 15%,
  XLY/XLP 10%.
- **Regimes:** Concentration, Broadening, Contraction, Inflationary, Transitional.
- **Failure rule:** fails closed when no component has data. A missing report is never read as "no change".
- **Not in this file:** the thresholds.

**Trend template and VCP** [file: `vcp_methodology.md`, `scoring_system.md`]
- **Seven trend criteria**, of which 6 must pass (score ≥ 85; each criterion is worth 14.3 points):
  1. Price above the 150-day and 200-day averages.
  2. 150-day average above the 200-day.
  3. 200-day average rising for at least 22 sessions.
  4. Price above the 50-day average.
  5. Price at least 25% above the 52-week low.
  6. Price within 25% of the 52-week high.
  7. Relative strength above 70.
- **VCP pattern:**
  - first contraction 8–35% deep for large caps;
  - each later contraction at least 25% tighter than the one before (ratio ≤ 0.75);
  - at least 2 contractions;
  - pivot at the last contraction's high;
  - breakout on volume at least 1.5x the 50-day average;
  - stop 1–2% below the last low.
- **Volume dry-up ratio:** below 0.30 exceptional, up to 0.50 strong, up to 0.70 adequate.
- **Composite weights:** trend 25%, contraction 25%, volume 20%, pivot proximity 15%, RS 15%.
- **RS periods:** 40/20/20/20% over 3, 6, 9 and 12 months.
- **Rating caps:** an extended or overextended stock has its rating capped.

**Pullback screener** [file: `dividend-growth-pullback-screener/SKILL.md`]
- **Technical filter:** 14-day RSI ≤ 40. The file names no trend filter.
- **Fundamental filters:**
  - dividend yield ≥ 1.5%;
  - 3-year dividend growth ≥ 12% a year;
  - no dividend cut in 4 years;
  - payout below 80%;
  - debt/equity below 2;
  - market cap ≥ $2bn.
- **Score weights:** dividend growth 40%, quality 30%, RSI setup 20%, valuation 10%.

**Earnings, PEAD and CANSLIM** [file]
- **Earnings trade analyzer:** gap 25%, 20-day pre-earnings trend 30%, 20d/60d volume 20%, distance from the 200-day
  average 15%, distance from the 50-day 10%. Grades: A ≥ 85, B 70–84, C 55–69, D below 55.
- **PEAD:**
  - qualifies on a gap-up of at least 3%;
  - wait for a red weekly candle, then enter when a green weekly candle closes above its high;
  - stop below the red candle's low; target 2R; time stop 4 weeks; watch window 5 weeks;
  - risk 1–2% per trade, size at most 1% of 20-day dollar volume, at most 3–5 PEAD positions.
- **CANSLIM:**
  - weights: C 15, A 20, N 15, S 15, L 20, I 10, M 5;
  - relative strength = 0.4 × 3-month + 0.3 × 6-month + 0.3 × 12-month return relative to the index;
  - when M = 0 (bear market), do not buy.

**Position sizer** [file]
- **Fixed fractional:** 1% risk by default. Shares = equity × risk% ÷ (entry − stop), rounded down.
- **ATR stop:** 2.0x ATR.
- **Kelly:** half Kelly only.
- **Portfolio heat:** total open risk of 6–8% at most.
- **Limits:** the strictest of the per-position and per-sector caps wins, and the binding constraint is reported.

**Drawdown circuit breaker** [file: `circuit_breaker_framework.md`]
- **Basis:** realised P&L only.
- **Rules:**
  - daily loss of 2% of the account → HALTED until the next weekday;
  - 2 losing closed theses in a row → COOLDOWN for 24 hours;
  - week-to-date loss of 5% → HALTED until Monday;
  - month-to-date loss of 8% → HALTED until the next month.
- **Strictest wins:** when several rules fire, the strictest state applies.
- **Bad data:** duplicate or malformed state means PARTIAL and HALTED, which fails closed. An empty state means
  trading is allowed.
- **Advisory only:** the breaker blocks no broker order.

**Pre-trade discipline gate** [file]
- **Hard blocks (NO_GO):**
  - the entry is not in the written plan;
  - no stop was set in advance;
  - the size is outside the plan;
  - actual risk in dollars is above planned risk;
  - a loss within the revenge window;
  - the exposure coach says REDUCE_ONLY or CASH_PRIORITY;
  - the breaker says COOLDOWN or HALTED.
- **REVIEW_REQUIRED:** a missing or invalid risk number, or a missing regime or breaker file. Every decision is
  journalled as a JSONL line.

**Signal postmortem** [file: `outcome-classification.md`]
- **Neutral band:** a move under 0.5% is NEUTRAL and counts as neither right nor wrong.
- **False positives:** mild down to −2%, severe beyond that.
- **MISSED_OPPORTUNITY:** a signal that was not taken and moved 2% or more the predicted way.
- **REGIME_MISMATCH:** the regime at exit differs from the regime at the signal, and the loss is over 2%.
- **Regime labels:** RISK_ON (VIX below 20, breadth above 60%) and RISK_OFF (VIX above 25, breadth below 40%).
- **Horizons:** 5 days (threshold 0.5%, weight 60%) and 20 days (threshold 1.0%, weight 40%).
- **Confidence adjustments:** earnings inside the window −20%, gap above 3% −15%.
- **Weight changes:** feedback is generated only from 20 or more signals.

**Trader memory** [file]
- **Thesis states, forward only:** IDEA → ENTRY_READY → ACTIVE → PARTIALLY_CLOSED → CLOSED, or INVALIDATED.
- **Recorded:** realised P&L for each trim, MAE/MFE, the source skill and the screening grade.
- **Writes:** atomic.

**Backtest expert** [file]
- **Stress tests:** stop at 50–150% of the base, target at 80–120%, slippage at 1.5–2x, worst-case fills.
- **Walk-forward:** 3 years in-sample, 1 year out-of-sample. Out-of-sample below 50% of in-sample is a warning.
- **Trade counts:** 30 is the minimum, 100 or more is preferred, 200 or more is high confidence.
- **Decision order:** NOT_EVALUABLE (fewer than 30 trades) → REJECT → RISK_LIMIT_EXCEEDED → VALIDATION_REQUIRED
  (no slippage test, under 5 years, or "too good") → score.
- **Blocking gates:** expectancy of zero or less, or a drawdown of 50% or more.
- **Principle:** look for parameter plateaus, not peaks.

**Edge pipeline** [file]
- **Stages:** hints → concepts (deduplicated, overlap 0.75 by default) → drafts (core, conservative and research-probe
  variants; reward/risk floor 1.5) → reviewer.
- **Reviewer criteria C1–C8:** plausibility 20, overfitting 20, sample 15, regime 10, exits 10, concentration 10,
  execution 10, invalidation 5.
- **Verdict:**
  - a fail on C1 or C2 → REJECT;
  - score ≥ 70 with no fail → PASS;
  - score below 35 → REJECT;
  - otherwise → REVISE.
- **Revision loop:** at most 2 rounds. A draft that is still REVISE afterwards is downgraded to research_probe.
- **Overfitting checklist:**
  - 10 or more conditions is a warning, 12 or more is almost certainly overfit;
  - thresholds with decimals (for example 33.5) are flagged as curve-fit;
  - fewer than 10 opportunities a year is a red flag;
  - a stop above 15% is a red flag;
  - reward/risk below 1.5 is a red flag;
  - a design for a single regime is a red flag.
- **Export:** only 2 families can be exported (pivot breakout and gap-up continuation).

**Scenario analyzer** [file]
- **Scenarios:** base, bull and bear, with probabilities that add up to 100%, over 18 months in three phases.
- **Impacts:** first, second and third order, plus 3–5 winners and 3–5 losers.
- **Second opinion (mandatory):** a reviewer checks six things: missed sectors, probabilities, logic, bias,
  alternatives and timing.
- **Not done:** results are never scored.

**Data quality checker** [file]
- **Checks:** price scale by digit count, ticker notation, date-to-weekday match (an ERROR), allocation totals more than
  0.5% away from 100 (a WARNING), and bp vs % units.
- **Advisory:** the checker never blocks publication.

### 4. Research ideas worth knowing
- **Distribution-day clustering** (d5/d15 escalation, the 1.15 multiplier for recent clusters) and **stalling days at
  half weight**: `ibd-distribution-day-monitor`, `distribution_day_calculator.py`.
- **Follow-through day as the "re-entry" half of a regime model**: `ftd_methodology.md`. A distribution-day monitor
  only says when to step back; the FTD rules say when the market has turned.
- **Missing-input haircut and confidence caps**, with "default to lower exposure when inputs are incomplete":
  `calculate_exposure.py`.
- **Run-level provenance gate** (same run id, maximum age, fail closed): `exposure-coach/SKILL.md`.
- **Time-windowed realised-loss brakes plus a losing-streak cooldown**, which fail closed on bad state:
  `circuit_breaker_framework.md`.
- **Outcome taxonomy with a neutral band and missed opportunities**: `outcome-classification.md`.
- **Overfitting heuristics that can be checked mechanically** (decimal thresholds, condition count, opportunities a
  year): `overfitting_checklist.md`.
- **Parameter-plateau stress tests**: `backtest-expert/SKILL.md`.

### 5. Comparison with our system

**Equivalents**

| Their skill | Ours |
|---|---|
| ibd-distribution-day-monitor | `market_regime.py` (distribution days, risk, ceiling) |
| exposure-coach | `market_regime.py` ceiling (advice only) |
| trend template | `rnd_ideas.py` `trend-template` family |
| dividend-growth pullback | `rnd_ideas.py` `pullback` family |
| backtest-expert, edge-strategy-reviewer | `research_checks.py` + scout (Bonferroni, lookahead, warm-up, random baseline, walk-forward, block bootstrap, proof time, tax) |
| edge pipeline | `rnd_ideas.py` (bounded grammar, append-only ledger, 3 ideas a month) |
| signal-postmortem, trader-memory-core | `reflections.py` + `trade-signals.ts` outcome scoring |
| scenario-analyzer | `scenario_panel.py` (5 personas, quorum 3/5, scored after 5 sessions) and `debate.py` (bull and bear) |
| drawdown-circuit-breaker | `paper.ts` cumulative realised-loss limit and system halt; `management.ts` management-v1 per-bot rules |

**Where our implementation differs from their specification** (checked line by line)

1. **SEVERE threshold is one higher.**
   - Ours (`market_regime.py`, `LEVELS`): SEVERE at 7 or more distribution days; HIGH at 5–6.
   - Theirs: SEVERE at d25 ≥ 6.
2. **We have no cluster or trend escalation.**
   - Theirs: HIGH also fires on d5 ≥ 2 or d15 ≥ 3; SEVERE also fires on d15 ≥ 4, or on d25 ≥ 5 while the index is
     below its 21-day EMA or 50-day SMA.
   - Ours: only the 25-session total is used. A burst of 3 distribution days in a week stays CAUTION with us; theirs
     calls it HIGH.
3. **Our exposure table is their leveraged-ETF table.**
   - Ours: `CEILING` 100 / 75 / 50 / 25 matches their TQQQ (3x leveraged) policy exactly.
   - For an unlevered index (QQQ) their file gives HIGH 75% and SEVERE 50%. Our basket is unlevered large caps, so the
     QQQ row is the closer analogue.
   - We then take a further 25 points off below the 200-day average, and another 25 with 2 or fewer shares above their
     200-day average. Both cuts are our own design, not theirs. Our docstring should say this.
4. **Our "exposure coach" is not their exposure coach.**
   - Their exposure coach is an 8-input weighted composite, with a piecewise ceiling, a missing-input haircut, a
     confidence level and a three-state recommendation.
   - Ours is distribution-day risk with two deductions. The attributions in `market_regime.py` and in the
     `trend-filter` card in `knowledge/methods.json` overstate how much is adapted. Their exposure coach contains no
     200-day filter: the 21-day EMA / 50-day SMA test is in the distribution-day monitor, and the 50-day EMA test is in
     CANSLIM's M component.
5. **Volume test.**
   - Theirs: index volume above the previous day's.
   - Ours: the average of the eight shares' own volume ratios is above 1. A mean of ratios can be pushed over 1 by one
     share's spike. Summed volume, or better summed traded value, is closer to an index-volume test.
6. **Removal by rally.** Theirs measures from the high after the distribution day by default. Ours uses basket closes,
     which is their configurable close option. Ours is valid, but stricter than their default.
7. **Window length.**
   - The distribution-day monitor counts ages 0–25 (26 sessions).
   - The top-detector calculator and our code count 25 sessions.
   - Their two files disagree with each other; ours matches the calculator.
8. **We do not count stalling days.** The top-detector counts them at half weight.
9. **"Breadth" means something different.**
   - Theirs: a market-wide breadth index (8-day and 200-day averages of the share of S&P 500 stocks in uptrends),
     scored on six components.
   - Ours: a count of how many of our 8 shares are above their 50-day and 200-day averages. With 8 shares this is
     concentration, not market breadth, and it should be labelled that way.
10. **Trend template.**
    - Ours (`_trend_template`) needs all of: close above the 50-day; 50-day above the 200-day; 200-day above its own
      value 21 sessions ago; within `nearHighPct` of the 52-week high.
    - Their file needs 6 of 7 criteria, including the 150-day average, ≥ 25% above the 52-week low and RS > 70. None of
      those three are in ours.
    - Our "50 above 200" is not in their list as written; their list has "150 above 200" and "price above 50".
    - So our scout's negative result (−0.63%/month) tested a simplified cousin, not their specification.
11. **Pullback.**
    - Their screener is mainly a dividend-growth quality screen: fundamentals carry 80% of the score, RSI ≤ 40 only
      20%, and there is no trend filter.
    - Ours keeps only the RSI part, adds a 200-day trend filter that theirs does not have, and ranks by RSI alone.
    - The `pullback` method card's result (−0.95%/month) therefore says nothing about their method. The card should say
      "RSI pullback inspired by", not "via".
    - Separately, `rnd_ideas.rsi` is labelled Wilder's RSI but uses simple sums over the window, which is Cutler's
      variant. Their file does not say which smoothing they use. Our docstring should be corrected.
12. **How calls are scored.**
    - Ours (`trade-signals.ts` `scoreCall`): a long is right if it beats 30 bps; an exit is right on any fall at all;
      "stand aside" is right if the move is at most 30 bps.
    - Theirs: moves inside ±0.5% are NEUTRAL and count as neither.
    - With us, a −0.05% day makes an exit "right". That is noise that feeds the live fitness test and the lessons.

**Gaps** (things they have that we do not)
- **No time-windowed loss brakes and no losing-streak cooldown.**
  - `paper.ts` has a cumulative realised-loss limit (`MAX_REALISED_LOSS_PAISE`) and a manual halt.
  - `management.ts` reviews each bot daily (suspend at −15% of budget, watch at −8% or at a 20% drawdown), but only as
    a recommendation.
  - Their daily 2% / weekly 5% / monthly 8% halts and the 2-loss, 24-hour cooldown have no counterpart. The
    `protections` method card calls this "covered", which overstates it.
- **The regime is not wired into review.** No backend file refers to the regime (searched `backend/src`). Their gate
  turns REDUCE_ONLY or CASH_PRIORITY into a hard block on new entries.
- **No re-entry signal.** We have no follow-through-day or "all clear" logic, so the regime only ever says "be
  careful".
- **No freshness or completeness gate on regime files.** `live_knowledge.py`, `debate.py`, `scenario_panel.py` and
  `daily-digest.mjs` read `regime/latest.json` without checking its age or whether its inputs were complete. Their
  exposure coach refuses inputs older than 3 days and caps confidence when inputs are missing.
- **No missed-opportunity scoring for proposals that were declined or lapsed.** We already store both kinds, so this
  is cheap to add.
- **No regime-at-signal vs regime-at-exit tagging** on scored calls.
- **No MAE/MFE per closed position.**
- **No plateau test.** `explore()` makes neighbouring variants, but each one becomes a new idea that raises the
  Bonferroni bar. Nothing reports whether a passing idea's neighbours also do well.
- **No 2x-slippage stress, and no "positive in most years" check**, in `research_checks.py`.

**Ideas to adopt in our own design**

| Idea | Why / benefit | Effort |
|---|---|---|
| Add d5/d15 escalation, use SEVERE at 6, use summed traded value for volume, add stalling days at 0.5, all as a new `regime-v2` with the old rules kept for comparison | Brings us in line with the method we cite. Clusters are what their spec treats as most urgent. Re-run `study` for both versions and keep the better-evidenced one. | S (one file, plus a re-study) |
| Switch the ceiling table to the unlevered row (100/100/75/50 or similar) and document our own −25 cuts as ours | Our basket is not 3x leveraged, so the current table halves exposure at HIGH for no stated reason. Advice-only today, so low risk. | S |
| Add `freshness` and `inputsComplete` fields to `regime/latest.json`; readers mark the regime "stale" past 3 sessions | Stops agents briefing on an old regime. It is the same idea as their provenance gate. | S |
| Score calls with a neutral band (for example ±50 bps, or the cost of 30 bps either way) | Exit and stand-aside calls stop being judged "right" on noise. Makes the live fitness p-values honest. Changes `scoreCall`, so it needs a new scoring version and owner sign-off. | M |
| Score the missed opportunities of declined and lapsed proposals (same horizon, same basket alpha) | Shows whether the review and debate desk reject good calls. This tests the reviewers, not the bots. | M |
| Time-windowed realised-loss brakes per bot (daily, weekly, monthly) and a 2-loss cooldown, as **pauses** that end automatically; changing a limit stays with the owner | Fits our rule "prefer a brake that pauses a bot". Fails closed on bad state. | M (backend plus migration) |
| Turn the regime into a review input: at CAUTION, flag proposals; at HIGH or SEVERE, size new longs down (not block) until a scout result justifies more | Makes the regime operational without claiming an edge it has not proven. Owner decision because it affects sizing. | M |
| Follow-through-day re-entry as an R&D filter (`ftd`), tested by the scout like any filter | Our study shows the distribution-day filter costs return because it stays in cash too long. FTD is the standard counterpart for getting back in. | M |
| Plateau report: for a passing idea, show its neighbours' results (diagnostic only, never a way to pass) | Separates a robust idea from a lucky peak without loosening the Bonferroni bar. | S |
| Slippage-2x and positive-in-most-years rows in `research_checks.stats` | Cheap robustness evidence. | S |
| Digest self-check, like their data-quality checker (date/weekday, percentages that should add to 100, paise vs rupees) | The owner digest is our "publication". It catches embarrassing errors. | S |

**Not worth adopting (now)**
- **VCP, CANSLIM, PEAD, earnings-trade scoring.** These need daily breakout execution, fundamentals or a wide
  universe. We hold 8 large caps on a monthly cycle, and our trend-template result already argues against
  breakout-style selection here.
- **Macro regime on US ETF ratios.** The idea transfers (equal-weight vs cap-weight NIFTY, midcap vs large cap, the
  G-sec curve), but it needs new approved data sources. Revisit after we have more data feeds.
- **Kelly sizing.** Our live records are far too short to estimate win rate and payoff reliably.
- **Unscored 18-month scenario reports.** Our scored panel is the stronger design. Keep only the first, second and
  third-order structure and the mandatory critic step as prompt ideas.

### 6. What could not be verified
- Everything in this part was read through a summarising fetch tool, not byte by byte. Exact numbers came from asking
  for them explicitly. A few should be rechecked before we code against them: the FTD point table can exceed 100, the
  CANSLIM holder-only rules conflict inside their own file, and the outcome-classification thresholds conflict with
  each other (the file itself notes this).
- The internals of the exposure-coach `regime_exposure_map.md`, the market-top-detector calculators other than the
  distribution-day one, the uptrend analyzer and the theme detector were not read.
- The README's claims about the skill count (74) and the folder names come from the README or tree page. Only the
  skills listed above were opened.

---

## Part 2: anthropics/financial-services-plugins

### 1. What it is
- These are Anthropic's reference plugins for financial-services work: skills, slash commands, named agents, and
  Managed-Agent "cookbooks" for deployment through the API.
- License: Apache-2.0 (`LICENSE`).
- Note: the GitHub page shows the repository as `anthropics/financial-services`, so it may have been renamed. The raw
  URLs under `financial-services-plugins/main` worked.

### 2. Structure (files read)
- **Equity-research skills:**
  - `plugins/vertical-plugins/equity-research/skills/morning-note/SKILL.md`
  - `.../thesis-tracker/SKILL.md`
  - `.../catalyst-calendar/SKILL.md`
  - `.../idea-generation/SKILL.md`
  - `.../earnings-analysis/SKILL.md`
  - `.../earnings-preview/SKILL.md`
  - `.../sector-overview/SKILL.md`
- **Agent templates:**
  - `plugins/agent-plugins/market-researcher/agents/market-researcher.md`
  - `plugins/agent-plugins/earnings-reviewer/agents/earnings-reviewer.md`
- **Managed-agent cookbooks:**
  - `managed-agent-cookbooks/earnings-reviewer/agent.yaml`
  - `.../README.md`
  - `.../steering-examples.json`
  - `.../subagents/transcript-reader.yaml`
  - `.../subagents/note-writer.yaml`
  - `managed-agent-cookbooks/market-researcher/agent.yaml`
- **Orchestration:** `scripts/orchestrate.py` (the reference loop that routes handoffs).

### 3. Key mechanisms as specified in the files

**Prompt structure** [file]
- **Shape:** each agent file has frontmatter (name, a description of its scope that says which other agent takes
  out-of-scope work, and a tools list), then a role, the deliverables, numbered steps that each call a named skill,
  and guardrails.

**Guardrails** (the same three in both agents) [file]
1. Third-party reports, transcripts and press releases are untrusted data. Instructions found in them are never
   followed.
2. Every number must trace to a named data source or filing. Anything else is marked `[UNSOURCED]`, never estimated.
3. The agent never publishes. Market Researcher stops twice for analyst review (after the comps spread and after the
   draft). Earnings Reviewer stages its outputs as drafts for senior sign-off.

**Isolation in the earnings-reviewer cookbook** [file: README, agent.yaml, subagents]
- **Three tiers:**

  | Tier | Sees untrusted documents | Tools | Connectors |
  |---|---|---|---|
  | `transcript-reader` | Yes | read and grep only | none |
  | Orchestrator | No | read, grep, glob, agent | read-only data connectors |
  | `note-writer` | No (forbidden to open transcripts) | read, write, edit (the only writer) | none |

- **Reader output schema:** strict JSON with no extra fields. The ticker is at most 12 characters from A–Z and dot.
  The period is at most 16 characters. There are at most 50 guidance notes of at most 256 characters each, from a
  restricted character set. Free text is not allowed.
- **Built-in tools:** off by default and turned on one by one.

**Handoffs** [file: `scripts/orchestrate.py`]
- **Allowlist:** the target agent must be one of 10 named agents.
- **Payload schema:** an `event` string of at most 2,000 characters and an optional reference of at most 256
  characters.
- **Weaknesses the file itself states:** the handoff is parsed out of model text, which untrusted documents can
  influence. A typed tool call is recommended instead.
- **Missing, by inspection:** a depth limit, cycle detection, logging and human approval. The file is labelled a
  reference loop, not production.

**Steering examples** [file]
- Three examples set the scope: one ticker; a fan-out where the orchestration layer loops, not the agent; and a
  partial run that updates the model and skips the note.

**Skills** [file]
- **morning-note:** opinionated, with the most important item first. Readable in 2 minutes, 1 page at most. "No
  news" is a valid note. Takes are time-stamped. Prior mistakes are corrected openly in the next note.
- **thesis-tracker:**
  - a falsifiable thesis with 3–5 pillars, 3–5 risks, catalysts, a target and a stop-loss trigger;
  - an update log that marks each pillar strengthened, weakened or neutral, with an action and a conviction;
  - a pillar scorecard;
  - a review at least quarterly;
  - disconfirming evidence tracked as carefully as confirming evidence.
- **catalyst-calendar:**
  - four categories: earnings, corporate, industry, macro;
  - each catalyst rated H/M/L for impact, with our positioning;
  - dates verified from primary sources;
  - past catalysts archived with their actual outcomes;
  - risk reviewed before binary events.
- **earnings-preview:** bull, base and bear cases with the expected stock reaction, 3–5 checklist items, and the
  options-implied move compared with the scenarios.
- **earnings-analysis:**
  - data dates are checked (the release must be within the last 3 months, and the transcript date must match);
  - every figure is cited with document and date;
  - published within 24–48 hours, at 8–12 pages.
- **idea-generation:**
  - screens give candidates, not conclusions;
  - crowding is checked;
  - a contrarian idea needs a catalyst;
  - hit rates are tracked by screen.
- **sector-overview:** cite the method behind any market size, separate hype from the realistic addressable market,
  and date the report with a flag on stale data.

### 4. Research ideas worth knowing
- **Least privilege by role.** Only one sandboxed reader touches untrusted text. It returns a narrow, length-capped,
  character-restricted schema. Only one leaf agent can write.
- **`[UNSOURCED]` marker.** Make missing provenance visible instead of silently estimating.
- **Corrections section.** Yesterday's wrong calls are named in today's note.
- **Thesis pillars and kill criteria** as a living, reviewable object.
- **Allowlisted, schema-checked handoffs.** Their reference script also shows what is still missing: depth limits and
  an audit trail.

### 5. Comparison with our system

**Equivalents**
- **Untrusted data in prompts:** `debate.py` and `scenario_panel.py` system prompts say that proposals and headlines
  are data, never instructions. Their outputs are bound to a schema.
- **Citations:** the debate desk may cite only the proposal's own verified evidence ids, and the backend checks this
  again. That is stronger than a text marker.
- **Human approval:** the owner agenda (`management.ts`): nothing applies without the owner accepting it.
- **Owner reporting:** `daily-digest.mjs` is our morning note.

**Differences**
- **Headlines go straight into agent prompts.** Ours pass raw headline text (truncated, for example to 240
  characters) into the prompts of agents that then act (post challenges, make calls). Theirs puts a reader in between
  and enforces a character pattern and length caps, so an injected instruction cannot travel onward as free text.
- **Our handoffs are simpler and safer.** Steps run in a fixed cycle; there is no free-form agent-to-agent routing.
  Their reference loop has no depth limit and no audit log.

**Gaps**
- No catalyst calendar: earnings dates of the 8 shares, RBI policy meetings, the Union Budget, FOMC, index rebalances.
- No living thesis per open position (pillars, kill criteria, review date). Proposals carry a thesis and an
  invalidation note, but these are frozen at creation.
- The digest has no "corrections" section and no single "top item" at its head.

**Ideas to adopt**

| Idea | Why / benefit | Effort |
|---|---|---|
| A "headline reader" step that turns stories into a strict schema (symbols from our universe, a driver from our list, title with a restricted character set and length cap) before debate or the scenario panel sees them | Closes the remaining injection path. Least privilege, as in their cookbook. | M |
| A catalyst file (`knowledge/catalysts.json` or a backend table): date, type, share, H/M/L impact, source, then the outcome once it has happened; read by debate, reflections and postmortem | Gives agents known event risk. Lets postmortem down-weight calls that had earnings inside their window (their postmortem uses −20%). | M |
| Digest: a "Top item" first line, a "Corrections" block (yesterday's calls that were scored wrong), and a time-stamp | Better owner reading in 2 minutes. Makes errors visible. | S |
| A position thesis object for open paper positions (pillars, kill criterion, next review date) and a review step | Turns invalidation into something checked continuously. | M–L |
| If we ever add agent-to-agent handoffs: an allowlist, a schema, a depth limit, cycle detection and an audit row for each handoff | Their reference loop shows these are easy to forget. | S (design rule now) |

**Not worth adopting**
- DOCX/XLSX report production, page and chart quotas, and sell-side formats such as initiations or comps spreads.
  These do not fit an 8-share paper desk.
- Paid data connectors (FactSet, CapIQ, Daloopa).

### 6. What could not be verified
- `model-updater.yaml` and the market-researcher subagents (`sector-reader`, `comps-spreader`, `note-writer`) were not
  opened.
- The skills' reference files (`workflow.md`, `report-structure.md`) were not read.
- Whether the repository was renamed is a README/page observation only.
- The weaknesses listed for `orchestrate.py` come from reading its logic through the summary. In particular, its
  pattern match may cut off nested JSON; this was not run.

---

## Part 3: simonlin1212/a-stock-data

### 1. What it is
- A single, very large `SKILL.md` (v3.10.2, dated 2026-10-11, about 330k characters) that teaches an agent to fetch
  China A-share data from 34 free sources: 87 endpoints, of which 5 are backups. It comes with offline and live tests
  and source-integration records.
- License: Apache-2.0.
- **[README/tree]** Layout: `SKILL.md`, `README.md`, `README_en.md`, `CHANGELOG.md`, `docs/`, `tests/`. There is no
  `scripts/` folder: the code lives in fenced blocks inside `SKILL.md`.

### 2. Structure (files read)
- `SKILL.md`, read in four passes covering the whole file.
- `docs/source-integration-v3.9.0.md`.
- `tests/test_v310_sources.py`.
- Tree listing of `tests/`: `test_official_data.py`, `test_v310_sources.py`, `test_v39_sources.py`,
  `test_valuation.py`.

### 3. Key mechanisms as specified in the files

**Routing** [file]
- **Source order, by blocking risk:**
  1. Tencent (quotes and K-lines; described as not blocking IPs).
  2. Official exchanges and agencies.
  3. Sina, Cninfo, 10jqka, Wallstreetcn.
  4. mootdx (only financials and F10 still work).
  5. Eastmoney, used only for data no one else has, because it does block IPs.
- **Backups:** every data type has a backup on a **different domain with a different risk profile**, so one block
  cannot take out both. Examples: dragon-tiger, fund-flow and announcement backups through the official exchanges or
  Sina.
- **Dead-source list:** sources known to be dead are listed explicitly, so no one tries them again.

**Fallback and throttling** [file]
- **Tencent K-line:** three hosts tried in order. A host that errors or returns empty is skipped for 120 seconds. When
  all three fail, an error is raised. A parameter error is raised at once, without rotating hosts.
- **Eastmoney (`em_get`):** strictly serial.
  - At least 1.0 s between calls. Only when a wait is needed, a random 0.1–0.5 s is added on top.
  - The gap is measured from the end of the previous request, failed ones included.
  - Retries: 3 with backoff factor 0.6 on 429 and 5xx. 403 is never retried. Retry-After is ignored.
  - Timeout 15 s; one shared keep-alive session.
- **Recorded incident:** about 45,000 requests in an hour brought an IP ban of more than 20 hours.
- **Playbook for a block:** stop for 30–60 minutes or change network, raise the minimum interval, and use the official
  backups.
- **Other limits:** Sina research waits at least 6 s between requests. Exchange pages sleep 0.2–0.3 s between pages.
  Per-endpoint timeouts run from 10 to 60 s.

**Data validation** [file]
- **Staleness:** a quote is stale when turnover is zero, the price equals the last close and the price is above zero.
  This flags suspended or dead codes.
- **Dates:** historical data must match the requested trade date, otherwise the call raises.
- **Rows and totals:** row counts must equal the source's stated total. Index weights must add up to 99–101.
- **Duplicates:** duplicate keys raise.
- **Cross-source checks** (in `docs/source-integration-v3.9.0.md`):
  - closes matched between the exchange daily package and Tencent on several dates;
  - per-market row floors set at 10,000, 3,000 and 50;
  - volume compared within 99 shares in the live tests.
- **Error convention:** bad input raises ValueError; a changed structure raises RuntimeError. The file itself admits
  that the functions which return empty with a warning cannot tell "no data" from "request failed".
- **Ticker normalisation:** inputs are normalised strictly and raise rather than guess.
- **Units:** the file warns about unit traps (yuan vs 10,000 yuan; a weight of 0.433 means 0.433%).

**Caching** [file]
- Northbound flow history goes to a local CSV (`date, hgt, sgt`), so history builds up from live calls.
- The orgId and UID maps are kept in memory.
- A PDF that already exists is not downloaded again.
- There is no general TTL cache.

**News, announcements and flows** [file]
- **News:**
  - Eastmoney stock news: title, content cut to 200 characters, time, source, url;
  - CLS telegraph: signed requests, no key;
  - Wallstreetcn 7×24, with cursor pages and an importance field;
  - CCTV evening news (marked as not to be quoted).
- **Announcements:** Cninfo: title, type, date, url, and PDF download.
- **Fund flow:** by minute and by day, in main, super-large, large, mid and small order tiers.
- **Board flows:** over 1, 5 and 10 days.
- **Dragon-tiger:** records plus the top 5 buy and sell seats.
- **Limit-up pools:** from two sources.

**Testing practice** [file]
- **Offline:** mocked HTTP with `sleep` patched. The tests assert that bad input fails *before* any network call.
- **Live:** live tests run only when an environment variable is set.
- **Integration record:** 115 cases, 114 offline and 1 live. Mutation testing reverted 209 fixes one at a time.
- **Rule for new sources:** zero registration (only one historical exception needs a key).

### 4. Research ideas worth knowing
- **Rank sources by how likely they are to block you**, and put each backup on a different domain.
- **Per-host cooldown** after an empty or error answer, rather than giving up on the whole source.
- **A serial throttle measured from the end of the last request, with jitter**, plus a written incident log ("what
  got us banned").
- **Strict stale-quote and date-match checks** that raise instead of returning plausible garbage.
- **Cross-checking one source against another** before trusting a new source.
- **Gated live tests and a mutation test of the fixes.**

### 5. Comparison with our system

**Equivalents**
- **Feed client** (`integrations/publisher-feeds/feed-client.mjs`): honours Retry-After on 429 and 503, sends
  conditional requests with ETag and If-Modified-Since, and backs off by itself.
- **Catalogue** (`world-sources.json`): every entry is validated by `loadCatalogue` (unique id, HTTPS, an existing
  backup). The `backup` field points to another entry.
- **Coverage** (`world-news.mjs coverage`): marks a feed "stale" after 3 days and names its backup.
- **Market-data steward** (`problems.json`): refuses moves over 20%, history rewrites and shorter histories, and keeps
  the last accepted day.

**Differences**
- **Backups are manual with us.** The owner must enable a backup source (`decidedBy: owner` in `problems.json`
  `feed-failing`). Theirs fall back in code. Ours is deliberate: approving a source is an owner decision. So the
  realistic improvement is to **pre-approve** backups, not to fall back to unapproved ones automatically.
- **Prices have no backup.** Market data has one source (Yahoo): `market-data-network` says the step retries and
  prices stay at the last accepted day. They never rely on one price source.
- **No cross-source check.** We have no check of prices against a second source, and no stale-bar check (zero volume
  with an unchanged close). Yahoo can repeat a bar on holidays or for suspended shares.

**Ideas to adopt**

| Idea | Why / benefit | Effort |
|---|---|---|
| A second, official end-of-day price source for the 8 shares (for example the NSE bhavcopy), used first as a **cross-check** (close and volume must agree within a tolerance) and later as a pre-approved backup | Removes our single point of failure. Catches bad Yahoo bars before they reach scoring. Needs the owner to approve the source. NSE also limits scrapers, so it needs a throttle like theirs. | M |
| A stale-bar rule in the steward: zero volume with close equal to the previous close is kept back and named | A cheap and clear data-quality gain. | S |
| A per-host cooldown and a serial minimum interval in `feed-client.mjs` for feeds served from the same host | Protects us from being blocked as the catalogue grows. Today we poll 60-minutely, so the risk is low. | S |
| A "dead sources" list and an "incidents" section in the problem playbook | Institutional memory of what failed and why, so the agents do not retry known-dead feeds. | S |
| Live probe tests gated by an environment variable, separate from the offline suite | Keeps CI offline while still letting us verify feeds on demand. This matches our office-laptop rule of running only what is needed. | S |

**Not worth adopting**
- The A-share endpoints themselves (Eastmoney, Tencent and so on). These are a different market.
- Folding all code into one 330k-character skill file. It is hard to review and to test in parts.
- Scraping order-book or "main force" fund-flow data. We have no comparable free NSE source, and its signal value is
  unproven.

### 6. What could not be verified
- `SKILL.md` was read through the summariser in four passes. Some sections were only partly visible: the iwencai
  section in pass one, and the Layer 12 code in pass four.
- `README.md`, `README_en.md`, `CHANGELOG.md`, `test_official_data.py`, `test_v39_sources.py` and
  `test_valuation.py` were not opened.
- The claim that Tencent "does not block" and the community rate-limit figures (5 requests/s, 200 a minute) are the
  author's reports, not tested by us.

---

## Summary of mismatches in our cited adaptations (for the method cards)
- `distribution-days`: SEVERE at 7 vs their 6; no d5/d15 escalation; no below-MA condition; no stalling days; volume
  is a mean of share ratios. The `study` result was measured on our variant.
- `trend-filter`: attributed to "exposure coach", but their exposure coach has no 200-day filter. It is a composite
  of 8 inputs.
- Exposure ceiling: uses their **leveraged** (TQQQ) table. The −25 cuts for trend and breadth are ours.
- `trend-template`: 4 of their 7 criteria, all required, vs 6 of 7 for them. The 150-day, 52-week-low and RS criteria
  are missing.
- `pullback`: their method is 80% dividend-growth fundamentals with no trend filter. Ours is RSI plus a 200-day filter.
  Our RSI is labelled "Wilder's" but uses simple averages.
- Call scoring: no neutral band, so exits are "right" on any fall at all.
