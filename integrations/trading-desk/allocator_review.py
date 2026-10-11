"""Where does an AI allocator lag? Month-by-month attribution against the basket and, optionally, a teacher.

For every decision month it computes, from the actual prices, the next month's return of
  - the model's allocation (its cash earns nothing),
  - the equal-weight basket,
  - a teacher's allocation for the same anonymised brief (when supplied, e.g. stronger-model answers),
and splits the gap into causes: cash drag (uninvested money while the basket rose or fell), selection (which shares
it over- or under-weighted), and turnover (how much it reshuffled, which costs about 0.25% of the amount traded).
It also groups results by market state (how many shares were above their 200-day average in the brief).
Read-only. Output: allocator-review.json beside the run, plus a training file of (brief, teacher answer, outcome)
records that any future model can learn from.
Run: .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\allocator_review.py --run ai-monthly-qwen4b-v2 [--teacher answers.json]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_allocator as ai  # noqa: E402
import batch  # noqa: E402
import daily  # noqa: E402
import portfolio_daily as pd  # noqa: E402

COST_RATE = 0.0025


def weights_of(entry):
    return {k: w / 100 for k, w in entry.get('weights', {}).items()} if entry.get('outcome') == 'valid' else None


def review(run, teacher=None, cache=daily.DAILY, root=ai.RUNS):
    state = json.loads((root / run / 'decisions.json').read_text(encoding='utf-8'))
    dates, table = pd.aligned(daily.load(sorted(daily.datasets.UNIVERSE), cache))
    letters = ai.mapping(run, table)
    days = sorted(state['months'])
    index = {d: k for k, d in enumerate(dates)}
    rows, previous = [], None
    for n, day in enumerate(days):
        end = days[n + 1] if n + 1 < len(days) else dates[-1]
        i, j = index[day], index[end]
        if j <= i:
            continue
        ret = {k: table[s][end]['closePaise'] / table[s][day]['closePaise'] - 1 for k, s in letters.items()}
        basket = sum(ret.values()) / len(ret)
        entry = state['months'][day]
        w = weights_of(entry) or previous or {}
        model = sum(w.get(k, 0) * r for k, r in ret.items())
        invested = sum(w.values())
        turnover = sum(abs(w.get(k, 0) - (previous or {}).get(k, 0)) for k in ret) / 2 if previous is not None else invested
        facts = entry['facts']
        above = sum(bool(f.get('above200dAverage')) for f in facts.values())
        row = {'month': n + 1, 'day': day, 'basketPct': round(100 * basket, 2), 'modelPct': round(100 * model, 2),
               'cashPct': round(100 * (1 - invested), 1), 'turnoverPct': round(100 * turnover, 1), 'sharesAbove200d': above,
               # gap split: what the uninvested part missed, and what the invested part's tilts added or lost
               'cashDragPct': round(100 * (1 - invested) * -basket, 2) if basket else 0.0,
               'selectionPct': round(100 * (model - invested * basket), 2), 'costPct': round(-100 * COST_RATE * turnover, 2)}
        if teacher and f'{n + 1:02d}' in teacher:
            t = teacher[f'{n + 1:02d}']
            tw = {k: t[k] / 100 for k in ai.LETTERS}
            scale = min(1.0, 1 / sum(tw.values())) if sum(tw.values()) else 1.0
            row['teacherPct'] = round(100 * sum(tw[k] * scale * r for k, r in ret.items()), 2)
            row['teacherCashPct'] = round(100 * (1 - min(1.0, sum(tw.values()))), 1)
        rows.append(row)
        previous = w

    def avg(key, subset=rows):
        values = [r[key] for r in subset if key in r]
        return round(sum(values) / len(values), 2) if values else None
    states = {'broad uptrend (6+ above 200d)': [r for r in rows if r['sharesAbove200d'] >= 6],
              'mixed (3-5)': [r for r in rows if 3 <= r['sharesAbove200d'] <= 5],
              'broad downtrend (0-2)': [r for r in rows if r['sharesAbove200d'] <= 2]}
    summary = {'months': len(rows), 'monthsModelBeatBasket': sum(r['modelPct'] > r['basketPct'] for r in rows),
               'averageMonthlyGapPct': round(avg('modelPct') - avg('basketPct'), 2),
               'averageCashDragPct': avg('cashDragPct'), 'averageSelectionPct': avg('selectionPct'), 'averageCostPct': avg('costPct'),
               'averageCashPct': avg('cashPct'), 'averageTurnoverPct': avg('turnoverPct'),
               'byMarketState': {name: {'months': len(sub), 'modelPct': avg('modelPct', sub), 'basketPct': avg('basketPct', sub),
                                        'cashPct': avg('cashPct', sub)} for name, sub in states.items() if sub}}
    taught = [r for r in rows if 'teacherPct' in r]
    if taught:
        summary['teacher'] = {'months': len(taught), 'teacherPct': avg('teacherPct', taught), 'modelPct': avg('modelPct', taught),
                              'basketPct': avg('basketPct', taught), 'teacherCashPct': avg('teacherCashPct', taught),
                              'monthsTeacherBeatModel': sum(r['teacherPct'] > r['modelPct'] for r in taught)}
    return {'run': run, 'summary': summary, 'months': rows,
            'note': 'Gross monthly returns from actual prices; costs estimated at 0.25% of the amount traded. Descriptive.'}


def fully_invested(run, start_date=None, cache=daily.DAILY, root=ai.RUNS):
    """Counterfactual with the simulator's real costs: the model's own tilts, but its cash spread across its picks
    in proportion. Shows how much of the gap was cash, not stock choice. Uses the model's existing decisions only;
    being chosen after seeing these results, it is a hypothesis for a forward test, not proof."""
    state = json.loads((root / run / 'decisions.json').read_text(encoding='utf-8'))
    dates, table = pd.aligned(daily.load(sorted(daily.datasets.UNIVERSE), cache))
    weights = {}
    for day, w in state['weights'].items():
        total = sum(w.values())
        weights[day] = {s: v / total for s, v in w.items()} if total else {}
    start = next(k for k, d in enumerate(dates) if d >= (start_date or state['from']))
    end = len(dates) - 1

    def rule(_table, _dates, i):
        return weights.get(_dates[i], {})

    def original(_table, _dates, i):
        return state['weights'].get(_dates[i], {})
    return {'modelAsDecided': pd.simulate(table, dates, original, start, end),
            'modelFullyInvested': pd.simulate(table, dates, rule, start, end),
            'basket': pd.simulate(table, dates, pd.equal_weight, start, end, once=True)}


def teacher_simulation(run, teacher, cache=daily.DAILY, root=ai.RUNS):
    """The teacher's answers through the same simulator, costs and arithmetic (ai.allocation) as the model."""
    state = json.loads((root / run / 'decisions.json').read_text(encoding='utf-8'))
    dates, table = pd.aligned(daily.load(sorted(daily.datasets.UNIVERSE), cache))
    letters = ai.mapping(run, table)
    days = sorted(state['months'])
    weights = {}
    for n, day in enumerate(days, 1):
        answer = teacher.get(f'{n:02d}')
        if answer and ai.valid(answer):
            w, _, _ = ai.allocation(answer)
            weights[day] = {letters[k]: v / 100 for k, v in w.items() if v}
    start = next(k for k, d in enumerate(dates) if d >= state['from'])
    return pd.simulate(table, dates, lambda _t, _d, i: weights.get(_d[i], {}), start, len(dates) - 1)


