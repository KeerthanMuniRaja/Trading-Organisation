# Market regime and the adopted trading-skill methods (REGIME-01)

On 20 October 2026 the owner asked to replicate a new Claude trading tool and train the system on it. We found two candidates:

- **Anthropic's financial-services plugins** (Apache-2.0). They hold research skills such as the morning note, thesis tracker,
  catalyst calendar, idea screening and earnings analysis. Anthropic says these agents make no investment recommendations
  and execute no transactions.
- **[claude-trading-skills](https://github.com/tradermonty/claude-trading-skills)** (MIT). This community project has 74
  trading skills for Claude.

Most of those skills read paid US data APIs. We rebuilt the methods that fit an organisation of eight NSE shares on our own
daily data. None of them needs a model, and each one is tested on our history before anyone relies on it.

## What was adopted

| Method (source skill) | Ours | Where |
| --- | --- | --- |
| Distribution-day monitor (IBD) | The 8 shares as one equal-weight basket (there is no index feed). A distribution day is a basket fall of at least 0.2% on higher volume than the day before. It counts for 25 sessions, or until the basket recovers 5%. Risk levels: NORMAL 0–2, CAUTION 3–4, HIGH 5–6, SEVERE 7+ | `market_regime.py` |
| Breadth / uptrend analysers | How many of the 8 close above their 50-day and 200-day averages | `market_regime.py` |
| Exposure coach | Advisory ceiling: 100 / 75 / 50 / 25% by risk level, 25 points lower below the 200-day trend, and 25 lower again with 2 or fewer shares above their 200-day average | `market_regime.py` |
| VCP / trend template (Minervini) | The `trend-template` R&D family: close above the 50-day average, the 50-day above the 200-day, the 200-day rising, and the close near the 52-week high | `rnd_ideas.py` |
| Dividend-growth pullback screener | The `pullback` R&D family: 14-day RSI at or below a bound, above the 200-day average | `rnd_ideas.py` |
| Market-top / distribution regime as a filter | The R&D filter `distribution-days`: cash while risk is HIGH or SEVERE | `rnd_ideas.py` |

Some skills were already covered by what the organisation has, so we did not copy them:

| Skill | Ours |
| --- | --- |
| Drawdown circuit breaker | Halt, loss limit and management review |
| Signal postmortem, trade performance coach | Outcome scoring, reflections and live fitness |
| Edge strategy reviewer | The scout's Bonferroni bar over every idea ever tried |
| Bull/bear agents | The debate desk |

## Governance

The exposure ceiling is **advice**. It is never applied to a bot, a budget or a limit, because money and limits stay with the
owner. A rule that uses the regime is an ordinary R&D idea. It must pass the scout before a bot can be born from it, and
then earn its release on live paper calls.

## Training run, 20 October 2026 (our history, net of costs)

**Regime study** (`market_regime.py study`) covers August 2022 to September 2026. It looks at the 20 sessions after each day:

| Risk | Days | Average return | Average worst fall | Falls over 5% |
| --- | --- | --- | --- | --- |
| SEVERE | 301 | +0.41% | −2.58% | 17.3% |
| HIGH | 298 | +0.98% | −1.73% | 4.4% |
| CAUTION | 262 | +0.94% | −2.05% | 9.9% |
| NORMAL | 156 | +0.80% | −1.91% | 7.1% |

The verdict was **no clear warning**. SEVERE days were followed by falls of over 5% more than twice as often as NORMAL days,
but HIGH days were not worse than NORMAL. On an 8-share basket the levels are crowded: only 156 days were NORMAL. The
thresholds were not re-tuned on the same history, because that would be mining it.

**R&D scout** now has 17 pre-registered ideas, so the Bonferroni bar is 0.0029. None passes.

| Idea | Months ahead / behind the basket | Average excess a month | p |
| --- | --- | --- | --- |
| momentum-6m-top3 (the current bot) | 30 / 16 | +0.23% | 0.027 |
| trend-template-25pct-top3 | 26 / 20 | −0.13% | 0.23 |
| momentum-6m-top3-distribution | 25 / 21 | +0.03% | 0.33 |
| equal-weight-distribution | 13 / 23 | −0.04% | 1.00 |
| pullback-rsi40-top3 | 22 / 24 | −0.44% | 1.00 |

The adopted methods do not beat holding the eight shares equally, and the distribution filter weakens momentum. They stay
in the catalogue: they were tried, so they keep raising the bar. Their variants can still be invented under the same limits.

**Today's regime** (19 Oct close): SEVERE, with 9 distribution days. 1 of 8 shares is above its 50-day and 200-day averages,
and the basket is below its 200-day trend. The advisory ceiling is 0%.

## Running it

- **The cycle** runs `market-regime` and `regime-study` after the market data, and writes them to `.local/trading-desk/regime/`.
- **The digest** has a "Market regime (advice)" section.
- **`npm run status`** shows the regime even while the backend is down.
- **By hand:**
  ```
  .local\replay-venv\Scripts\python.exe integrations\trading-desk\market_regime.py now
  .local\replay-venv\Scripts\python.exe integrations\trading-desk\market_regime.py study
  .local\replay-venv\Scripts\python.exe integrations\trading-desk\rnd_scout.py
  ```
