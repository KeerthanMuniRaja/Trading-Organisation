"""News reactions (AWARE-02): what happened after the press reported a share's move, by the kind of news.

The market pulse reads "KEI Industries shares tumble 8% despite Q2 profit rising 29%" as a move and its reason. This
study keeps every such report (append-only history) and, once the prices exist, measures the next 5 sessions against
the market (the average NIFTY 500 share), from the close of the day it was reported. Grouped by the kind of news
(results, broker call, deal or stake, order or contract, policy, other) and by direction, it answers: after this kind
of news, did the move continue or give back? A kind with enough cases becomes an organisation lesson.
Unverified press read by rules; a study, never a signal by itself. No model, no network.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\news_reactions.py
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import re
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import daily  # noqa: E402

PULSE = daily.ROOT / '.local' / 'world' / 'market-pulse.json'
HISTORY = daily.ROOT / '.local' / 'world' / 'pulse-history.jsonl'
OUT = daily.ROOT / '.local' / 'world' / 'news-reactions.json'
AHEAD = 5
MIN_CASES = 30   # a kind needs this many measured reports before it says anything
KINDS = [  # first match wins: the reason (or the title) decides
    ('results', r'\b(?:Q[1-4]|results?|profit|PAT|revenue|earnings|margin|EBITDA|NII|guidance)\b'),
    ('broker-call', r'\b(?:target|brokerage|upgrade|downgrade|rating|Jefferies|Nomura|Goldman|Morgan Stanley|CLSA|Macquarie|Citi|'
                    r'Motilal|Kotak|buy call|sell call|overweight|underweight)\b'),
    ('deal-or-stake', r'\b(?:stake|acquir\w*|acquisition|merger|demerger|block deal|bulk deal|promoter|IPO|listing|buyback|open offer)\b'),
    ('order-or-contract', r'\b(?:order|contract|wins?|bags?|awarded|tender|deal worth)\b'),
    ('policy', r'\b(?:RBI|SEBI|government|tax|policy|ban|tariff|regulat\w*|court|probe)\b'),
]


def kind_of(text):
    return next((k for k, pattern in KINDS if re.search(pattern, text or '', re.IGNORECASE)), 'other')


def record(pulse, history=HISTORY):
    """Appends the pulse's same-day moves not yet in the history (by title and time); returns how many were new."""
    history = Path(history)
    seen = set()
    if history.exists():
        seen = {json.loads(l)['key'] for l in history.read_text(encoding='utf-8').splitlines() if l.strip()}
    new = []
    for m in pulse.get('movers', []):
        if m.get('period'):
            continue  # a year-to-date or six-month move has no single day to measure from
        key = hashlib.sha256(f"{m['publishedAt']}|{m['title']}".encode()).hexdigest()[:16]
        if key in seen:
            continue
        seen.add(key)
        new.append({'key': key, 'publishedAt': m['publishedAt'], 'symbol': m['symbol'], 'direction': m['direction'], 'pct': m['pct'],
                    'kind': kind_of(m.get('why') or m['title']), 'why': m.get('why'), 'title': m['title']})
    if new:
        history.parent.mkdir(parents=True, exist_ok=True)
        with history.open('a', encoding='utf-8') as handle:
            for row in new:
                handle.write(json.dumps(row, sort_keys=True) + '\n')
    return len(new)


def measure(rows, prepared):
    """Each report's next AHEAD sessions against the market, from the close of the session it was reported on (or the
    next session, if it came after the close or on a holiday). None while those sessions have not happened."""
    shares, _ = prepared
    out = []
    for r in rows:
        p = shares.get(r['symbol'])
        if not p:
            continue
        published = datetime.fromisoformat(r['publishedAt'])
        ist = published.astimezone(timezone(timedelta(hours=5, minutes=30)))
        day = ist.date().isoformat()
        after_close = (ist.hour, ist.minute) >= (15, 30)
        i = next((k for k, d in enumerate(p['dates']) if d > day or (d == day and not after_close)), None)
        if i is None or i + AHEAD >= len(p['dates']):
            continue
        window = p['rel'][i + 1:i + AHEAD + 1]
        if None in window:
            continue
        out.append({**r, 'from': p['dates'][i], 'nextPct': round(100 * sum(window), 2)})
    return out


def study(measured, min_cases=MIN_CASES):
    """By kind and direction: cases, the average next-week move against the market, and how often the move continued."""
    groups = {}
    for m in measured:
        groups.setdefault((m['kind'], m['direction']), []).append(m['nextPct'])
    table = []
    for (kind, direction), xs in sorted(groups.items()):
        same = [x for x in xs if (x > 0) == (direction == 'up') and x != 0]
        row = {'kind': kind, 'direction': direction, 'cases': len(xs), 'avgNextWeekPct': round(statistics.fmean(xs), 2),
               'continuedPct': round(100 * len(same) / len(xs)), 'enough': len(xs) >= min_cases}
        if len(xs) >= 3 and statistics.stdev(xs):
            row['tStat'] = round(statistics.fmean(xs) / (statistics.stdev(xs) / len(xs) ** 0.5), 2)
        table.append(row)
    return table


def build(pulse_path=PULSE, history=HISTORY, out=OUT, prepared=None, now=None):
    pulse = json.loads(Path(pulse_path).read_text(encoding='utf-8')) if Path(pulse_path).exists() else {'movers': []}
    new = record(pulse, history)
    rows = [json.loads(l) for l in Path(history).read_text(encoding='utf-8').splitlines() if l.strip()] if Path(history).exists() else []
    if prepared is None:
        import mentor_broad
        prepared = mentor_broad.load() if daily.BROAD.exists() else ({}, {})
    measured = measure(rows, prepared)
    report = {'generatedAt': (now or datetime.now(timezone.utc)).isoformat(), 'reports': len(rows), 'newToday': new,
              'measured': len(measured), 'waitingForPrices': len(rows) - len(measured), 'horizonSessions': AHEAD,
              'minCases': MIN_CASES, 'byKind': study(measured),
              'note': 'Unverified press read by rules, measured against the market afterwards: a study, never a signal by itself.'}
    batch.save(Path(out), report)
    return report


def main(argv=None):
    r = build()
    print(json.dumps({k: r[k] for k in ('reports', 'newToday', 'measured', 'waitingForPrices')}
                     | {'byKind': [f"{t['kind']} {t['direction']}: {t['cases']} cases, next week {t['avgNextWeekPct']:+}% vs market, "
                                   f"continued {t['continuedPct']}%" + ('' if t['enough'] else ' (too few)') for t in r['byKind']]}, indent=2))


if __name__ == '__main__':
    main()
