"""Bounded benchmark of a candidate model on the organisation's own task contracts.

Uses the production prompts (contracts.py) and validators, fixed synthetic fixtures and backend-equivalent
assessment grading. Assessment sets run twice on identical cases, with and without transferred lessons.
Results are descriptive evidence for an owner model decision, never a qualification or promotion.
"""
from __future__ import annotations

import argparse
from dataclasses import replace
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import random
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import contracts  # noqa: E402
from adapter import HermesError, PINNED_REVISION, strict_json, validate_candidate, validate_capability  # noqa: E402
from knowledge import validate_plan  # noqa: E402
from knowledge_assessment import validate_answers  # noqa: E402
from openai_compat import Endpoint, EndpointError, chat  # noqa: E402
from source_learning import validate_lesson  # noqa: E402

TASKS = ('candidate', 'capability', 'knowledge', 'source-lesson', 'knowledge-assessment', 'knowledge-assessment-methods')
ASSESSMENT_TASKS = ('knowledge-assessment', 'knowledge-assessment-methods')
HARD_MAX_CALLS, HARD_MAX_MINUTES, HARD_MAX_TOKENS = 60, 120, 400_000
SKILLS = ('costs', 'drawdown', 'informationTiming', 'abstention')
BOT = {'id': 'benchmark-student', 'department': 'research', 'specialty': 'cost-aware-allocation',
       'method': 'equal_weight', 'contribution': 'Synthetic benchmark identity'}
LESSONS = [
    {'id': 'lesson-costs', 'authorBotId': 'mentor-a', 'evidenceId': 'evidence-a',
     'content': 'Net profit is gross profit minus fees minus slippage; never compare strategies on gross profit.'},
    {'id': 'lesson-drawdown', 'authorBotId': 'mentor-b', 'evidenceId': 'evidence-b',
     'content': 'Maximum drawdown is the largest decline from any earlier running peak, as (peak - value) / peak * 10000 basis points.'},
    {'id': 'lesson-timing', 'authorBotId': 'mentor-c', 'evidenceId': 'evidence-c',
     'content': 'A record may be used only if both its event time and its availability time are at or before the decision cutoff.'},
    {'id': 'lesson-abstain', 'authorBotId': 'mentor-d', 'evidenceId': 'evidence-d',
     'content': 'Choose research only when the system is not halted, the evidence is verified and the budget covers the required amount; otherwise wait.'},
]
PLAN = {'summary': 'Apply the four reviewed basics before any comparison.',
        'application': 'Compute net results after costs, peak-relative drawdown and cutoff-eligible records, then abstain unless controls allow research.',
        'lessonIds': [l['id'] for l in LESSONS], 'checks': ['Recompute each figure from the supplied case'],
        'risks': ['Synthetic cases do not establish market competence']}
ARTICLE = ('Brokers raised execution fees this quarter. Analysts noted that strategies with high turnover now pay '
           'materially more in commissions and slippage. Several funds reported that gross returns overstated '
           'performance once these costs were deducted.')


