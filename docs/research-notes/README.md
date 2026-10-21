# Research notes on other people's trading systems, and our gap analysis (21 October 2026)

The owner asked us to understand the **source code** of every repository shared so far: what others have built, and how.
Nothing is copied. The aim is to document their ideas, find gaps in our organisation, and design better solutions of our
own where we can.

Seven research agents read the code on GitHub, read-only (nothing was cloned or installed), and compared it with ours.
Every note cites the files read and separates what was verified in code from what only the documentation claims. The
fetch tool returns a model-written digest of each file, not the raw text, so exact constants should be re-checked in the
source before we build on them. Each note says which.

## The notes

| Note | Repositories (licence) | Files read |
| --- | --- | --- |
| [tradingagents-and-finnewshunter.md](tradingagents-and-finnewshunter.md) | TradingAgents (Apache-2.0, `e8f5503`, the version our member pins), FinnewsHunter (Apache-2.0) | 24 + 24 |
| [freqtrade.md](freqtrade.md) | freqtrade (GPL-3.0) | 44 + 10 docs |
| [lean.md](lean.md) | QuantConnect Lean (Apache-2.0) | 62 |
| [nautilus-trader.md](nautilus-trader.md) | nautilus_trader (LGPL-3.0, v2, Rust core) | 18 + 14 docs |
| [backtesting-py-and-vectorbt.md](backtesting-py-and-vectorbt.md) | backtesting.py 0.6.6 (AGPL-3.0), vectorbt 1.2.0 (Apache-2.0 with Commons Clause) | 12+ each |
| [trading-skills-finance-plugins-a-stock-data.md](trading-skills-finance-plugins-a-stock-data.md) | claude-trading-skills (MIT), Anthropic financial-services-plugins (Apache-2.0), a-stock-data (Apache-2.0) | 37 + 16 + 3 |
| [mirofish-fincept-soup.md](mirofish-fincept-soup.md) | MiroFish (AGPL-3.0), FinceptTerminal (AGPL or paid commercial; business use needs the paid licence), Soup (Apache-2.0) | 17–30 each |

## 1. Defects the review found in our own code (fixed 21 Oct 2026)

| Defect | Found by | Fix |
| --- | --- | --- |
| The scout took each decision at a month's close and also bought at that same close | backtesting.py / vectorbt | Decisions trade at the next open and are held to the open after the next decision, as the paper engine fills |
| Turnover counted only changes in target weights, so rules with unchanged targets paid no rebalancing cost | backtesting.py / vectorbt | Turnover is measured against drifted holdings. A rule that rebalances every few months holds and drifts between decisions |
| The after-tax figure taxed the first purchase as a sale | backtesting.py / vectorbt | The first month's turnover is excluded |
| Proof time used a t-test, but the scout judges with a sign test | backtesting.py / vectorbt | Divided by the sign test's efficiency (2/π, about 1.57 times more months) |
| The risk-lens bootstrap was too coarse for a bar of 0.0025 | backtesting.py / vectorbt | 5,000 resamples; "would pass" only if p plus twice its Monte-Carlo error is under the bar |
| Method cards and docstrings overstated what we adapted (exposure coach, trend template, pullback, "protections covered"); RSI was mislabelled "Wilder's" | claude-trading-skills, freqtrade | Method cards are now version 2, with corrected attributions and numbers; docstrings corrected |

**The corrected results.** On 10 years of the 8 shares, nothing passes, as before. Some earlier statements were too
favourable and are now corrected:
- **Yearly-rebalanced momentum after tax:** 11.2% a year, against the basket's 12.55%. It trails the basket and does
  not match it, as claimed earlier. Monthly momentum keeps 9.8%.
- **Reversal on NIFTY 50:** with realistic next-open entry, its p-value moved from 0.03 to 0.14.
- **Proof time:** the best idea on the 8 shares would need about 490 years of records.

## 2. Known defects not yet fixed

