"""Teacher curriculum: lessons for the AI allocator, learned on earlier months and tested on later ones.

A stronger teacher model answered the same anonymised monthly briefs as the local allocator (allocator_review.py).
This module turns only the first --study months of that comparison into
  - a short lesson plan: the student's measured habits next to the teacher's, with the numbers computed here,
  - worked examples: study months where the teacher beat the student, one per market state where possible,
and gives them to the same local model as a taught prompt. The taught prompt also shows the weights currently held,
so the student can keep turnover low.
The taught bot then allocates the held-out months, which the lessons never saw, starting from cash. It is compared
on those months only, from the same starting cash, with the same costs, against: the untaught bot, the untaught
bot's picks fully invested, the teacher, and the basket. A lesson that only helps on the months it came from is
not a skill; only the held-out comparison (and then a pre-registered forward test) counts.
Research only: paper results, no orders, nothing changes in the organisation.
  build:    .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\curriculum.py build --run ai-monthly-qwen4b-v2 --name lessons-v1
  replay:   ... curriculum.py replay --curriculum lessons-v1 --name ai-taught-qwen4b-v1   (needs the local model server)
  compare:  ... curriculum.py compare --curriculum lessons-v1 --name ai-taught-qwen4b-v1
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_allocator as ai  # noqa: E402
import allocator_review as ar  # noqa: E402
import batch  # noqa: E402
import daily  # noqa: E402
import portfolio_daily as pd  # noqa: E402

CURRICULA = daily.ROOT / '.local' / 'trading-desk' / 'curriculum'
NAME = re.compile(r'[A-Za-z0-9_-]{1,60}')


def market_state(above):
    return 'uptrend' if above >= 6 else 'downtrend' if above <= 2 else 'mixed'


def gather(run, teacher, cache=daily.DAILY, root=ai.RUNS):
    """Per decision month: the brief, the teacher's answer, and both outcomes (from allocator_review)."""
    state = json.loads((root / run / 'decisions.json').read_text(encoding='utf-8'))
    rows = ar.review(run, teacher, cache=cache, root=root)['months']
    return [{**row, 'facts': state['months'][row['day']]['facts'], 'teacher': teacher[f"{row['month']:02d}"]}
            for row in rows if 'teacherPct' in row]


def _avg(values):
    values = list(values)
    return round(sum(values) / len(values), 1) if values else None


def study_stats(months, study):
    """Habits of student and teacher over the study months only."""
    rows = [m for m in months if m['month'] <= study]
    turns, above, below, previous = [], [], [], None
    for m in rows:
        w = {k: m['teacher'][k] for k in ai.LETTERS}
        if previous:
            turns.append(sum(abs(w[k] - previous[k]) for k in ai.LETTERS) / 2)
        previous = w
        for k, f in m['facts'].items():
            (above if f.get('above200dAverage') else below).append(w[k])
    return {'months': len(rows), 'basketUpMonths': sum(m['basketPct'] > 0 for m in rows),
            'studentCashPct': _avg(m['cashPct'] for m in rows), 'studentCashDragPct': round(sum(m['cashDragPct'] for m in rows) / len(rows), 2),
            'studentSelectionPct': round(sum(m['selectionPct'] for m in rows) / len(rows), 2),
            'studentTurnoverPct': _avg(m['turnoverPct'] for m in rows[1:]), 'teacherTurnoverPct': _avg(turns),
            'teacherCashPct': _avg(m['teacherCashPct'] for m in rows),
            'teacherWeightAbove200d': _avg(above), 'teacherWeightBelow200d': _avg(below),
            'teacherBeatStudentMonths': sum(m['teacherPct'] > m['modelPct'] for m in rows),
            'marketStates': {s: sum(market_state(m['sharesAbove200d']) == s for m in rows) for s in ('uptrend', 'mixed', 'downtrend')}}


