"""Portfolio and risk research on daily bars: how to hold the whole universe without deep losses. Research only.

Every portfolio rule decides target weights on the first trading day of each month, from completed days only,
and trades at the next day's open with integer shares, sells before buys, and the same delivery costs as daily.py
(including the depository charge on every sell). Capital is Rs 4,00,000 (8 x Rs 50,000) to match daily.py.

Honesty: the daily tournament has already used every past period, so these results are labelled `seen`. They
describe; they do not prove. The only clean test is `register` + `forward`: rules frozen by fingerprint and scored
only on days after registration, exactly as in daily.py.
Run with the replay environment: .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\portfolio_daily.py report
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import inspect
import json
import math
from pathlib import Path
import re
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import daily  # noqa: E402

CAPITAL = 40_000_000  # Rs 4,00,000
REPORTS = daily.ROOT / '.local' / 'trading-desk' / 'portfolio-reports'
FORWARD = daily.ROOT / '.local' / 'trading-desk' / 'portfolio-forward'


# ---------- data ----------
def aligned(all_bars):
    """Only days every share traded, so every weight can be acted on."""
    common = set.intersection(*({b['date'] for b in bars} for bars in all_bars.values()))
    return sorted(common), {s: {b['date']: b for b in bars if b['date'] in common} for s, bars in all_bars.items()}


# ---------- rules: weights(history) -> {symbol: weight}, using completed days only ----------
def closes(table, symbol, dates, i, n):
    return [table[symbol][d]['closePaise'] for d in dates[max(0, i - n + 1):i + 1]]


def equal_weight(table, dates, i):
    return {s: 1 / len(table) for s in table}


def inverse_volatility(table, dates, i, window=60):
    vols = {}
    for s in table:
        c = closes(table, s, dates, i, window + 1)
        if len(c) <= window:
            return equal_weight(table, dates, i)
        vols[s] = statistics.pstdev([math.log(c[k] / c[k - 1]) for k in range(1, len(c))]) or 1e-9
    inv = {s: 1 / v for s, v in vols.items()}
    total = sum(inv.values())
    return {s: v / total for s, v in inv.items()}


def top_momentum(table, dates, i, months=6, keep=3):
    days = 21 * months
    if i < days:
        return {}
    ranked = sorted(table, key=lambda s: table[s][dates[i]]['closePaise'] / table[s][dates[i - days]]['closePaise'], reverse=True)
    return {s: 1 / keep for s in ranked[:keep]}


def trend_filtered(table, dates, i, window=200):
    """Equal weight while an equal-weight index of the universe is above its 200-day average; otherwise cash."""
    if i < window:
        return {}
    index = [sum(table[s][dates[k]]['closePaise'] / table[s][dates[0]]['closePaise'] for s in table) for k in range(i - window + 1, i + 1)]
    return equal_weight(table, dates, i) if index[-1] >= sum(index) / window else {}


def cash_only(table, dates, i):
    return {}


RULES = {
    'cash': ('Holds cash', cash_only, False),
    'buy-and-hold-equal': ('Equal amounts on day one, never rebalanced', equal_weight, True),
    'equal-weight-monthly': ('Equal weights, rebalanced monthly', equal_weight, False),
    'inverse-volatility': ('Weights inversely proportional to 60-day volatility, monthly', inverse_volatility, False),
    'top3-momentum-6m': ('The 3 strongest shares over 6 months, equal weights, monthly', top_momentum, False),
    'equal-weight-trend-filter': ('Equal weights while the universe is above its 200-day average, else cash', trend_filtered, False),
}
BASELINES = ('cash', 'buy-and-hold-equal')


# ---------- simulation ----------
def simulate(table, dates, rule, start, end, once=False, capital=CAPITAL):
    """Trades on dates[start..end]; monthly decisions at the close fill at the next open; closes out at the end."""
    cash, qty, pending = capital, {s: 0 for s in table}, None
    peak, max_dd, curve, costs_paid, fills = capital, 0.0, [], 0, 0
    for i in range(start, end + 1):
        day = dates[i]
        if pending is not None:
            equity = cash + sum(qty[s] * table[s][day]['openPaise'] for s in table)
            target = {s: int(pending.get(s, 0) * equity // table[s][day]['openPaise']) for s in table}
            for s in table:  # sells first, so their cash can fund buys
                if target[s] < qty[s]:
                    value = int((qty[s] - target[s]) * table[s][day]['openPaise'] * (10000 - daily.SLIPPAGE_BPS) / 10000)
                    cost = daily.sell_costs(value)
                    cash, costs_paid, fills, qty[s] = cash + value - cost, costs_paid + cost, fills + 1, target[s]
            for s in table:
                if target[s] > qty[s]:
                    price = table[s][day]['openPaise'] * (10000 + daily.SLIPPAGE_BPS) / 10000
                    q = target[s] - qty[s]
                    while q > 0 and daily.ceil_paise(q * price) + daily.buy_costs(daily.ceil_paise(q * price)) > cash:
                        q -= 1
                    if q:
                        value = daily.ceil_paise(q * price)
                        cost = daily.buy_costs(value)
                        cash, costs_paid, fills, qty[s] = cash - value - cost, costs_paid + cost, fills + 1, qty[s] + q
            pending = None
        first_of_month = i == start or day[:7] != dates[i - 1][:7]
        if i < end and first_of_month and not (once and i > start):
            pending = rule(table, dates, i)
        equity = cash + sum(qty[s] * table[s][day]['closePaise'] for s in table)
        peak, curve = max(peak, equity), curve + [equity]
        max_dd = max(max_dd, (peak - equity) / peak)
    for s in table:  # close out at the final close with full sell costs
        if qty[s]:
            value = int(qty[s] * table[s][dates[end]]['closePaise'] * (10000 - daily.SLIPPAGE_BPS) / 10000)
            cost = daily.sell_costs(value)
            cash, costs_paid, fills = cash + value - cost, costs_paid + cost, fills + 1
    returns = [curve[k] / curve[k - 1] - 1 for k in range(1, len(curve))]
    years = max((end - start) / 252, 1 / 252)
    return {'netPaise': cash - capital, 'cagr': round((cash / capital) ** (1 / years) - 1, 4), 'maxDrawdown': round(max_dd, 4),
            'annualVolatility': round(statistics.pstdev(returns) * math.sqrt(252), 4) if len(returns) > 1 else None,
            'costsPaise': costs_paid, 'fills': fills}


def evaluate(all_bars, period, last_period=False):
    dates, table = aligned(all_bars)
    start = next((k for k, d in enumerate(dates) if d >= period[0]), len(dates))
    end = len(dates) - 1 if last_period else max(k for k, d in enumerate(dates) if d < period[1])
    if end - start < 1:
        return None
    return {name: simulate(table, dates, fn, start, end, once=once) for name, (_, fn, once) in RULES.items()}


def rules_fingerprint():
    digest = hashlib.sha256(daily.rules_fingerprint().encode())  # shares daily.py's cost model
    for part in (aligned, closes, equal_weight, inverse_volatility, top_momentum, trend_filtered, cash_only, simulate):
        digest.update(inspect.getsource(part).encode())
    digest.update(json.dumps({'rules': sorted(RULES), 'capital': CAPITAL}).encode())
    return digest.hexdigest()[:16]


def report(symbols=None, cache=daily.DAILY, out=REPORTS):
    all_bars = daily.load(symbols or sorted(daily.datasets.UNIVERSE), cache)
    if not all_bars:
        raise ValueError('No daily data; run daily.py fetch first')
    cut = daily.periods(all_bars)
    result = {'generatedAt': datetime.now(timezone.utc).isoformat(), 'status': 'seen',
              'note': 'Every period here was already seen by the daily tournament: descriptive, not proof.',
              'capitalPaise': CAPITAL, 'periods': cut,
              'results': {name: evaluate(all_bars, p, last_period=(name == 'sealed')) for name, p in cut.items()}}
    full = (cut['train'][0], cut['sealed'][1])
    result['results']['all'] = evaluate(all_bars, full, last_period=True)
    out.mkdir(parents=True, exist_ok=True)
    batch.save(out / 'latest.json', result)
    return result


def register(name, root=FORWARD, cache=daily.DAILY):
    all_bars = daily.load(sorted(daily.datasets.UNIVERSE), cache)
    if not all_bars:
        raise ValueError('No daily data; run daily.py fetch first')
    path = root / f'{name}.json'
    if path.exists():
        raise ValueError('A forward test with this name exists; choose a new name')
    record = {'name': name, 'registeredAt': datetime.now(timezone.utc).isoformat(), 'startAfter': max(b[-1]['date'] for b in all_bars.values()),
              'rules': rules_fingerprint(), 'symbols': sorted(all_bars), 'capitalPaise': CAPITAL}
    root.mkdir(parents=True, exist_ok=True)
    batch.save(path, record)
    return record


def forward(name, root=FORWARD, cache=daily.DAILY):
    record = json.loads((root / f'{name}.json').read_text(encoding='utf-8'))
    if rules_fingerprint() != record['rules']:
        raise ValueError('The rules changed after registration; this forward test has ended. Register a new one.')
    all_bars = daily.load(record['symbols'], cache)
    dates, _ = aligned(all_bars)
    days = [d for d in dates if d > record['startAfter']]
    if len(days) < 2:
        return {'name': name, 'status': 'waiting', 'startAfter': record['startAfter']}
    return {'name': name, 'status': 'running', 'startAfter': record['startAfter'], 'through': days[-1], 'tradingDays': len(days),
            'results': evaluate(all_bars, (days[0], days[-1]), last_period=True)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('report')
    for command in ('register', 'forward'):
        sub.add_parser(command).add_argument('--name', required=True)
    args = parser.parse_args(argv)
    if args.command == 'report':
        result = report()
        for period, rows in result['results'].items():
            print(f"\n{period} ({'to ' + result['periods'][period][1] if period in result['periods'] else 'all five years'})")
            for name, r in sorted((rows or {}).items(), key=lambda kv: -kv[1]['netPaise']):
                print(f"  {name:28s} net {r['netPaise'] / 100:>12,.0f}  CAGR {r['cagr']:>7.1%}  worst drawdown {r['maxDrawdown']:>6.1%}  "
                      f"costs {r['costsPaise'] / 100:>8,.0f}  fills {r['fills']}")
        return
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,60}', args.name):
        raise SystemExit('Name: letters, digits, _ or -')
    print(json.dumps(register(args.name) if args.command == 'register' else forward(args.name), indent=2))


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
