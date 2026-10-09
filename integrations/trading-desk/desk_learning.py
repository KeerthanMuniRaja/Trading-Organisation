"""Automatic learning from the desk's own results: no human in the loop, and no number taken on trust.

Two independent bots, neither using a model, each step a separate child process holding only its own credential
(the same orchestration as integrations/claims/autolearn.py):
  Desk analyst    (researcher)  reports each finished batch week as dataset evidence, then proposes each desk
                                bot's factual lessons to the organisation bot it is mapped to.
  Desk fact-checker (evaluator) recomputes everything itself from the raw bars and the decision log: the desk's
                                P&L by replaying the logged actions through the same book, both baselines, every
                                scorecard and every lesson. It verifies only exact matches, rejects evidence that
                                misreports, reads back what the backend stored and revokes on any difference.
The decision log is the desk's own record of what its bots did; what the fact-checker guarantees is that the
reported results and lessons are exactly what that record and the market data imply.
Sessions are owner-started and finite. Run with the replay environment, e.g.:
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\desk_learning.py run --config .local\\trading-desk\\desk-learning.json
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import glob
import json
import os
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[0] / 'claims'))
import autolearn  # noqa: E402  (shared orchestration, backend access and state files)
import desk  # noqa: E402
import export_evidence  # noqa: E402
import learning  # noqa: E402

STATE = desk.ROOT / '.local' / 'trading-desk' / 'auto-learning'
BATCHES = desk.ROOT / '.local' / 'trading-desk' / 'batches'
STEPS = {'desk-report': 'researcher', 'desk-verify-evidence': 'evaluator', 'desk-lessons': 'researcher', 'desk-verify-lessons': 'evaluator'}
ID = re.compile(r'^[a-zA-Z0-9_-]{1,80}$')


def load_config(path):
    value = json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(value, dict) or set(value) != {'sourceId', 'batches', 'bots'}:
        raise ValueError('Config keys: sourceId, batches, bots')
    if not (isinstance(value['sourceId'], str) and ID.match(value['sourceId'])):
        raise ValueError('sourceId: the approved source registered for desk results')
    if not (isinstance(value['batches'], list) and 1 <= len(value['batches']) <= 20
            and all(isinstance(b, str) and ID.match(b) for b in value['batches'])):
        raise ValueError('batches: 1-20 batch names')
    bots = value['bots']
    if not (isinstance(bots, dict) and bots and set(bots) <= set(learning.ROLES)
            and all(isinstance(b, str) and ID.match(b) for b in bots.values())):
        raise ValueError(f'bots: map some of {list(learning.ROLES)} to organisation bot ids')
    return value


def windows(config):
    """(key, row, decisions) for every finished week of the configured batches."""
    for name in config['batches']:
        directory = BATCHES / name
        for path in sorted(glob.glob(str(directory / '*.json'))):
            file = Path(path).name
            if file in ('summary.json', 'lessons.json', 'comparison.json') or file.endswith('.decisions.json'):
                continue
            row = json.loads(Path(path).read_text(encoding='utf-8'))
            decisions = json.loads((directory / f"{row['datasetKey']}.decisions.json").read_text(encoding='utf-8'))
            yield f"{name}:{row['datasetKey']}", row, decisions


def replay_actions(decisions):
    """The logged orders, bar by bar; everything else is hold."""
    actions = {d['index']: d['action'] for d in decisions if d['type'] in ('desk-meeting', 'risk-stop')}
    return lambda i, book: actions.get(i, 'hold')


def recompute(row, decisions):
    """The fact-checker's own numbers, evidence text and lessons, from the market data and the decision log only."""
    dataset = json.loads(Path(row['path']).read_text(encoding='utf-8'))
    bars = desk.validate(dataset)
    every = row['every']
    result = desk.simulate(bars, replay_actions(decisions))
    momentum = desk.simulate(bars, desk.momentum_decider(bars))
    meetings = [d['index'] for d in decisions if d['type'] == 'desk-meeting']
    first = min(meetings) + 1 if meetings else len(bars) - 1
    cost = desk.buy_fill(bars[first]['openPaise']) + desk.fee(desk.buy_fill(bars[first]['openPaise']))
    mark = desk.sell_fill(bars[-1]['closePaise'])
    own = {'deskVersion': row['deskVersion'], 'model': row['model'], 'every': every, 'symbol': dataset['symbol'],
           'from': bars[0]['time'], 'to': bars[-1]['time'], 'bars': len(bars), 'decisionPoints': row['decisionPoints'],
           'deskNetPaise': result['netPaise'], 'deskTrades': len(result['trades']),
           'momentumNetPaise': momentum['netPaise'], 'momentumTrades': len(momentum['trades']),
           'buyAndHoldPaise': mark - desk.fee(mark) - cost, 'scorecards': desk.scorecards(bars, decisions, every)}
    period = f"{own['from'][:10]} to {own['to'][:10]}"
    lessons = {role: '\n'.join(lines) for role, lines in learning.lessons(learning.experience([(bars, decisions)], every), period).items()}
    return {'row': own, 'content': export_evidence.evidence_text(own), 'publishedAt': own['to'], 'lessons': lessons}


