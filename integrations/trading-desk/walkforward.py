"""Walk-forward learning test: lessons from earlier windows, applied to later windows, compared with no lessons.

Uses a completed no-lesson batch as the control arm. Training windows must end before every test window starts,
so no lesson can contain information from the period it is tested on. Results are descriptive (few windows of one
symbol), not proof of learning, profitability or trading authority.
"""
import argparse
import glob
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import desk  # noqa: E402
import learning  # noqa: E402

BATCHES = desk.ROOT / '.local' / 'trading-desk' / 'batches'


def load_rows(directory):
    rows = []
    for path in glob.glob(str(directory / '*.json')):
        name = Path(path).name
        if name == 'summary.json' or name.endswith('.decisions.json') or name in ('lessons.json', 'comparison.json'):
            continue
        rows.append(json.loads(Path(path).read_text(encoding='utf-8')))
    return sorted(rows, key=lambda r: r['from'])


def split(rows, train):
    if len(rows) <= train:
        raise ValueError(f'Need more than {train} completed control windows; have {len(rows)}')
    train_rows, test_rows = rows[:train], rows[train:]
    if max(r['to'] for r in train_rows) >= min(r['from'] for r in test_rows):
        raise ValueError('Training windows must end before every test window starts')
    return train_rows, test_rows


def build_lessons(control_dir, train_rows, every):
    windows = []
    for row in train_rows:
        bars = json.loads(Path(row['path']).read_text(encoding='utf-8'))['bars']
        decisions = json.loads((control_dir / f"{row['datasetKey']}.decisions.json").read_text(encoding='utf-8'))
        windows.append((bars, decisions))
    period = f"{train_rows[0]['from'][:10]} to {train_rows[-1]['to'][:10]}"
    return learning.lessons(learning.experience(windows, every), period)


def compare(control, treated):
    pairs = []
    by_key = {r['datasetKey']: r for r in control}
    for t in treated:
        c = by_key[t['datasetKey']]
        m = lambda r, k: r['scorecards'].get('portfolioManager', {}).get(k)  # noqa: E731
        pairs.append({'from': t['from'][:10], 'to': t['to'][:10],
                      'netPaise': {'withoutLessons': c['deskNetPaise'], 'withLessons': t['deskNetPaise']},
                      'trades': {'withoutLessons': c['deskTrades'], 'withLessons': t['deskTrades']},
                      'managerAccuracy': {'withoutLessons': m(c, 'accuracy'), 'withLessons': m(t, 'accuracy'),
                                          'alwaysHold': m(t, 'alwaysHoldAccuracy')},
                      'missedRises': {'withoutLessons': m(c, 'missedOpportunities'), 'withLessons': m(t, 'missedOpportunities')},
                      'analystHits': {role: {'withoutLessons': c['scorecards']['analysts'].get(role, {}).get('correct', 0),
                                             'withLessons': t['scorecards']['analysts'].get(role, {}).get('correct', 0),
                                             'opinions': t['scorecards']['analysts'].get(role, {}).get('opinions', 0)}
                                      for role in desk.ANALYSTS},
                      'momentumNetPaise': t['momentumNetPaise'], 'buyAndHoldPaise': t['buyAndHoldPaise']})
    total = lambda f: sum(f(p) for p in pairs)  # noqa: E731
    return {'pairs': pairs, 'testWindows': len(pairs),
            'netPaise': {'withoutLessons': total(lambda p: p['netPaise']['withoutLessons']),
                         'withLessons': total(lambda p: p['netPaise']['withLessons'])},
            'windowsImproved': sum(p['netPaise']['withLessons'] > p['netPaise']['withoutLessons'] for p in pairs),
            'windowsWorse': sum(p['netPaise']['withLessons'] < p['netPaise']['withoutLessons'] for p in pairs),
            'interpretation': 'Paired, chronologically separated, but few windows of one symbol: descriptive only.'}


def run(control_name, name, train, llm, model, *, max_calls, run_batch=batch.run_batch):
    control_dir, out = BATCHES / control_name, BATCHES / name
    summary = json.loads((control_dir / 'summary.json').read_text(encoding='utf-8')) if (control_dir / 'summary.json').exists() else {}
    rows = load_rows(control_dir)
    every = rows[0]['every'] if rows else summary.get('every')
    if any(r['every'] != every or r['model'] != model for r in rows):
        raise ValueError('Control windows must share the cadence and model being tested')
    if any(r['deskVersion'] != batch.desk_version() for r in rows):
        raise ValueError('Control windows came from a different desk version; rerun the control first')
    train_rows, test_rows = split(rows, train)
    role_lessons = build_lessons(control_dir, train_rows, every)
    out.mkdir(parents=True, exist_ok=True)
    saved = out / 'lessons.json'
    if saved.exists() and json.loads(saved.read_text(encoding='utf-8')) != role_lessons:
        raise ValueError('This experiment already used different lessons; choose a new name')
    batch.save(saved, role_lessons)
    max_decisions = max(r['decisionPoints'] for r in rows)
    run_batch([r['path'] for r in test_rows], learning.with_lessons(llm, role_lessons), out, every=every,
              max_decisions=max_decisions, max_calls=max_calls, model=model)
    treated = [r for r in load_rows(out) if r['datasetKey'] in {t['datasetKey'] for t in test_rows}]
    result = compare(test_rows, treated)
    result.update(train=[f"{r['from'][:10]}..{r['to'][:10]}" for r in train_rows], lessons=role_lessons)
    batch.save(out / 'comparison.json', result)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--control', default='eight-weeks-v1')
    parser.add_argument('--name', default='eight-weeks-v1-walkforward')
    parser.add_argument('--train', type=int, default=4, choices=range(1, 8))
    parser.add_argument('--max-calls', type=int, default=250, choices=range(1, 1001))
    parser.add_argument('--timeout-seconds', type=int, default=240, choices=range(10, 601))
    args = parser.parse_args(argv)
    llm, endpoint = desk.model_client(desk.local_settings(os.environ), args.timeout_seconds)
    result = run(args.control, args.name, args.train, llm, endpoint.model, max_calls=args.max_calls)
    print(json.dumps({k: v for k, v in result.items() if k not in ('pairs', 'lessons')}, indent=2))


if __name__ == '__main__':
    main()
