"""Daily-bar research: does any simple rule beat holding the share, after realistic delivery costs, over years?

The 5-minute work showed that ~30 bps per round trip swamps every intraday signal. Daily bars move far more than
costs and give years of history, so results can mean something. This module mirrors the 5-minute tournament:
  fetch     owner-run, one-time: up to 5 years of adjusted daily bars per universe share (the only network step)
  run       scores every entrant on chronological training and validation periods; selects one winner on
            validation only, and only if it beat BOTH holding cash and buy-and-hold there
  finalise  judges that winner once on the sealed final period, next to cash and buy-and-hold
Costs model an Indian equity delivery trade on a discount broker (illustrative; confirm with your broker):
STT 0.1% each side, stamp duty 0.015% on buys, exchange 0.00297%, SEBI 0.0001%, GST 18% on exchange and SEBI fees,
a Rs 15.93 depository charge per sell, and 5 bps slippage each side. Fills are at the next day's open.
Research only: no orders, no wallets, no trading authority. Adjusted prices fold dividends into returns.
"""
from __future__ import annotations

import argparse
from bisect import bisect_left
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
import math
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import datasets  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DAILY = ROOT / '.local' / 'trading-desk' / 'daily'
TOURNAMENTS = ROOT / '.local' / 'trading-desk' / 'daily-tournaments'
CAPITAL = 5_000_000           # Rs 50,000 notional per share, so the fixed depository charge is realistic
SLIPPAGE_BPS = 5
STT_BPS, STAMP_BUY_BPS, EXCHANGE_BPS, SEBI_BPS, GST = 10.0, 1.5, 0.297, 0.01, 0.18
DP_PER_SELL_PAISE = 1593


# ---------- costs ----------
def ceil_paise(value):
    return int(math.ceil(value - 1e-9))


def buy_costs(value):
    fees = value * (EXCHANGE_BPS + SEBI_BPS) / 10000
    return ceil_paise(value * (STT_BPS + STAMP_BUY_BPS) / 10000 + fees * (1 + GST))


def sell_costs(value):
    fees = value * (EXCHANGE_BPS + SEBI_BPS) / 10000
    return ceil_paise(value * STT_BPS / 10000 + fees * (1 + GST)) + DP_PER_SELL_PAISE


# ---------- data ----------
def validate(dataset):
    if (dataset.get('schemaVersion') != 1 or dataset.get('symbol') not in datasets.UNIVERSE or dataset.get('interval') != '1d'
            or dataset.get('priceBasis') != 'adjusted' or dataset.get('source') not in ('yahoo-via-yfinance', 'synthetic-test')):
        raise ValueError('INVALID_DAILY_METADATA')
    bars = dataset.get('bars')
    if not isinstance(bars, list) or len(bars) < 60:
        raise ValueError('INVALID_DAILY_BAR_COUNT')
    previous = None
    for b in bars:
        day = date.fromisoformat(b['date'])
        if previous and day <= previous:  # weekends are allowed: NSE holds special sessions (e.g. Muhurat, Budget day)
            raise ValueError('INVALID_DAILY_ORDER')
        prices = [b.get(k) for k in ('openPaise', 'highPaise', 'lowPaise', 'closePaise')]
        if not all(type(p) is int and 0 < p <= 100_000_000 for p in prices) or not prices[2] <= min(prices[0], prices[3]) <= max(prices[0], prices[3]) <= prices[1]:
            raise ValueError('INVALID_DAILY_PRICE')
        if type(b.get('volume')) is not int or b['volume'] < 0:
            raise ValueError('INVALID_DAILY_VOLUME')
        previous = day
    return bars


def settled_only(bars, now):
    """Drops today's bar while its session is unfinished (before 16:00 IST: 15:30 close plus 30 minutes to settle). The
    provider serves the running session as a daily bar during market hours; stored, it would later pass as a close."""
    india = now + timedelta(hours=5, minutes=30)
    if bars and bars[-1]['date'] == india.date().isoformat() and (india.hour, india.minute) < (16, 0):
        return bars[:-1]
    return bars


