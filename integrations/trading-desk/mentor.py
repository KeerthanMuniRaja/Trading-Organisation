"""Mentor (MENTOR-01): lessons from an experienced mentor, checked on the organisation's own data and handed to the agents
at decision time. The curriculum (knowledge/mentor-curriculum.json) says what each lesson teaches, when it applies, and
which check proves it; `refresh` runs every check on the steward-checked daily data and writes
.local/trading-desk/knowledge/mentor.json, so every lesson carries its current evidence or is labelled unverified.
`notes_for` picks the few lessons that fit one decision (its share, the events coming up, the market regime), at most
three, so a small model's prompt stays short. Lessons are background for reasoning, never evidence to cite, and never
training data: the organisation's model learns permanently only from its own decisions and their real outcomes.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\mentor.py refresh
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import daily  # noqa: E402
import portfolio_daily as pd  # noqa: E402

CURRICULUM = Path(__file__).resolve().parent / 'knowledge' / 'mentor-curriculum.json'
OUT = daily.ROOT / '.local' / 'trading-desk' / 'knowledge' / 'mentor.json'
BANKS = ('HDFCBANK.NS', 'ICICIBANK.NS', 'AXISBANK.NS', 'SBIN.NS')
WINDOW = 500  # about two years of sessions for correlations and betas
MAX_NOTES = 3


def _returns(table, dates, window=WINDOW):
    days = dates[-window - 1:]
    return {s: [table[s][days[k]]['closePaise'] / table[s][days[k - 1]]['closePaise'] - 1 for k in range(1, len(days))] for s in table}


def _corr(a, b):
    ma, mb = statistics.fmean(a), statistics.fmean(b)
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    va, vb = sum((x - ma) ** 2 for x in a), sum((y - mb) ** 2 for y in b)
    return cov / (va * vb) ** 0.5 if va and vb else 0.0


def bank_correlation(table, dates):
    r = _returns(table, dates)
    banks = [s for s in BANKS if s in r]
    others = [s for s in r if s not in banks]
    within = [_corr(r[a], r[b]) for i, a in enumerate(banks) for b in banks[i + 1:]]
    across = [_corr(r[a], r[b]) for a in banks for b in others]
    w, x = round(statistics.fmean(within), 2), round(statistics.fmean(across), 2)
    return {'withinBanks': w, 'bankToOthers': x,
            'text': f'Over the last ~2 years the banks\' daily moves correlate {w} with each other, against {x} with the other shares.',
            'holds': w > x}


def betas(table, dates):
    r = _returns(table, dates)
    basket = [statistics.fmean(day) for day in zip(*r.values())]
    var = statistics.pvariance(basket)
    out = {s.removesuffix('.NS'): round(sum((x - statistics.fmean(r[s])) * (y - statistics.fmean(basket)) for x, y in zip(r[s], basket)) / len(basket) / var, 2)
           for s in sorted(r)}
    low = {s: out[s] for s in ('ITC', 'NTPC') if s in out}
    banks = statistics.fmean(out[s.removesuffix('.NS')] for s in BANKS if s.removesuffix('.NS') in out)
    return {'betas': out, 'text': f"Betas to the basket over ~2 years: {', '.join(f'{k} {v}' for k, v in low.items())}; the banks average {banks:.2f}.",
            'holds': bool(low) and all(v < banks for v in low.values())}


def momentum_in_rebounds(table, dates, drop_pct=-10.0):
    import rnd_scout
    rows = rnd_scout.monthly(table, dates, {'m': lambda t, d, i: pd.top_momentum(t, d, i, months=6, keep=3)})
    after, normal = [], []
    for k, row in enumerate(rows):
        prior = rows[max(0, k - 3):k]
        level = 1.0
        for p in prior:
            level *= 1 + p['basketPct'] / 100
        (after if len(prior) == 3 and 100 * (level - 1) <= drop_pct else normal).append(row['rules']['m'] - row['basketPct'])
    if not after:
        return {'text': 'No deep three-month fall in the history to judge momentum against.', 'holds': None}
    a, n = round(statistics.fmean(after), 2), round(statistics.fmean(normal), 2)
    return {'monthsAfterDeepFalls': len(after), 'excessAfterFallsPct': a, 'excessOtherwisePct': n,
            'text': f'In the {len(after)} months after a basket fall of 10%+ over three months, 6-month momentum (top 3) averaged {a:+}% a month against the basket, against {n:+}% in other months.',
            'holds': a < n}


def turnover_cost(table, dates):
    import rnd_scout
    c = rnd_scout.ONE_WAY_COST_PCT
    return {'oneWayCostPct': c, 'text': f'Our model charges {c}% on each unit traded, one way: a full monthly rebalance in and out costs about {2 * c}% of the money moved.',
            'holds': True}


def regime_warning(table, dates):
    path = OUT.parent.parent / 'regime' / 'study.json'
    if not path.exists():
        return {'text': 'The regime study has not run yet.', 'holds': None}
    levels = json.loads(path.read_text(encoding='utf-8'))['levels']
    s, n = levels['SEVERE']['averageWorstFallPct'], levels['NORMAL']['averageWorstFallPct']
    return {'text': f'After SEVERE days the next 20 sessions\' average worst fall was {s}%, after NORMAL days {n}%.', 'holds': s is not None and n is not None and s < n}


CHECKS = {'bank_correlation': bank_correlation, 'betas': betas, 'momentum_in_rebounds': momentum_in_rebounds,
          'turnover_cost': turnover_cost, 'regime_warning': regime_warning}


def refresh(curriculum=CURRICULUM, out=OUT, cache=daily.DAILY, now=None):
    """Every lesson with the result of its check on our data: 'checked' (the data agrees), 'contradicted' (it does not;
    the lesson is kept but marked, so nobody leans on it), or 'unverified' (no check yet, or it could not run)."""
    plan = json.loads(Path(curriculum).read_text(encoding='utf-8'))
    dates, table = pd.aligned(daily.load(sorted(daily.datasets.UNIVERSE), cache))
    lessons = []
    for lesson in plan['lessons']:
        check, result = lesson.get('test'), None
        if check in CHECKS and len(dates) > WINDOW:
            try:
                result = CHECKS[check](table, dates)
            except (KeyError, ValueError, ZeroDivisionError, statistics.StatisticsError) as error:
                result = {'text': f'The check could not run: {type(error).__name__}', 'holds': None}
        status = 'unverified' if not result or result.get('holds') is None else 'checked' if result['holds'] else 'contradicted'
        lessons.append({**lesson, 'status': status, **({'evidence': result['text'], 'measured': {k: v for k, v in result.items() if k not in ('text', 'holds')}}
                                                         if result else {})})
    report = {'version': plan['version'], 'generatedAt': (now or datetime.now(timezone.utc)).isoformat(), 'through': dates[-1] if dates else None,
              'lessons': lessons, 'note': plan['note']}
    batch.save(Path(out), report)
    return report


def notes_for(symbol=None, events=(), regime=None, method=None, path=OUT, limit=MAX_NOTES):
    """The lessons that fit one decision, most specific first (its share, an event coming up, the regime, its method,
    then the always-true ones), contradicted lessons left out; each as {title, lesson, status, evidence}."""
    if not Path(path).exists():
        return []
    share = (symbol or '').removesuffix('.NS')
    scored = []
    for k, lesson in enumerate(json.loads(Path(path).read_text(encoding='utf-8'))['lessons']):
        if lesson['status'] == 'contradicted':
            continue
        a = lesson.get('appliesTo', {})
        score = (4 if share and share in a.get('symbols', []) else 0) + (3 if set(events) & set(a.get('events', [])) else 0) \
            + (2 if regime and regime in a.get('regimes', []) else 0) + (2 if method and method in a.get('methods', []) else 0) \
            + (1 if a.get('always') else 0)
        if a.get('symbols') and share and share not in a['symbols'] and not set(events) & set(a.get('events', [])):
            score = 0  # a lesson about other shares does not apply
        if score:
            scored.append((-score, k, lesson))
    return [{'title': l['title'], 'lesson': l['lesson'], 'status': l['status'], **({'evidence': l['evidence']} if l.get('evidence') else {})}
            for _, _, l in sorted(scored)[:limit]]


def main(argv=None):
    command = (argv or sys.argv[1:] or ['refresh'])[0]
    if command != 'refresh':
        raise SystemExit('Usage: mentor.py refresh')
    r = refresh()
    print(json.dumps({'state': 'done', 'through': r['through'], 'lessons': len(r['lessons']),
                      'byStatus': {s: sum(l['status'] == s for l in r['lessons']) for s in ('checked', 'contradicted', 'unverified')}}))


if __name__ == '__main__':
    main()
