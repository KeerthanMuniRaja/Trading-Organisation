"""Review scorecard (TRUST-02): does the risk review keep the organisation out of bad calls, or out of good ones? No model.

The scorer scores every reviewed proposal that had a fresh quote, accepted or not, so the backend already knows how the
calls the review turned down would have gone. This report reads those scores (evaluator credential, read-only) and
groups them:
  - by what happened: executed, lapsed (accepted but never filled), accepted and still open, rejected, expired before
    review, acknowledged (no-action);
  - by each rejection reason (a reason that mostly blocks right calls is a candidate for the owner to look at);
  - by the market regime known when the call was made (the last session that had closed by then, from
    regime/history.json), so the record shows whether calls go worse under pressure.
A call is right or wrong by the backend's own rule (signal_scorer, trade-signals.ts), never re-judged here. It changes
nothing: the review rules and limits are the owner's.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\review_scorecard.py
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import daily  # noqa: E402
import signal_scorer as sc  # noqa: E402

OUT = daily.ROOT / '.local' / 'trading-desk' / 'review-scorecard.json'
REGIMES = daily.ROOT / '.local' / 'trading-desk' / 'regime' / 'history.json'
MIN_CALLS, MIN_GAP_POINTS = 20, 10
ACTIONABLE = ('enter-long', 'exit')
NOT_A_REASON = {'priced-from-verified-close'}


def fate(signal):
    outcome = signal['review']['outcome']
    if outcome == 'accepted':
        return 'executed' if signal.get('execution') else 'lapsed' if signal.get('lapse') else 'accepted-open'
    return outcome  # rejected, expired, acknowledged


def regime_at(days, created_at):
    """The risk level of the last session that had closed (and settled) when the call was made; None if unknown."""
    made = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
    known = [d for d in days if sc.close_time(d['date']) + sc.SETTLE <= made]
    return known[-1]['risk'] if known else None


def tally(calls):
    right = sum(1 for c in calls if c['outcome']['correct'])
    moves = [c['outcome']['moveBps'] for c in calls if c['outcome'].get('moveBps') is not None]
    return {'scored': len(calls), 'right': right, 'rightPct': round(100 * right / len(calls), 1) if calls else None,
            'averageMovePct': round(sum(moves) / len(moves) / 100, 2) if moves else None}


def scorecard(signals, regime_days=()):
    calls = [s for s in signals if s.get('review') and s.get('outcome')]
    fates = {}
    for c in calls:
        fates.setdefault(fate(c), []).append(c)
    reasons = {}
    for c in fates.get('rejected', []):
        for r in set(c['review']['reasons']) - NOT_A_REASON:
            reasons.setdefault(r, []).append(c)
    regimes = {}
    for c in calls:
        regimes.setdefault(regime_at(regime_days, c['createdAt']) or 'unknown', []).append(c)
    # the question that matters: among calls that could have traded, did the turned-down ones do worse than the taken ones?
    taken = [c for c in calls if fate(c) in ('executed', 'lapsed', 'accepted-open') and c['action'] in ACTIONABLE]
    refused = [c for c in fates.get('rejected', []) if c['action'] in ACTIONABLE]
    a, r = tally(taken), tally(refused)
    if a['scored'] < MIN_CALLS or r['scored'] < MIN_CALLS:
        verdict = 'insufficient-evidence'
    elif r['rightPct'] <= a['rightPct'] - MIN_GAP_POINTS:
        verdict = 'review-turns-down-worse-calls'
    elif r['rightPct'] >= a['rightPct'] + MIN_GAP_POINTS:
        verdict = 'review-turns-down-better-calls'
    else:
        verdict = 'no-clear-difference'
    return {'calls': len(calls), 'accepted': a, 'rejected': r, 'verdict': verdict,
            'byFate': {k: tally(v) for k, v in sorted(fates.items())},
            'byRejectionReason': {k: tally(v) for k, v in sorted(reasons.items(), key=lambda kv: -len(kv[1]))},
            'byRegimeAtCall': {k: tally(v) for k, v in sorted(regimes.items())},
            'rule': f'verdict needs {MIN_CALLS}+ scored calls on each side and a gap of {MIN_GAP_POINTS}+ points in the share right',
            'note': 'Right or wrong is the backend\'s own score. A report only: the review rules and limits are the owner\'s.'}


def all_signals(base, token, opener):
    out, before = [], None
    while True:
        page = sc.post(base, token, '/v1/trading/signals/query', {'limit': 200, **({'before': before} if before else {})}, opener)
        out += page['signals']
        before = page.get('nextBefore')
        if not before:
            return out


def run(env=os.environ, opener=None, out=OUT, regimes=REGIMES, now=None):
    from urllib import request as urlrequest
    days = json.loads(regimes.read_text(encoding='utf-8'))['days'] if regimes.exists() else []
    card = scorecard(all_signals(*sc.principals(env, 'evaluator'), opener or urlrequest.urlopen), days)
    card['generatedAt'] = (now or datetime.now(timezone.utc)).isoformat()
    batch.save(out, card)
    return card


if __name__ == '__main__':
    c = run()
    print(json.dumps({k: c[k] for k in ('calls', 'accepted', 'rejected', 'verdict')}))
