"""Events calendar (NEWS-05; Anthropic financial plugins' catalyst calendar, gap 30): what is scheduled that can move the
shares, so a decision is never taken blind to results day or a policy meeting. The owner keeps the file by hand (no
source is fetched): .local/events.json, for example
  {"events": [{"date": "2026-10-28", "kind": "results", "symbols": ["SBIN"], "title": "SBI Q2 results"},
              {"date": "2026-12-05", "kind": "rbi-policy", "title": "RBI monetary policy decision"}]}
Kinds: results, rbi-policy, budget, fomc, macro-data, holiday, other. An event without symbols concerns the whole market.
Invalid entries are skipped and counted, never guessed. The debate, the scenario panel and the digest read it; a
missing file is said plainly ('no calendar'), never treated as 'nothing scheduled'.
"""
from __future__ import annotations

from datetime import date, timedelta
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily  # noqa: E402

CALENDAR = daily.ROOT / '.local' / 'events.json'
KINDS = ('results', 'rbi-policy', 'budget', 'fomc', 'macro-data', 'holiday', 'other')
SHARES = {s.removesuffix('.NS') for s in daily.datasets.UNIVERSE}


def load(path=CALENDAR):
    """(events, skipped) from the owner's file, or (None, 0) when there is no file."""
    path = Path(path)
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
            events.append({'date': day.isoformat(), 'kind': kind, 'title': title, 'symbols': symbols})
        except (KeyError, TypeError, ValueError):
            skipped += 1
    return sorted(events, key=lambda e: (e['date'], e['kind'], e['title'])), skipped


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


def context(as_of, symbol=None, days=10, path=CALENDAR):
    """What an agent sees: the upcoming events, or a plain statement that there is no calendar."""
    events, _ = load(path)
    found = upcoming(events, as_of, days, symbol)
    return {'status': 'no calendar' if found is None else 'available', 'events': found or []}
