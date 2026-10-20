# Research methods, knowledge base and problem playbook (RESEARCH-01, OPS-02)

On 20 October 2026 the owner asked us to review five open-source trading frameworks and take what helps the agents decide,
build solutions and handle problems. Their licences allow ideas but not copied code into this project, so everything below
is our own code, with no new dependencies.

| Project | Licence | What we took |
| --- | --- | --- |
| [freqtrade](https://github.com/freqtrade/freqtrade) | GPL-3.0 | Lookahead and recursive-formula checks; protections, recorded as knowledge |
| [backtesting.py](https://github.com/kernc/backtesting.py) | AGPL-3.0 | Result statistics |
| [vectorbt](https://github.com/polakowo/vectorbt) | Apache-2.0 + Commons Clause | Random-signal baseline; walk-forward validation |
| [QuantConnect Lean](https://github.com/QuantConnect/Lean) | Apache-2.0 | Framework stages and point-in-time universes, recorded as knowledge |
| [nautilus_trader](https://github.com/nautechsystems/nautilus_trader) | LGPL-3.0 | Backtest–live parity and deterministic runs, recorded as knowledge |

## The checks every idea now faces (`research_checks.py`, in every scout run)

- **Lookahead.** A decision on day *i* must not change when every later day is removed. It is checked on 6 decision days.
  An idea that fails cannot pass.
- **Warm-up.** A decision should not depend on how far back the data starts. It is checked against only the last 300
  sessions, and the result is reported as `warmupSensitive`.
- **Statistics.** For each idea and for the basket:
  - CAGR, volatility, Sharpe and Sortino;
  - worst fall and its length, and Calmar;
  - profit factor, expectancy and SQN of the monthly excess.
- **Random baseline.** 100 reproducible random pickers hold 3 shares a month and pay the same costs. Each idea gets
  `beatsRandomPct`.
- **Walk-forward.** Each year, take the idea with the best record over the previous three years and hold it for the next
  year. This tests our own way of choosing ideas.

- **Risk lens** (report only). A circular block bootstrap (6-month blocks, 1,000 samples) of the paired monthly returns
  asks how often an idea's Sharpe stays above the basket's. The lens also reports the idea's worst fall against the
  basket's, its average cash share, and its result if cash earned an **assumed** 6% a year (our backtests otherwise earn
  0% on cash). `wouldPassRiskBar` shows whether it would pass at the same Bonferroni bar with a smaller worst fall.
  Whether risk may ever pass an idea is the owner's decision; the lens only supplies the evidence.

  On 20 October 2026, **no idea would pass on risk either.** The best was the 200-day trend filter: Sharpe +0.16 over the
  basket, better in 63% of samples (p 0.37), worst fall −12.7% against −35%. At an assumed 6% on cash it would earn
  14.2% a year against the basket's 13.6%. Its smaller fall comes mostly from one episode, the 2020 crash.

## The NIFTY 50 research universe

`datasets.NIFTY50` holds the members after the reconstitution effective 30 Sep 2026, taken from Wikipedia's NIFTY 50 page.
It is **research only**: bots trade only the eight desk shares, and the research screen cannot propose a bot.

- **Download:** 10 years each, in `.local/trading-desk/daily-research/`:
  `daily.py fetch --universe nifty50 --years 10`
- **Confirmed moves:** the owner's confirmations for Axis Bank (23 Mar 2020) and SBI (25 Oct 2017) were carried over.
- **Kept back (7 shares),** each with a move over 20% in a day that needs checking:
  - Bajaj Finance, Bajaj Finserv and Shriram Finance (COVID crash day);
  - Adani Ports (election-results day);
  - Adani Enterprises (several days, including the Hindenburg crash);
  - Tata Motors PV (−40% on 14 Oct 2025, probably its demerger rather than a real move);
  - Trent (−33% on 1 Jan 2026, unexplained).
- **Left out of the comparison (6 shares)** because they listed or joined later: BSE, Eternal, HDFC Life, Jio Financial,
  Max Healthcare and SBI Life.
- **The screen:** 37 shares over 106 months: `rnd_scout.py --universe nifty50`
- **Survivorship bias:** today's members over past years leave out the companies that dropped out of the index. Every
  result is flattered, reversal most of all.

## What the training run found (seen history, net of costs)

| Question | 8 desk shares | 37 NIFTY 50 shares |
| --- | --- | --- |
| Does any idea pass? | No (17 ideas, bar 0.0029) | No |
| Best idea | Momentum 6m top 3: 61/45 months, 0.00% a month, beats 81% of random pickers | Reversal 1m bottom 3: 63/43, +0.56% a month, p 0.032, beats 95% of random pickers (survivorship-biased) |
| Random pickers against the basket | median −0.16% a month (costs) | — |
| Does picking the best past idea work (walk-forward)? | **No**: 33/37 months, −0.35% a month | **No**: 35/35, −0.32% a month |
| Basket | 13.6% a year, Sharpe 0.79, worst fall −35% | 17.0% a year, Sharpe 1.04, worst fall −28% |
| Lowest risk | Trend filter 200d: 12.95% a year, Sharpe 0.95, worst fall −12.7% | Distribution filter: worst fall −11.8% |

Two lessons stand out:
- **Picking the best backtest does not work here.** It is the strongest reason to trust only live, pre-registered records.
- **The trend filter's value is lower risk, not higher return.** The scout's pass test counts months ahead on return only,
  so it cannot see this. Cash also earns no interest in our backtests, which understates every filter.

## Knowledge the agents use

- **Method cards** (`integrations/trading-desk/knowledge/methods.json`): 17 cards. Each gives the method, its source, how we
  test it, our result and the lesson. R&D's idea invention sends every lesson to the model with the results, so new ideas
  start from what the organisation has already learned, including what failed.
- **Problem playbook** (`integrations/trading-desk/knowledge/problems.json`, `scripts/playbook.mjs`): 11 known problems.
  Each gives the cause, the safe fix and who decides: **agents** may retry or repair; only the **owner** touches money,
  limits, sources or data confirmations. When a cycle step fails or degrades, the matching entry goes into the day's
  journal, the console, the escalation incident and the morning readiness check. A new problem gets an entry once its
  cause is known.
- **Unknown problems** go to `.local/cycles/unknown-problems.jsonl`. The digest lists them under **Needs you** for 7 days,
  so the playbook grows with the organisation's own failures.
- **Drafted entries** (`playbook_drafts.py`, cycle step `playbook-drafts`, needs the model). The local model drafts one
  entry per unknown failing step: the cause, a safe fix, who decides and a pattern for the failure text. The failure text
  is untrusted data, and the answer is bound to a schema. Safeguards:
  - a fix that mentions money, limits, sources, credentials, releases or data confirmations is always marked **owner**,
    whatever the model said;
  - a pattern that does not compile, matches everything or misses the failure is replaced by the escaped failure text;
  - in the playbook loader, a pattern that does not compile is skipped.

  The digest lists waiting drafts. The owner reviews them with `playbook_drafts.py list` and accepts one with
  `playbook_drafts.py accept <id> --yes`, which adds it just before the catch-all. A failure the playbook covers is
  never drafted again.

## Live knowledge (KNOW-05)

After the scout, the cycle step `knowledge-refresh` (`live_knowledge.py refresh`) writes
`.local/trading-desk/knowledge/live.json`. It gathers what the organisation currently knows:
- the latest research on the 8 shares: ideas tried, passing ideas, the best three with their statistics, the lowest-risk
  idea, the random baseline and the walk-forward verdict;
- the NIFTY 50 screen;
- today's regime and its study verdict;
- the news links that carry information;
- the scenario panel's record.

The numbers in the method cards are a dated snapshot. `live.json` is always current.

**The agents use it.** `live_knowledge.briefing()` is a short context, under 4 KB, so it fits the 4B model. It holds today's
regime and six decision lessons: costs, momentum, trend, regime, walk-forward and survivorship. The context is used by:
- **the debate desk's bull and bear,** as `organisationKnowledge`: background they may use but never cite as evidence;
- **the scenario panel's personas,** as `marketRegime`;
- **R&D's idea invention,** which also gets every method lesson and each idea's random-baseline result.

The digest has a **Research** section with the same evidence.
