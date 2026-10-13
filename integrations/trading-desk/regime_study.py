"""Regime study: does any allocation rule's edge over the basket hold in every kind of market, or only in some?

For every month-start in the cached daily data, each rule's target weights (decided from completed days only) are held
to the next month-start, and the month's gross return is compared with the equal-weight basket's. Months are grouped
by market breadth at the decision: how many of the eight shares closed above their 200-day average
(broad uptrend 6-8, mixed 3-5, broad downtrend 0-2). A rule that wins only in one regime is a regime bet, not a skill;
knowing which regime it suits is what a teacher can turn into a lesson, to be confirmed in a forward test.
Gross of costs on purpose: this isolates behaviour; portfolio_daily.py and the allocator reports carry the real costs.
Research only, no model, no network:
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\regime_study.py
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import daily  # noqa: E402
import portfolio_daily as pd  # noqa: E402

OUT = daily.ROOT / '.local' / 'trading-desk' / 'regime-study.json'
REGIMES = ('broad uptrend (6-8)', 'mixed (3-5)', 'broad downtrend (0-2)')


def regime(above):
    return REGIMES[0] if above >= 6 else REGIMES[2] if above <= 2 else REGIMES[1]


def breadth(table, dates, i, window=200):
    count = 0
    for s in table:
        closes = [table[s][d]['closePaise'] for d in dates[max(0, i - window + 1):i + 1]]
        count += len(closes) >= window and closes[-1] > sum(closes) / len(closes)
    return count


def monthly_rows(table, dates, rules, start=200):
    """One row per month: breadth, basket return and each rule's gross return over the month (percent)."""
    starts = [i for i in range(max(start, 1), len(dates)) if dates[i][:7] != dates[i - 1][:7]]
    rows = []
    for a, b in zip(starts, starts[1:]):
        ret = {s: table[s][dates[b]]['closePaise'] / table[s][dates[a]]['closePaise'] - 1 for s in table}
        basket = sum(ret.values()) / len(ret)
        row = {'month': dates[a][:7], 'breadth': breadth(table, dates, a), 'basketPct': round(100 * basket, 3), 'rules': {}}
        for name, rule in rules.items():
            weights = rule(table, dates, a)
            row['rules'][name] = round(100 * sum(w * ret[s] for s, w in weights.items()), 3)
        rows.append(row)
    return rows


def summarise(rows):
    """Per rule and regime: months, average excess over the basket, and months ahead/behind."""
    out = {}
    names = sorted({n for r in rows for n in r['rules']})
    for name in names:
        out[name] = {}
        for label in REGIMES + ('all months',):
            sample = [r for r in rows if label == 'all months' or regime(r['breadth']) == label]
            excess = [r['rules'][name] - r['basketPct'] for r in sample]
            out[name][label] = {'months': len(sample),
                                'averageExcessPct': round(sum(excess) / len(excess), 3) if excess else None,
                                'ahead': sum(e > 0 for e in excess), 'behind': sum(e < 0 for e in excess)}
    return out


def rules():
    import quant_advisor as qa
    chosen = {name: fn for name, (_, fn, once) in pd.RULES.items() if not once and name != 'equal-weight-monthly'}
    chosen['momentum-12-1-tilt'] = qa.momentum_tilt
    return chosen


def main(argv=None):
    argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter).parse_args(argv)
    dates, table = pd.aligned(daily.load(sorted(daily.datasets.UNIVERSE)))
    rows = monthly_rows(table, dates, rules())
    report = {'from': rows[0]['month'], 'through': rows[-1]['month'], 'months': len(rows),
              'regimeMonths': {label: sum(regime(r['breadth']) == label for r in rows) for label in REGIMES},
              'byRule': summarise(rows), 'rows': rows,
              'note': 'Gross monthly returns versus the equal-weight basket, grouped by breadth at the decision. Descriptive; '
                      'a regime-dependent edge is a hypothesis for a forward test, not proof.'}
    batch.save(OUT, report)
    print(f"{report['months']} months {report['from']}..{report['through']}; regimes: {report['regimeMonths']}")
    for name, by in report['byRule'].items():
        cells = '  '.join(f"{label.split(' (')[0]:>14s} {v['averageExcessPct']:+.2f}% ({v['ahead']}/{v['behind']})"
                          for label, v in by.items() if v['months'])
        print(f'  {name:26s} {cells}')


if __name__ == '__main__':
    main()
