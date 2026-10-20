"""Does the forecast analyst know anything? Kronos forecasts against simple baselines, with no language model.

At every desk meeting bar (session clock, hourly) of the chosen weeks, each forecaster predicts the next hour.
Each forecaster is judged in three ways, and so are the baselines:
  1. Stance accuracy against the cost-aware truth used for every desk analyst (rose / fell / within 30 bps).
  2. Correlation between forecast and realised one-hour return.
  3. A simple paper-trading rule on the desk's book: buy when the forecast is bullish, exit when it no longer is,
     with the desk's 0.5% stop-loss, caps and costs.
Baselines: always neutral, a momentum rule on the last hour, and one-share buy-and-hold.
A fine-tuned forecaster is only evaluated on weeks that start after its training data ended.
Forecasts are cached per forecaster and dataset, so reruns cost nothing.
Run with the Kronos environment: .local\\kronos-venv\\Scripts\\python.exe integrations\\trading-desk\\forecast_eval.py
"""
from __future__ import annotations

import argparse
from datetime import date
import glob
import json
import math
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import desk  # noqa: E402
import forecast  # noqa: E402

CACHE = desk.ROOT / '.local' / 'trading-desk' / 'forecasts'
REPORTS = desk.ROOT / '.local' / 'trading-desk' / 'forecast-reports'
EVERY = 12


def truth(bps):
    return 'bullish' if bps > desk.COST_BPS_ROUND_TRIP else 'bearish' if bps < -desk.COST_BPS_ROUND_TRIP else 'neutral'


def momentum_stance(bars, i):
    return truth(desk.bps(bars[i]['closePaise'], bars[i - 11]['closePaise']))


def forecasts_for(forecaster, dataset, bars, cache=CACHE):
    """{index: expected bps or None} at every meeting bar; cached by forecaster name and dataset hash."""
    path = cache / forecaster.name.replace('@', '-') / f'{batch.dataset_key(dataset)}.json'
    if path.exists():
        return {int(k): v for k, v in json.loads(path.read_text(encoding='utf-8')).items()}
    out = {}
    for i in desk.meeting_points(bars, EVERY, 10_000):
        result = forecaster(bars, i)
        out[i] = None if result is None else result['expectedReturn1HourBps']
    path.parent.mkdir(parents=True, exist_ok=True)
    batch.save(path, {str(k): v for k, v in out.items()})
    return out


def trade(bars, signals):
    """Paper rule on the desk's book: enter on a bullish signal, exit when the signal is no longer bullish."""
    def decide(i, book):
        if book['position']:
            mark = desk.sell_fill(bars[i]['closePaise'])
            if mark - desk.fee(mark) - book['position']['costPaise'] <= -book['position']['costPaise'] * desk.STOP_LOSS_FRACTION:
                return 'sell'
        if i not in signals:
            return 'hold'
        bullish = signals[i] == 'bullish'
        if book['position']:
            return 'hold' if bullish else 'sell'
        if bullish and not desk.risk_officer(book, bars[i], desk.data_steward(bars, i)):
            return 'buy'
        return 'hold'
    result = desk.simulate(bars, decide)
    return {'netPaise': result['netPaise'], 'trades': len(result['trades'])}


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    return round(sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / (sx * sy), 3) if sx and sy else None


def ranks(values):
    order = sorted(range(len(values)), key=lambda k: values[k])
    out = [0.0] * len(values)
    k = 0
    while k < len(order):
        j = k
        while j + 1 < len(order) and values[order[j + 1]] == values[order[k]]:
            j += 1
        for m in range(k, j + 1):
            out[order[m]] = (k + j) / 2
        k = j + 1
    return out


