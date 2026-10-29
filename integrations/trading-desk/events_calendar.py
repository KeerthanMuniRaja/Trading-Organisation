"""Events calendar (NEWS-05; Anthropic financial plugins' catalyst calendar, gap 30): what is scheduled that can move the
shares, so a decision is never taken blind to results day or a policy meeting. The owner keeps the file by hand (no
source is fetched): .local/events.json, for example
  {"events": [{"date": "2026-10-28", "kind": "results", "symbols": ["SBIN"], "title": "SBI Q2 results"},
              {"date": "2026-12-05", "kind": "rbi-policy", "title": "RBI monetary policy decision"}]}
Kinds: results, rbi-policy, budget, fomc, macro-data, holiday, other. An event without symbols concerns the whole market.
Invalid entries are skipped and counted, never guessed. The debate, the scenario panel and the digest read it; a
missing file is said plainly ('no calendar'), never treated as 'nothing scheduled'.
The organisation adds the results days the press reported for the desk shares, and the RBI and Fed decision days
(results_calendar.py, NEWS-07), marked source 'press'; an owner entry for the same share's results, or the same
decider's policy day, within 20 days replaces the press one.
"""
from __future__ import annotations

from datetime import date, timedelta
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily  # noqa: E402

CALENDAR = daily.ROOT / '.local' / 'events.json'
PRESS = daily.ROOT / '.local' / 'world' / 'results-calendar.json'
KINDS = ('results', 'rbi-policy', 'budget', 'fomc', 'macro-data', 'holiday', 'other')
SHARES = {s.removesuffix('.NS') for s in daily.datasets.UNIVERSE}
OWNER_WINS_DAYS = 20
PRESS_ONLY = 'press-reported results and policy days only (no owner calendar): other dates unknown'


def press_events(path=PRESS):
    """The desk shares' results days as the press reported them, or None when the organisation has none yet."""
    if not path or not Path(path).exists():
        return None
    try:
        raw = json.loads(Path(path).read_text(encoding='utf-8')).get('events', [])
    except (ValueError, AttributeError):
        return None
    out = []
    for e in raw if isinstance(raw, list) else []:
        if e.get('kind') in ('rbi-policy', 'fomc') and e.get('date'):  # market-wide: every share sees it
            out.append({'date': str(e['date']), 'kind': e['kind'], 'symbols': [], 'source': 'press',
                        'title': f"{e.get('company') or e['kind']} (press report, {e.get('publisher') or 'news'} "
                                 f"{str(e.get('publishedAt', ''))[:10]}; not the official calendar)"[:160]})
            continue
        share = str(e.get('symbol') or '').removesuffix('.NS')
        if share in SHARES and e.get('date'):
            out.append({'date': str(e['date']), 'kind': 'results', 'symbols': [share], 'source': 'press',
                        'title': f"{e.get('company') or share} results (press report, {e.get('publisher') or 'news'} "
                                 f"{str(e.get('publishedAt', ''))[:10]}; not the exchange filing)"[:160]})
    return out


def load(path=CALENDAR, press=PRESS):
    """(events, skipped): the owner's file plus the press's results days; (None, 0) when there is neither."""
    owner, skipped = _owner(Path(path))
    reported = press_events(press)
    if owner is None and reported is None:
        return None, 0
    owner = owner or []
    # the owner's entry wins over the press's for the same share's results, or the same decider's policy day
    owned = [(e['symbols'][0] if e['kind'] == 'results' else e['kind'], date.fromisoformat(e['date'])) for e in owner
             if (e['kind'] == 'results' and len(e['symbols']) == 1) or e['kind'] in ('rbi-policy', 'fomc')]
    key = lambda e: e['symbols'][0] if e['kind'] == 'results' else e['kind']  # noqa: E731
    extra = [e for e in reported or [] if not any(s == key(e) and abs((d - date.fromisoformat(e['date'])).days) <= OWNER_WINS_DAYS
                                                   for s, d in owned)]
    return sorted(owner + extra, key=lambda e: (e['date'], e['kind'], e['title'])), skipped


def _owner(path):
    if not path.exists():
        return None, 0
    try:
        raw = json.loads(path.read_text(encoding='utf-8')).get('events', [])
    except (ValueError, AttributeError):
        return [], 1
    events, skipped = [], 0
    for e in raw if isinstance(raw, list) else []:
        try:
            day = date.fromisoformat(str(e['date']))
            kind, title = e['kind'], str(e['title']).strip()[:160]
            symbols = sorted({str(s).removesuffix('.NS') for s in e.get('symbols', [])})
            if kind not in KINDS or not title or any(s not in SHARES for s in symbols):
                raise ValueError
            events.append({'date': day.isoformat(), 'kind': kind, 'title': title, 'symbols': symbols, 'source': 'owner'})
        except (KeyError, TypeError, ValueError):
            skipped += 1
    return events, skipped


def upcoming(events, as_of, days=10, symbol=None):
    """Events after `as_of` (a date or ISO timestamp) and within `days`, for one share (its own and market-wide ones) or
    all of them. None when there is no calendar."""
    if events is None:
        return None
    start = date.fromisoformat(str(as_of)[:10])
    end = start + timedelta(days=days)
    share = symbol.removesuffix('.NS') if symbol else None
    return [e for e in events if start < date.fromisoformat(e['date']) <= end
            and (share is None or not e['symbols'] or share in e['symbols'])]


def context(as_of, symbol=None, days=10, path=CALENDAR, press=PRESS):
    """What an agent sees: the upcoming events, or a plain statement that there is no calendar. With only the press's
    results days the status says so, since an empty list then means 'none reported', not 'nothing scheduled'."""
    events, _ = load(path, press)
    found = upcoming(events, as_of, days, symbol)
    status = 'no calendar' if found is None else 'available' if Path(path).exists() else PRESS_ONLY
    return {'status': status, 'events': found or []}
