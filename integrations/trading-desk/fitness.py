"""Desk bot fitness: does each bot beat the simplest alternative, by more than luck? Research only.

Every bot is compared, meeting by meeting, with the do-nothing version of its own job:
  analysts  vs "always neutral"  (most hours move less than the 30 bps round-trip cost)
  manager   vs "always hold"
Only meetings where the bot and its baseline disagree carry information. An exact one-sided sign test on those
disagreements says whether the bot's wins could plausibly be luck. Verdicts are deterministic and conservative:
  adds-value             significantly more wins than losses against the baseline
  worse-than-baseline    significantly more losses: a candidate for retraining or retirement review
  no-detectable-skill    neither, with enough disagreements to have seen a real effect
  insufficient-evidence  too few disagreements to judge
The report also shows calibration by conviction, reliability (failed calls) and cost (latency, tokens).
It recommends; it never retires, promotes or changes any bot. Those stay lifecycle and owner decisions.
Run: integrations\\skfolio\\.venv\\Scripts\\python.exe integrations\\trading-desk\\fitness.py --batch eight-weeks-v1
"""
from __future__ import annotations

import argparse
import glob
import json
from math import comb
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import desk  # noqa: E402

BATCHES = desk.ROOT / '.local' / 'trading-desk' / 'batches'
REPORTS = desk.ROOT / '.local' / 'trading-desk' / 'fitness'
MIN_DISAGREEMENTS = 20
SIGNIFICANCE = 0.05


def sign_test(wins, losses):
    """One-sided exact binomial p-value: chance of at least `wins` successes in wins+losses fair coin flips."""
    n = wins + losses
    if n == 0:
        return 1.0
    return sum(comb(n, k) for k in range(wins, n + 1)) / 2 ** n


def verdict(wins, losses):
    if wins + losses < MIN_DISAGREEMENTS:
        return 'insufficient-evidence'
    if wins > losses and sign_test(wins, losses) < SIGNIFICANCE:
        return 'adds-value'
    if losses > wins and sign_test(losses, wins) < SIGNIFICANCE:
        return 'worse-than-baseline'
    return 'no-detectable-skill'


def truth(bars, i, every):
    forward = desk.bps(bars[min(i + every, len(bars) - 1)]['closePaise'], bars[i]['closePaise'])
    return forward, ('bullish' if forward > desk.COST_BPS_ROUND_TRIP else 'bearish' if forward < -desk.COST_BPS_ROUND_TRIP else 'neutral')


def blank():
    return {'judged': 0, 'correct': 0, 'baselineCorrect': 0, 'wins': 0, 'losses': 0, 'failed': 0, 'latencyMs': [], 'tokens': 0,
            'byConviction': {}}


def evaluate(windows):
    """windows: [(bars, decisions, every)]. Returns per-bot fitness with verdicts."""
    bots = {role: blank() for role in desk.ANALYSTS}
    bots['portfolio-manager'] = blank()
    for bars, decisions, every in windows:
        for d in decisions:
            if d.get('type') != 'desk-meeting' or 'portfolio-manager' not in d.get('bots', {}):
                continue
            _, actual = truth(bars, d['index'], every)
            for role in desk.ANALYSTS:
                log = d['bots'].get(role)
                if not log or log.get('outcome') == 'not-consulted':
                    continue
                card = bots[role]
                if log.get('outcome') != 'valid':
                    card['failed'] += 1
                    continue
                record(card, log, log['opinion']['stance'] == actual, actual == 'neutral', log['opinion']['conviction'])
            pm = d['bots']['portfolio-manager']
            if pm.get('outcome') != 'valid':
                bots['portfolio-manager']['failed'] += 1
                continue
            forward, _ = truth(bars, d['index'], every)
            holding = d.get('allowed') == ['sell', 'hold']
            best = ('sell' if forward < -desk.EXIT_COST_BPS else 'hold') if holding else ('buy' if forward > desk.COST_BPS_ROUND_TRIP else 'hold')
            record(bots['portfolio-manager'], pm, pm['decision']['action'] == best, best == 'hold', None)
    return {role: summarise(card) for role, card in bots.items()}