def training_records(run, teacher, result, root=ai.RUNS):
    """(brief, teacher answer, outcomes) per taught month: model-agnostic data a future model can learn from."""
    state = json.loads((root / run / 'decisions.json').read_text(encoding='utf-8'))
    days = sorted(state['months'])
    out = []
    for row in result['months']:
        key = f"{row['month']:02d}"
        if key in teacher:
            entry = state['months'][days[row['month'] - 1]]
            out.append({'brief': {'shares': entry['facts']}, 'teacher': teacher[key],
                        'model': {**entry.get('weights', {}), 'rationale': entry.get('rationale')},
                        'nextMonth': {k: row[k] for k in ('teacherPct', 'modelPct', 'basketPct')}})
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--run', required=True)
    parser.add_argument('--teacher', type=Path, help='JSON {"01": {"A":..,"H":..,"rationale":..}, ...} keyed by month number')
    args = parser.parse_args(argv)
    teacher = json.loads(args.teacher.read_text(encoding='utf-8')) if args.teacher else None
    result = review(args.run, teacher)
    result['counterfactual'] = fully_invested(args.run)
    if teacher:
        result['counterfactual']['teacher'] = teacher_simulation(args.run, teacher)
    batch.save(ai.RUNS / args.run / 'allocator-review.json', result)
    if teacher:
        records = training_records(args.run, teacher, result)
        with (ai.RUNS / args.run / 'teacher-training.jsonl').open('w', encoding='utf-8') as handle:
            for r in records:
                handle.write(json.dumps(r) + '\n')
    print(json.dumps(result['summary'], indent=2))
    for name, r in result['counterfactual'].items():
        print(f"{name:20s} net {r['netPaise'] / 100:>12,.0f}  CAGR {r['cagr']:>6.1%}  worst fall {r['maxDrawdown']:>6.1%}  costs {r['costsPaise'] / 100:>8,.0f}")


if __name__ == '__main__':
    main()
