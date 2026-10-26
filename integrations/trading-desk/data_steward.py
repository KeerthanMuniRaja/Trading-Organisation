"""Data steward (MARKET-01): no daily price file is replaced unless the new download passes checks, and every replaced
version is archived with its fingerprint so any earlier result can be reproduced on the exact data it used.

Checks on a new download, against the previous version and the other shares:
  extreme-move      a close-to-close move beyond 20% in one session: large NSE shares rarely move that much, so it is
                    most likely an unadjusted split/bonus or a bad print (reject)
  history-rewrite   on overlapping days, adjusted prices may be rescaled by ONE factor (a new dividend or split moves
                    the whole past); differences that are not a single scale mean history changed (reject)
  shrunk-history    the new file covers fewer old days than the previous one (reject)
  corporate-action-suspected  the whole past rescaled by more than 20% (a split or bonus): accepted, but the owner
                    must record the action so paper positions are rescaled (warning)
  stale             the last bar is more than 7 calendar days old (warning)
  gaps              sessions missing where most other shares traded (warning)
Rejected downloads leave the previous file in place (fail closed).
Before review, placeholder bars are left out of a download (`without_placeholders`): zero volume and a flat bar at the
previous close, which the provider repeats on a day the share did not trade (seen on 18 Mar 2025 and 15 Jan 2026 for
nearly every share). Kept, they would pass as sessions in which nothing moved, and a fill priced at their open would be
a fill on a day with no trading.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\data_steward.py report
"""
from __future__ import annotations

import argparse
from datetime import date
import hashlib
import json
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

EXTREME_MOVE = 0.20
REWRITE_TOLERANCE = 0.002   # 0.2% spread of old/new ratios is still "one scale" after rounding to paise
STALE_DAYS = 7


def fingerprint(dataset):
    return hashlib.sha256(json.dumps(dataset['bars'], sort_keys=True).encode()).hexdigest()[:16]


def extreme_moves(bars, limit=EXTREME_MOVE):
    out = []
    for a, b in zip(bars, bars[1:]):
        change = b['closePaise'] / a['closePaise'] - 1
        if abs(change) > limit:
            out.append({'date': b['date'], 'changePct': round(change * 100, 1)})
    return out


MAX_ADJUSTMENT_STEPS = 4    # e.g. quarterly dividends since the previous download
MIN_SEGMENT_SESSIONS = 5


def rewrite(old_bars, new_bars, tolerance=REWRITE_TOLERANCE):
    """Old/new close ratios on shared days, in date order. A dividend or split rescales every day before its ex-date by
    one factor, so legitimate changes form a few long flat segments separated by steps. Many steps, or a short segment
    (a blip that goes away again), mean the past itself changed."""
    old = {b['date']: b['closePaise'] for b in old_bars}
    pairs = sorted((b['date'], b['closePaise'] / old[b['date']]) for b in new_bars if b['date'] in old)
    if len(pairs) < 2:
        return {'sharedDays': len(pairs), 'adjustmentSteps': 0, 'stepDates': [], 'rewritten': False}
    steps = [i for i in range(1, len(pairs)) if abs(pairs[i][1] / pairs[i - 1][1] - 1) > tolerance]
    bounds = [0, *steps, len(pairs)]
    interior = [bounds[k + 1] - bounds[k] for k in range(1, len(bounds) - 2)]  # segments between two steps
    rewritten = len(steps) > MAX_ADJUSTMENT_STEPS or any(n < MIN_SEGMENT_SESSIONS for n in interior)
    return {'sharedDays': len(pairs), 'adjustmentSteps': len(steps), 'stepDates': [pairs[i][0] for i in steps][:5],
            'latestScale': round(statistics.median(r for _, r in pairs[-20:]), 6), 'rewritten': rewritten}


ACTION_SCALE = 0.20         # a whole-history rescale beyond 20% is a split or bonus, not a dividend


def suspected_action(old_bars, new_bars, r):
    """A split or bonus rescales the whole past by its ratio (a 1:1 bonus halves it). Dividends move it by a few percent.
    Returns the likely factor and the first session not in the previous file (the ex-date, on a daily refresh)."""
    scale = r.get('latestScale')
    if not scale or abs(scale - 1) <= ACTION_SCALE:
        return None
    last_old = old_bars[-1]['date']
    first_new = next((b['date'] for b in new_bars if b['date'] > last_old), None)
    factor = round(1 / scale, 3)
    return {'factor': factor, 'likelyExDate': first_new, 'sharesAfterPerShare': factor,
            'action': 'Possible split or bonus: check the exchange notice and record it (POST /v1/corporate-actions) so positions are rescaled'}