def challenge(rng: random.Random, index: int) -> dict:
    """Mirror of the backend's makeChallenge, with the assessment issuer's fixed control pattern."""
    day = rng.randint(10, 20)
    stamp = lambda offset: datetime(2020, 1, day + offset, tzinfo=timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    records = []
    for i in range(6):
        event, available = rng.randint(-3, 2), rng.randint(-3, 2)
        records.append({'id': f'record-{i}', 'eventAt': stamp(event), 'availableAt': stamp(max(event, available))})
    return {'grossProfitPaise': rng.randint(-5000, 10000), 'feesPaise': rng.randint(1, 500), 'slippagePaise': rng.randint(1, 500),
            'equityPaise': [10000] + [rng.randint(5000, 15000) for _ in range(6)], 'cutoff': stamp(0), 'records': records,
            'control': {'halted': index == 1, 'evidenceVerified': index != 2, 'budget': 0 if index == 3 else 10, 'required': 10}}


def grade(case: dict, answers: dict) -> dict:
    """Python port of backend gradeSkill (research-basics-v1)."""
    peak = drawdown = 0
    for value in case['equityPaise']:
        peak = max(peak, value)
        drawdown = max(drawdown, (peak - value) / peak * 10000)
    parse = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00'))
    eligible = sorted(r['id'] for r in case['records'] if parse(r['eventAt']) <= parse(case['cutoff']) and parse(r['availableAt']) <= parse(case['cutoff']))
    c = case['control']
    action = 'research' if not c['halted'] and c['evidenceVerified'] and c['budget'] >= c['required'] else 'wait'
    return {'costs': answers['netProfitPaise'] == case['grossProfitPaise'] - case['feesPaise'] - case['slippagePaise'],
            'drawdown': abs(answers['maxDrawdownBps'] - drawdown) <= 0.0001,
            'informationTiming': sorted(answers['eligibleRecordIds']) == eligible,
            'abstention': answers['action'] == action}


def derive(case: dict, method: dict) -> dict:
    """Python port of backend deriveAnswers (research-methods-v1): chosen methods -> numbers."""
    amounts = {'grossProfitPaise': case['grossProfitPaise'], 'feesPaise': case['feesPaise'], 'slippagePaise': case['slippagePaise']}
    net = sum((-1 if term[0] == '-' else 1) * amounts[term[1:]] for term in method['costTerms'])
    equity = case['equityPaise']
    first, last, low, high = equity[0], equity[-1], min(equity), max(equity)
    if method['drawdownMethod'] == 'running-peak-to-trough':
        peak = drawdown = 0
        for value in equity:
            peak = max(peak, value)
            drawdown = max(drawdown, (peak - value) / peak * 10000)
    elif method['drawdownMethod'] == 'first-to-last':
        drawdown = max(0, (first - last) / first * 10000)
    elif method['drawdownMethod'] == 'first-to-minimum':
        drawdown = max(0, (first - low) / first * 10000)
    else:
        drawdown = (high - low) / high * 10000
    parse = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00'))
    cutoff = parse(case['cutoff'])
    rules = {'event-and-availability-at-or-before-cutoff': lambda r: parse(r['eventAt']) <= cutoff and parse(r['availableAt']) <= cutoff,
             'event-at-or-before-cutoff': lambda r: parse(r['eventAt']) <= cutoff,
             'availability-at-or-before-cutoff': lambda r: parse(r['availableAt']) <= cutoff,
             'all-records': lambda r: True}
    return {'netProfitPaise': net, 'maxDrawdownBps': min(10000, drawdown),
            'eligibleRecordIds': [r['id'] for r in case['records'] if rules[method['timingRule']](r)], 'action': method['action']}


def fixtures(tasks, repeats: int, seed: int) -> list[dict]:
    calls = []
    for repeat in range(repeats):
        if 'candidate' in tasks:
            rng = random.Random(seed + repeat)
            trials = [{'lookback': n, 'netReturnBps': round(rng.uniform(-80, 120), 2), 'maxDrawdownBps': round(rng.uniform(5, 400), 2),
                       'turnover': rng.randint(1, 40)} for n in range(2, 21)]
            calls.append({'task': 'candidate', 'request': {'trials': trials}, 'context': None})
        if 'capability' in tasks:
            context = {'datasetId': 'benchmark-dataset', 'method': 'inverse_volatility', 'beforeTrainingEnd': '2020-01-01T00:00:00Z',
                       'memories': [{'id': 'memory-1', 'content': 'Inverse volatility scored above the equal-weight baseline in one example test of 63 observations.'},
                                    {'id': 'memory-2', 'content': 'Minimum variance scored below the baseline in one example test.'}],
                       'existingCapabilities': [{'specialty': 'baseline', 'method': 'equal_weight'}]}
            calls.append({'task': 'capability', 'request': {'task': 'capability', 'context': context}, 'context': context})
        if 'knowledge' in tasks:
            context = {'kind': 'knowledge-transfer-v1', 'bot': BOT, 'task': 'Design a fresh cost-aware comparison of two allocation methods.',
                       'experiences': [], 'priorPlans': [], 'lessons': LESSONS[:2]}
            calls.append({'task': 'knowledge', 'request': {'task': 'knowledge', 'context': context}, 'context': context})
        if 'source-lesson' in tasks:
            context = {'kind': 'source-lesson-v1', 'bot': BOT, 'article': {'evidenceId': 'evidence-article', 'sourceId': 'publisher',
                       'title': 'Execution fees rise', 'url': 'https://publisher.example/fees', 'content': ARTICLE,
                       'snapshotHash': 'fixture', 'publishedAt': '2026-10-01T09:00:00.000Z', 'observedAt': '2026-10-01T10:00:00.000Z'}}
            calls.append({'task': 'source-lesson', 'request': {'task': 'source-lesson', 'context': context}, 'context': context})
        if 'knowledge-assessment-methods' in tasks:
            rng = random.Random(seed * 1000 + 500 + repeat)
            cases = [{'id': f'method-case-{repeat}-{i}', 'challenge': challenge(rng, i)} for i in range(4)]
            for arm, lessons, plan in (('with-lessons', LESSONS, PLAN), ('without-lessons', [], None)):
                context = {'botId': BOT['id'], 'rubric': 'research-methods-v1', 'plan': plan, 'lessons': lessons, 'cases': cases}
                calls.append({'task': 'knowledge-assessment-methods', 'pairId': f'methods:{seed}:{repeat}', 'arm': arm,
                              'request': {'task': 'knowledge-assessment-methods', 'context': context}, 'context': context})
        if 'knowledge-assessment' in tasks:
            rng = random.Random(seed * 1000 + repeat)
            cases = [{'id': f'case-{repeat}-{i}', 'challenge': challenge(rng, i)} for i in range(4)]
            # Identical cases in both arms; only the transferred knowledge differs.
            for arm, lessons, plan in (('with-lessons', LESSONS, PLAN), ('without-lessons', [], None)):
                context = {'botId': BOT['id'], 'rubric': 'research-basics-v1', 'plan': plan, 'lessons': lessons, 'cases': cases}
                calls.append({'task': 'knowledge-assessment', 'pairId': f'{seed}:{repeat}', 'arm': arm, 'request': {'task': 'knowledge-assessment', 'context': context},
                              'context': context})
    return calls


def validate(task: str, value, context):
    if task == 'candidate':
        return validate_candidate(value)
    if task == 'capability':
        return validate_capability(value, context)
    if task == 'knowledge':
        return validate_plan(value, context)
    if task == 'source-lesson':
        return validate_lesson(value, context)
    return validate_answers(value, context)  # dispatches on the context rubric


def direct_engine(endpoint: Endpoint, timeout: float, opener=None, structured=False):
    def run(call):
        task = call['task']
        schema = contracts.output_schema(task, call['context']) if structured else None
        result = chat(endpoint, contracts.PROMPTS[task], json.dumps(contracts.user_payload(task, call['request']), allow_nan=False),
                      contracts.MAX_TOKENS[task], timeout=timeout, opener=opener, schema=schema)
        return result['content'], result
    return run


def hermes_engine(settings):
    from adapter import propose, propose_capability
    from knowledge import propose_knowledge
    from knowledge_assessment import propose_answers
    from source_learning import propose_lesson
    functions = {'candidate': lambda c: propose(settings, c['request']['trials']),
                 'capability': lambda c: propose_capability(settings, c['context']),
                 'knowledge': lambda c: propose_knowledge(settings, c['context']),
                 'source-lesson': lambda c: propose_lesson(settings, c['context']),
                 'knowledge-assessment': lambda c: propose_answers(settings, c['context']),
                 'knowledge-assessment-methods': lambda c: propose_answers(settings, c['context'])}

    def run(call):
        started = time.perf_counter()
        value = functions[call['task']](call)
        # The pinned adapter validates internally and does not expose provider usage counts.
        return json.dumps(value), {'latencyMs': round((time.perf_counter() - started) * 1000, 1),
                                   'promptTokens': None, 'completionTokens': None, 'finishReason': None, 'reportedModel': None}
    return run


def percentile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, math.ceil(q * len(ordered)) - 1))]


