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

The headline history keeps only the newest 500 items, so the calendar accumulates in .local/world/results-calendar.json
(kept 400 days). It is the press's account: the debate sees it as background with its source, never as evidence, and
the owner's own .local/events.json overrides it.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\results_calendar.py
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta, timezone
import json
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
MAX_GAP_RELATIVE = 12  # ... and "today" / "tomorrow" ("results today", "results due tomorrow")


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


def dates_in(title, published):
    """The results days a headline gives: [date], usually one."""
    found = []
    for m in DATE.finditer(title):
        before = title[max(0, m.start() - MAX_GAP - 30):m.start()]
        words = list(RESULTS.finditer(before))
        if not words:
            continue
        word = words[-1]
        between = before[word.end():]
        if len(between) > (MAX_GAP_RELATIVE if m['rel'] else MAX_GAP) or NOT_BETWEEN.search(between):
            continue
        if NOT_BEFORE.search(before[:word.start()]):
            continue
        if word.group(0).lower().startswith('board') and not REAL_RESULTS.search(title):
            continue  # a board meeting about something else
        day = _day(m, published)
        if day and day not in found:
            found.append(day)
    return found


def read(items, alias_list, names):
    """Calendar entries from headlines: one per (share, date) the headline gives."""
    out = []
    for h in items:
        if not h.get('publishedAt') or not h.get('title'):
            continue
        published = datetime.fromisoformat(str(h['publishedAt'])).astimezone(IST).date()
        days = dates_in(h['title'], published)
        if not days:
            continue
        symbols = list(dict.fromkeys([*market_pulse.named(h['title'], alias_list),
                                      *(s if s.endswith('.NS') else s + '.NS' for s in h.get('symbols') or [])]))
        for day in days:
            for s in symbols:
                out.append({'date': day.isoformat(), 'symbol': s, 'company': names.get(s, datasets.UNIVERSE.get(s, s)),
                            'desk': s in datasets.UNIVERSE, 'title': h['title'][:200], 'publisher': h.get('source'),
                            'publishedAt': str(h['publishedAt'])})
    return out


def merge(old, new, today, keep_days=KEEP_DAYS):
    """One entry per share per results period. Within RESCHEDULE_DAYS of each other, the latest headline wins; the same
    date reported twice keeps the first report. Entries older than keep_days are dropped."""
    by_share = {}
    for e in sorted([*old, *new], key=lambda e: e['publishedAt']):
        if (today - date.fromisoformat(e['date'])).days > keep_days:
            continue
        kept = by_share.setdefault(e['symbol'], [])
        near = [k for k in kept if abs((date.fromisoformat(k['date']) - date.fromisoformat(e['date'])).days) <= RESCHEDULE_DAYS]
        if any(k['date'] == e['date'] for k in near):
            continue
        for k in near:
            kept.remove(k)
        kept.append(e)
    return sorted((e for kept in by_share.values() for e in kept), key=lambda e: (e['date'], e['symbol']))


def build(headlines_path=HEADLINES, out=OUT, now=None, rows=None):
    now = now or datetime.now(timezone.utc)
    items = json.loads(Path(headlines_path).read_text(encoding='utf-8')) if Path(headlines_path).exists() else []
    names = rows if rows is not None else datasets.nifty500()
    found = read(items, market_pulse.aliases(rows), names)
    old = json.loads(Path(out).read_text(encoding='utf-8')).get('events', []) if Path(out).exists() else []
    events = merge(old, found, now.astimezone(IST).date())
    report = {'generatedAt': now.isoformat(), 'headlinesRead': len(items), 'foundThisRun': len(found), 'events': events,
              'note': 'Results dates as the press reported them, read by fixed rules: unverified background; '
                      'the exchange filing and the owner\'s events calendar take priority.'}
    batch.save(Path(out), report)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.parse_args(argv)
    r = build()
    today = datetime.now(IST).date().isoformat()
    print(json.dumps({'headlinesRead': r['headlinesRead'], 'foundThisRun': r['foundThisRun'], 'kept': len(r['events']),
                      'upcomingDesk': [f"{e['date']} {e['company']}" for e in r['events'] if e['desk'] and e['date'] >= today],
                      'upcoming': [f"{e['date']} {e['company']}" for e in r['events'] if e['date'] >= today][:15]},
                     indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