def pick_examples(months, study, k=2):
    """Study months where the teacher beat the student: the widest margin per market state first, then overall."""
    won = sorted((m for m in months if m['month'] <= study and m['teacherPct'] > m['modelPct']),
                 key=lambda m: (m['modelPct'] - m['teacherPct'], m['month']))
    chosen, seen = [], set()
    for m in won:
        if market_state(m['sharesAbove200d']) not in seen:
            seen.add(market_state(m['sharesAbove200d']))
            chosen.append(m)
    chosen += [m for m in won if m not in chosen]
    return sorted(chosen[:k], key=lambda m: m['month'])


def lessons(stats):
    s = stats
    return (
        f"LESSONS FROM YOUR TEACHER, learned on {s['months']} earlier months. They are habits, not predictions.\n"
        f"1. Stay invested. Cash earns nothing here. In those months the basket rose in {s['basketUpMonths']} of {s['months']}; "
        f"you kept {s['studentCashPct']}% in cash on average, which cost about {abs(s['studentCashDragPct'])}% a month, more than your "
        f"share choices added ({s['studentSelectionPct']:+}% a month). Your teacher kept {s['teacherCashPct']}%. Make your weights add up to "
        "95-100. Hold more cash only when most shares (6 or more of 8) are below their 200-day average"
        + (" (untested: the earlier months had no such market).\n" if not s['marketStates']['downtrend'] else ".\n")
        + "2. Tilt, do not bet. Start from equal weights (12-13 each) and adjust: about 15-20 for shares above their 200-day average "
        "with strong 6- and 12-month returns and small drawdowns, about 3-8 for shares below their 200-day average with negative "
        f"6-month returns. Your teacher averaged {s['teacherWeightAbove200d']} for shares above the 200-day average and "
        f"{s['teacherWeightBelow200d']} for those below. Keep at least six shares. One month's move alone is weak evidence.\n"
        f"3. Trade little. currentWeights shows what you hold now. Change a weight only when the facts behind it changed and "
        f"leave the others alone. You reshuffled {s['studentTurnoverPct']}% of the portfolio a month; your teacher {s['teacherTurnoverPct']}%. "
        "Every 10% of the portfolio moved costs about 0.025% of it.\n")


def worked_examples(examples):
    out = ['WORKED EXAMPLES from earlier months (their letters are unrelated to today\'s letters):']
    for n, m in enumerate(examples, 1):
        answer = {**{k: m['teacher'][k] for k in ai.LETTERS}, 'rationale': m['teacher']['rationale']}
        out.append(f"Example {n} brief: {json.dumps({'shares': m['facts']}, separators=(',', ':'))}")
        out.append(f"Teacher's answer: {json.dumps(answer, separators=(',', ':'))}")
    return '\n'.join(out)


def taught_system(stats, examples):
    return (ai.SYSTEM + '\n\nEach brief also gives currentWeights: the percent you hold in each share now (all zero means all cash).\n\n'
            + lessons(stats) + '\n' + worked_examples(examples))


def build(run, teacher_path, study, name, k=2, cache=daily.DAILY, root=ai.RUNS, out=CURRICULA):
    """Freezes a curriculum from the study months; the held-out months start right after them."""
    if not NAME.fullmatch(name):
        raise ValueError('Name: letters, digits, _ or -')
    path = out / f'{name}.json'
    if path.exists():
        raise ValueError('A curriculum with this name exists; curricula are frozen, choose a new name')
    teacher = json.loads(Path(teacher_path).read_text(encoding='utf-8'))
    months = gather(run, teacher, cache=cache, root=root)
    if not 0 < study < len(months):
        raise ValueError(f'Study months must leave held-out months (taught months available: {len(months)})')
    stats, examples = study_stats(months, study), pick_examples(months, study, k)
    system = taught_system(stats, examples)
    record = {'name': name, 'run': run, 'teacherFile': Path(teacher_path).name, 'studyMonths': study,
              'heldOutFrom': months[study]['day'], 'heldOutMonths': len(months) - study, 'stats': stats,
              'exampleMonths': [m['month'] for m in examples], 'system': system, 'promptVersion': ai.prompt_version(system, True),
              'builtAt': datetime.now(timezone.utc).isoformat(),
              'note': 'Built from the study months only. Judge it on the held-out months, then in a forward test.'}
    out.mkdir(parents=True, exist_ok=True)
    batch.save(path, record)
    return record


