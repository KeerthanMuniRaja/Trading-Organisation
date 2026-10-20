"""Participant activity: what large disclosed traders did, and whether following them would have paid. Research only.

The organisation design calls for a participant-activity department that studies public, disclosed transactions and
keeps observed activity separate from guessed motives (docs/knowledge-base/02-organisation-and-plugins.md). In India
the exchanges publish every bulk deal (one client trading over 0.5% of a company's shares in a day) and every block
deal (a large negotiated trade in the block window), with the client's name, side, quantity and price.

Input: deal files the owner downloads from the exchange's website (NSE: bulk deals and block deals reports, CSV) and
saves in .local/trading-desk/participants/inbox/. This module never contacts the internet; checking that the source's
terms allow this use is the owner's decision.
Honesty rules:
  - Timing: deals are published after the session, so a follower acts at the NEXT session's open, never at the deal price.
  - Excess return: every event is measured against the equal-weight basket over the same days, so a rising market
    is not mistaken for skill. Following a sell means staying out, so its excess counts with the opposite sign.
  - No hindsight in choosing leaders: leaders are picked only from deals before --split, then judged only on deals
    after it, with the exact sign test used for bot fitness. A client's name is an observation, not a motive.
Run (replay or skfolio environment):
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\participants.py ingest
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\participants.py study --split 2025-01-01
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime
import hashlib
import io
import json
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import daily  # noqa: E402
import portfolio_daily as pd  # noqa: E402

ROOT = daily.ROOT / '.local' / 'trading-desk' / 'participants'
HORIZON = 21  # about one month of sessions
MIN_EVENTS = 3
HEADERS = {  # normalised header -> field; covers the exchange's bulk and block report spellings
    'date': 'date', 'dealdate': 'date', 'symbol': 'symbol', 'clientname': 'client', 'nameoftheclient': 'client',
    'buysell': 'side', 'dealtype': 'side', 'quantitytraded': 'quantity', 'quantity': 'quantity',
    'tradepricewghtavgprice': 'price', 'tradeprice': 'price', 'price': 'price', 'wghtavgprice': 'price'}
DATE_FORMATS = ('%d-%b-%Y', '%d-%m-%Y', '%Y-%m-%d', '%d/%m/%Y', '%d %b %Y')
MAX_FILE_BYTES = 20 * 1024 * 1024


def normal(text):
    return re.sub(r'[^a-z0-9]', '', text.lower())


def client_key(name):
    """Same client, same key: upper case, single spaces, no trailing punctuation."""
    return re.sub(r'\s+', ' ', name.upper()).strip(' .,')


def parse_date(text):
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(text.strip().title() if '%b' in fmt else text.strip(), fmt).date().isoformat()
        except ValueError:
            continue
    raise ValueError(f'Unrecognised date {text[:20]!r}')


def parse_deals(text, kind):
    """Rows of an exchange deal report -> deals. Returns (deals, skipped). Unusable rows are counted, never guessed."""
    if kind not in ('bulk', 'block'):
        raise ValueError('kind: bulk or block')
    reader = csv.reader(io.StringIO(text.lstrip('﻿')))
    header = next(reader, None)
    if not header:
        return [], 0
    columns = {HEADERS[normal(h)]: k for k, h in enumerate(header) if normal(h) in HEADERS}
    missing = {'date', 'symbol', 'client', 'side', 'quantity', 'price'} - set(columns)
    if missing:
        raise ValueError(f'Not a deal report: missing columns {sorted(missing)}')
    deals, skipped = [], 0
    for row in reader:
        if not any(cell.strip() for cell in row):
            continue
        try:
            get = lambda field: row[columns[field]].strip()  # noqa: E731
            side = {'BUY': 'buy', 'B': 'buy', 'SELL': 'sell', 'S': 'sell'}[get('side').upper()]
            quantity = int(get('quantity').replace(',', ''))
            price_paise = round(float(get('price').replace(',', '')) * 100)
            symbol = get('symbol').upper()
            if quantity <= 0 or price_paise <= 0 or not re.fullmatch(r'[A-Z0-9&_-]{1,20}', symbol) or not get('client'):
                raise ValueError
            deals.append({'kind': kind, 'date': parse_date(get('date')), 'symbol': symbol, 'client': client_key(get('client')),
                          'side': side, 'quantity': quantity, 'pricePaise': price_paise})
        except (KeyError, ValueError, IndexError):
            skipped += 1
    return deals, skipped


def deal_id(deal):
    return hashlib.sha256(json.dumps(deal, sort_keys=True).encode()).hexdigest()[:16]


def ingest(root=ROOT):
    """Reads every CSV in the inbox (kind from the file name: 'block' in the name means block deals, else bulk),
    merges new deals into deals.json without duplicates, and records which file each came from."""
    inbox, store = root / 'inbox', root / 'deals.json'
    data = json.loads(store.read_text(encoding='utf-8')) if store.exists() else {'deals': {}, 'files': {}}
    added = 0
    for path in sorted(inbox.glob('*.csv')) if inbox.exists() else []:
        raw = path.read_bytes()
        if len(raw) > MAX_FILE_BYTES:
            raise ValueError(f'{path.name} is larger than 20 MB')
        digest = hashlib.sha256(raw).hexdigest()
        if digest in data['files']:
            continue
        deals, skipped = parse_deals(raw.decode('utf-8-sig', errors='replace'), 'block' if 'block' in path.name.lower() else 'bulk')
        new = 0
        for deal in deals:
            key = deal_id(deal)
            if key not in data['deals']:
                data['deals'][key] = {**deal, 'sourceFile': path.name}
                new += 1
        data['files'][digest] = {'name': path.name, 'deals': len(deals), 'new': new, 'skipped': skipped}
        added += new
    root.mkdir(parents=True, exist_ok=True)
    batch.save(store, data)
    return {'deals': len(data['deals']), 'added': added, 'files': len(data['files'])}


def event_returns(deals, table, dates, horizon=HORIZON):
    """Follower's excess return per deal: from the next session's open to the open `horizon` sessions later, minus the
    basket's return over the same days; a sell counts as staying out (opposite sign). Deals without prices are listed."""
    from bisect import bisect_right
    events, unpriced = [], 0
    for deal in sorted(deals, key=lambda d: (d['date'], d['symbol'], d['client'])):
        if deal['symbol'] + '.NS' not in table and deal['symbol'] not in table:
            unpriced += 1
            continue
        symbol = deal['symbol'] + '.NS' if deal['symbol'] + '.NS' in table else deal['symbol']
        entry = bisect_right(dates, deal['date'])  # the first session after the deal day
        if entry + horizon >= len(dates):
            continue  # not enough later sessions yet
        a, b = dates[entry], dates[entry + horizon]
        stock = table[symbol][b]['openPaise'] / table[symbol][a]['openPaise'] - 1
        basket = sum(table[s][b]['openPaise'] / table[s][a]['openPaise'] - 1 for s in table) / len(table)
        sign = 1 if deal['side'] == 'buy' else -1
        events.append({**deal, 'entry': a, 'exit': b, 'excessPct': round(100 * sign * (stock - basket), 2)})
    return events, unpriced


