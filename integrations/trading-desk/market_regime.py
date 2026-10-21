"""Market regime (REGIME-01): is the market of our eight shares healthy, under pressure or breaking down?

Inspired by claude-trading-skills (MIT, github.com/tradermonty/claude-trading-skills), mainly its IBD distribution-day
monitor. Our version is a SIMPLER VARIANT, not their specification (their source was read on 21 Oct 2026, see
docs/research-notes/trading-skills-finance-plugins-a-stock-data.md): they call SEVERE at 6 days and also escalate on
5- and 15-session clusters, count stalling days and use index volume; our exposure table equals their table for a 3x
leveraged ETF, and the trend and breadth deductions below are our own design, as is the "breadth" of eight shares (a
concentration measure, not market breadth). It is model-free and runs on the desk's own daily data for its eight NSE
shares, treated as one equal-weight basket (there is no index feed):
  - distribution day: the basket falls at least 0.2% on higher volume than the day before (the shares' average volume
    ratio above 1). It counts for 25 sessions, unless the basket later closes 5% above that day's close;
  - risk: NORMAL (0-2 active distribution days), CAUTION (3-4), HIGH (5-6), SEVERE (7 or more);
  - breadth: how many of the eight close above their 50-day and 200-day averages;
  - trend: whether the basket is above its 200-day average;
  - exposure ceiling: NORMAL 100%, CAUTION 75%, HIGH 50%, SEVERE 25%, a further 25 points lower below the 200-day trend
    and again with 2 or fewer shares above their 200-day average (never below 0).
The ceiling is ADVICE: limits and money are the owner's. A rule that uses the regime is an R&D idea like any other (the
`distribution-days` filter) and has to pass the scout before a bot can be born from it.
`study` checks the regime against what followed on our own history: the basket's next-20-session return and worst fall
for each risk level. Seen history, overlapping windows: a description, not proof.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\market_regime.py [now|study]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import daily  # noqa: E402
import portfolio_daily as pd  # noqa: E402

OUT = daily.ROOT / '.local' / 'trading-desk' / 'regime'
DROP_PCT, EXPIRY, INVALIDATE_PCT = -0.2, 25, 5.0
LEVELS = ((7, 'SEVERE'), (5, 'HIGH'), (3, 'CAUTION'), (0, 'NORMAL'))
CEILING = {'NORMAL': 100, 'CAUTION': 75, 'HIGH': 50, 'SEVERE': 25}
HORIZON = 20


def basket(table, dates, start, end):
    """Equal-weight index levels, daily returns (%) and average volume ratios for dates[start..end]."""
    first = {s: table[s][dates[start]]['closePaise'] for s in table}
    level = [sum(table[s][dates[k]]['closePaise'] / first[s] for s in table) / len(table) for k in range(start, end + 1)]
    ret, ratio = [None], [None]
    for k in range(start + 1, end + 1):
        ret.append(100 * sum(table[s][dates[k]]['closePaise'] / table[s][dates[k - 1]]['closePaise'] - 1 for s in table) / len(table))
        ratio.append(sum(table[s][dates[k]]['volume'] / max(1, table[s][dates[k - 1]]['volume']) for s in table) / len(table))
    return level, ret, ratio


def distribution_days(table, dates, i):
    """The dates of active distribution days at day i (completed days only)."""
    start = max(0, i - EXPIRY - 1)
    if i - start < 2:
        return []
    level, ret, ratio = basket(table, dates, start, i)
    active = []
    for j in range(1, len(level)):
        k = start + j
        if i - k >= EXPIRY or ret[j] > DROP_PCT or ratio[j] <= 1:
            continue
        if max(level[j + 1:], default=0) >= level[j] * (1 + INVALIDATE_PCT / 100):
            continue  # the market recovered well above it
        active.append(dates[k])
    return active


def risk_of(count):
    return next(name for floor, name in LEVELS if count >= floor)


def above(table, dates, i, window):
    if i < window:
        return None
    return sum(table[s][dates[i]]['closePaise'] > sum(pd.closes(table, s, dates, i, window)) / window for s in table)


def regime(table, dates, i):
    days = distribution_days(table, dates, i)
    risk = risk_of(len(days))
    trend = bool(pd.trend_filtered(table, dates, i)) if i >= 200 else None
    b50, b200 = above(table, dates, i, 50), above(table, dates, i, 200)
    ceiling = CEILING[risk] - (25 if trend is False else 0) - (25 if b200 is not None and b200 <= 2 else 0)
    return {'date': dates[i], 'distributionDays': len(days), 'distributionDates': days, 'risk': risk, 'aboveTrend200d': trend,
            'breadth50d': b50, 'breadth200d': b200, 'shares': len(table), 'exposureCeilingPct': max(0, ceiling),
            # readers check these before trusting it (trading-skills' provenance gate): which shares it rests on
            'inputsComplete': len(table) == len(daily.datasets.UNIVERSE)}


def calm(table, dates, i):
    """The R&D filter: true unless distribution risk is HIGH or SEVERE."""
    return risk_of(len(distribution_days(table, dates, i))) in ('NORMAL', 'CAUTION')


def study(table, dates, start=200, horizon=HORIZON):
    """Per risk level: how often it occurred and the basket's next-`horizon`-session return and worst fall."""
    level, _, _ = basket(table, dates, 0, len(dates) - 1)
    by = {name: [] for _, name in LEVELS}
    for i in range(start, len(dates) - horizon):
        risk = risk_of(len(distribution_days(table, dates, i)))
        ahead = level[i + 1:i + horizon + 1]
        by[risk].append((100 * (ahead[-1] / level[i] - 1), 100 * (min(ahead) / level[i] - 1)))
    rows = {}
    for name, xs in by.items():
        rows[name] = {'days': len(xs), 'averageReturnPct': round(statistics.fmean(r for r, _ in xs), 2) if xs else None,
                      'averageWorstFallPct': round(statistics.fmean(f for _, f in xs), 2) if xs else None,
                      'fallOver5PctShare': round(sum(f <= -5 for _, f in xs) / len(xs), 3) if xs else None}
    normal, stressed = rows['NORMAL'], [rows[n] for n in ('HIGH', 'SEVERE') if rows[n]['days'] >= 20]
    verdict = ('insufficient-evidence' if not stressed or normal['days'] < 20 else
               'warns-of-falls' if all(r['averageWorstFallPct'] < normal['averageWorstFallPct'] for r in stressed) else 'no-clear-warning')
    return {'horizonSessions': horizon, 'from': dates[start], 'through': dates[len(dates) - horizon - 1], 'levels': rows, 'verdict': verdict,
            'note': 'Seen history, overlapping windows: describes how the regime and later falls went together; it is not proof.'}


