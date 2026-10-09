"""Strategy tournament with a sealed test: the desk's hackathon. Research only; no model, no orders.

Registered entrants (simple, fully specified rules) compete on cached 5-minute weeks of the desk's universe.
Weeks are split by date, never shuffled: training (explore), validation (select) and a sealed test (judge once).
  1. `run`       scores every entrant on training and validation, with the desk's exact book, costs and caps.
                 One winner is selected on validation only, and only if it beat holding cash there.
  2. `finalise`  scores that single winner, with the cash and momentum baselines, on the sealed weeks. It runs once
                 per tournament: a second call, or a call after the entrants or data changed, is refused.
Every entrant's results are kept, including losers, so the number of ideas tried is visible: picking the best of
many on the same data inflates results, which is why only the sealed weeks may be quoted as evidence.
Run: integrations\\skfolio\\.venv\\Scripts\\python.exe integrations\\trading-desk\\tournament.py run --name t1
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import glob
import hashlib
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import desk  # noqa: E402

DATASETS = desk.ROOT / '.local' / 'trading-desk' / 'datasets'
TOURNAMENTS = desk.ROOT / '.local' / 'trading-desk' / 'tournaments'
HOLD_BARS = 12        # every entrant exits after at most one hour
FLAT_BY_MINUTES = 15  # and is flat before the last 15 minutes of the session (no overnight gap risk)


# ---------- entrants: entry signals on completed bars only ----------
def momentum(lookback, threshold):
    return lambda bars, i: i >= lookback and desk.bps(bars[i]['closePaise'], bars[i - lookback]['closePaise']) > threshold


def reversion(distance):
    return lambda bars, i: desk.reversion_view(bars, i)['distanceFromVwapBps'] < -distance


def breakout(lookback):
    def signal(bars, i):
        start = desk.session(bars, i)
        return i - start >= lookback and bars[i]['closePaise'] > max(b['highPaise'] for b in bars[i - lookback:i])
    return signal


ENTRANTS = {
    'cash': ('Never trades', None),
    **{f'momentum-{lb}b-{th}bps': (f'Buy when the last {lb} bars rose more than {th} bps', momentum(lb, th))
       for lb in (6, 12, 24) for th in (20, 40)},
    **{f'reversion-vwap-{d}bps': (f'Buy when price is more than {d} bps below the session VWAP', reversion(d)) for d in (40, 80)},
    **{f'breakout-{lb}b': (f'Buy when the close exceeds the high of the previous {lb} bars', breakout(lb)) for lb in (12, 24)},
}


def decider(bars, signal):
    """Shared exits and limits for every entrant: 0.5% stop, one-hour time exit, flat before the close,
    and the desk's loss limit, trade cap and position cap. Entries need an hour of the session first."""
    def decide(i, book):
        if book['position']:
            mark = desk.sell_fill(bars[i]['closePaise'])
            stopped = mark - desk.fee(mark) - book['position']['costPaise'] <= -book['position']['costPaise'] * desk.STOP_LOSS_FRACTION
            if stopped or i - book['position']['entryIndex'] >= HOLD_BARS or desk.minutes_to_close(bars[i]) < FLAT_BY_MINUTES:
                return 'sell'
            return 'hold'
        if (signal is None or i - desk.session(bars, i) < desk.WARMUP - 1 or desk.minutes_to_close(bars[i]) < 30
                or book['realised'] <= desk.LOSS_LIMIT or len(book['trades']) >= desk.MAX_TRADES or bars[i]['volume'] <= 0):
            return 'hold'
        return 'buy' if signal(bars, i) else 'hold'
    return decide


# ---------- data and splits ----------
def weeks(symbols, cache=DATASETS):
    """{week end: [(symbol, bars)]}, every cached week of the chosen symbols."""
    out = {}
    for symbol in symbols:
        for path in sorted(glob.glob(str(cache / f'{symbol}-5m-*.json'))):
            end = Path(path).stem.rsplit('-5m-', 1)[1]
            out.setdefault(end, []).append((symbol, desk.validate(json.loads(Path(path).read_text(encoding='utf-8')))))
    return dict(sorted(out.items()))


def split(ends, validation, sealed):
    """Chronological: the oldest weeks train, the next validate, the newest are sealed."""
    if len(ends) < validation + sealed + 1:
        raise ValueError(f'Need at least {validation + sealed + 1} weeks; have {len(ends)}')
    return {'train': ends[:-(validation + sealed)], 'validation': ends[-(validation + sealed):-sealed], 'sealed': ends[-sealed:]}