def run_benchmark(engine, calls, *, max_calls: int, max_total_tokens: int, max_seconds: float, clock=time.monotonic):
    if len(calls) > max_calls:
        raise ValueError('Planned calls exceed the call budget')
    started, used, estimated, stopped = clock(), 0, False, None
    tasks = {t: {'calls': 0, 'valid': 0, 'failures': {}, 'latencies': [], 'promptTokens': 0, 'completionTokens': 0} for t in TASKS}
    arms = {kind: {arm: {'sets': 0, 'validSets': 0, 'checksPassed': 0, 'checksTotal': 0, 'bySkill': {s: 0 for s in SKILLS}}
                   for arm in ('with-lessons', 'without-lessons')} for kind in ASSESSMENT_TASKS}
    records = []
    pairs = {kind: {} for kind in ASSESSMENT_TASKS}
    for call in calls:
        task = call['task']
        reserve = contracts.MAX_TOKENS[task] + len(json.dumps(call['request'])) // 3
        if used + reserve > max_total_tokens:
            stopped = 'token-budget'
            break
        if clock() - started > max_seconds:
            stopped = 'time-budget'
            break
        stats, record = tasks[task], {'task': task, 'arm': call.get('arm'), 'pairId': call.get('pairId'), 'outcome': None}
        stats['calls'] += 1
        if task in ASSESSMENT_TASKS:
            arms[task][call['arm']]['sets'] += 1
            arms[task][call['arm']]['checksTotal'] += 16
        try:
            content, meta = engine(call)
        except EndpointError as exc:
            stats['failures'][exc.code] = stats['failures'].get(exc.code, 0) + 1
            record['outcome'] = exc.code
            used += reserve
            estimated = True
            records.append(record)
            continue
        except HermesError:
            stats['failures']['HERMES_FAILED'] = stats['failures'].get('HERMES_FAILED', 0) + 1
            record['outcome'] = 'HERMES_FAILED'
            used += reserve
            estimated = True
            records.append(record)
            continue
        stats['latencies'].append(meta['latencyMs'])
        if meta['promptTokens'] is not None and meta['completionTokens'] is not None:
            stats['promptTokens'] += meta['promptTokens']
            stats['completionTokens'] += meta['completionTokens']
            used += meta['promptTokens'] + meta['completionTokens']
        else:
            used += reserve
            estimated = True
        record.update({'latencyMs': meta['latencyMs'], 'finishReason': meta['finishReason'], 'reportedModel': meta['reportedModel'],
                       'output': content[:8192]})
        try:
            value = validate(task, strict_json(content), call['context'])
        except HermesError:
            # Production parses strictly; fenced JSON is recorded separately to guide prompt work, not accepted.
            stripped = content.strip()
            category = 'FENCED_JSON' if stripped.startswith('```') else 'NOT_STRICT_JSON'
            try:
                strict_json(content)
                category = 'CONTRACT_INVALID'
            except HermesError:
                pass
            if meta['finishReason'] == 'length':
                category = 'TRUNCATED_OUTPUT'
            stats['failures'][category] = stats['failures'].get(category, 0) + 1
            record['outcome'] = category
            records.append(record)
            continue
        stats['valid'] += 1
        record['outcome'] = 'valid'
        if task in ASSESSMENT_TASKS:
            arm = arms[task][call['arm']]
            arm['validSets'] += 1
            given = {a['caseId']: a['answers'] for a in value['answers']}
            # Method answers are converted exactly as the backend does before the same grading.
            numeric = {c['id']: derive(c['challenge'], given[c['id']]) if task == 'knowledge-assessment-methods' else given[c['id']]
                       for c in call['context']['cases']}
            scored = [grade(c['challenge'], numeric[c['id']]) for c in call['context']['cases']]
            for checks in scored:
                for skill, passed in checks.items():
                    arm['checksPassed'] += passed
                    arm['bySkill'][skill] += passed
            record['checksPassed'] = sum(sum(checks.values()) for checks in scored)
            pairs[task].setdefault(call['pairId'], {})[call['arm']] = {
                'checksPassed': record['checksPassed'], 'cases': call['context']['cases']}
        records.append(record)
    summary = {}
    for task, stats in tasks.items():
        if stats['calls']:
            latencies = stats.pop('latencies')
            summary[task] = {**stats, 'validRate': round(stats['valid'] / stats['calls'], 4),
                             'latencyMs': {'p50': percentile(latencies, 0.5), 'p95': percentile(latencies, 0.95),
                                           'max': max(latencies) if latencies else None}}
    def compare(kind):
        complete = [p for p in pairs[kind].values() if set(p) == {'with-lessons', 'without-lessons'}
                    and p['with-lessons']['cases'] == p['without-lessons']['cases']]
        comparison = None
        if complete:
            with_rate = sum(p['with-lessons']['checksPassed'] for p in complete) / (16 * len(complete))
            without_rate = sum(p['without-lessons']['checksPassed'] for p in complete) / (16 * len(complete))
            comparison = {'withLessonsRate': round(with_rate, 4), 'withoutLessonsRate': round(without_rate, 4),
                          'difference': round(with_rate - without_rate, 4), 'pairedSets': len(complete),
                          'interpretation': 'Completed valid pairs only; inspect arm failures and coverage for selection bias. Descriptive, not causal.'}
        coverage = {'plannedPairs': len({c['pairId'] for c in calls if c['task'] == kind}), 'completePairs': len(complete)}
        return comparison, coverage
    comparison, coverage = compare('knowledge-assessment')
    methods_comparison, methods_coverage = compare('knowledge-assessment-methods')
    # The original keys keep describing the numeric rubric; method results are reported alongside.
    return {'tasks': summary, 'assessmentArms': arms['knowledge-assessment'], 'transferComparison': comparison, 'calls': records,
            'assessmentCoverage': coverage, 'methodsAssessmentArms': arms['knowledge-assessment-methods'],
            'methodsTransferComparison': methods_comparison, 'methodsAssessmentCoverage': methods_coverage,
            'budget': {'usedTokens': used, 'tokensIncludeEstimates': estimated, 'stoppedReason': stopped,
                       'elapsedSeconds': round(clock() - started, 1)}}


