"""Live paper desk: the replay desk's bots, book and rules, fed delayed Yahoo 5-minute bars as they complete.

Paper only: no broker, wallet, bank or backend writes. Sessions are owner-started and finite (--minutes, at most
one trading day); this is never an OS service and never restarts itself. Every bar goes through desk.decide_bar
and desk.Book, exactly as in replay (a parity test proves it), and the state is saved after every bar, so a
stopped session resumes where it left off. Bars that were missed while stopped still update the book (fills,
stop-loss), but no meeting is held on them: a decision is only taken while its bar is fresh.
Run with the replay environment, which has the market-data library:
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\live.py run --book reliance-w41 --symbol RELIANCE.NS --minutes 375
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import datasets  # noqa: E402
import desk  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))
LIVE = desk.ROOT / '.local' / 'trading-desk' / 'live'
BOOK_NAME = re.compile(r'^[A-Za-z0-9_-]{1,60}$')
GRACE = timedelta(seconds=75)        # provider delay before a 5-minute bar is treated as complete
FRESH = timedelta(minutes=10)        # a meeting is only held on a bar completed this recently
SESSION_OPEN, SESSION_CLOSE = (9, 15), (15, 35)


def completed(bars, now):
    return [b for b in bars if datetime.fromisoformat(b['time']) + timedelta(minutes=5) + GRACE <= now]


def fetch_recent(symbol, now):
    """Up to five sessions of completed 5-minute bars, checked against the replay contract."""
    import yfinance as yf
    yf.set_tz_cache_location(str(desk.ROOT / '.local' / 'market-replay-cache'))
    ticker = yf.Ticker(symbol)
    frame = ticker.history(period='5d', interval='5m', auto_adjust=False, back_adjust=False, actions=True, repair=False, timeout=20)
    if frame.empty:
        raise ValueError('EMPTY_PROVIDER_DATA')
    datasets.check_metadata(ticker, symbol)
    today = now.astimezone(IST).date()
    bars = completed(datasets.frame_bars(frame, today - timedelta(days=10), today + timedelta(days=1)), now)
    datasets.validate({'schemaVersion': 1, 'symbol': symbol, 'currency': 'INR', 'interval': '5m', 'source': 'yahoo-via-yfinance',
                       'priceBasis': 'unadjusted', 'bars': bars})
    return bars


def in_session(now):
    t = now.astimezone(IST)
    return t.weekday() < 5 and SESSION_OPEN <= (t.hour, t.minute) < SESSION_CLOSE


class LiveBook:
    """One named paper book in its own directory: state.json (saved after every bar), journal.jsonl, live.lock."""

    def __init__(self, name, root=LIVE):
        if not BOOK_NAME.match(name):
            raise ValueError('Book name: letters, digits, _ or -')
        self.dir = root / name
        self.state_path, self.journal_path, self.lock_path = self.dir / 'state.json', self.dir / 'journal.jsonl', self.dir / 'live.lock'

    def open(self, symbol, every, model, max_meetings_per_day):
        self.dir.mkdir(parents=True, exist_ok=True)
        try:
            self.lock = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            raise ValueError('Another session holds this book; confirm it stopped before removing live.lock') from None
        os.write(self.lock, str(os.getpid()).encode())
        binding = {'symbol': symbol, 'every': every, 'model': model, 'deskVersion': batch.desk_version()}
        if self.state_path.exists():
            self.state = json.loads(self.state_path.read_text(encoding='utf-8'))
            if any(self.state[k] != v for k, v in binding.items()):
                self.close()
                raise ValueError('This book was started with a different symbol, cadence, model or desk version; use a new book name')
        else:
            self.state = {'schemaVersion': 1, **binding, 'createdAt': datetime.now(timezone.utc).isoformat(), 'book': desk.Book().s,
                          'memory': [], 'lastBar': None, 'meetingsByDay': {}, 'maxMeetingsPerDay': max_meetings_per_day,
                          'modelCalls': 0}
            self.save()
        return self

    def close(self):
        os.close(self.lock)
        self.lock_path.unlink(missing_ok=True)

    def save(self):
        # Windows can briefly hold the target open (indexing, antivirus); retry the atomic replace a few times.
        for attempt in range(5):
            try:
                return batch.save(self.state_path, self.state)
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.05 * (attempt + 1))

    def log(self, entry):
        with self.journal_path.open('a', encoding='utf-8') as handle:
            handle.write(json.dumps(entry) + '\n')

    def process(self, bars, llm, now, forecaster=None, headlines=None):
        """Feeds every completed bar after lastBar through the shared desk logic, saving after each one."""
        s = self.state
        if s['lastBar'] is None:
            if not bars:
                return 0  # nothing completed yet; start once there is a bar to start after
            # A new book starts at the next completed bar; it never trades on history.
            s['lastBar'] = bars[-1]['time']
            self.save()
            self.log({'type': 'book-started', 'at': now.isoformat(), 'firstBarAfter': s['lastBar']})
            return 0
        book = desk.Book(s['book'])
        processed = 0
        for i, bar in enumerate(bars):
            if bar['time'] <= s['lastBar']:
                continue
            day = bar['time'][:10]
            fresh = now - (datetime.fromisoformat(bar['time']) + timedelta(minutes=5)) <= FRESH
            scheduled = desk.is_meeting_bar(bars, i, s['every'])
            meeting = scheduled and fresh and s['meetingsByDay'].get(day, 0) < s['maxMeetingsPerDay']
            trades_before = len(book.s['trades'])
            outcome = {}

            def decide(index, state):
                action, record = desk.decide_bar(bars, index, state, llm, s['memory'], symbol=s['symbol'], meeting=meeting,
                                                 forecaster=forecaster, headlines=headlines)
                outcome['record'] = record
                return action
            book.step(i, bar, decide)
            record = outcome.get('record')
            if record and record['type'] == 'desk-meeting':
                s['meetingsByDay'][day] = s['meetingsByDay'].get(day, 0) + 1
                s['modelCalls'] += record.get('modelCalls', 0)
            if scheduled and not meeting:
                record = {'bar': bar['time'], 'type': 'meeting-skipped', 'reason': 'stale-bar' if not fresh else 'daily-meeting-cap'}
            for trade in book.s['trades'][trades_before:]:
                self.log({'type': 'fill', 'at': now.isoformat(), **trade})
            if record:
                self.log({**record, 'at': now.isoformat()})
            s['memory'] = s['memory'][-10:]
            s['lastBar'] = bar['time']
            self.save()
            processed += 1
        return processed

    def status(self):
        s = self.state
        book = desk.Book(s['book']).result()
        return {'symbol': s['symbol'], 'deskVersion': s['deskVersion'], 'model': s['model'], 'lastBar': s['lastBar'],
                'netPaise': book['netPaise'], 'realisedNetPaise': book['realisedNetPaise'], 'trades': len(book['trades']),
                'openPosition': book['openPosition'], 'pendingOrder': book['unfilledFinalSignal'],
                'maxDrawdownFraction': book['maxDrawdownFraction'], 'meetingsByDay': s['meetingsByDay'], 'modelCalls': s['modelCalls']}


def load_news(path, last):
    """Re-read every poll so newly verified news arrives and revoked news disappears. A missing file means no
    news yet; an unreadable or invalid one keeps the last good copy (and is journaled by the caller)."""
    if not path.exists():
        return [], None
    try:
        if path.stat().st_size > 5_000_000:
            raise ValueError('NEWS_FILE_TOO_LARGE')
        return desk.validate_headlines(json.loads(path.read_text(encoding='utf-8'))), None
    except (ValueError, OSError) as error:
        return last, f'{type(error).__name__}: {str(error)[:60]}'


def run_session(name, symbol, minutes, llm, model, *, every=12, max_meetings_per_day=6, fetch=fetch_recent,
                clock=lambda: datetime.now(IST), sleep=time.sleep, root=LIVE, forecaster=None, news_path=None):
    if symbol not in datasets.UNIVERSE:
        raise ValueError('Symbol is not in the desk universe')
    # The book is bound to its inputs: the model, the forecaster and whether news is consulted.
    model = model + (f'+{forecaster.name}' if forecaster else '') + ('+news' if news_path else '')
    live = LiveBook(name, root).open(symbol, every, model, max_meetings_per_day)
    headlines = [] if news_path else None
    deadline = clock() + timedelta(minutes=minutes)
    live.log({'type': 'session-started', 'at': clock().isoformat(), 'minutes': minutes})
    stopped, failures = 'deadline', 0
    try:
        while clock() < deadline:
            now = clock()
            if in_session(now):
                if news_path:
                    headlines, problem = load_news(news_path, headlines)
                    if problem:
                        live.log({'type': 'news-error', 'at': now.isoformat(), 'reason': problem, 'keptHeadlines': len(headlines)})
                try:
                    live.process(fetch(symbol, now), llm, now, forecaster, headlines)
                    failures = 0
                except ValueError as error:  # provider or contract problem: record it, keep the book unchanged
                    failures += 1
                    live.log({'type': 'data-error', 'at': now.isoformat(), 'reason': str(error)[:80]})
                    if failures >= 3:
                        stopped = 'repeated-data-errors'
                        break
            # Wake shortly after the next 5-minute bar completes.
            t = clock()
            next_bar = t.replace(second=0, microsecond=0) + timedelta(minutes=5 - t.minute % 5)
            sleep(max(1.0, min((next_bar + GRACE - t).total_seconds(), (deadline - t).total_seconds())))
    except KeyboardInterrupt:
        stopped = 'owner-interrupt'
    finally:
        live.log({'type': 'session-stopped', 'at': clock().isoformat(), 'reason': stopped})
        result = live.status()
        live.close()
    return {**result, 'stoppedReason': stopped}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    run = sub.add_parser('run')
    run.add_argument('--book', required=True)
    run.add_argument('--symbol', required=True, choices=sorted(datasets.UNIVERSE))
    run.add_argument('--minutes', type=int, required=True, choices=range(1, 391))
    run.add_argument('--every', type=int, default=12, choices=range(3, 76))
    run.add_argument('--max-meetings-per-day', type=int, default=6, choices=range(1, 13))
    run.add_argument('--timeout-seconds', type=int, default=240, choices=range(10, 601))
    run.add_argument('--allow-remote-cost', action='store_true')
    run.add_argument('--forecaster', help='Adds the forecast analyst: Kronos-mini, Kronos-small or finetuned:NAME (local weights)')
    run.add_argument('--news', type=Path, help='Headlines file re-read every poll, e.g. .local/claims/auto/verified-headlines.json')
    status = sub.add_parser('status')
    status.add_argument('--book', required=True)
    args = parser.parse_args(argv)
    if args.command == 'status':
        live = LiveBook(args.book)
        if not live.state_path.exists():
            raise SystemExit('No such book')
        live.state = json.loads(live.state_path.read_text(encoding='utf-8'))
        print(json.dumps(live.status(), indent=2))
        return
    llm, endpoint = desk.model_client(desk.local_settings(os.environ), args.timeout_seconds, args.allow_remote_cost)
    forecaster = None
    if args.forecaster:
        import forecast
        forecaster = forecast.build(args.forecaster)
    print(json.dumps(run_session(args.book, args.symbol, args.minutes, llm, endpoint.model, every=args.every,
                                 max_meetings_per_day=args.max_meetings_per_day, forecaster=forecaster, news_path=args.news), indent=2))


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
