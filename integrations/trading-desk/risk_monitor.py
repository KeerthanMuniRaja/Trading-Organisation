"""Portfolio risk monitor: a rule-based risk officer for the whole basket. Reports; never trades. Research only.

Each day it measures the equal-weight basket of the universe from completed days only:
  drawdown      fall of the basket from its 252-day peak
  volatility    20-day annualised volatility against its own 1-year median
  breadth       how many shares are above their 200-day average
  correlation   average pairwise 60-day correlation (high means diversification is failing)
  worst day     largest one-day basket fall in the last 20 days
Fixed thresholds turn each into normal / caution / alert, and the day takes the most severe level, with reasons.
`history` checks whether the levels meant anything: the basket's return over the following month, by level.
Those days were already seen, so that check is descriptive, not proof. Thresholds are set here once, not tuned.
Run: .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\risk_monitor.py today
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import daily  # noqa: E402
import portfolio_daily as pd  # noqa: E402

OUT = daily.ROOT / '.local' / 'trading-desk' / 'risk-monitor'
LEVELS = ('normal', 'caution', 'alert')
# Fixed in advance (not fitted to history): (caution, alert)
DRAWDOWN = (0.10, 0.20)
VOL_RATIO = (1.5, 2.0)
BREADTH_ABOVE = (0.375, 0.125)   # caution when 3 or fewer of 8 are above their 200-day average, alert at 1 or none
CORRELATION = (0.6, 0.8)
WORST_DAY = (0.03, 0.05)


def basket_index(table, dates, upto):
    """Equal-weight basket value per day (1.0 at the first date), completed days only."""
    first = dates[0]
    return [sum(table[s][dates[k]]['closePaise'] / table[s][first]['closePaise'] for s in table) / len(table) for k in range(upto + 1)]


def returns(values):
    return [values[k] / values[k - 1] - 1 for k in range(1, len(values))]


def correlation(a, b):
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    sa = math.sqrt(sum((x - ma) ** 2 for x in a))
    sb = math.sqrt(sum((y - mb) ** 2 for y in b))
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (sa * sb) if sa and sb else 0.0


def assess(table, dates, i):
    """The risk state on day i, from days up to and including i."""
    index = basket_index(table, dates, i)
    rets = returns(index)
    reasons, level = [], 0

    def rate(name, value, limits, higher_is_worse=True, text=''):
        nonlocal level
        hit = 2 if (value >= limits[1] if higher_is_worse else value <= limits[1]) else 1 if (value >= limits[0] if higher_is_worse else value <= limits[0]) else 0
        if hit:
            reasons.append(f'{LEVELS[hit]}: {text}')
        level = max(level, hit)
        return round(value, 4)
    peak = max(index[max(0, i - 251):])
    metrics = {'drawdown': rate('drawdown', 1 - index[-1] / peak, DRAWDOWN, text=f'basket {100 * (1 - index[-1] / peak):.1f}% below its 1-year peak')}
    if len(rets) >= 252:
        vols = [statistics.pstdev(rets[k - 20:k]) * math.sqrt(252) for k in range(len(rets) - 232, len(rets) + 1)]
        ratio = vols[-1] / statistics.median(vols) if statistics.median(vols) else 1.0
        metrics['volatilityRatio'] = rate('vol', ratio, VOL_RATIO, text=f'20-day volatility {ratio:.1f}x its 1-year median')
    if i >= 199:
        above = sum(table[s][dates[i]]['closePaise'] > sum(table[s][d]['closePaise'] for d in dates[i - 199:i + 1]) / 200 for s in table) / len(table)
        metrics['breadthAbove200d'] = rate('breadth', above, BREADTH_ABOVE, higher_is_worse=False,
                                           text=f'only {round(above * len(table))} of {len(table)} shares above their 200-day average')
    if i >= 60:
        series = {s: returns([table[s][d]['closePaise'] for d in dates[i - 60:i + 1]]) for s in table}
        names = sorted(series)
        pairs = [correlation(series[a], series[b]) for x, a in enumerate(names) for b in names[x + 1:]]
        avg = sum(pairs) / len(pairs) if pairs else 0.0
        metrics['averageCorrelation'] = rate('corr', avg, CORRELATION, text=f'shares moving together (average correlation {avg:.2f})')
    if len(rets) >= 20:
        worst = -min(rets[-20:])
        metrics['worstDayLast20'] = rate('day', worst, WORST_DAY, text=f'a {100 * worst:.1f}% one-day basket fall in the last 20 days')
    return {'date': dates[i], 'level': LEVELS[level], 'reasons': reasons, 'metrics': metrics}


def history(table, dates, start=252, horizon=21):
    """Every day's level against the basket's return over the next `horizon` days (descriptive: these days were seen)."""
    index = basket_index(table, dates, len(dates) - 1)
    groups = {lv: [] for lv in LEVELS}
    for i in range(start, len(dates) - horizon):
        groups[assess(table, dates, i)['level']].append(index[i + horizon] / index[i] - 1)
    return {lv: {'days': len(v), 'averageNextMonthPct': round(100 * sum(v) / len(v), 2) if v else None,
                 'shareOfDaysFollowedByLoss': round(sum(r < 0 for r in v) / len(v), 3) if v else None} for lv, v in groups.items()}


def load():
    all_bars = daily.load(sorted(daily.datasets.UNIVERSE))
    if not all_bars:
        raise ValueError('No daily data; run daily.py fetch first')
    return pd.aligned(all_bars)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('today')
    sub.add_parser('history')
    args = parser.parse_args(argv)
    dates, table = load()
    OUT.mkdir(parents=True, exist_ok=True)
    if args.command == 'today':
        state = assess(table, dates, len(dates) - 1)
        journal = json.loads((OUT / 'journal.json').read_text(encoding='utf-8')) if (OUT / 'journal.json').exists() else {}
        journal[state['date']] = state  # one entry per trading day; rerunning the same day replaces it
        batch.save(OUT / 'journal.json', journal)
        print(json.dumps(state, indent=2))
    else:
        result = {'status': 'seen', 'note': 'Descriptive: these days were already used elsewhere; thresholds were fixed, not fitted.',
                  'byLevel': history(table, dates)}
        batch.save(OUT / 'history.json', result)
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