def score(entrant, data, ends):
    signal = ENTRANTS[entrant][1]
    total = trades = profitable = windows = 0
    for end in ends:
        for _, bars in data[end]:
            result = desk.simulate(bars, decider(bars, signal))
            total += result['netPaise']
            trades += len(result['trades'])
            profitable += result['netPaise'] > 0
            windows += 1
    return {'netPaise': total, 'trades': trades, 'profitableWindows': profitable, 'windows': windows}


def momentum_baseline(data, ends):
    """The replay's own momentum rule, for reference on the sealed weeks."""
    total = trades = 0
    for end in ends:
        for _, bars in data[end]:
            result = desk.simulate(bars, desk.momentum_decider(bars))
            total, trades = total + result['netPaise'], trades + len(result['trades'])
    return {'netPaise': total, 'trades': trades}


def fingerprint(data):
    """Binds a tournament to its exact entrants and data."""
    digest = hashlib.sha256(json.dumps(sorted(ENTRANTS)).encode())
    digest.update(Path(__file__).read_bytes())
    for end, items in data.items():
        for symbol, bars in items:
            digest.update(f'{end}{symbol}{len(bars)}{bars[0]["time"]}{bars[-1]["closePaise"]}'.encode())
    return digest.hexdigest()[:16]


# ---------- the two stages ----------
def run(name, symbols, validation=2, sealed=2, root=TOURNAMENTS, cache=DATASETS):
    data = weeks(symbols, cache)
    parts = split(list(data), validation, sealed)
    results = {e: {'description': ENTRANTS[e][0], 'train': score(e, data, parts['train']), 'validation': score(e, data, parts['validation'])}
               for e in ENTRANTS}
    best = max((e for e in ENTRANTS if e != 'cash'), key=lambda e: (results[e]['validation']['netPaise'], e))
    winner = best if results[best]['validation']['netPaise'] > results['cash']['validation']['netPaise'] else None
    record = {'name': name, 'createdAt': datetime.now(timezone.utc).isoformat(), 'fingerprint': fingerprint(data), 'symbols': symbols,
              'split': parts, 'entrantsTried': len(ENTRANTS), 'results': results, 'winner': winner,
              'selectionRule': 'highest validation net after costs; must beat holding cash on validation',
              'note': 'Training and validation numbers are exploratory: the best of many tries looks better than it is.'}
    directory = root / name
    if (directory / 'tournament.json').exists():
        raise ValueError('A tournament with this name exists; choose a new name')
    directory.mkdir(parents=True)
    batch.save(directory / 'tournament.json', record)
    return record


def finalise(name, root=TOURNAMENTS, cache=DATASETS):
    directory = root / name
    record = json.loads((directory / 'tournament.json').read_text(encoding='utf-8'))
    if (directory / 'sealed.json').exists():
        raise ValueError('The sealed weeks were already used for this tournament; they cannot be judged twice')
    data = weeks(record['symbols'], cache)
    if fingerprint(data) != record['fingerprint']:
        raise ValueError('Entrants or data changed since selection; start a new tournament')
    ends = record['split']['sealed']
    outcome = {'judgedAt': datetime.now(timezone.utc).isoformat(), 'weeks': ends, 'cash': score('cash', data, ends),
               'momentumBaseline': momentum_baseline(data, ends), 'winner': record['winner']}
    if record['winner']:
        outcome['winnerResult'] = score(record['winner'], data, ends)
        outcome['verdict'] = 'beat-cash-on-sealed-weeks' if outcome['winnerResult']['netPaise'] > 0 else 'failed-on-sealed-weeks'
    else:
        outcome['verdict'] = 'no-entrant-qualified'
    batch.save(directory / 'sealed.json', outcome)
    return outcome


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    r = sub.add_parser('run')
    r.add_argument('--name', required=True)
    r.add_argument('--symbol', action='append', choices=sorted(desk.UNIVERSE), help='Repeatable; default all')
    r.add_argument('--validation-weeks', type=int, default=2, choices=range(1, 5))
    r.add_argument('--sealed-weeks', type=int, default=2, choices=range(1, 5))
    f = sub.add_parser('finalise')
    f.add_argument('--name', required=True)
    args = parser.parse_args(argv)
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,60}', args.name):
        raise SystemExit('Name: letters, digits, _ or -')
    if args.command == 'run':
        record = run(args.name, args.symbol or sorted(desk.UNIVERSE), args.validation_weeks, args.sealed_weeks)
        for entrant, res in sorted(record['results'].items(), key=lambda kv: -kv[1]['validation']['netPaise']):
            print(f"{entrant:24s} train {res['train']['netPaise'] / 100:>9.2f}  validation {res['validation']['netPaise'] / 100:>9.2f}  "
                  f"({res['validation']['trades']} fills)")
        print(f"winner: {record['winner'] or 'none (nothing beat cash on validation)'}")
    else:
        print(json.dumps(finalise(args.name), indent=2))


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
