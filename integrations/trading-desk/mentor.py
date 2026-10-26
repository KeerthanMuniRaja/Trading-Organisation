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


# ---------- curriculum v2 (27 Oct 2026) ----------
LIVE_BUDGET_PAISE = 500_000   # the live rule bot's budget: the size at which costs are judged


def _basket(table, dates):
    """The equal-weight basket's daily returns over the whole aligned history."""
    return [statistics.fmean(table[s][dates[k]]['closePaise'] / table[s][dates[k - 1]]['closePaise'] - 1 for s in table) for k in range(1, len(dates))]


def dp_at_live_size(table, dates):
    position = LIVE_BUDGET_PAISE // 3
    dp_pct = round(100 * daily.DP_PER_SELL_PAISE / position, 2)
    import rnd_scout
    return {'positionPaise': position, 'depositoryChargePaise': daily.DP_PER_SELL_PAISE, 'dpPctOfSale': dp_pct,
            'text': f'Selling a third of a Rs {LIVE_BUDGET_PAISE // 100:,} budget (Rs {position // 100:,}) pays a Rs {daily.DP_PER_SELL_PAISE / 100:.2f} '
                    f'depository charge: {dp_pct}% of the sale, on top of the {rnd_scout.ONE_WAY_COST_PCT}% percentage costs.',
            'holds': dp_pct > rnd_scout.ONE_WAY_COST_PCT}


def volatility_clusters(table, dates):
    r = [abs(x) for x in _basket(table, dates)]
    c = round(_corr(r[:-1], r[1:]), 2)
    return {'lagOneCorrelationOfAbsMoves': c,
            'text': f'On our basket, the size of one day\'s move correlates {c} with the next day\'s: calm follows calm, storms follow storms.',
            'holds': c > 0.05}


def below_trend_falls(table, dates, window=200, ahead=20):
    level, levels = 1.0, [1.0]
    for x in _basket(table, dates):
        level *= 1 + x
        levels.append(level)
    below, above = [], []
    for i in range(window, len(levels) - ahead):
        worst = min(levels[i + 1:i + ahead + 1]) / levels[i] - 1
        (below if levels[i] < sum(levels[i - window + 1:i + 1]) / window else above).append(worst)
    if not below or not above:
        return {'text': 'Not enough history on both sides of the 200-day average.', 'holds': None}
    b, a = round(100 * statistics.fmean(below), 2), round(100 * statistics.fmean(above), 2)
    return {'daysBelow': len(below), 'worstFallBelowPct': b, 'worstFallAbovePct': a,
            'text': f'When our basket was below its 200-day average ({len(below)} days), the next 20 sessions\' worst fall averaged {b}%, against {a}% when above.',
            'holds': b < a}


def diversification(table, dates):
    r = _returns(table, dates)
    single = statistics.fmean(statistics.pstdev(v) for v in r.values())
    basket = statistics.pstdev([statistics.fmean(day) for day in zip(*r.values())])
    ratio = round(basket / single, 2) if single else None
    return {'basketToSingleVolatility': ratio,
            'text': f'Over ~2 years the 8-share basket swung {ratio} times as much as the average single share: holding several cuts risk, less so when they are alike.',
            'holds': ratio is not None and ratio < 0.85}


def recovery_maths(table, dates):
    level, peak, worst, under, longest = 1.0, 1.0, 0.0, 0, 0
    for x in _basket(table, dates):
        level *= 1 + x
        if level >= peak:
            peak, under = level, 0
        else:
            under += 1
            longest = max(longest, under)
            worst = min(worst, level / peak - 1)
    need = round(100 * (1 / (1 + worst) - 1), 1) if worst > -1 else None
    return {'worstFallPct': round(100 * worst, 1), 'gainNeededPct': need, 'longestUnderwaterSessions': longest,
            'text': f'Our basket\'s worst fall was {round(100 * worst, 1)}%, which needed a {need}% gain to recover; its longest time below a previous peak was {longest} sessions.',
            'holds': True}


def base_rate(table, dates, horizon=21, cost_pct=0.3):
    wins, total = 0, 0
    for s in table:
        closes = [table[s][d]['closePaise'] for d in dates]
        for i in range(0, len(closes) - horizon, horizon):
            total += 1
            wins += 100 * (closes[i + horizon] / closes[i] - 1) > cost_pct
    rate = round(100 * wins / total, 1) if total else None
    return {'monthsJudged': total, 'roseMoreThanCostsPct': rate,
            'text': f'Across our 8 shares, a month rose by more than the {cost_pct}% round-trip cost {rate}% of the time: a "buy" call must beat that base rate, not 50%.',
            'holds': rate is not None and 35 <= rate <= 65}


CHECKS = {'bank_correlation': bank_correlation, 'betas': betas, 'momentum_in_rebounds': momentum_in_rebounds,
          'turnover_cost': turnover_cost, 'regime_warning': regime_warning,
          'dp_at_live_size': dp_at_live_size, 'volatility_clusters': volatility_clusters, 'below_trend_falls': below_trend_falls,
          'diversification': diversification, 'recovery_maths': recovery_maths, 'base_rate': base_rate}


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


def method_of(model):
    """The method family behind a proposal's model name (e.g. 'rules:top3-momentum-6m' -> 'momentum'), or None."""
    text = str(model or '').lower()
    return next((m for m in ('momentum', 'reversal', 'low-vol', 'trend', 'pullback') if m in text), None)


def notes_for(symbol=None, events=(), regime=None, method=None, path=OUT, limit=MAX_NOTES):
    """The lessons that fit one decision, most specific first (its share, an event coming up, the regime, its method,
    then the always-true ones), contradicted lessons left out; each as {title, lesson, status, evidence}. Read from the
    mentor's checked curriculum AND the organisation's own lessons beside it (organisation_lessons.py, MENTOR-02)."""
    files = [p for p in (Path(path), Path(path).parent / 'organisation-lessons.json') if p.exists()]
    if not files:
        return []
    share = (symbol or '').removesuffix('.NS')
    scored = []
    pool = [l for p in files for l in json.loads(p.read_text(encoding='utf-8'))['lessons']]
    for k, lesson in enumerate(pool):
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