def load(name, out=CURRICULA):
    if not NAME.fullmatch(name):
        raise ValueError('Name: letters, digits, _ or -')
    record = json.loads((out / f'{name}.json').read_text(encoding='utf-8'))
    if ai.prompt_version(record['system'], True) != record['promptVersion']:
        raise ValueError('Curriculum text does not match its fingerprint')
    return record


def habits(state, from_day):
    """Average cash and turnover (percent) of an allocator's decisions from a day on; failed months keep the last weights."""
    held, cash, turns, first = None, [], [], True
    for day in sorted(d for d in state['months'] if d >= from_day):
        entry = state['months'][day]
        w = dict(entry['weights']) if entry['outcome'] == 'valid' else held or {k: 0 for k in ai.LETTERS}
        if not first:
            turns.append(sum(abs(w.get(k, 0) - (held or {}).get(k, 0)) for k in ai.LETTERS) / 2)
        cash.append(100 - sum(w.values()))
        held, first = w, False
    return {'averageCashPct': _avg(cash), 'averageTurnoverPct': _avg(turns),
            'failedMonths': sum(state['months'][d]['outcome'] != 'valid' for d in state['months'] if d >= from_day)}


def monthly_verdict(run, from_day, cache=daily.DAILY, root=ai.RUNS):
    """Month by month against the basket, after estimated trading costs, with the bot-fitness sign test.
    The first month is left out: a run starting from cash pays a full entry there, which says nothing about skill."""
    import fitness
    rows = [r for r in ar.review(run, cache=cache, root=root)['months'] if r['day'] >= from_day][1:]
    wins = sum(r['modelPct'] + r['costPct'] > r['basketPct'] for r in rows)
    losses = sum(r['modelPct'] + r['costPct'] < r['basketPct'] for r in rows)
    return {'months': len(rows), 'monthsAheadOfBasket': wins, 'monthsBehindBasket': losses,
            'pValue': round(fitness.sign_test(max(wins, losses), min(wins, losses)), 4) if wins + losses else None,
            'verdict': fitness.verdict(wins, losses)}


