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

The report is saved to `.local/trading-desk/rnd/factor-lab-<month>.json`.

## Results

See the [project log](project-log/2026-10-27.md) for the first full run.