def record(card, log, correct, baseline_correct, conviction):
    card['judged'] += 1
    card['correct'] += correct
    card['baselineCorrect'] += baseline_correct
    card['wins'] += correct and not baseline_correct
    card['losses'] += baseline_correct and not correct
    if log.get('latencyMs') is not None:
        card['latencyMs'].append(log['latencyMs'])
    card['tokens'] += sum(t or 0 for t in (log.get('tokens') or []))
    if conviction:
        c = card['byConviction'].setdefault(conviction, {'judged': 0, 'correct': 0})
        c['judged'] += 1
        c['correct'] += correct


def summarise(card):
    n, latencies = card['judged'], sorted(card.pop('latencyMs'))
    attempts = n + card['failed']
    return {**card, 'accuracy': round(card['correct'] / n, 3) if n else None,
            'baselineAccuracy': round(card['baselineCorrect'] / n, 3) if n else None,
            'pValue': round(sign_test(card['wins'], card['losses']), 4) if card['wins'] + card['losses'] else None,
            'verdict': verdict(card['wins'], card['losses']) if n else 'no-valid-calls' if card['failed'] else 'not-consulted',
            'failureRate': round(card['failed'] / attempts, 3) if attempts else None,
            'medianLatencyMs': latencies[len(latencies) // 2] if latencies else None,
            'byConviction': {k: {**v, 'accuracy': round(v['correct'] / v['judged'], 3)} for k, v in sorted(card['byConviction'].items())}}


def load(batch_names, batches=BATCHES):
    windows = []
    for name in batch_names:
        directory = batches / name
        for path in sorted(glob.glob(str(directory / '*.json'))):
            file = Path(path).name
            if file in ('summary.json', 'lessons.json', 'comparison.json') or file.endswith('.decisions.json'):
                continue
            row = json.loads(Path(path).read_text(encoding='utf-8'))
            decisions = json.loads((directory / f"{row['datasetKey']}.decisions.json").read_text(encoding='utf-8'))
            windows.append((json.loads(Path(row['path']).read_text(encoding='utf-8'))['bars'], decisions, row['every']))
    return windows


def batch_facts(batch_names, batches=BATCHES):
    """The period covered and the model(s) that produced the decisions, from the batch rows themselves."""
    rows = []
    for name in batch_names:
        for path in glob.glob(str(batches / name / '*.json')):
            file = Path(path).name
            if file in ('summary.json', 'lessons.json', 'comparison.json') or file.endswith('.decisions.json'):
                continue
            rows.append(json.loads(Path(path).read_text(encoding='utf-8')))
    return {'periodFrom': min(r['from'][:10] for r in rows), 'periodTo': max(r['to'][:10] for r in rows),
            'models': sorted({r['model'] for r in rows})}


def submissions(bots, mapping, test_name, facts):
    """Backend fitness reports for the mapped desk roles. Counts only: the backend computes p-values and verdicts."""
    if len(facts['models']) != 1:
        raise ValueError('Pool only batches from one model: a fitness record belongs to one model')
    out = []
    for role, bot_id in sorted(mapping.items()):
        card = bots.get(role)
        if not card or not card['judged']:
            continue
        out.append({'botId': bot_id, 'role': role, 'baseline': 'always-hold' if role == 'portfolio-manager' else 'always-neutral',
                    'testName': test_name, 'periodFrom': facts['periodFrom'], 'periodTo': facts['periodTo'],
                    'judged': card['judged'], 'wins': card['wins'], 'losses': card['losses'], 'failed': card['failed'],
                    'model': facts['models'][0]})
    return out


def evaluator_backend(env):
    """API origin and the single evaluator credential, from the environment or the private .env (never printed)."""
    import re
    values = {k: env.get(k) for k in ('API_URL', 'PRINCIPALS_JSON')}
    path = desk.ROOT / '.env'
    if not all(values.values()) and path.exists():
        for line in path.read_text(encoding='utf-8').splitlines():
            key, _, value = line.partition('=')
            if key in values and not values[key]:
                values[key] = value.strip()
    base = (values['API_URL'] or 'http://127.0.0.1:3000').rstrip('/')
    if not re.match(r'^(https://[^/@?#]+|http://(127\.0\.0\.1|localhost)(:\d+)?)$', base):
        raise ValueError('Invalid backend API origin')
    evaluators = [p for p in json.loads(values['PRINCIPALS_JSON'] or '[]') if p.get('role') == 'evaluator']
    if len(evaluators) != 1 or not evaluators[0].get('token'):
        raise ValueError('Configure exactly one evaluator credential')
    return base, evaluators[0]['token']


def submit(payloads, env, opener=None):
    """POST each report once; content-derived idempotency keys make a retry after a lost answer safe."""
    import hashlib
    from urllib import request as urlrequest
    from urllib.error import HTTPError, URLError
    base, token = evaluator_backend(env)
    opener = opener or urlrequest.urlopen
    results = []
    for body in payloads:
        data = json.dumps(body, sort_keys=True)
        req = urlrequest.Request(base + '/v1/bots/fitness', data=data.encode(), method='POST', headers={
            'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
            'Idempotency-Key': 'fitness-' + hashlib.sha256(data.encode()).hexdigest()[:64]})
        try:
            with opener(req, timeout=15) as response:
                results.append({**json.loads(response.read(65537)), 'role': body['role']})
        except HTTPError as error:
            error.close()
            raise RuntimeError(f"Fitness report for {body['role']} refused (HTTP {error.code})") from None
        except (URLError, OSError, ValueError):
            raise RuntimeError(f"Fitness report for {body['role']} was not acknowledged; rerun to recover safely") from None
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--batch', action='append', required=True, help='Repeatable; results are pooled')
    parser.add_argument('--submit-bot', action='append', default=[],
                        help='role=organisationBotId; sends that role\'s counts to the backend fitness record (evaluator credential)')
    parser.add_argument('--test-name', help='Name recorded with submitted reports (default: the batch names)')
    args = parser.parse_args(argv)
    if not all(batch_name.replace('-', '').replace('_', '').isalnum() for batch_name in args.batch):
        raise SystemExit('Batch names: letters, digits, _ or -')
    windows = load(args.batch)
    if not windows:
        raise SystemExit('No finished weeks in those batches')
    report = {'batches': args.batch, 'weeks': len(windows), 'bots': evaluate(windows),
              'rules': {'minimumDisagreements': MIN_DISAGREEMENTS, 'significance': SIGNIFICANCE, 'test': 'exact one-sided sign test'},
              'note': 'Recommendations only; lifecycle and owner decisions are unchanged.'}
    REPORTS.mkdir(parents=True, exist_ok=True)
    batch.save(REPORTS / f"{'+'.join(args.batch)}.json", report)
    for role, card in report['bots'].items():
        print(f"{role:20s} {card['verdict']:22s} accuracy {card['accuracy']} vs baseline {card['baselineAccuracy']} "
              f"(wins {card['wins']}, losses {card['losses']}, p={card['pValue']})")
    if args.submit_bot:
        mapping = dict(item.split('=', 1) for item in args.submit_bot if '=' in item)
        unknown = set(mapping) - set(report['bots'])
        if unknown or not mapping:
            raise SystemExit(f'Map known roles to organisation bot ids, e.g. trend-analyst=ORG_ID (unknown: {sorted(unknown)})')
        payloads = submissions(report['bots'], mapping, args.test_name or '+'.join(args.batch), batch_facts(args.batch))
        for result in submit(payloads, os.environ):
            print(f"submitted {result['role']}: backend verdict {result['verdict']} (report {result['id']})")


if __name__ == '__main__':
    main()
