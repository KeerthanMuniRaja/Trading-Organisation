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

Next, under founder review B14: re-test it on point-in-time membership, then run a pre-registered forward test before any
bot uses it. Trend-200d (IC t 1.92) and near-52w-high (1.84) point the same way but fail the bar.