| Item | Source | Effort | Who |
| --- | --- | --- | --- |
| **Call scoring has no neutral band.** An exit is "right" on any fall, even 0.05%, which flatters exit-heavy records and live fitness | trading-skills postmortem | M (a new scoring version) | **Owner** |
| **The TradingAgents member's memory file** (`.local/tradingagents/memory.md`) is written by our model, steers its later decisions, and is not part of its release identity | TradingAgents | S (turn it off in shadow, or hash it into the identity) | **Owner** (member governance) |
| **The debate context has no as-of filter.** A replay of a past day would see later headlines and lessons | TradingAgents | S | Agents |
| **The scenario panel silently turns a failed persona into "flat"** | MiroFish | S (count and show these fallbacks) | Agents |
| **The model evaluation** always exits 0, drops tasks that never ran, has no baseline-regression rule, and does not fingerprint its judges | Soup | S | Agents |
| **The training-data builder** can put evaluation rows into the training files | Soup | S (a `source` field; evaluation rows never reach training) | Agents |
| **The regime file is read without a freshness or completeness check** | trading-skills, Fincept | S | Agents |

## 3. Gaps and ideas, ranked by value for our organisation

> **Status, 21 Oct 2026.** Built without an owner decision (see the [project log](../project-log/2026-10-21.md)):
>
> **Done:**
> - **16:** a real debate.
> - **17:** debaters see the bot's own record.
> - **18:** data-status markers and a share identity.
>
> **Partly done:**
> - **13:** deflated and probabilistic Sharpe, a turnover-matched random baseline, years ahead, twice the costs and
>   India's 2018, 2020 and 2022 stress windows. Still open: the plateau report, an expanding walk-forward, a shuffled
>   null and a lookahead sweep.
> - **15:** regime v2 without stalling days. It warns less sharply than v1, so v1 stays.
> - **23:** a review scorecard covering declined and lapsed calls.
> - **24:** the regime at entry. Still open: the regime at exit, and the worst and best move during each holding
>   (MAE/MFE).
> - **25:** baseline regression, pinned judges and KTO rows. Still open: a measured noise floor.
> - **26:** run manifests for cycles, holding code, switches and price hashes. Still open: backtests, seeds and
>   flagging crashed runs.
> - **29:** a freshness self-check. Still open: arithmetic checks.
>
> **New, not on this list:** a point-in-time knowledge index.
>
> **Still open:** everything else, including the top-ranked A1 (self-expiring loss brakes), which needs the owner.

### A. Risk brakes that work by themselves (highest value for autonomy)

1. **Self-expiring protections.** Pause a bot's new entries after a daily, weekly or monthly realised loss, after a losing
   streak, or for a per-share cooldown after an exit. The pause lifts by itself, and exits stay allowed. Check it in
   `trade-signals.ts` review and `paper.ts`. (freqtrade protections; trading-skills circuit breaker.) **M.** It fits our
   rule "prefer a brake that pauses over one that changes limits". Owner sign-off for the thresholds.
2. **Unrealised losses are invisible to our limits.** The loss limit counts realised loss only, and there are no
   per-position stops.
   - Add a portfolio drawdown halt on marked value, and optional trailing stops per position. A stop should also cancel
     that day's buy of the same share. (Lean risk models.) **M.**
   - Also from Lean: **close or renew a position when its horizon passes.** Today a position stays open until a bot
     proposes an exit. **S–M.**
3. **A sector concentration limit,** using a static NSE industry map recorded as evidence. (Lean.) **S–M.**

### B. Before any real broker (nautilus_trader)

These are needed before a live intraday feed or a broker connection, not before.

4. **An order state machine and a per-order event history** (`order_events`), with an "outcome unknown" state for a
   broker submit that timed out. Never retry a submit blindly. **M.**
5. **Record refusals.** A refused order leaves no trace today, because the transaction rolls back. Logging it in a
   separate small write (like their `OrderDenied`) gives the agents and the owner the data. **S.**
6. **Reconciliation with the broker.** Compare holdings, orders and trades; open a critical incident on any mismatch; and
   remember that a missing report does not mean "flat". **M**, with the adapter.
7. **A broker trade id per fill,** and several fills per order. **S–M.**
8. **A "frozen" state** that blocks sells too, for example while the feed is broken. Our halt is their "reducing" state.
   **S.**
9. **A broker rate limit that refuses rather than queues;** feed-lag rules; positions without a fresh quote marked
   unpriced. **S.**