def history(table, dates, start=200):
    """The regime of every session from `start` (completed days only, the same rules as `regime`), so any past day's
    regime can be looked up point-in-time (the knowledge index loads it)."""
    return [{k: v for k, v in regime(table, dates, i).items() if k != 'distributionDates'} for i in range(start, len(dates))]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', nargs='?', choices=['now', 'study'], default='now')
    args = parser.parse_args(argv)
    dates, table = pd.aligned(daily.load(sorted(daily.datasets.UNIVERSE)))
    OUT.mkdir(parents=True, exist_ok=True)
    if args.command == 'now':
        r = regime(table, dates, len(dates) - 1)
        r['note'] = 'Advice only: the exposure ceiling is not applied to any bot or limit.'
        batch.save(OUT / 'latest.json', r)
        batch.save(OUT / f"regime-{r['date']}.json", r)
        print(json.dumps({k: r[k] for k in ('date', 'risk', 'distributionDays', 'breadth50d', 'breadth200d', 'aboveTrend200d', 'exposureCeilingPct')}))
        return
    report = study(table, dates)
    batch.save(OUT / 'study.json', report)
    batch.save(OUT / 'history.json', {'note': 'The regime of every session, computed with completed days only.', 'days': history(table, dates)})
    for name, row in report['levels'].items():
        print(f"  {name:8s} days {row['days']:>5}  next {HORIZON} sessions: return {row['averageReturnPct']}%  worst fall {row['averageWorstFallPct']}%"
              f"  falls over 5%: {row['fallOver5PctShare']}")
    print(json.dumps({'verdict': report['verdict'], 'from': report['from'], 'through': report['through']}))


if __name__ == '__main__':
    main()