def compare(curriculum, taught_name, cache=daily.DAILY, root=ai.RUNS, out=CURRICULA):
    """Held-out months only, every entrant starting from the same cash on the same day with the same costs."""
    cur = load(curriculum, out)
    taught = json.loads((root / taught_name / 'decisions.json').read_text(encoding='utf-8'))
    if (taught['promptVersion'], taught['from']) != (cur['promptVersion'], cur['heldOutFrom']):
        raise ValueError('That run was not taught with this curriculum from its held-out start')
    student = json.loads((root / cur['run'] / 'decisions.json').read_text(encoding='utf-8'))
    if taught['model'] != student['model']:
        raise ValueError('Taught and untaught runs used different models; that would not isolate the lessons')
    teacher = json.loads((root / cur['run'] / cur['teacherFile']).read_text(encoding='utf-8'))
    dates, table = pd.aligned(daily.load(sorted(daily.datasets.UNIVERSE), cache))
    start, end = dates.index(cur['heldOutFrom']), len(dates) - 1
    letters = ai.mapping(cur['run'], table)
    teacher_weights = {}
    for n, day in enumerate(sorted(student['months']), 1):
        answer = teacher.get(f'{n:02d}')
        if day >= cur['heldOutFrom'] and answer and ai.valid(answer):
            w, _, _ = ai.allocation(answer)
            teacher_weights[day] = {letters[k]: v / 100 for k, v in w.items() if v}
    invested = {day: {s: v / sum(w.values()) for s, v in w.items()} if sum(w.values()) else {} for day, w in student['weights'].items()}

    def follow(weights):
        return lambda _t, _d, i: weights.get(_d[i], {})
    results = {'taught-student': pd.simulate(table, dates, follow(taught['weights']), start, end),
               'untaught-student': pd.simulate(table, dates, follow(student['weights']), start, end),
               'untaught-picks-fully-invested': pd.simulate(table, dates, follow(invested), start, end),
               'teacher': pd.simulate(table, dates, follow(teacher_weights), start, end),
               'basket-buy-and-hold': pd.simulate(table, dates, pd.equal_weight, start, end, once=True),
               'basket-monthly': pd.simulate(table, dates, pd.equal_weight, start, end)}
    report = {'curriculum': curriculum, 'taughtRun': taught_name, 'model': taught['model'], 'heldOutFrom': cur['heldOutFrom'],
              'through': dates[end], 'heldOutMonths': len([d for d in taught['months'] if d >= cur['heldOutFrom']]),
              'results': results, 'habits': {'taught-student': habits(taught, cur['heldOutFrom']),
                                             'untaught-student': habits(student, cur['heldOutFrom'])},
              'versusBasketMonthly': {'taught-student': monthly_verdict(taught_name, cur['heldOutFrom'], cache, root),
                                      'untaught-student': monthly_verdict(cur['run'], cur['heldOutFrom'], cache, root)},
              'lessonsHelped': results['taught-student']['netPaise'] > results['untaught-student']['netPaise'],
              'beatBasket': results['taught-student']['netPaise'] > results['basket-buy-and-hold']['netPaise'],
              'note': 'One held-out stretch of one basket is evidence, not proof. Confirm in a pre-registered forward test.'}
    report['trialsOnTheseMonths'] = record_trial(report, cur, out)
    if report['trialsOnTheseMonths'] > 1:
        report['note'] += (f" These held-out months have now judged {report['trialsOnTheseMonths']} different curricula, so they are"
                           ' partly seen: the best of several tries looks better than it is. Only a forward test settles it.')
    batch.save(out / f'{taught_name}-heldout.json', report)
    return report


def fitness_payload(report, bot_id):
    """The taught allocator's month-by-month record as a backend bot-fitness report. Counts only: the backend decides."""
    monthly = report['versusBasketMonthly']['taught-student']
    return {'botId': bot_id, 'role': 'portfolio-allocator', 'baseline': 'equal-weight-basket',
            'testName': f"{report['taughtRun']}-heldout"[:120], 'periodFrom': report['heldOutFrom'], 'periodTo': report['through'],
            'judged': monthly['months'], 'wins': monthly['monthsAheadOfBasket'], 'losses': monthly['monthsBehindBasket'],
            'failed': report['habits']['taught-student']['failedMonths'], 'model': report['model']}