### C. Research engine fidelity

10. **Research and paper-trading parity.**
    - `daily.py`, `portfolio_daily.py` and `rnd_scout.py` each use their own costs and none of the paper engine's limits.
    - One shared, versioned cost-and-limit model, plus a test that a recorded day gives the same fills in both.
      (nautilus_trader, freqtrade.) **M.**
    - Add a "with brakes" column to scout results. (freqtrade.) **S.**
11. **A component Indian fee model** (brokerage with a cap, STT on delivery, exchange, SEBI, GST, stamp duty, DP charge)
    in place of a flat rate, and **slippage that grows with order size.** (Lean.) **S–M.**
12. **Point-in-time universes:**
    - dated index membership, a rename/ticker map, and a delisting policy (Lean);
    - raw prices plus adjustment factors, so history does not shift after each dividend (Lean).

    **M.** It needs membership data the owner approves.
13. **Cheap statistical guards:**
    - a deflated Sharpe ratio next to Bonferroni (vectorbt);
    - a probabilistic Sharpe ratio (Lean);
    - a random baseline matched to each rule's turnover (vectorbt);
    - a neighbour or plateau report for passing ideas (backtesting.py heatmaps, trading-skills);
    - a 2x-slippage stress test and a "positive in most years" check (trading-skills);
    - Indian crisis windows (2008, 2013, 2016, 2020, 2022) (Lean);
    - an expanding-window walk-forward (vectorbt);
    - a shuffled-history null test (backtesting.py);
    - a lookahead check across a sweep of history lengths, failing on too few samples (freqtrade).

    **S each.**
14. **Re-entry signals.** The regime only ever says "be careful". A follow-through-day filter is the standard
    counterpart for getting back in. (trading-skills.) **M**, tested by the scout like any filter.
15. **Regime v2 matching the full specification:** SEVERE at 6, 5- and 15-session clusters, stalling days, value-weighted
    volume and the unlevered exposure table. Keep v1 for comparison and re-run the study. (trading-skills.) **S.**

### D. Better agents (the model members)

16. **A real debate.** The bear speaks first and the bull answers it, for the same two model calls. Today they never see
    each other. (TradingAgents.) **S.**
17. **Give debaters the bot's own scored record on the share** (our verified reflections, capped at a few lines).
    TradingAgents gives its judge 5 same-share and 3 other-share lessons. **S.**
18. **Tell the model what is missing.** Mark "no news" separately from "feeds down", and "no opinion" when an input is
    stale, incomplete or an outlier. Give each share a one-line identity (name, sector). (TradingAgents, FreqAI.) **S.**
19. **A headline reader.** It turns raw news into a strict, short schema before the debate desk and panel see it.
    (Anthropic plugins.) **S–M.**
20. **Panel improvements, in shadow:** vote weights earned from each persona's record, a two-round panel where personas
    see each other's calls, and asking a persona what it missed after a wrong call. (MiroFish.) **M.**
21. **One repair attempt and a circuit breaker per model agent,** so a failing agent pauses instead of failing every day.
    (Fincept.) **S.**
22. **Count how often TradingAgents' judges return unreadable decisions** on our 4B model before relying on the member.
    It does not force its answer schema. **S.**

### E. Scoring, learning and evaluation

23. **Score the missed opportunities.** Measure whether the proposals our review declined, or that lapsed, would have
    paid off. This tests the reviewers and the debate desk, not the bots. The data is already stored. (trading-skills,
    freqtrade.) **S–M.**
24. **Tag scored calls with the regime** at entry and exit, and record the worst and best move during each holding
    (MAE/MFE). (trading-skills.) **S.**
25. **Model gate.**
    - Fail a candidate that drops more than max(0.05, the noise floor) against the stored baseline report, with the
      noise floor measured by about 3 runs of the current model.
    - Pin the judges in the lock.
    - Add pairs that change a field and KTO rows to the training data, so DPO does not just learn to "say less".
    - Shuffle the data before training.

    Our `sft.jsonl` and `preference.jsonl` already load in Soup as they are. (Soup.) **S.**

### F. Operations and the owner's view

