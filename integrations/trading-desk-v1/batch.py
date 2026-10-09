"""Run the trading desk across many cached windows and aggregate against the baselines. Research only.

Resumable: each window's result is saved as soon as it finishes, keyed by dataset hash and desk version, so a
stopped batch continues without repeating model calls. A total call budget bounds every run.
"""
import argparse
from datetime import datetime, timezone
import glob
import hashlib
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import desk  # noqa: E402


def desk_version():
    """Identifies the exact desk logic and prompts; results from other versions are never mixed."""
    return hashlib.sha256(Path(desk.__file__).read_bytes()).hexdigest()[:16]


def dataset_key(dataset):
    return hashlib.sha256(json.dumps(dataset, sort_keys=True, allow_nan=False).encode()).hexdigest()[:16]


def save(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2), encoding='utf-8')
    os.replace(temporary, path)


def run_batch(paths, llm, out, *, every, max_decisions, max_calls, model, run=desk.run_desk):
    out.mkdir(parents=True, exist_ok=True)
    version, rows, used, stopped = desk_version(), [], 0, None
    for path in paths:
        dataset = json.loads(Path(path).read_text(encoding='utf-8'))
        key = dataset_key(dataset)
        target = out / f'{key}.json'
        if target.exists():
            saved = json.loads(target.read_text(encoding='utf-8'))
            if saved['deskVersion'] == version and saved['model'] == model and saved['every'] == every:
                rows.append(saved)
                continue
        if used + max_decisions * 3 > max_calls:
            stopped = 'call-budget'
            break
        result = run(dataset, llm, every=every, max_decisions=max_decisions)
        used += result['modelCalls']
        bars = dataset['bars']
        row = {'deskVersion': version, 'model': model, 'every': every, 'datasetKey': key, 'path': str(path),
               'from': bars[0]['time'], 'to': bars[-1]['time'], 'bars': len(bars),
               'deskNetPaise': result['desk']['netPaise'], 'deskTrades': len(result['desk']['trades']),
               'momentumNetPaise': result['baselines']['momentum']['netPaise'],
               'momentumTrades': len(result['baselines']['momentum']['trades']),
               'buyAndHoldPaise': result['baselines']['buyAndHoldOneSharePaise'],
               'scorecards': result['scorecards'], 'modelCalls': result['modelCalls'], 'decisionPoints': result['decisionPoints'],
               'finishedAt': datetime.now(timezone.utc).isoformat()}
        save(out / f'{key}.decisions.json', result['decisions'])
        save(target, row)
        rows.append(row)
    summary = aggregate(rows)
    summary.update(deskVersion=version, model=model, every=every, windowsPlanned=len(paths), stoppedReason=stopped,
                   modelCallsThisRun=used)
    save(out / 'summary.json', summary)
    return summary


def aggregate(rows):
    total = lambda key: sum(r[key] for r in rows)  # noqa: E731
    cards = {role: {'opinions': 0, 'correct': 0} for role in desk.ANALYSTS}
    manager = {'decisions': 0, 'correct': 0, 'alwaysHoldCorrect': 0, 'missedOpportunities': 0, 'badEntries': 0}
    for r in rows:
        for role in cards:
            cards[role]['opinions'] += r['scorecards']['analysts'][role]['opinions']
            cards[role]['correct'] += r['scorecards']['analysts'][role]['correct']
        for key in manager:
            manager[key] += r['scorecards'].get('portfolioManager', {}).get(key, 0)
    for card in cards.values():
        card['hitRate'] = round(card['correct'] / card['opinions'], 3) if card['opinions'] else None
    if manager['decisions']:
        manager['accuracy'] = round(manager['correct'] / manager['decisions'], 3)
        manager['alwaysHoldAccuracy'] = round(manager['alwaysHoldCorrect'] / manager['decisions'], 3)
    return {'windows': len(rows), 'desk': {'netPaise': total('deskNetPaise'), 'trades': total('deskTrades')},
            'momentum': {'netPaise': total('momentumNetPaise'), 'trades': total('momentumTrades')},
            'buyAndHoldPaise': total('buyAndHoldPaise'),
            'deskBeatMomentumWindows': sum(r['deskNetPaise'] > r['momentumNetPaise'] for r in rows),
            'deskBeatBuyAndHoldWindows': sum(r['deskNetPaise'] > r['buyAndHoldPaise'] for r in rows),
            'deskProfitableWindows': sum(r['deskNetPaise'] > 0 for r in rows),
            'analysts': cards, 'portfolioManager': manager,
            'perWindow': [{k: r[k] for k in ('from', 'to', 'deskNetPaise', 'deskTrades', 'momentumNetPaise', 'buyAndHoldPaise')} for r in rows],
            'interpretation': 'Descriptive across windows of one symbol; not statistical proof, qualification or trading authority.'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--datasets', default=str(desk.ROOT / '.local' / 'trading-desk' / 'datasets' / 'RELIANCE.NS-5m-*.json'))
    parser.add_argument('--batch', required=True, help='Batch name; reuse it to resume')
    parser.add_argument('--every', type=int, default=24, choices=range(3, 76))
    parser.add_argument('--max-decisions', type=int, default=15, choices=range(1, 41))
    parser.add_argument('--max-calls', type=int, default=400, choices=range(1, 1001))
    parser.add_argument('--timeout-seconds', type=int, default=240, choices=range(10, 601))
    parser.add_argument('--allow-remote-cost', action='store_true')
    args = parser.parse_args(argv)
    if not __import__('re').fullmatch(r'[A-Za-z0-9_-]{1,60}', args.batch):
        raise SystemExit('Batch name: letters, digits, _ or -')
    paths = sorted(glob.glob(args.datasets))
    if not paths:
        raise SystemExit('No cached datasets; run datasets.py with the replay environment first')
    llm, endpoint = desk.model_client(desk.local_settings(os.environ), args.timeout_seconds, args.allow_remote_cost)
    summary = run_batch(paths, llm, desk.ROOT / '.local' / 'trading-desk' / 'batches' / args.batch, every=args.every,
                        max_decisions=args.max_decisions, max_calls=args.max_calls, model=endpoint.model)
    print(json.dumps({k: v for k, v in summary.items() if k != 'perWindow'}, indent=2))


if __name__ == '__main__':
    main()