def fetch(symbols, years=5, cache=DAILY, refresh=False):
    """Owner-run download of adjusted daily bars. Existing files are kept unless `refresh` re-downloads them
    (needed to score forward tests on new days; adjusted history may shift slightly after new dividends)."""
    import yfinance as yf
    cache.mkdir(parents=True, exist_ok=True)
    yf.set_tz_cache_location(str(ROOT / '.local' / 'market-replay-cache'))
    results = []
    for symbol in symbols:
        path = cache / f'{symbol}-1d.json'
        if path.exists() and not refresh:
            results.append({'symbol': symbol, 'state': 'cached', 'bars': len(validate(json.loads(path.read_text(encoding='utf-8'))))})
            continue
        ticker = yf.Ticker(symbol)
        frame = ticker.history(period=f'{years}y', interval='1d', auto_adjust=True, actions=False, timeout=20)
        if frame.empty:
            results.append({'symbol': symbol, 'state': 'skipped', 'reason': 'EMPTY_PROVIDER_DATA'})
            continue
        datasets.check_metadata(ticker, symbol)

        def paise(value):
            return int((Decimal(str(float(value))) * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
        bars = []
        for index, row in frame.iterrows():
            if not all(math.isfinite(float(row[k])) for k in ('Open', 'High', 'Low', 'Close', 'Volume')):
                continue  # a provider gap is left out, never invented
            o, h, low, c = (paise(row[k]) for k in ('Open', 'High', 'Low', 'Close'))
            # Adjustment and rounding can break OHLC order by a paisa; restore the envelope without moving open/close.
            bars.append({'date': index.date().isoformat(), 'openPaise': o, 'highPaise': max(h, o, c), 'lowPaise': min(low, o, c),
                         'closePaise': c, 'volume': int(row['Volume'])})
        bars = settled_only(bars, datetime.now(timezone.utc))
        dataset = {'schemaVersion': 1, 'symbol': symbol, 'interval': '1d', 'priceBasis': 'adjusted', 'source': 'yahoo-via-yfinance',
                   'providerVersion': yf.__version__, 'retrievedAt': datetime.now(timezone.utc).isoformat(), 'bars': bars}
        validate(dataset)
        results.append(store(path, dataset, cache))
    return results


def accepted_moves(cache=DAILY):
    """{symbol: [session dates]} of large moves the owner checked against the news and confirmed as real."""
    path = cache / 'accepted-moves.json'
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}


def accept_move(symbol, day, cache=DAILY):
    """Owner step after a refresh was kept back for an extreme move: confirm the move is real (results, news, a crash)
    so the next refresh is accepted. Only that one session is confirmed."""
    if symbol not in datasets.UNIVERSE:
        raise ValueError('SYMBOL_NOT_IN_UNIVERSE')
    date.fromisoformat(day)
    moves = accepted_moves(cache)
    moves[symbol] = sorted(set(moves.get(symbol, [])) | {day})
    (cache / 'accepted-moves.json').write_text(json.dumps(moves, indent=2), encoding='utf-8')
    return moves[symbol]


def store(path, dataset, cache=DAILY):
    """The data steward decides: a rejected download leaves the previous file in place (fail closed); an accepted one
    archives the version it replaces, by fingerprint, so earlier results stay reproducible."""
    import data_steward
    old = json.loads(path.read_text(encoding='utf-8')) if path.exists() else None
    peers = [json.loads(p.read_text(encoding='utf-8')) for p in sorted(cache.glob('*-1d.json')) if p != path]
    quality = data_steward.review(dataset, old, peers, accepted=accepted_moves(cache).get(dataset['symbol'], []))
    bars = dataset['bars']
    summary = {'symbol': dataset['symbol'], 'bars': len(bars), 'from': bars[0]['date'], 'to': bars[-1]['date'],
               'quality': quality['verdict'], 'fingerprint': quality['fingerprint']}
    if quality['verdict'] == 'reject':
        return {**summary, 'state': 'kept-previous' if old else 'rejected', 'issues': quality['issues']}
    if old and data_steward.fingerprint(old) != quality['fingerprint']:
        summary['archived'] = data_steward.archive(path, old, cache / 'history').name
    path.write_text(json.dumps(dataset), encoding='utf-8')
    return {**summary, 'state': 'downloaded', **({'warnings': quality['issues']} if quality['issues'] else {})}


def load(symbols, cache=DAILY):
    out = {}
    for symbol in symbols:
        path = cache / f'{symbol}-1d.json'
        if path.exists():
            out[symbol] = validate(json.loads(path.read_text(encoding='utf-8')))
    return out


# ---------- simulation ----------
def simulate(bars, decide, start, end, capital=CAPITAL):
    """Trades only on bars[start..end] (signals may use earlier history); flat after `end`. Fills at the next open."""
    cash, qty, cost, pending, trades = capital, 0, 0, None, 0
    peak, max_drawdown = capital, 0.0
    for i in range(start, end + 1):
        bar = bars[i]
        if pending == 'buy' and qty == 0:
            fill = bar['openPaise'] * (10000 + SLIPPAGE_BPS) / 10000
            q = int(cash // (fill * (1 + (STT_BPS + STAMP_BUY_BPS + EXCHANGE_BPS) / 10000) + 1))
            while q > 0 and ceil_paise(q * fill) + buy_costs(ceil_paise(q * fill)) > cash:
                q -= 1  # the exact rounded value and its costs must fit in cash
            if q > 0:
                value = ceil_paise(q * fill)
                cash -= value + buy_costs(value)
                qty, cost, trades = q, value, trades + 1
        elif pending == 'sell' and qty:
            value = int(qty * bar['openPaise'] * (10000 - SLIPPAGE_BPS) / 10000)
            cash += value - sell_costs(value)
            qty, trades = 0, trades + 1
        pending = None
        if i < end:
            action = decide(i, qty > 0)
            if action == 'buy' and not qty or action == 'sell' and qty:
                pending = action
        equity = cash + qty * bar['closePaise']
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, (peak - equity) / peak)
    if qty:  # close out at the final close, with full sell costs
        value = int(qty * bars[end]['closePaise'] * (10000 - SLIPPAGE_BPS) / 10000)
        cash += value - sell_costs(value)
        trades += 1
    return {'netPaise': cash - capital, 'trades': trades, 'maxDrawdown': round(max_drawdown, 4)}


# ---------- entrants: decide(i, holding) on completed days only ----------
def sma_table(bars):
    prefix = [0]
    for b in bars:
        prefix.append(prefix[-1] + b['closePaise'])
    return lambda i, n: (prefix[i + 1] - prefix[i + 1 - n]) / n if i + 1 >= n else None


def cash(bars):
    return lambda i, holding: 'hold'


def buy_and_hold(bars):
    return lambda i, holding: 'hold' if holding else 'buy'


def momentum(months):
    days = 21 * months

    def make(bars):
        def decide(i, holding):
            if i < days or (i > 0 and bars[i]['date'][:7] == bars[i - 1]['date'][:7]):
                return 'hold'  # rebalance on the first trading day of each month only
            up = bars[i]['closePaise'] > bars[i - days]['closePaise']
            return 'buy' if up and not holding else 'sell' if not up and holding else 'hold'
        return decide
    return make


def ma_cross(fast, slow):
    def make(bars):
        sma = sma_table(bars)

        def decide(i, holding):
            f, s = sma(i, fast), sma(i, slow)
            if s is None:
                return 'hold'
            return 'buy' if f > s and not holding else 'sell' if f < s and holding else 'hold'
        return decide
    return make


def reversal(days, drop_pct):
    def make(bars):
        entered = {}

        def decide(i, holding):
            if holding:
                return 'sell' if i - entered.get('at', i) >= days else 'hold'
            if i >= days and bars[i]['closePaise'] < bars[i - days]['closePaise'] * (1 - drop_pct / 100):
                entered['at'] = i
                return 'buy'
            return 'hold'
        return decide
    return make


def near_high(weeks):
    days = 5 * weeks

    def make(bars):
        def decide(i, holding):
            if i < days:
                return 'hold'
            high = max(b['highPaise'] for b in bars[i - days + 1:i + 1])
            close = bars[i]['closePaise']
            return 'buy' if close >= high * 0.95 and not holding else 'sell' if close < high * 0.90 and holding else 'hold'
        return decide
    return make


ENTRANTS = {
    'cash': ('Never trades', cash),
    'buy-and-hold': ('Buys once and holds', buy_and_hold),
    **{f'momentum-{m}m': (f'Holds when the last {m} months rose; rebalances monthly', momentum(m)) for m in (3, 6, 12)},
    **{f'ma-{f}-{s}': (f'Holds while the {f}-day average is above the {s}-day average', ma_cross(f, s)) for f, s in ((20, 100), (50, 200))},
    **{f'reversal-{d}d-{p}pct': (f'Buys after a {p}% fall over {d} days; sells {d} days later', reversal(d, p)) for d, p in ((5, 5), (10, 8))},
    'near-52w-high': ('Holds within 5% of the 52-week high; exits 10% below it', near_high(52)),
}
BASELINES = ('cash', 'buy-and-hold')


# ---------- tournament ----------
def periods(all_bars, validation_years=1, sealed_years=1):
    """Chronological date cut points over the common calendar: train | validation | sealed."""
    last = max(bars[-1]['date'] for bars in all_bars.values())
    first = min(bars[0]['date'] for bars in all_bars.values())
    y, m, d = map(int, last.split('-'))
    sealed_from = date(y - sealed_years, m, min(d, 28)).isoformat()
    validation_from = date(y - sealed_years - validation_years, m, min(d, 28)).isoformat()
    if validation_from <= first:
        raise ValueError('Not enough history for this split')
    return {'train': (first, validation_from), 'validation': (validation_from, sealed_from), 'sealed': (sealed_from, last)}


def span(bars, period, last_period=False):
    dates = [b['date'] for b in bars]
    start = bisect_left(dates, period[0])
    end = (len(dates) - 1) if last_period else bisect_left(dates, period[1]) - 1
    return start, end


def score(entrant, all_bars, period, last_period=False, min_days=20):
    total, trades, profitable, worst = 0, 0, 0, 0.0
    for symbol, bars in sorted(all_bars.items()):
        start, end = span(bars, period, last_period)
        if end - start < min_days:
            continue
        result = simulate(bars, ENTRANTS[entrant][1](bars), start, end)
        total, trades = total + result['netPaise'], trades + result['trades']
        profitable += result['netPaise'] > 0
        worst = max(worst, result['maxDrawdown'])
    return {'netPaise': total, 'trades': trades, 'profitableShares': profitable, 'worstDrawdown': worst}


def fingerprint(all_bars):
    digest = hashlib.sha256(Path(__file__).read_bytes())
    for symbol, bars in sorted(all_bars.items()):
        digest.update(f"{symbol}{len(bars)}{bars[0]['date']}{bars[-1]['date']}{bars[-1]['closePaise']}".encode())
    return digest.hexdigest()[:16]


def run(name, symbols, root=TOURNAMENTS, cache=DAILY):
    all_bars = load(symbols, cache)
    if not all_bars:
        raise ValueError('No daily data; run `fetch` first')
    cut = periods(all_bars)
    results = {e: {'description': ENTRANTS[e][0], 'train': score(e, all_bars, cut['train']),
                   'validation': score(e, all_bars, cut['validation'])} for e in ENTRANTS}
    contenders = [e for e in ENTRANTS if e not in BASELINES]
    best = max(contenders, key=lambda e: (results[e]['validation']['netPaise'], e))
    bar_to_beat = max(results[b]['validation']['netPaise'] for b in BASELINES)
    record = {'name': name, 'createdAt': datetime.now(timezone.utc).isoformat(), 'fingerprint': fingerprint(all_bars),
              'symbols': sorted(all_bars), 'periods': cut, 'entrantsTried': len(ENTRANTS), 'capitalPerSharePaise': CAPITAL,
              'results': results, 'winner': best if results[best]['validation']['netPaise'] > bar_to_beat else None,
              'selectionRule': 'highest validation net after costs; must beat both cash and buy-and-hold on validation'}
    directory = root / name
    if (directory / 'tournament.json').exists():
        raise ValueError('A tournament with this name exists; choose a new name')
    directory.mkdir(parents=True)
    batch.save(directory / 'tournament.json', record)
    return record


def finalise(name, root=TOURNAMENTS, cache=DAILY):
    directory = root / name
    record = json.loads((directory / 'tournament.json').read_text(encoding='utf-8'))
    if (directory / 'sealed.json').exists():
        raise ValueError('The sealed period was already used for this tournament')
    all_bars = load(record['symbols'], cache)
    if fingerprint(all_bars) != record['fingerprint']:
        raise ValueError('Entrants or data changed since selection; start a new tournament')
    period = record['periods']['sealed']
    outcome = {'judgedAt': datetime.now(timezone.utc).isoformat(), 'period': period, 'winner': record['winner'],
               **{b: score(b, all_bars, period, last_period=True) for b in BASELINES}}
    if record['winner']:
        outcome['winnerResult'] = score(record['winner'], all_bars, period, last_period=True)
        beat = outcome['winnerResult']['netPaise'] > max(outcome[b]['netPaise'] for b in BASELINES)
        outcome['verdict'] = 'beat-both-baselines-on-sealed-period' if beat else 'failed-on-sealed-period'
    else:
        outcome['verdict'] = 'no-entrant-qualified'
    batch.save(directory / 'sealed.json', outcome)
    return outcome


FORWARD = ROOT / '.local' / 'trading-desk' / 'daily-forward'
RULE_PARTS = (ceil_paise, buy_costs, sell_costs, simulate, sma_table, cash, buy_and_hold, momentum, ma_cross, reversal, near_high)


def rules_fingerprint():
    """The exact rules being tested: costs, simulator and every entrant's code and settings. Editing anything
    else in this file (reports, commands) leaves registered forward tests valid; editing a rule ends them."""
    import inspect
    digest = hashlib.sha256()
    for part in RULE_PARTS:
        digest.update(inspect.getsource(part).encode())
    digest.update(json.dumps({'entrants': sorted(ENTRANTS), 'capital': CAPITAL, 'slippage': SLIPPAGE_BPS,
                              'costs': [STT_BPS, STAMP_BUY_BPS, EXCHANGE_BPS, SEBI_BPS, GST, DP_PER_SELL_PAISE]}).encode())
    return digest.hexdigest()[:16]


def register(name, symbols, root=FORWARD, cache=DAILY):
    """Pre-registers a forward test: from now on, only days after the latest cached bar count, and the rules are frozen."""
    all_bars = load(symbols, cache)
    if not all_bars:
        raise ValueError('No daily data; run `fetch` first')
    path = root / f'{name}.json'
    if path.exists():
        raise ValueError('A forward test with this name exists; choose a new name')
    record = {'name': name, 'registeredAt': datetime.now(timezone.utc).isoformat(), 'startAfter': max(b[-1]['date'] for b in all_bars.values()),
              'rules': rules_fingerprint(), 'entrants': sorted(ENTRANTS), 'symbols': sorted(all_bars), 'capitalPerSharePaise': CAPITAL,
              'note': 'Pre-registered: only trading days after startAfter count, and the rules are frozen by fingerprint.'}
    root.mkdir(parents=True, exist_ok=True)
    batch.save(path, record)
    return record


def forward(name, root=FORWARD, cache=DAILY):
    """Scores every registered entrant on the days since registration: data no rule could have been fitted to."""
    record = json.loads((root / f'{name}.json').read_text(encoding='utf-8'))
    if rules_fingerprint() != record['rules']:
        raise ValueError('The rules changed after registration; this forward test has ended. Register a new one.')
    all_bars = load(record['symbols'], cache)
    days = sorted({b['date'] for bars in all_bars.values() for b in bars if b['date'] > record['startAfter']})
    if not days:
        return {'name': name, 'status': 'waiting', 'startAfter': record['startAfter'], 'note': 'No trading days yet; refresh the data later.'}
    period = (days[0], days[-1])
    results = {e: score(e, all_bars, period, last_period=True, min_days=1) for e in record['entrants']}
    bar = max(results[b]['netPaise'] for b in BASELINES)
    return {'name': name, 'status': 'running', 'startAfter': record['startAfter'], 'through': days[-1], 'tradingDays': len(days),
            'results': results, 'aheadOfBothBaselines': sorted(e for e in results if e not in BASELINES and results[e]['netPaise'] > bar),
            'note': 'Descriptive until enough days pass; a few weeks prove nothing.'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    f = sub.add_parser('fetch')
    f.add_argument('--years', type=int, default=5, choices=range(2, 11))
    f.add_argument('--refresh', action='store_true', help='Re-download cached shares to include the newest days')
    for name in ('run', 'finalise', 'register', 'forward'):
        p = sub.add_parser(name)
        p.add_argument('--name', required=True)
    a = sub.add_parser('accept-move', help='Owner: confirm a large move the steward kept back is real (checked against the news)')
    a.add_argument('--symbol', required=True, help='e.g. RELIANCE.NS')
    a.add_argument('--date', required=True, help='The session date of the move, YYYY-MM-DD')
    args = parser.parse_args(argv)
    symbols = sorted(datasets.UNIVERSE)
    if args.command == 'fetch':
        print(json.dumps(fetch(symbols, args.years, refresh=args.refresh), indent=2))
        return
    if args.command == 'accept-move':
        print(json.dumps({'symbol': args.symbol, 'acceptedMoves': accept_move(args.symbol, args.date)}))
        return
    if args.command in ('register', 'forward'):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,60}', args.name):
            raise SystemExit('Name: letters, digits, _ or -')
        result = register(args.name, symbols) if args.command == 'register' else forward(args.name)
        print(json.dumps(result, indent=2))
        return
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,60}', args.name):
        raise SystemExit('Name: letters, digits, _ or -')
    if args.command == 'run':
        record = run(args.name, symbols)
        print(f"periods: {record['periods']}")
        for entrant, res in sorted(record['results'].items(), key=lambda kv: -kv[1]['validation']['netPaise']):
            print(f"{entrant:20s} train {res['train']['netPaise'] / 100:>11.2f}  validation {res['validation']['netPaise'] / 100:>10.2f}  "
                  f"({res['validation']['trades']} fills, worst drawdown {res['validation']['worstDrawdown']:.1%})")
        print(f"winner: {record['winner'] or 'none (nothing beat both cash and buy-and-hold on validation)'}")
    else:
        print(json.dumps(finalise(args.name), indent=2))


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