def placeholders(bars):
    """Dates of bars with no trading in them: zero volume, open = high = low = close, and that close equal to the previous
    bar's close. A real session with no volume does not exist for these shares; the provider repeats the last close."""
    return [b['date'] for a, b in zip(bars, bars[1:]) if b['volume'] == 0
            and b['openPaise'] == b['highPaise'] == b['lowPaise'] == b['closePaise'] == a['closePaise']]


def without_placeholders(bars):
    """The bars without placeholders, and the dates left out. A gap is honest; an invented session is not."""
    drop = set(placeholders(bars))
    return [b for b in bars if b['date'] not in drop], sorted(drop)


def gaps(bars, peer_dates, share=0.75):
    """Sessions (within this file's span) on which at least `share` of peers traded but this share has no bar."""
    mine = {b['date'] for b in bars}
    first, last = bars[0]['date'], bars[-1]['date']
    counts = {}
    for dates in peer_dates:
        for d in dates:
            if first <= d <= last:
                counts[d] = counts.get(d, 0) + 1
    need = max(1, int(share * len(peer_dates)))
    return sorted(d for d, n in counts.items() if n >= need and d not in mine)


def review(new, old=None, peers=(), today=None, accepted=()):
    """Verdict for a new download: 'ok', 'warning' (usable) or 'reject' (keep the previous file). `accepted`: session
    dates of large moves the owner checked and confirmed as real (daily.py accept-move)."""
    bars = new['bars']
    issues = []
    # a large move the previous (accepted) file already had, or that the owner confirmed, is known; any other large move,
    # new or rewritten into the past, is rejected
    known = ({m['date'] for m in extreme_moves(old['bars'])} if old else set()) | set(accepted)
    for move in extreme_moves(bars):
        if move['date'] not in known:
            issues.append({'check': 'extreme-move', 'severity': 'reject', **move})
    if old:
        r = rewrite(old['bars'], bars)
        if r['rewritten']:
            issues.append({'check': 'history-rewrite', 'severity': 'reject', **r})
        action = suspected_action(old['bars'], bars, r)
        if action:
            issues.append({'check': 'corporate-action-suspected', 'severity': 'warning', **action})
        if bars[0]['date'] > old['bars'][0]['date'] and len(bars) < len(old['bars']) - 5:
            issues.append({'check': 'shrunk-history', 'severity': 'reject', 'oldBars': len(old['bars']), 'newBars': len(bars)})
    age = ((today or date.today()) - date.fromisoformat(bars[-1]['date'])).days
    if age > STALE_DAYS:
        issues.append({'check': 'stale', 'severity': 'warning', 'lastBar': bars[-1]['date'], 'ageDays': age})
    missing = gaps(bars, [[b['date'] for b in p['bars']] for p in peers]) if peers else []
    if missing:
        issues.append({'check': 'gaps', 'severity': 'warning', 'missingSessions': len(missing), 'examples': missing[:5]})
    verdict = 'reject' if any(i['severity'] == 'reject' for i in issues) else 'warning' if issues else 'ok'
    return {'verdict': verdict, 'issues': issues, 'fingerprint': fingerprint(new), 'bars': len(bars), 'to': bars[-1]['date']}


def archive(path, dataset, history_dir):
    """Keeps the version about to be replaced, named by its fingerprint; returns the archived path."""
    history_dir.mkdir(parents=True, exist_ok=True)
    target = history_dir / f"{path.stem}-{fingerprint(dataset)}.json"
    if not target.exists():
        target.write_text(json.dumps(dataset), encoding='utf-8')
    return target


def main(argv=None):
    import daily
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=['report'])
    parser.parse_args(argv)
    data = {s: json.loads((daily.DAILY / f'{s}-1d.json').read_text(encoding='utf-8')) for s in sorted(daily.datasets.UNIVERSE)
            if (daily.DAILY / f'{s}-1d.json').exists()}
    report = {}
    for symbol, dataset in data.items():
        peers = [d for s, d in data.items() if s != symbol]
        report[symbol] = review(dataset, None, peers)
        print(f"{symbol:14s} {report[symbol]['verdict']:8s} fingerprint {report[symbol]['fingerprint']} bars {report[symbol]['bars']} "
              f"to {report[symbol]['to']}  " + '; '.join(i['check'] + (f" {i.get('date', '')} {i.get('changePct', '')}%" if i['check'] == 'extreme-move' else '')
                                                        for i in report[symbol]['issues']))
    history = daily.DAILY / 'history'
    print(f"archived versions: {len(list(history.glob('*.json'))) if history.exists() else 0}")


if __name__ == '__main__':
    main()
