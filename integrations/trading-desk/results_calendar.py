"""Results calendar from the press (NEWS-07): the organisation keeps its own list of results days, so the "results day
carries gap risk" lesson reaches the agents without anyone keeping a file by hand.

Every headline the approved feeds bring in is read by fixed rules (no model, no network). A headline counts only when a
results word comes just before the date it gives:
  "4 banking stocks to declare results 2026 on Oct 17"        results on 17 Oct for the shares it names
  "Q2 Results Today Live: Adani Enterprises & Hyundai ..."     results today for the shares it names
  "board meeting on November 7 to consider Q2 results"         results on 7 Nov
Dividend record dates, splits, bonuses, IPOs and election results never count. A date with no year takes the one
nearest the headline; a date more than a week before it or two months after is not trusted. When later headlines give
a different date for the same share within 20 days, the latest headline wins (a rescheduled meeting).

The same reading finds the market-wide policy days (29 Oct 2026): an RBI or Fed decision day when the headline names
the decider and a decision word comes just before the date ("US Fed meeting October 2026 today", "RBI MPC meeting
on December 4"). Minutes, speeches and testimony before the date are not decisions.

The headline history keeps only the newest 500 items, so the calendar accumulates in .local/world/results-calendar.json
(kept 400 days). It is the press's account: the debate sees it as background with its source, never as evidence, and
the owner's own .local/events.json overrides it.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\results_calendar.py
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import daily  # noqa: E402
import datasets  # noqa: E402
import market_pulse  # noqa: E402

HEADLINES = market_pulse.HEADLINES
OUT = daily.ROOT / '.local' / 'world' / 'results-calendar.json'
KEEP_DAYS = 400
RESCHEDULE_DAYS = 20
IST = timezone(timedelta(hours=5, minutes=30))

MONTHS = {m: i for i, m in enumerate(('jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'), 1)}
MON = r'(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'
DATE = re.compile(r'\b(?:(?P<d1>\d{1,2})(?:st|nd|rd|th)?\s+(?P<m1>' + MON + r')|(?P<m2>' + MON + r')\.?\s+(?P<d2>\d{1,2})(?:st|nd|rd|th)?)\b'
                  r'(?:,?\s+(?P<y>20\d\d))?|\b(?P<rel>today|tomorrow)\b', re.IGNORECASE)
RESULTS = re.compile(r'\b(?:results?|earnings|numbers|board meet(?:ing)?s?)\b', re.IGNORECASE)
REAL_RESULTS = re.compile(r'\b(?:results?|earnings)\b', re.IGNORECASE)
# between the results word and the date: nothing that makes the date something else
NOT_BETWEEN = re.compile(r'[|;?]|record date|ex-?date|ex-dividend|dividend|bonus|split|IPO|listing|AGM|\b(?:after|since|ahead of)\b|'
                         r'\b(?:' + market_pulse.UP + '|' + market_pulse.DOWN + r')\b', re.IGNORECASE)
NOT_BEFORE = re.compile(r'\b(?:election|exit poll|poll|exam|bypoll|assembly)\s*$', re.IGNORECASE)
MAX_GAP = 40        # characters between the results word and an explicit date
MAX_GAP_RELATIVE = 16  # ... and "today" / "tomorrow" ("results today", "Fed meeting October 2026 today")
# market-wide policy days (29 Oct 2026): who decides, and a decision word just before the date
POLICY = {'fomc': (re.compile(r'\b(?:US Fed|Fed|FOMC|Federal Reserve)\b'), 'US Federal Reserve decision'),
          'rbi-policy': (re.compile(r'\b(?:RBI|MPC|Monetary Policy Committee)\b'), 'RBI monetary policy decision')}
POLICY_WORDS = re.compile(r'\b(?:meeting|decision|policy|announcement|outcome|review)\b', re.IGNORECASE)
NOT_POLICY = re.compile(r'\b(?:minutes|speech|testimony|Jackson Hole|governor said)\b', re.IGNORECASE)


def _day(m, published):
    """The calendar day a date match names, or None when it is not a sensible results date for this headline."""
    if m['rel']:
        return published + timedelta(days=1 if m['rel'].lower() == 'tomorrow' else 0)
    month = MONTHS[(m['m1'] or m['m2'])[:3].lower()]
    try:
        if m['y']:
            day = date(int(m['y']), month, int(m['d1'] or m['d2']))
        else:  # the year nearest the headline: "Jan 15" written in late December is next year
            day = min((date(y, month, int(m['d1'] or m['d2'])) for y in (published.year - 1, published.year, published.year + 1)),
                      key=lambda d: abs((d - published).days))
    except ValueError:  # 31 Nov
        return None
    return day if -7 <= (day - published).days <= 60 else None


def dates_in(title, published, keyword=RESULTS, reject=None):
    """The days a headline gives for its event (results by default): [date], usually one. `reject`: words that, before
    the date, make it some other event ("Fed governor speech on Nov 3")."""
    found = []
    for m in DATE.finditer(title):
        before = title[max(0, m.start() - MAX_GAP - 30):m.start()]
        words = list(keyword.finditer(before))
        if not words or (reject and reject.search(before)):
            continue
        word = words[-1]
        between = before[word.end():]
        if len(between) > (MAX_GAP_RELATIVE if m['rel'] else MAX_GAP) or NOT_BETWEEN.search(between):
            continue
        if NOT_BEFORE.search(before[:word.start()]):
            continue
        if keyword is RESULTS and word.group(0).lower().startswith('board') and not REAL_RESULTS.search(title):
            continue  # a board meeting about something else
        day = _day(m, published)
        if day and day not in found:
            found.append(day)
    return found


def policy_days(title, published):
    """[(kind, date)] for an RBI or Fed decision day the headline gives. The decider must be named, and a decision word
    must come just before the date; minutes, speeches and testimony before the date are not decisions (a speech
    mentioned after it, "Fed meeting today: ... where to watch Warsh's speech", does not change the meeting)."""
    return [(kind, day) for kind, (who, _) in POLICY.items() if who.search(title) for day in dates_in(title, published, POLICY_WORDS, NOT_POLICY)]


def read(items, alias_list, names):
    """Calendar entries from headlines: one per (share, date) the headline gives, and one per market-wide policy day."""
    out = []
    for h in items:
        if not h.get('publishedAt') or not h.get('title'):
            continue
        published = datetime.fromisoformat(str(h['publishedAt'])).astimezone(IST).date()
        for kind, day in policy_days(h['title'], published):
            out.append({'date': day.isoformat(), 'kind': kind, 'symbol': None, 'company': POLICY[kind][1], 'desk': False,
                        'title': h['title'][:200], 'publisher': h.get('source'), 'publishedAt': str(h['publishedAt'])})
        days = dates_in(h['title'], published)
        if not days:
            continue
        symbols = list(dict.fromkeys([*market_pulse.named(h['title'], alias_list),
                                      *(s if s.endswith('.NS') else s + '.NS' for s in h.get('symbols') or [])]))
        for day in days:
            for s in symbols:
                out.append({'date': day.isoformat(), 'kind': 'results', 'symbol': s, 'company': names.get(s, datasets.UNIVERSE.get(s, s)),
                            'desk': s in datasets.UNIVERSE, 'title': h['title'][:200], 'publisher': h.get('source'),
                            'publishedAt': str(h['publishedAt'])})
    return out


SNAPSHOTS = daily.ROOT / '.local' / 'claims' / 'auto' / 'snapshots.json'
SENTENCE = re.compile(r'(?<=[.!?])\s+')


def read_bodies(snapshots, alias_list, names):
    """Results days from the article text the fact-checker keeps (the desk shares' news, 29 Oct 2026): titles like
    "Reliance Industries Q2 results 2026 date and time" carry no date, but their text does ("Reliance Industries' board
    will review September-quarter results on October 30, 2026"). Each sentence is read by the same rules as a title,
    and a date counts only for the companies named in that same sentence."""
    out = []
    for s in snapshots:
        if not s.get('publishedAt') or not s.get('content'):
            continue
        published = datetime.fromisoformat(str(s['publishedAt']).replace('Z', '+00:00')).astimezone(IST).date()
        for sentence in SENTENCE.split(' '.join(str(s['content']).split())):
            days = dates_in(sentence, published)
            symbols = market_pulse.named(sentence, alias_list) if days else []
            for day in days:
                for sym in dict.fromkeys(symbols):
                    out.append({'date': day.isoformat(), 'kind': 'results', 'symbol': sym, 'company': names.get(sym, datasets.UNIVERSE.get(sym, sym)),
                                'desk': sym in datasets.UNIVERSE, 'title': str(s.get('title', ''))[:200], 'publisher': s.get('sourceName'),
                                'publishedAt': str(s['publishedAt']), 'from': 'article text'})
    return out


def merge(old, new, today, keep_days=KEEP_DAYS):
    """One entry per share per results period. Within RESCHEDULE_DAYS of each other, the latest headline wins; the same
    date reported twice keeps the first report. Entries older than keep_days are dropped."""
    by_share = {}
    for e in sorted([*old, *new], key=lambda e: e['publishedAt']):
        if (today - date.fromisoformat(e['date'])).days > keep_days:
            continue
        kept = by_share.setdefault(e.get('symbol') or e.get('kind'), [])  # a policy day has no share: one series per decider
        near = [k for k in kept if abs((date.fromisoformat(k['date']) - date.fromisoformat(e['date'])).days) <= RESCHEDULE_DAYS]
        if any(k['date'] == e['date'] for k in near):
            continue
        for k in near:
            kept.remove(k)
        kept.append(e)
    return sorted((e for kept in by_share.values() for e in kept), key=lambda e: (e['date'], e.get('symbol') or '', e.get('kind') or ''))


def build(headlines_path=HEADLINES, out=OUT, now=None, rows=None, snapshots_path=SNAPSHOTS):
    now = now or datetime.now(timezone.utc)
    items = json.loads(Path(headlines_path).read_text(encoding='utf-8')) if Path(headlines_path).exists() else []
    names = rows if rows is not None else datasets.nifty500()
    alias_list = market_pulse.aliases(rows)
    found = read(items, alias_list, names)
    if snapshots_path and Path(snapshots_path).exists():
        raw = json.loads(Path(snapshots_path).read_text(encoding='utf-8'))
        found += read_bodies(raw if isinstance(raw, list) else list(raw.values()), alias_list, names)
    old = json.loads(Path(out).read_text(encoding='utf-8')).get('events', []) if Path(out).exists() else []
    events = merge(old, found, now.astimezone(IST).date())
    report = {'generatedAt': now.isoformat(), 'headlinesRead': len(items), 'foundThisRun': len(found), 'events': events,
              'note': 'Results dates as the press reported them, read by fixed rules: unverified background; '
                      'the exchange filing and the owner\'s events calendar take priority.'}
    batch.save(Path(out), report)
    return report


FILE_AHEAD_DAYS = 60


def file_days(env=None, opener=None, now=None, events=None):
    """PROTECT-03 (founderReview W13): the desk shares' coming results days, filed with the backend by the evaluator, so
    the owner's pre-results sizing can see them. The owner's calendar wins over the press (events_calendar.load). The
    backend keeps what it has and adds new days; a wrong date can only make a buy smaller, never larger."""
    import events_calendar
    import signal_scorer as sc
    from urllib import request as urlrequest
    now = now or datetime.now(timezone.utc)
    today = now.astimezone(IST).date()
    if events is None:
        events, _ = events_calendar.load()
    days = sorted({(e['symbols'][0], e['date']) for e in events or [] if e['kind'] == 'results' and len(e['symbols']) == 1
                   and 0 <= (date.fromisoformat(e['date']) - today).days <= FILE_AHEAD_DAYS})
    if not days:
        return {'filed': 0, 'alreadyKnown': 0}
    base, token = sc.principals(env if env is not None else os.environ, 'evaluator')
    return sc.post(base, token, '/v1/protections/results-days', {'source': 'results calendar (owner file, then press)',
                                                                 'days': [{'symbol': s, 'day': d} for s, d in days]}, opener or urlrequest.urlopen)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--file', action='store_true', help="also file the desk shares' coming results days with the backend (evaluator)")
    args = parser.parse_args(argv)
    r = build()
    filed = file_days() if args.file else None
    today = datetime.now(IST).date().isoformat()
    print(json.dumps({'headlinesRead': r['headlinesRead'], 'foundThisRun': r['foundThisRun'], 'kept': len(r['events']),
                      **({'filedWithBackend': filed} if filed is not None else {}),
                      'upcomingDesk': [f"{e['date']} {e['company']}" for e in r['events'] if (e['desk'] or not e.get('symbol')) and e['date'] >= today],
                      'upcoming': [f"{e['date']} {e['company']}" for e in r['events'] if e['date'] >= today][:15]},
                     indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