def study(events, split, min_events=MIN_EVENTS):
    """Leaders chosen on events before `split` (enough events, more ahead of the basket than behind, positive average),
    then judged on events from `split` on. Baselines: following every disclosed deal, in each period."""
    import fitness

    def score(sample):
        wins = sum(e['excessPct'] > 0 for e in sample)
        losses = sum(e['excessPct'] < 0 for e in sample)
        return {'events': len(sample), 'aheadOfBasket': wins, 'behindBasket': losses,
                'averageExcessPct': round(sum(e['excessPct'] for e in sample) / len(sample), 2) if sample else None,
                'verdict': fitness.verdict(wins, losses)}
    before = [e for e in events if e['date'] < split]
    after = [e for e in events if e['date'] >= split]
    by_client = {}
    for e in before:
        by_client.setdefault(e['client'], []).append(e)
    candidates = {}
    for client, sample in by_client.items():
        s = score(sample)
        if s['events'] >= min_events and s['aheadOfBasket'] > s['behindBasket'] and s['averageExcessPct'] > 0:
            candidates[client] = s
    followed = [e for e in after if e['client'] in candidates]
    return {'split': split, 'horizonSessions': HORIZON, 'minimumEventsToQualify': min_events,
            'allDealsBefore': score(before), 'allDealsAfter': score(after),
            'leadersChosenBefore': {k: candidates[k] for k in sorted(candidates)},
            'followingLeadersAfter': score(followed),
            'leadersByClientAfter': {k: score([e for e in followed if e['client'] == k]) for k in sorted(candidates)},
            'note': 'Leaders were chosen only from earlier deals. Names are observations, not motives. Excess is versus the '
                    'equal-weight basket, from the next open, before costs (about 0.25% per round trip).'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('ingest')
    s = sub.add_parser('study')
    s.add_argument('--split', required=True, help='YYYY-MM-DD: leaders chosen before, judged from this day on')
    s.add_argument('--min-events', type=int, default=MIN_EVENTS, choices=range(1, 51))
    args = parser.parse_args(argv)
    if args.command == 'ingest':
        print(json.dumps(ingest(), indent=2))
        return
    parse_date(args.split)
    store = ROOT / 'deals.json'
    if not store.exists():
        raise ValueError('No deals yet: save exchange deal CSVs in .local/trading-desk/participants/inbox and run ingest')
    deals = list(json.loads(store.read_text(encoding='utf-8'))['deals'].values())
    dates, table = pd.aligned(daily.load(sorted(daily.datasets.UNIVERSE)))
    events, unpriced = event_returns(deals, table, dates)
    report = {**study(events, args.split, args.min_events), 'deals': len(deals), 'pricedEvents': len(events),
              'dealsWithoutPriceData': unpriced}
    batch.save(ROOT / f'study-{args.split}.json', report)
    print(json.dumps({k: report[k] for k in ('deals', 'pricedEvents', 'dealsWithoutPriceData', 'allDealsBefore', 'allDealsAfter',
                                             'followingLeadersAfter')}, indent=2))
    print('leaders chosen before the split:', ', '.join(report['leadersChosenBefore']) or 'none')


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