# ---------- the analyst's steps ----------
def desk_report(api, state, config):
    """Researcher: one dataset evidence per finished week, written from the batch's own result row."""
    reports = autolearn.read(state, 'reports.json', {})
    made = 0
    for key, row, _ in windows(config):
        if key in reports:
            continue
        content = export_evidence.evidence_text(row)
        result = api('POST', '/v1/evidence', {'sourceId': config['sourceId'], 'kind': 'dataset', 'content': content, 'publishedAt': row['to']})
        reports[key] = {'evidenceId': result['id'], 'status': result.get('status'), 'content': content, 'publishedAt': row['to']}
        autolearn.write(state, 'reports.json', reports)
        made += 1
    return {'reported': made}


def desk_lessons(api, state, config):
    """Researcher: each mapped bot's lessons from verified weeks, once."""
    reviews, proposals = autolearn.read(state, 'evidence-reviews.json', {}), autolearn.read(state, 'proposals.json', {})
    made = 0
    for key, row, decisions in windows(config):
        if reviews.get(key, {}).get('status') != 'verified':
            continue
        bars = json.loads(Path(row['path']).read_text(encoding='utf-8'))['bars']
        texts = learning.lessons(learning.experience([(bars, decisions)], row['every']), f"{row['from'][:10]} to {row['to'][:10]}")
        for role, bot in config['bots'].items():
            pkey = f'{key}:{role}'
            if pkey in proposals:
                continue
            content = '\n'.join(texts[role])
            result = api('POST', '/v1/lessons', {'botId': bot, 'content': content, 'evidenceId': reviews[key]['evidenceId']})
            proposals[pkey] = {'lessonId': result['id'], 'window': key, 'role': role, 'botId': bot, 'content': content}
            autolearn.write(state, 'proposals.json', proposals)
            made += 1
    return {'proposed': made}


# ---------- the fact-checker's steps ----------
def desk_verify_evidence(api, state, config, now):
    reports, reviews = autolearn.read(state, 'reports.json', {}), autolearn.read(state, 'evidence-reviews.json', {})
    revocations = autolearn.read(state, 'revocations.json', {})
    counts = {'verified': 0, 'rejected': 0, 'alreadyReviewed': 0, 'revoked': 0}
    expected = {key: recompute(row, decisions) for key, row, decisions in windows(config) if key in reports}
    for key, report in reports.items():
        if key in reviews or key not in expected:
            continue
        if report.get('status') not in (None, 'unverified'):
            reviews[key] = {'status': 'already-reviewed', 'evidenceId': report['evidenceId'], 'at': now.isoformat()}
            counts['alreadyReviewed'] += 1
        else:
            own = expected[key]
            status = 'verified' if (report['content'], report['publishedAt']) == (own['content'], own['publishedAt']) else 'rejected'
            api('POST', '/v1/evidence/reviews', {'evidenceId': report['evidenceId'], 'status': status})
            reviews[key] = {'status': status, 'evidenceId': report['evidenceId'], 'at': now.isoformat(),
                            **({'reason': 'reported results differ from the recomputation'} if status == 'rejected' else {})}
            counts[status] += 1
        autolearn.write(state, 'evidence-reviews.json', reviews)
    stored = {row['id']: row['content'] for row in api('GET', '/v1/knowledge').get('evidence', [])}
    for key, review in reviews.items():
        evidence_id = review['evidenceId']
        if review['status'] == 'verified' and evidence_id in stored and key in expected and stored[evidence_id] != expected[key]['content']:
            if evidence_id not in revocations:
                api('POST', '/v1/evidence/revocations', {'kind': 'evidence', 'targetId': evidence_id,
                                                          'reason': 'Automatic desk fact-check: stored results differ from the recomputation'})
                revocations[evidence_id] = {'window': key, 'at': now.isoformat()}
                autolearn.write(state, 'revocations.json', revocations)
                counts['revoked'] += 1
    return counts


