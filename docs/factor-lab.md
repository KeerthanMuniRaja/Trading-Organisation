# Factor lab: patterns across 500 shares (RESEARCH-02)

On our 8 desk shares, the best idea would need about 490 years of records to prove at our bar ([skill
roadmap](skill-roadmap.md)): eight similar shares and one decision a month carry very little independent information.
Across 500 shares each month holds hundreds of outcomes, so a real pattern can be told apart from luck within years. That
is the single biggest lever toward proven skill, and the factor lab is where it is used.

**Research only.** Nothing here proposes a trade. A factor that passes becomes a candidate for a pre-registered live test
through the normal R&D road (evidence, birth, release, live fitness), never a trade by itself.

## The data

| Item | Where | Note |
| --- | --- | --- |
| NIFTY 500 members, with NSE industry | `.local/trading-desk/datasets/ind_nifty500list.csv` | NSE Indices' public constituent file, fetched once (27 Oct 2026); `datasets.nifty500()`, `datasets.industries()` |
| 10 years of daily bars per member | `.local/trading-desk/daily-nifty500/` | `daily.py fetch --universe nifty500 --years 10`: the approved Yahoo source, sequential with a 1-second pause, every file through the data steward; a failing share is recorded and skipped |

**Survivorship bias.** These are today's members over past years: companies that fell out of the index are missing, which
flatters momentum and trend most. Point-in-time membership (founder review B14) removes it; until then a pass here is a
lead, not a finding.

## What it measures (`factor_lab.py`)

Each month, every share with enough history is ranked on each factor:

| Factor | Signal |
| --- | --- |
| `momentum-12-1` | 12-month return, skipping the latest month (the classic momentum factor) |
| `momentum-6m`, `momentum-3m` | 6- and 3-month return |
| `reversal-1m` | last month's losers (short-term reversal) |
| `low-vol-60d`, `low-vol-250d` | calm: low volatility of daily returns |
| `near-52w-high` | closeness to the 52-week high |
| `trend-200d` | distance above the 200-day average |

For each factor and month: the **top fifth** (equal weights, net of 0.15% on each unit traded, one way) against the
equal-weight universe; the **spread**, top fifth minus bottom fifth; and the **information coefficient (IC)**, the rank
correlation between the factor and next month's return. Timing is the scout's: decide on the month's first session, enter
at the next open, hold to the open after the next month's first session.

**A factor passes only if** its IC t-statistic and its top fifth's months-ahead sign test both clear a Bonferroni bar over
the whole catalogue (0.05 / 8), it is ahead of the basket in both halves of the history, and in most years.

```
.local\replay-venv\Scripts\python.exe integrations\trading-desk\factor_lab.py [--through YYYY-MM]
```

The report is saved to `.local/trading-desk/rnd/factor-lab-<month>.json`. With `--monthly` (the daily cycle's
`factor-lab` step) it does nothing once last month has a report.

**In the daily cycle.** The `broad-data` step keeps the files at most 28 days old, with at most 40 downloads a run. The
`factor-lab` step judges each closed month. The `organisation-lessons` step turns the newest report into lessons that the
debate reads ([mentor](mentor.md)).

**Research universe rule.** In the research universe, a large one-day move whose ratio does not look like a split or
bonus (1/2, 1/3, 2/3 … 10) is kept and flagged `extreme-move-kept-for-research`, not rejected. Rejecting every big move
left out the volatile companies, which tilted the universe towards calm shares. Split-like jumps are still rejected:
they are probably unadjusted actions. The desk's own traded files keep the strict rule.

## Results (through September 2026, 119 months)

| Run | Shares | momentum-12-1 | momentum-6m | Low volatility | Basket after tax |
| --- | --- | --- | --- | --- | --- |
| Strict steward (98 shares held back) | 396 | IC t 2.23, **no pass** | top fifth ahead 72/40, IC t 1.82, no pass | top fifth behind the basket | 23.57% a year |
| Research rule (88 of them restored) | 484 | IC t **2.69**, top fifth ahead 68/38: **passes** | IC t 2.35, ahead 75/37, no pass | behind the basket (ahead 43/73), no IC signal | 22.85% a year |

momentum-12-1 is the first factor to pass. **It is a candidate, not proof.**

- It passed only once the volatile shares were back. A result that rests on which shares were kept is fragile.
- The universe is today's members: survivorship bias flatters momentum most.

Two checks remain before any bot uses it:
- a re-test on point-in-time membership (founder review B14);
- the pre-registered forward test below.

Trend-200d (IC t 1.92) and near-52w-high (1.84) point the same way but fail the bar.

### When the factors work: after a deep fall

Each factor's record is also split by market condition (`byCondition`, descriptive, not part of the pass). One group
is the months after the whole universe fell 15% or more over the previous 6 judged months (`DEEP_FALL_PCT`); the other
is every other month:

| Factor | After a deep fall (4 months) | Other months |
| --- | --- | --- |
| reversal-1m (last month's losers) | **+3.1% a month, ahead 4/4** | −0.4% |
| momentum-12-1 | **−1.6%, ahead 1/4** | +0.7% |
| momentum-6m | −1.7%, ahead 1/4 | +0.9% |
| near-52w-high | −4.2%, ahead 0/4 | +0.2% |

This is the well-known "momentum crash": in a rebound, last month's losers bounce hardest. On our 8 shares the mentor's
lesson that momentum fails in a rebound looked contradicted; on 484 shares it shows. There are only 4 such months, so
it is a warning, not a rule.

The organisation lesson `org-after-deep-fall` carries it to decisions in a HIGH or SEVERE market and to momentum,
reversal and trend members. The model exam `exam-momentum-after-deep-fall` checks that a bear uses it.

## The forward test

`momentum-12-1-from-2026-11` was registered on 28 Oct 2026 (RESEARCH-03,
`.local/trading-desk/factor-forward/`). Everything was frozen at registration:

| What | Fixed at |
| --- | --- |
| The rule | Fingerprint `4e5f6c41de7f6393`: the factor, the monthly panel and the costs. Changing any of it ends the test |
| The shares | The 484 shares that had data. The list never changes, so there is no survivorship bias going forward |
| What counts | Months from **November 2026** only. A month counts once 90% of the shares have its prices, and none is ever skipped |
| The verdict | After **24 months** (about end of 2028), it passes only if the IC t-statistic is at least 1.645 (one test, one-sided 5%) and the top fifth is ahead of the list on average after costs. Before then, the reports are descriptive |

The cycle's `factor-forward` step scores it every day and writes the result to `factor-forward/reports/`. The first
month is judged once December's prices arrive. A share with no prices for a month (suspended, delisted) is left out of
that month. So a collapse just before a delisting is missed, a small bias in the factor's favour.

A pass makes momentum-12-1 eligible for a bot proposal to the owner. It never trades by itself.

```
.local\replay-venv\Scripts\python.exe integrations\trading-desk\factor_lab.py --register-forward <name> --factor <factor>
.local\replay-venv\Scripts\python.exe integrations\trading-desk\factor_lab.py --forward
```
