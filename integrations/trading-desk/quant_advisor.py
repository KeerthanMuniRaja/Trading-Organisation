"""Quant advisor: skfolio's Hierarchical Risk Parity as a numerical specialist beside the language-model allocator.

The reference review (docs/reference-map.md) concluded: use the language model for judgement and specialist numerical
methods for portfolios. This module is that specialist. On each month's first trading day it fits skfolio's
HierarchicalRiskParity (variance, long-only, at most 25% per share, the allocator's own cap) to the last year of daily
returns up to that day's close. It also computes the 12-1 month momentum factor (the 12-month return skipping the latest
month), a standard factor from the Awesome Systematic Trading catalogue. Code computes both, so the 4B model never has
to do the arithmetic.
Uses:
  - advice for the allocator: per share, the advisor's weight and the 12-1 momentum, available on the decision day;
  - an entrant of its own: the advisor's weights traded through the same simulator, costs and capital as everything else.
No look-ahead: only closes up to the decision day are used, and a test proves it. Research only, no orders.
Run with the skfolio environment (it has skfolio; no downloads):
  integrations\\skfolio\\.venv\\Scripts\\python.exe integrations\\trading-desk\\quant_advisor.py evaluate --from 2022-10-03 --from 2024-10-01
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

ADVICE = daily.ROOT / '.local' / 'trading-desk' / 'quant-advisor'
WINDOW = 252
MAX_WEIGHT = 0.25


def returns_frame(table, dates, i, window=WINDOW):
    import pandas
    days = dates[max(0, i - window):i + 1]
    closes = pandas.DataFrame({s: [table[s][d]['closePaise'] for d in days] for s in sorted(table)}, index=days)
    return closes.pct_change().iloc[1:]


def hrp_weights(table, dates, i, window=WINDOW, max_weight=MAX_WEIGHT):
    """skfolio HRP weights from returns up to dates[i] only; {} until a full window exists."""
    if i < window:
        return {}
    from skfolio import RiskMeasure
    from skfolio.optimization import HierarchicalRiskParity
    frame = returns_frame(table, dates, i, window)
    model = HierarchicalRiskParity(risk_measure=RiskMeasure.VARIANCE, max_weights=max_weight).fit(frame)
    return {s: round(float(w), 6) for s, w in zip(frame.columns, model.weights_)}


def momentum_12_1(table, dates, i, symbol):
    """12-month return skipping the most recent month, in percent; None without a year of history."""
    if i < 252:
        return None
    return round((table[symbol][dates[i - 21]]['closePaise'] / table[symbol][dates[i - 252]]['closePaise'] - 1) * 100, 1)


def momentum_tilt(table, dates, i):
    """The catalogue's 12-1 momentum factor as a gentle tilt, fixed in advance: the stronger half of the shares 18.75%
    each, the weaker half 6.25% each. Equal weights until a year of history exists."""
    scores = {s: momentum_12_1(table, dates, i, s) for s in table}
    if any(v is None for v in scores.values()):
        return pd.equal_weight(table, dates, i)
    ranked = sorted(table, key=lambda s: (-scores[s], s))
    half = len(ranked) // 2
    return {s: (0.1875 if n < half else 0.0625) for n, s in enumerate(ranked)}


def advice(table, dates, i):
    """Per symbol: advisor weight (percent, rounded) and 12-1 momentum, for a decision at dates[i]'s close."""
    weights = hrp_weights(table, dates, i)
    return {s: {'advisorWeightPct': round(weights[s] * 100) if weights else None, 'momentum12m1mPct': momentum_12_1(table, dates, i, s)}
            for s in sorted(table)}


def evaluate(starts, cache=daily.DAILY, out=ADVICE):
    dates, table = pd.aligned(daily.load(sorted(daily.datasets.UNIVERSE), cache))
    report = {'advisor': 'skfolio HierarchicalRiskParity, variance, long-only, max 25% per share, 252-day window, monthly',
              'through': dates[-1], 'periods': {}}
    for start_date in starts:
        start = next(k for k, d in enumerate(dates) if d >= start_date)
        end = len(dates) - 1
        report['periods'][dates[start]] = {
            'quant-advisor-hrp': pd.simulate(table, dates, hrp_weights, start, end),
            'momentum-12-1-tilt': pd.simulate(table, dates, momentum_tilt, start, end),
            'basket-buy-and-hold': pd.simulate(table, dates, pd.equal_weight, start, end, once=True),
            'basket-monthly': pd.simulate(table, dates, pd.equal_weight, start, end),
            'inverse-volatility': pd.simulate(table, dates, pd.inverse_volatility, start, end)}
    out.mkdir(parents=True, exist_ok=True)
    batch.save(out / 'evaluation.json', report)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    e = sub.add_parser('evaluate')
    e.add_argument('--from', dest='starts', action='append', required=True, help='Repeatable start date YYYY-MM-DD')
    args = parser.parse_args(argv)
    report = evaluate(args.starts)
    for start, results in report['periods'].items():
        print(f'From {start} to {report["through"]}')
        for rule, res in sorted(results.items(), key=lambda kv: -kv[1]['netPaise']):
            print(f"  {rule:22s} net {res['netPaise'] / 100:>11,.0f}  CAGR {res['cagr']:>7.1%}  worst drawdown {res['maxDrawdown']:>6.1%}  "
                  f"volatility {res['annualVolatility']:>6.1%}  costs {res['costsPaise'] / 100:>7,.0f}")


if __name__ == '__main__':
    main()