def evaluate(paths, forecasters, cache=CACHE):
    arms = {name: {'n': 0, 'correct': 0, 'forecast': [], 'realised': [], 'netPaise': 0, 'trades': 0, 'abstained': 0}
            for name in ['always-neutral', 'momentum-rule'] + [f.name for f in forecasters]}
    windows, buy_and_hold = [], 0
    for path in paths:
        dataset = json.loads(Path(path).read_text(encoding='utf-8'))
        bars = desk.validate(dataset)
        points = desk.meeting_points(bars, EVERY, 10_000)
        realised = {i: desk.bps(bars[min(i + EVERY, len(bars) - 1)]['closePaise'], bars[i]['closePaise']) for i in points}
        stances = {'always-neutral': {i: 'neutral' for i in points}, 'momentum-rule': {i: momentum_stance(bars, i) for i in points}}
        expected = {'momentum-rule': {i: desk.bps(bars[i]['closePaise'], bars[i - 11]['closePaise']) for i in points}}
        for f in forecasters:
            values = forecasts_for(f, dataset, bars, cache)
            stances[f.name] = {i: forecast.opinion(v)['stance'] for i, v in values.items() if v is not None}
            expected[f.name] = {i: v for i, v in values.items() if v is not None}
            arms[f.name]['abstained'] += sum(v is None for v in values.values())
        row = {'symbol': dataset['symbol'], 'from': bars[0]['time'][:10], 'to': bars[-1]['time'][:10], 'meetings': len(points)}
        for name, by_bar in stances.items():
            arm = arms[name]
            for i, stance in by_bar.items():
                arm['n'] += 1
                arm['correct'] += stance == truth(realised[i])
            for i, value in expected.get(name, {}).items():
                arm['forecast'].append(value)
                arm['realised'].append(realised[i])
            result = trade(bars, by_bar)
            arm['netPaise'] += result['netPaise']
            arm['trades'] += result['trades']
            row[name] = result['netPaise']
        first = points[0] + 1 if points else len(bars) - 1
        cost = desk.buy_fill(bars[first]['openPaise']) + desk.fee(desk.buy_fill(bars[first]['openPaise']))
        mark = desk.sell_fill(bars[-1]['closePaise'])
        row['buyAndHold'] = mark - desk.fee(mark) - cost
        buy_and_hold += row['buyAndHold']
        windows.append(row)
    summary = {}
    for name, arm in arms.items():
        summary[name] = {'judged': arm['n'], 'abstained': arm['abstained'],
                         'stanceAccuracy': round(arm['correct'] / arm['n'], 3) if arm['n'] else None,
                         'pearson': pearson(arm['forecast'], arm['realised']),
                         'spearman': pearson(ranks(arm['forecast']), ranks(arm['realised'])) if arm['forecast'] else None,
                         'paperRuleNetPaise': arm['netPaise'], 'paperRuleTrades': arm['trades']}
    return {'arms': summary, 'buyAndHoldPaise': buy_and_hold, 'windows': windows,
            'truthDefinition': f'next {EVERY} bars close-to-close beyond +/-{desk.COST_BPS_ROUND_TRIP} bps',
            'interpretation': 'Descriptive; few weeks of a few shares. A forecaster earns a desk seat only by beating '
                              'always-neutral on accuracy and the momentum rule on correlation, on weeks it never trained on.'}


def select(symbols, start):
    paths = []
    for symbol in symbols:
        for path in sorted(glob.glob(str(desk.ROOT / '.local' / 'trading-desk' / 'datasets' / f'{symbol}-5m-*.json'))):
            end = date.fromisoformat(Path(path).stem.rsplit('-5m-', 1)[1])
            if start is None or end.toordinal() - 7 >= start.toordinal():
                paths.append(path)
    return paths


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--forecaster', action='append', required=True, help='Kronos-mini, Kronos-small or finetuned:NAME')
    parser.add_argument('--symbol', action='append', choices=sorted(desk.UNIVERSE), help='Repeatable; default all')
    parser.add_argument('--from', dest='start', type=date.fromisoformat, help='Only weeks starting on or after this date')
    parser.add_argument('--samples', type=int, default=5, choices=range(1, 21))
    parser.add_argument('--name', required=True, help='Report name')
    args = parser.parse_args(argv)
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,60}', args.name):
        raise SystemExit('Report name: letters, digits, _ or -')
    forecasters = []
    for spec in args.forecaster:
        if spec.startswith('finetuned:'):
            manifest = json.loads((forecast.KRONOS / 'finetuned' / spec[10:] / 'manifest.json').read_text(encoding='utf-8'))
            if args.start is None or args.start.isoformat() < manifest['validatedThroughExclusive']:
                raise SystemExit(f'{spec} trained and was selected on data up to {manifest["validatedThroughExclusive"]}; '
                                 f'pass --from on or after that date so it is only tested on unseen weeks')
        forecasters.append(forecast.build(spec, samples=args.samples))
    paths = select(args.symbol or sorted(desk.UNIVERSE), args.start)
    if not paths:
        raise SystemExit('No cached weeks match; run datasets.py first')
    report = evaluate(paths, forecasters)
    report.update(forecasters={f.name: spec for f, spec in zip(forecasters, args.forecaster)}, weeks=len(paths),
                  start=args.start.isoformat() if args.start else None, samplesAveraged=args.samples)
    REPORTS.mkdir(parents=True, exist_ok=True)
    batch.save(REPORTS / f'{args.name}.json', report)
    print(json.dumps({k: v for k, v in report.items() if k != 'windows'}, indent=2))


if __name__ == '__main__':
    main()
