"""Fetch consecutive 7-day 5-minute windows for a small universe of liquid NSE shares. Personal research only.

Bar rules are the market-replay dataset contract, unchanged; only the symbol may differ, and only within UNIVERSE.
Each window is cached under .local/trading-desk/datasets and never refetched, so later runs compare against
identical inputs. Windows with corporate actions or invalid bars are skipped with a recorded reason, not repaired.
Yahoo keeps only about 60 days of 5-minute bars, so older windows must be cached before they roll off.
Run with the replay environment: .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\datasets.py
"""
import argparse
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'integrations' / 'market-replay'))
import replay  # noqa: E402

CACHE = ROOT / '.local' / 'trading-desk' / 'datasets'
# Liquid large caps whose single share normally fits the desk's 20% position cap (Rs 2,000). Owner-editable.
UNIVERSE = {
    'RELIANCE.NS': 'Reliance Industries', 'HDFCBANK.NS': 'HDFC Bank', 'ICICIBANK.NS': 'ICICI Bank',
    'INFY.NS': 'Infosys', 'SBIN.NS': 'State Bank of India', 'ITC.NS': 'ITC', 'AXISBANK.NS': 'Axis Bank', 'NTPC.NS': 'NTPC',
}


def validate(dataset):
    """The replay contract's bar rules, applied to any UNIVERSE symbol. Returns the bars."""
    if dataset.get('symbol') not in UNIVERSE:
        raise ValueError('SYMBOL_NOT_IN_UNIVERSE')
    return replay.validate({**dataset, 'symbol': replay.SYMBOL})


def window_ends(latest: date, count: int):
    """Exclusive end dates, newest first, each covering the previous 7 calendar days."""
    return [latest - timedelta(days=7 * k) for k in range(count)]


def cache_path(symbol, end, cache=CACHE):
    return cache / f'{symbol}-5m-{end.isoformat()}.json'


def frame_bars(frame, first_day, end_day):
    """Provider rows to contract bars: exact paise, integer volume, IST times within [first_day, end_day)."""
    def price(value):
        if not math.isfinite(float(value)):
            raise ValueError('NONFINITE_PRICE')
        return int((Decimal(str(value)) * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
    rows = []
    for index, row in frame.iterrows():
        if index.tzinfo is None:
            raise ValueError('MISSING_TIMEZONE')
        t = index.to_pydatetime().astimezone(replay.IST)
        if t.date() >= end_day or t.date() < first_day:
            raise ValueError('OUT_OF_RANGE_BAR')
        volume = float(row['Volume'])
        if not math.isfinite(volume) or not volume.is_integer():
            raise ValueError('INVALID_VOLUME')
        rows.append({'time': t.isoformat(), **{k.lower() + 'Paise': price(row[k]) for k in ('Open', 'High', 'Low', 'Close')},
                     'volume': int(volume), 'dividend': float(row.get('Dividends', 0)), 'split': float(row.get('Stock Splits', 0))})
    return rows


def check_metadata(ticker, symbol):
    meta = ticker.get_history_metadata()
    if (meta.get('symbol') != symbol or meta.get('currency') != 'INR'
            or meta.get('exchangeTimezoneName') not in ('Asia/Kolkata', 'Asia/Calcutta')):
        raise ValueError('UNEXPECTED_MARKET_METADATA')


def download(symbol, end):
    """Same provider call, checks and conversions as replay.download, for one UNIVERSE symbol."""
    if symbol not in UNIVERSE:
        raise ValueError('SYMBOL_NOT_IN_UNIVERSE')
    try:
        import yfinance as yf
    except ImportError:
        raise ValueError('YFINANCE_NOT_INSTALLED: see docs/historical-replay.md') from None
    if end > datetime.now(replay.IST).date():
        raise ValueError('END_MUST_NOT_BE_IN_FUTURE')
    yf.set_tz_cache_location(str(ROOT / '.local' / 'market-replay-cache'))
    ticker = yf.Ticker(symbol)
    frame = ticker.history(start=(end - timedelta(days=7)).isoformat(), end=end.isoformat(), interval='5m',
                           auto_adjust=False, back_adjust=False, actions=True, repair=False, timeout=20)
    if frame.empty:
        raise ValueError('EMPTY_PROVIDER_DATA')
    check_metadata(ticker, symbol)
    rows = frame_bars(frame, end - timedelta(days=7), end)
    dataset = {'schemaVersion': 1, 'symbol': symbol, 'currency': 'INR', 'interval': '5m', 'source': 'yahoo-via-yfinance',
               'providerVersion': yf.__version__, 'priceBasis': 'unadjusted', 'retrievedAt': datetime.now(timezone.utc).isoformat(),
               'endExclusive': end.isoformat(), 'bars': rows}
    validate(dataset)
    return dataset


def fetch(ends, download=download, cache=CACHE, symbols=('RELIANCE.NS',)):
    cache.mkdir(parents=True, exist_ok=True)
    results = []
    for symbol in symbols:
        for end in ends:
            path = cache_path(symbol, end, cache)
            entry = {'symbol': symbol, 'end': end.isoformat()}
            if path.exists():
                dataset = json.loads(path.read_text(encoding='utf-8'))
                validate(dataset)
                results.append({**entry, 'state': 'cached', 'bars': len(dataset['bars']), 'path': str(path)})
                continue
            try:
                dataset = download(symbol, end)
            except ValueError as error:
                # Corporate actions, empty or malformed provider data: record and move on; never patch prices.
                results.append({**entry, 'state': 'skipped', 'reason': str(error)[:80]})
                continue
            raw = json.dumps(dataset, sort_keys=True, allow_nan=False)
            path.write_text(raw, encoding='utf-8')
            results.append({**entry, 'state': 'downloaded', 'bars': len(dataset['bars']),
                            'sha256': hashlib.sha256(raw.encode()).hexdigest(), 'path': str(path)})
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--latest-end', type=date.fromisoformat, default=datetime.now(replay.IST).date())
    parser.add_argument('--windows', type=int, default=8, choices=range(1, 9))  # Yahoo keeps ~60 days of 5-minute bars
    parser.add_argument('--symbol', action='append', choices=sorted(UNIVERSE),
                        help='Repeatable; default RELIANCE.NS. Use --all for the whole universe.')
    parser.add_argument('--all', action='store_true')
    args = parser.parse_args(argv)
    symbols = sorted(UNIVERSE) if args.all else args.symbol or ['RELIANCE.NS']
    results = fetch(window_ends(args.latest_end, args.windows), symbols=symbols)
    print(json.dumps([{k: v for k, v in r.items() if k != 'path'} for r in results], indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never echo provider responses or network configuration.
        print(f'Dataset fetch failed ({type(error).__name__}); cached windows are unchanged.', file=sys.stderr)
        sys.exit(1)