def record_trial(report, cur, out=CURRICULA):
    """Trial ledger (Qanat's pattern): every distinct curriculum judged on a held-out period is recorded, append-only.
    Returns how many distinct curricula these held-out months have judged; re-running the same comparison is not a new trial."""
    ledger = out / 'trials.jsonl'
    trials = [json.loads(line) for line in ledger.read_text(encoding='utf-8').splitlines()] if ledger.exists() else []
    key = (cur['promptVersion'], report['taughtRun'])
    if key not in {(t['promptVersion'], t['taughtRun']) for t in trials}:
        trial = {'at': datetime.now(timezone.utc).isoformat(), 'curriculum': cur['name'], 'promptVersion': cur['promptVersion'],
                 'taughtRun': report['taughtRun'], 'model': report['model'], 'heldOutFrom': report['heldOutFrom'],
                 'through': report['through'], 'taughtNetPaise': report['results']['taught-student']['netPaise'],
                 'untaughtNetPaise': report['results']['untaught-student']['netPaise']}
        with ledger.open('a', encoding='utf-8') as handle:
            handle.write(json.dumps(trial) + '\n')
        trials.append(trial)
    return len({t['promptVersion'] for t in trials if t['heldOutFrom'] == report['heldOutFrom']})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    b = sub.add_parser('build')
    b.add_argument('--run', required=True)
    b.add_argument('--teacher', help='Teacher answers file in the run folder (default teacher-opus.json)', default='teacher-opus.json')
    b.add_argument('--study', type=int, default=24)
    b.add_argument('--examples', type=int, default=2, choices=range(0, 5))
    b.add_argument('--name', required=True)
    model_commands = [sub.add_parser(c) for c in ('replay', 'register', 'forward')]
    c = sub.add_parser('compare')
    for p in model_commands + [c]:
        p.add_argument('--curriculum', required=True)
        p.add_argument('--name', required=True)
    c.add_argument('--submit-bot', metavar='ORG_BOT_ID',
                   help='Send the taught allocator\'s monthly record to the backend bot-fitness record (evaluator credential)')
    for p in model_commands:
        p.add_argument('--max-calls', type=int, default=80, choices=range(1, 201))
        p.add_argument('--timeout-seconds', type=int, default=300, choices=range(10, 601))
        p.add_argument('--allow-remote-cost', action='store_true')
    args = parser.parse_args(argv)
    if args.command == 'build':
        if not NAME.fullmatch(args.run) or Path(args.teacher).name != args.teacher:
            raise ValueError('Run: letters, digits, _ or -; teacher: a file name inside the run folder')
        record = build(args.run, ai.RUNS / args.run / args.teacher, args.study, args.name, args.examples)
        print(json.dumps({k: record[k] for k in ('name', 'studyMonths', 'heldOutFrom', 'heldOutMonths', 'exampleMonths',
                                                 'promptVersion', 'stats')}, indent=2))
        print('\n' + lessons(record['stats']))
        return
    if args.command == 'compare':
        report = compare(args.curriculum, args.name)
        print(f"Held-out {report['heldOutMonths']} months from {report['heldOutFrom']} to {report['through']} ({report['model']})")
        for rule, res in sorted(report['results'].items(), key=lambda kv: -kv[1]['netPaise']):
            print(f"  {rule:30s} net {res['netPaise'] / 100:>11,.0f}  CAGR {res['cagr']:>7.1%}  worst drawdown {res['maxDrawdown']:>6.1%}  "
                  f"costs {res['costsPaise'] / 100:>7,.0f}")
        for who, h in report['habits'].items():
            v = report['versusBasketMonthly'][who]
            print(f"  {who:30s} cash {h['averageCashPct']}%  turnover {h['averageTurnoverPct']}%/month  failed {h['failedMonths']}  "
                  f"months ahead/behind basket {v['monthsAheadOfBasket']}/{v['monthsBehindBasket']} -> {v['verdict']} (p={v['pValue']})")
        print(f"  Curricula judged on these months so far: {report['trialsOnTheseMonths']}")
        if args.submit_bot:
            import fitness
            for result in fitness.submit([{**fitness_payload(report, args.submit_bot)}], os.environ):
                print(f"submitted portfolio-allocator: backend verdict {result['verdict']} (report {result['id']})")
        return
    cur = load(args.curriculum)
    import desk
    llm, endpoint = desk.model_client(desk.local_settings(os.environ), args.timeout_seconds, args.allow_remote_cost)
    if args.command == 'register':
        print(json.dumps(ai.register(args.name, endpoint.model, system=cur['system'], held=True), indent=2))
        return
    if args.command == 'forward':
        print(json.dumps(ai.forward(args.name, llm, endpoint.model, max_calls=args.max_calls, system=cur['system'], held=True), indent=2)[:4000])
        return
    report = ai.replay(args.name, llm, endpoint.model, cur['heldOutFrom'], max_calls=args.max_calls, system=cur['system'], held=True)
    print(f"{report['months']} taught months from {report['from']}; failed {report['failedMonths']}; average cash {report['averageCashPct']}%")


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