def main(argv=None, env=None, out_root=None, opener=None):
    env = os.environ if env is None else env
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', choices=('direct', 'hermes'), default='direct')
    parser.add_argument('--tasks', default=','.join(TASKS))
    parser.add_argument('--repeats', type=int, default=1, choices=range(1, 6))
    parser.add_argument('--seed', type=int, default=20261006)
    parser.add_argument('--max-calls', type=int, default=30)
    parser.add_argument('--max-total-tokens', type=int, default=100_000)
    parser.add_argument('--max-minutes', type=int, default=30)
    parser.add_argument('--timeout-seconds', type=int, default=None, choices=range(5, 301))
    parser.add_argument('--model-revision', default=None, help='Owner-recorded immutable weight revision, e.g. a model repository commit')
    parser.add_argument('--allow-remote-cost', action='store_true', help='Acknowledge that a non-loopback endpoint may bill usage')
    parser.add_argument('--structured', action='store_true', help='Direct engine only: request schema-constrained JSON output')
    args = parser.parse_args(argv)
    tasks = tuple(t for t in args.tasks.split(',') if t)
    if not tasks or any(t not in TASKS for t in tasks):
        parser.error('Unknown task')
    if not 1 <= args.max_calls <= HARD_MAX_CALLS or not 1 <= args.max_minutes <= HARD_MAX_MINUTES or not 1000 <= args.max_total_tokens <= HARD_MAX_TOKENS:
        parser.error(f'Budgets are capped at {HARD_MAX_CALLS} calls, {HARD_MAX_MINUTES} minutes and {HARD_MAX_TOKENS} tokens')
    if args.model_revision is not None and not 1 <= len(args.model_revision) <= 120:
        parser.error('Model revision label is limited to 120 characters')
    endpoint = Endpoint.create(env.get('HERMES_MODEL_BASE_URL', ''), env.get('HERMES_MODEL', ''), env.get('HERMES_MODEL_API_KEY', ''))
    if not endpoint.loopback and not args.allow_remote_cost:
        parser.error('Non-loopback endpoint: pass --allow-remote-cost after confirming the provider budget')
    calls = fixtures(tasks, args.repeats, args.seed)
    if len(calls) > args.max_calls:
        parser.error(f'{len(calls)} planned calls exceed --max-calls {args.max_calls}')
    if args.structured and args.engine != 'direct':
        parser.error('--structured applies to the direct engine only')
    if args.engine == 'hermes':
        from adapter import Settings
        # The explicit benchmark engine must not be overridden by a worker's ambient setting.
        settings = Settings.from_env({**env, 'HERMES_ENGINE': 'hermes'})
        if args.timeout_seconds is not None:
            if args.timeout_seconds < 70:
                parser.error('Hermes needs at least 70 seconds for its process/run/API budgets')
            settings = replace(settings, timeout_seconds=args.timeout_seconds)
        configured_timeout = settings.timeout_seconds
        if settings.model != endpoint.model or settings.base_url.rstrip('/') != endpoint.base_url:
            raise HermesError('Hermes settings differ from the benchmark endpoint')
        engine = hermes_engine(settings)
    else:
        configured_timeout = args.timeout_seconds if args.timeout_seconds is not None else 120
        engine = direct_engine(endpoint, configured_timeout, opener, structured=args.structured)
    started = datetime.now(timezone.utc)
    result = run_benchmark(engine, calls, max_calls=args.max_calls, max_total_tokens=args.max_total_tokens, max_seconds=args.max_minutes * 60)
    calls_detail = result.pop('calls')
    report = {'reportVersion': 2, 'benchmark': contracts.CONTRACT_VERSION, 'startedAt': started.isoformat(), 'finishedAt': datetime.now(timezone.utc).isoformat(),
              'engine': ('direct-chat-completions' + ('-structured' if args.structured else '')) if args.engine == 'direct' else f'hermes-{PINNED_REVISION[:12]}',
              'model': endpoint.model, 'declaredModelRevision': args.model_revision, 'endpointOrigin': endpoint.origin,
              'endpointLoopback': endpoint.loopback,
              # The served model name the endpoint returned; it is a self-report, not weight attestation.
              'reportedModels': sorted({c['reportedModel'] for c in calls_detail if c.get('reportedModel')}),
              'promptVersions': {t: contracts.prompt_version(t) for t in tasks},
              'settings': {'temperature': 0 if args.engine == 'direct' else 'hermes-default', 'maxTokens': {t: contracts.MAX_TOKENS[t] for t in tasks},
                            'timeoutSeconds': configured_timeout,
                            'effectiveTimeoutSecondsByTask': {t: contracts.timeout_for(t, configured_timeout)
                                if args.engine == 'hermes' else configured_timeout for t in tasks},
                            'repeats': args.repeats, 'seed': args.seed},
              'plannedCalls': len(calls), **result,
              'qualification': 'none', 'promotionAllowed': False,
              'scope': 'Synthetic organisation task contracts. Not market competence, model learning or a deployment decision.'}
    if args.engine == 'direct':
        report['note'] = 'Direct engine uses production prompts/validators without Hermes agent scaffolding; confirm with --engine hermes before activation.'
    root = Path(out_root) if out_root else Path(__file__).resolve().parents[2] / '.local' / 'model-benchmarks'
    directory = root / started.strftime('%Y%m%dT%H%M%SZ')
    directory.mkdir(parents=True, exist_ok=False)
    (directory / 'report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    with (directory / 'calls.jsonl').open('w', encoding='utf-8') as handle:
        for record in calls_detail:
            handle.write(json.dumps(record) + '\n')
    summary = {k: report[k] for k in ('model', 'engine', 'plannedCalls', 'tasks', 'assessmentCoverage', 'transferComparison',
                                      'methodsAssessmentCoverage', 'methodsTransferComparison', 'budget', 'promotionAllowed')}
    print(json.dumps({**summary, 'report': str(directory / 'report.json')}))
    return report


if __name__ == '__main__':
    try:
        main()
    except (EndpointError, HermesError) as exc:
        print(json.dumps({'event': 'model.benchmark.failed', 'code': getattr(exc, 'code', 'HERMES_FAILED')}), file=sys.stderr)
        raise SystemExit(1)