def desk_verify_lessons(api, state, config, now):
    reviews, lesson_reviews = autolearn.read(state, 'evidence-reviews.json', {}), autolearn.read(state, 'lesson-reviews.json', {})
    revocations = autolearn.read(state, 'revocations.json', {})
    expected = {key: recompute(row, decisions)['lessons'] for key, row, decisions in windows(config) if reviews.get(key, {}).get('status') == 'verified'}
    counts = {'verified': 0, 'skipped': 0, 'revoked': 0}
    for pkey, p in autolearn.read(state, 'proposals.json', {}).items():
        if p['lessonId'] in lesson_reviews:
            continue
        want = expected.get(p['window'], {}).get(p['role'])
        if want is None or want != p['content'] or reviews[p['window']]['evidenceId'] in revocations:
            lesson_reviews[p['lessonId']] = {'status': 'not-verified', 'at': now.isoformat()}
            counts['skipped'] += 1
        else:
            api('POST', '/v1/lessons/reviews', {'lessonId': p['lessonId']})
            lesson_reviews[p['lessonId']] = {'status': 'verified', 'content': want, 'evidenceId': reviews[p['window']]['evidenceId'],
                                             'at': now.isoformat()}
            counts['verified'] += 1
        autolearn.write(state, 'lesson-reviews.json', lesson_reviews)
    stored = {row['id']: row['content'] for row in api('GET', '/v1/knowledge').get('lessons', [])}
    for lesson_id, review in lesson_reviews.items():
        if review['status'] == 'verified' and lesson_id in stored and stored[lesson_id] != review['content'] \
                and review['evidenceId'] not in revocations:
            api('POST', '/v1/evidence/revocations', {'kind': 'evidence', 'targetId': review['evidenceId'],
                                                      'reason': 'Automatic desk fact-check: stored lesson differs from the reviewed text'})
            revocations[review['evidenceId']] = {'lesson': lesson_id, 'at': now.isoformat()}
            autolearn.write(state, 'revocations.json', revocations)
            counts['revoked'] += 1
    return counts


def step_main(args):
    if os.environ.get('AUTOLEARN_STEP') != args.step:
        raise ValueError('Steps run only as children of `run`, which gives each one its own credential')
    config, now = load_config(args.config), datetime.now(timezone.utc)
    api = autolearn.child_backend(os.environ, STEPS[args.step])
    if args.step == 'desk-report':
        return desk_report(api, args.state, config)
    if args.step == 'desk-verify-evidence':
        return desk_verify_evidence(api, args.state, config, now)
    if args.step == 'desk-lessons':
        return desk_lessons(api, args.state, config)
    return desk_verify_lessons(api, args.state, config, now)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('run', 'step'):
        p = sub.add_parser(name)
        if name == 'step':
            p.add_argument('step', choices=list(STEPS))
        p.add_argument('--config', type=Path, required=True)
        p.add_argument('--state', type=Path, default=STATE)
        p.add_argument('--timeout-seconds', type=int, default=60, choices=range(10, 601))  # accepted for the shared runner
        p.add_argument('--allow-remote-cost', action='store_true')                       # accepted for the shared runner
        if name == 'run':
            p.add_argument('--cycles', type=int, default=1, choices=range(1, 49))
            p.add_argument('--interval-minutes', type=int, default=60, choices=range(5, 241))
    args = parser.parse_args(argv)
    args.state.mkdir(parents=True, exist_ok=True)
    if args.command == 'step':
        print(json.dumps(step_main(args)))
        return
    runner = lambda step, a, env: autolearn.run_step(step, a, env, script=__file__)  # noqa: E731
    print(json.dumps(autolearn.run(args, runner=runner, steps=STEPS, validate=load_config, model_steps=()), indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