26. **Run manifests** (git commit, configuration hash, data hashes, seed, status) for every cycle, session and
    backtest. Runs left "running" after a crash are flagged. (nautilus_trader.) **S.**
27. **A limits banner in the digest,** showing the limits the running backend actually loaded. It exposes stale settings.
    (freqtrade.) **S.**
28. **An injectable clock** in `paper.ts` and `trade-signals.ts`, so a whole live day can be replayed through the real
    backend. (nautilus_trader.) **M.**
29. **A digest self-check:** dates and weekdays, percentages that should add up, paise against rupees.
    (trading-skills.) **S.**
30. **A catalyst calendar** (results dates, RBI, Budget, FOMC), and a second end-of-day price source for cross-checks,
    such as the NSE bhavcopy. Also hold back bars with zero volume and an unchanged close. (Anthropic plugins,
    a-stock-data.) **M.** It needs source approval.
31. **Dashboard lessons:**
    - Home: uniform tiles, each showing its data's age and state.
    - Decisions: an approval queue that expires, re-checked at approval time.
    - Members: member rows with their circuit status and record.
    - Money: stress scenarios and each holding's share of risk; statistics hidden until 20 periods.
    - Operations: feed health with the reason it is broken.
    - Every research result: an assumptions block (costs, timing, data, survivorship).

    (Fincept.) Copy the organisation, not the 50-screen size.

### Where we are already ahead

- **Stricter research.** No project has our full set of overfitting guards: Bonferroni over every idea ever tried, a
  random baseline, walk-forward, a lookahead check by truncation, proof time, tax and costs. freqtrade's backtester has
  no slippage; backtesting.py's setup step sees the whole data; vectorbt annualises with 365 days by default.
- **Stronger scoring.** We have independent evaluators, verified price evidence, cost-adjusted calls, Brier scores and
  challenger records. Lean ships no default insight scorer.
- **A more careful news pipeline.** We extract exact quotes, use a deterministic fact-checker and alias matching, and
  cluster stories, which TradingAgents and FinnewsHunter do not.
- **Measured simulation.** Our scenario panel is scored in shadow. MiroFish has no accuracy evaluation at all.
- **Automatic loss brakes.** nautilus_trader's risk engine has no automatic switch to a reduced or halted state in the
  code that was read. Ours halts on a critical incident and limits realised loss.

### Not worth adopting (consolidated)

| Item | Why |
| --- | --- |
| Hyperopt and large parameter grids, SAMBO | More trials raise our bar, with no hold-out |
| Edge's pair selection | The project itself removed it in 2025.6 |
| PerformanceFilter | Chasing our own recent P&L |
| ROI tables and averaging down | Not our trading style |
| The full FreqAI pipeline | Too heavy for its value here |
| Telegram control without confirmations | Unsafe |
| The Rust message bus and event store, order-book and queue simulation, latency, margin and hedging models, multi-venue routing | Far beyond our scale |
| Intraday execution and market-impact models, short-window mean-variance optimisers | Our skfolio HRP advisor is better |
| Silent zero-slippage defaults | They hide real costs |
| A model-run risk debate with real authority | Authority stays with deterministic review |
| Model-written reflections | Ours are deterministic and verified |
| Web search during debates | Unverified inputs |
| FinnewsHunter's RL factor mining | It selects on the data it trained on |
| VCP, CANSLIM, PEAD and earnings screens | They need breakout execution, fundamentals or a wide universe |
| Kelly sizing | Our records are too short |
| MiroFish's cloud simulation, FinceptTerminal's code | Licences, cloud services and scale |

## Suggested order

1. **Now, by the agents (small):** items 2 marked "Agents"; 5, 8, 9, 13, 15, 16, 17, 18, 21, 22, 24, 25, 26, 27 and 29.
2. **Owner decisions next:**
   - the neutral band in scoring;
   - the TradingAgents memory;
   - self-expiring protections and their thresholds (1);
   - unrealised-loss and horizon exits (2);
   - the regime as a sizing input (from 14 and 15).
3. **With more data or sources:** point-in-time universes (12), the catalyst calendar and a second price source (30).
4. **Before any broker:** 4, 6, 7 and 28.
