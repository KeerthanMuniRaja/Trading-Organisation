from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import contracts
import model_benchmark
import model_doctor
from openai_compat import Endpoint, EndpointError, chat, list_models

KEY = 'fixture-model-key'


def solve(task, payload):
    """Deterministic stand-in model. Assessment answers are only correct when lessons are supplied."""
    if task == 'candidate':
        best = max(payload['trainingTrials'], key=lambda t: t['netReturnBps'] - t['maxDrawdownBps'])
        return {'kind': 'momentum', 'lookback': best['lookback']}
    if task == 'capability':
        return {'specialty': 'volatility-regime', 'method': payload['method'], 'hypothesis': 'Inverse volatility may reduce drawdown.',
                'expectedContribution': 'A falsifiable drawdown comparison.', 'risks': ['One example test'], 'memoryIds': ['memory-1']}
    if task == 'knowledge':
        return {'summary': 'Apply costs', 'application': 'Compare after fees.', 'lessonIds': [l['id'] for l in payload['lessons']],
                'checks': ['Recompute net figures'], 'risks': ['Synthetic only']}
    if task == 'source-lesson':
        return {'lesson': 'Deduct execution costs.', 'quote': payload['article']['content'].split('. ')[0], 'limitation': 'One article.'}
    if task == 'knowledge-assessment-methods':
        informed = bool(payload['lessons'])
        def method(case):
            c = case['challenge']['control']
            act = 'research' if not c['halted'] and c['evidenceVerified'] and c['budget'] >= c['required'] else 'wait'
            if informed:
                return {'costTerms': ['+grossProfitPaise', '-feesPaise', '-slippagePaise'], 'drawdownMethod': 'running-peak-to-trough',
                        'timingRule': 'event-and-availability-at-or-before-cutoff', 'action': act}
            return {'costTerms': ['+grossProfitPaise'], 'drawdownMethod': 'first-to-last', 'timingRule': 'event-at-or-before-cutoff', 'action': act}
        return {'answers': [{'caseId': case['id'], 'answers': method(case)} for case in payload['cases']]}
    answers = []
    for case in payload['cases']:
        c, informed = case['challenge'], bool(payload['lessons'])
        peak = drawdown = 0
        for value in c['equityPaise']:
            peak = max(peak, value); drawdown = max(drawdown, (peak - value) / peak * 10000)
        control = c['control']
        answers.append({'caseId': case['id'], 'answers': {
            # Uninformed answers ignore costs and availability times, as a naive model might.
            'netProfitPaise': c['grossProfitPaise'] - (c['feesPaise'] + c['slippagePaise'] if informed else 0),
            'maxDrawdownBps': drawdown,
            'eligibleRecordIds': [r['id'] for r in c['records'] if r['eventAt'] <= c['cutoff'] and (r['availableAt'] <= c['cutoff'] or not informed)],
            'action': 'research' if not control['halted'] and control['evidenceVerified'] and control['budget'] >= control['required'] else 'wait'}})
    return {'answers': answers}


class FakeModel(BaseHTTPRequestHandler):
    mode = 'solver'
    hits = []
    bodies = []

    def log_message(self, *args):
        pass

    def reply(self, status, value, headers=()):
        body = json.dumps(value).encode() if not isinstance(value, bytes) else value
        self.send_response(status)
        for name, header in headers:
            self.send_header(name, header)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorised(self):
        FakeModel.hits.append((self.command, self.path, self.headers.get('Authorization')))
        if self.headers.get('Authorization') != 'Bearer ' + KEY:
            self.reply(401, {'error': 'secret provider detail'})
            return False
        return True

    def do_GET(self):
        if self.path == '/target/models':
            FakeModel.hits.append(('GET', self.path, None)); return self.reply(200, {'data': []})
        if not self.authorised():
            return
        if FakeModel.mode == 'redirect':
            return self.reply(302, {}, [('Location', '/target/models')])
        self.reply(200, {'object': 'list', 'data': [{'id': 'fixture-model'}, {'id': 'other'}]})

    def do_POST(self):
        if not self.authorised():
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        FakeModel.bodies.append(body)
        if FakeModel.mode == 'slow':
            time.sleep(2)
        if FakeModel.mode == 'huge':
            return self.reply(200, b'{"x":"' + b'a' * 300000 + b'"}')
        system, user = body['messages'][0]['content'], body['messages'][1]['content']
        task = next((name for name, prompt in contracts.PROMPTS.items() if prompt == system), None)
        content = '{"ok":true}' if task is None else json.dumps(solve(task, json.loads(user)))
        if FakeModel.mode == 'fenced':
            content = '```json\n' + content + '\n```'
        self.reply(200, {'model': body['model'], 'choices': [{'message': {'content': content}, 'finish_reason': 'stop'}],
                         'usage': {'prompt_tokens': len(user) // 4, 'completion_tokens': len(content) // 4}})


class ModelToolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), FakeModel)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f'http://127.0.0.1:{cls.server.server_address[1]}/v1'
        cls.env = {'HERMES_MODEL_BASE_URL': cls.base, 'HERMES_MODEL': 'fixture-model', 'HERMES_MODEL_API_KEY': KEY}

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        FakeModel.mode, FakeModel.hits = 'solver', []

    def endpoint(self, key=KEY):
        return Endpoint.create(self.base, 'fixture-model', key)

    def test_endpoint_policy_and_bounded_transport(self):
        for url in ('http://model.example/v1', 'https://user:pw@model.example/v1', 'https://model.example/v1?k=1', ''):
            with self.assertRaises(EndpointError):
                Endpoint.create(url, 'm', 'k')
        self.assertNotIn(KEY, repr(self.endpoint()))
        with patch.dict(os.environ, {'HTTP_PROXY': 'http://127.0.0.1:9', 'http_proxy': 'http://127.0.0.1:9'}):
            self.assertEqual(list_models(self.endpoint()), ['fixture-model', 'other'])
        result = chat(self.endpoint(), 'unknown system', '{}', 16)
        self.assertEqual(result['content'], '{"ok":true}')
        self.assertEqual(result['reportedModel'], 'fixture-model')
        self.assertIsInstance(result['promptTokens'], int)
        FakeModel.mode = 'redirect'
        with self.assertRaises(EndpointError) as raised:
            list_models(self.endpoint())
        self.assertEqual(raised.exception.code, 'ENDPOINT_REDIRECT_REFUSED')
        self.assertFalse(any(path == '/target/models' for _, path, _ in FakeModel.hits))
        FakeModel.mode = 'solver'
        with self.assertRaises(EndpointError) as raised:
            list_models(self.endpoint('wrong-key'))
        self.assertEqual(raised.exception.code, 'ENDPOINT_UNAUTHORISED')
        self.assertNotIn('secret', str(raised.exception))
        for mode, code, timeout in (('huge', 'ENDPOINT_RESPONSE_TOO_LARGE', 30), ('slow', 'ENDPOINT_TIMEOUT', 0.5)):
            FakeModel.mode = mode
            with self.assertRaises(EndpointError) as raised:
                chat(self.endpoint(), 's', '{}', 16, timeout=timeout)
            self.assertEqual(raised.exception.code, code)

    def test_doctor_reports_readiness_without_secrets(self):
        report = model_doctor.diagnose(self.env, probe=True)
        self.assertEqual(report['status'], 'ready')
        probe = next(c for c in report['checks'] if c['name'] == 'probe')
        self.assertTrue(probe['strictJson'] and probe['usageReported'])
        self.assertNotIn(KEY, json.dumps(report))
        missing = model_doctor.diagnose({**self.env, 'HERMES_MODEL': 'absent'})
        self.assertEqual(missing['status'], 'attention')
        self.assertEqual(missing['checks'][1]['code'], 'MODEL_NOT_SERVED')
        self.assertEqual(model_doctor.diagnose({**self.env, 'HERMES_MODEL_BASE_URL': 'http://10.0.0.5/v1'})['checks'][0]['code'], 'ENDPOINT_REQUIRES_HTTPS')
        class Opener:  # A remote endpoint must not be probed without an explicit cost acknowledgement.
            def open(self, request, timeout):
                raise AssertionError('no network expected for the probe gate') if request.get_method() == 'POST' else OSError()
        remote = model_doctor.diagnose({**self.env, 'HERMES_MODEL_BASE_URL': 'https://model.example/v1'}, probe=True, opener=Opener())
        self.assertEqual(next(c for c in remote['checks'] if c['name'] == 'probe')['code'], 'REMOTE_COST_NOT_ACKNOWLEDGED')
        hermes = model_doctor.diagnose(self.env, check_hermes=True)
        self.assertEqual(next(c for c in hermes['checks'] if c['name'] == 'hermes-checkout')['code'], 'HERMES_NOT_READY')

    def test_benchmark_scores_contracts_and_transfer_comparison(self):
        with tempfile.TemporaryDirectory() as out:
            with patch('sys.stdout'):
                report = model_benchmark.main(['--repeats', '2'], env=self.env, out_root=out)
            self.assertEqual(report['plannedCalls'], 16)  # 4 single-call tasks + 2 numeric + 2 method assessment arms, twice
            for task in model_benchmark.TASKS:
                self.assertEqual(report['tasks'][task]['validRate'], 1.0, task)
            comparison = report['transferComparison']
            self.assertEqual(comparison['withLessonsRate'], 1.0)
            self.assertLess(comparison['withoutLessonsRate'], 1.0)
            self.assertGreater(comparison['difference'], 0)
            self.assertEqual(report['assessmentArms']['with-lessons']['bySkill']['abstention'], 8)
            self.assertEqual(report['promptVersions']['knowledge'], contracts.prompt_version('knowledge'))
            methods = report['methodsTransferComparison']
            self.assertEqual((methods['withLessonsRate'], methods['pairedSets']), (1.0, 2))
            self.assertLess(methods['withoutLessonsRate'], 1.0)
            self.assertEqual(report['methodsAssessmentArms']['with-lessons']['bySkill']['drawdown'], 8)
            self.assertEqual(report['reportedModels'], ['fixture-model'])
            self.assertFalse(report['promotionAllowed'])
            self.assertFalse(report['budget']['tokensIncludeEstimates'])
            files = list(Path(out).rglob('*'))
            self.assertTrue(any(f.name == 'calls.jsonl' for f in files))
            for path in files:
                if path.is_file():
                    self.assertNotIn(KEY, path.read_text(encoding='utf-8'))

    def test_benchmark_failures_budgets_and_cost_gate(self):
        FakeModel.mode = 'fenced'
        with tempfile.TemporaryDirectory() as out:
            with patch('sys.stdout'):
                report = model_benchmark.main(['--tasks', 'knowledge,knowledge-assessment'], env=self.env, out_root=out)
        self.assertEqual(report['tasks']['knowledge']['failures'], {'FENCED_JSON': 1})
        self.assertIsNone(report['transferComparison'])
        with patch('sys.stderr'):
            for argv, env in ((['--max-calls', '3'], self.env), ([], {**self.env, 'HERMES_MODEL_BASE_URL': 'https://model.example/v1'}),
                              (['--max-calls', '999'], self.env), (['--tasks', 'trading'], self.env)):
                with self.assertRaises(SystemExit):
                    model_benchmark.main(argv, env=env, out_root=tempfile.gettempdir())
        calls = model_benchmark.fixtures(('knowledge',), 3, 1)
        def engine(call):
            return json.dumps(solve('knowledge', call['context'])), {'latencyMs': 1.0, 'promptTokens': None, 'completionTokens': None,
                                                                      'finishReason': 'stop', 'reportedModel': None}
        limited = model_benchmark.run_benchmark(engine, calls, max_calls=10, max_total_tokens=2500, max_seconds=60)
        self.assertEqual(limited['budget']['stoppedReason'], 'token-budget')
        self.assertTrue(limited['budget']['tokensIncludeEstimates'])
        self.assertLess(limited['tasks']['knowledge']['calls'], 3)
        def failing(call):
            raise EndpointError('ENDPOINT_TIMEOUT')
        failed = model_benchmark.run_benchmark(failing, calls, max_calls=10, max_total_tokens=100000, max_seconds=60)
        self.assertEqual(failed['tasks']['knowledge']['failures'], {'ENDPOINT_TIMEOUT': 3})

    def test_failed_assessment_arms_cannot_create_a_false_pair(self):
        from adapter import HermesError
        calls = model_benchmark.fixtures(('knowledge-assessment',), 2, 7)
        def engine(call):
            if call is calls[1]:
                raise EndpointError('ENDPOINT_TIMEOUT')
            if call is calls[2]:
                raise HermesError('fixture failure')
            return json.dumps(solve(call['task'], call['context'])), {
                'latencyMs': 1, 'promptTokens': 1, 'completionTokens': 1,
                'finishReason': 'stop', 'reportedModel': 'fixture'}
        result = model_benchmark.run_benchmark(engine, calls, max_calls=4, max_total_tokens=100000, max_seconds=60)
        self.assertIsNone(result['transferComparison'])
        self.assertEqual(result['assessmentCoverage'], {'plannedPairs': 2, 'completePairs': 0})
        for arm in result['assessmentArms'].values():
            self.assertEqual(arm['sets'], 2)
            self.assertEqual(arm['checksTotal'], 32)
            self.assertEqual(arm['validSets'], 1)
        self.assertEqual([c['pairId'] for c in result['calls']], ['7:0', '7:0', '7:1', '7:1'])

    def test_time_budget_mid_pair_does_not_compare_unmatched_cases(self):
        calls = model_benchmark.fixtures(('knowledge-assessment',), 2, 7)
        clock_values = iter([0, 0, 0, 0, 61, 61])
        def engine(call):
            return json.dumps(solve(call['task'], call['context'])), {
                'latencyMs': 1, 'promptTokens': 1, 'completionTokens': 1,
                'finishReason': 'stop', 'reportedModel': 'fixture'}
        result = model_benchmark.run_benchmark(engine, calls, max_calls=4, max_total_tokens=100000,
                                                max_seconds=60, clock=lambda: next(clock_values))
        self.assertEqual(result['budget']['stoppedReason'], 'time-budget')
        self.assertEqual(result['assessmentCoverage'], {'plannedPairs': 2, 'completePairs': 1})
        self.assertEqual(result['transferComparison']['pairedSets'], 1)
        self.assertEqual(result['assessmentArms']['with-lessons']['sets'], 2)

    def test_hermes_timeout_override_environment_and_report_match(self):
        env = {**self.env, 'HERMES_ENABLED': 'true', 'HERMES_SOURCE_PATH': '.',
               'HERMES_PYTHON': sys.executable, 'HERMES_TIMEOUT_SECONDS': '240', 'HERMES_ENGINE': 'direct'}
        captured = []
        def factory(settings):
            self.assertEqual(settings.engine, 'hermes')
            captured.append(settings.timeout_seconds)
            return lambda call: (json.dumps(solve(call['task'], call['context'])), {
                'latencyMs': 1, 'promptTokens': None, 'completionTokens': None,
                'finishReason': 'stop', 'reportedModel': None})
        for options, expected in (([], 240), (['--timeout-seconds', '300'], 300)):
            with tempfile.TemporaryDirectory() as out, patch('sys.stdout'), patch.object(model_benchmark, 'hermes_engine', factory):
                report = model_benchmark.main(['--engine', 'hermes', '--tasks', 'knowledge,capability'] + options,
                                              env=env, out_root=out)
            self.assertEqual(captured[-1], expected)
            self.assertEqual(report['settings']['timeoutSeconds'], expected)
            self.assertEqual(report['settings']['effectiveTimeoutSecondsByTask'], {'knowledge': expected, 'capability': 150})
        with patch('sys.stderr'), patch.object(model_benchmark, 'hermes_engine') as engine:
            with self.assertRaises(SystemExit):
                model_benchmark.main(['--engine', 'hermes', '--timeout-seconds', '5'], env=env)
            engine.assert_not_called()

    def test_structured_mode_sends_contract_schemas_with_supplied_ids(self):
        FakeModel.bodies = []
        with tempfile.TemporaryDirectory() as out:
            with patch('sys.stdout'):
                report = model_benchmark.main(['--structured', '--tasks', 'knowledge,knowledge-assessment'], env=self.env, out_root=out)
        self.assertEqual(report['engine'], 'direct-chat-completions-structured')
        formats = [b['response_format'] for b in FakeModel.bodies]
        self.assertTrue(all(f['type'] == 'json_schema' for f in formats))
        knowledge = formats[0]['json_schema']['schema']
        self.assertEqual(knowledge['properties']['lessonIds']['items']['enum'], ['lesson-costs', 'lesson-drawdown'])
        assessment = formats[1]['json_schema']['schema']['properties']['answers']
        self.assertEqual((assessment['minItems'], assessment['maxItems']), (4, 4))
        self.assertEqual(assessment['items']['properties']['caseId']['enum'], [f'case-0-{i}' for i in range(4)])
        FakeModel.bodies = []
        with tempfile.TemporaryDirectory() as out:
            with patch('sys.stdout'):
                model_benchmark.main(['--tasks', 'knowledge'], env=self.env, out_root=out)
        self.assertNotIn('response_format', FakeModel.bodies[0])
        with patch('sys.stderr'), self.assertRaises(SystemExit):
            model_benchmark.main(['--structured', '--engine', 'hermes'], env=self.env, out_root=tempfile.gettempdir())
        for task, call in {c['task']: c for c in model_benchmark.fixtures(model_benchmark.TASKS, 1, 3)}.items():
            schema = contracts.output_schema(task, call['context'])
            self.assertFalse(schema['additionalProperties'], task)

    def test_benchmark_fixture_mirrors_backend_grading(self):
        case = {'grossProfitPaise': 1000, 'feesPaise': 10, 'slippagePaise': 5, 'equityPaise': [10000, 12000, 9000, 15000],
                'cutoff': '2020-01-15T00:00:00.000Z', 'control': {'halted': False, 'evidenceVerified': True, 'budget': 10, 'required': 10},
                'records': [{'id': 'record-0', 'eventAt': '2020-01-14T00:00:00.000Z', 'availableAt': '2020-01-16T00:00:00.000Z'},
                            {'id': 'record-1', 'eventAt': '2020-01-15T00:00:00.000Z', 'availableAt': '2020-01-15T00:00:00.000Z'}]}
        good = {'netProfitPaise': 985, 'maxDrawdownBps': 2500.0, 'eligibleRecordIds': ['record-1'], 'action': 'research'}
        self.assertEqual(model_benchmark.grade(case, good), dict.fromkeys(model_benchmark.SKILLS, True))
        self.assertFalse(model_benchmark.grade(case, {**good, 'eligibleRecordIds': ['record-0', 'record-1']})['informationTiming'])
        generated = model_benchmark.fixtures(('knowledge-assessment',), 1, 7)
        self.assertEqual(generated[0]['context']['cases'], generated[1]['context']['cases'])
        self.assertEqual([c['challenge']['control']['halted'] for c in generated[0]['context']['cases']], [False, True, False, False])
        for case in generated[0]['context']['cases']:
            for record in case['challenge']['records']:
                self.assertGreaterEqual(record['availableAt'], record['eventAt'])


if __name__ == '__main__':
    unittest.main()


class MethodRubricTests(unittest.TestCase):
    CASE = {'grossProfitPaise': 1000, 'feesPaise': 40, 'slippagePaise': 10, 'equityPaise': [10000, 12000, 9000, 15000, 14000],
            'cutoff': '2020-01-15T00:00:00.000Z', 'control': {'halted': False, 'evidenceVerified': True, 'budget': 10, 'required': 10},
            'records': [{'id': 'record-0', 'eventAt': '2020-01-14T00:00:00.000Z', 'availableAt': '2020-01-16T00:00:00.000Z'},
                        {'id': 'record-1', 'eventAt': '2020-01-15T00:00:00.000Z', 'availableAt': '2020-01-15T00:00:00.000Z'},
                        {'id': 'record-2', 'eventAt': '2020-01-16T00:00:00.000Z', 'availableAt': '2020-01-16T00:00:00.000Z'}]}
    CORRECT = {'costTerms': ['+grossProfitPaise', '-feesPaise', '-slippagePaise'], 'drawdownMethod': 'running-peak-to-trough',
               'timingRule': 'event-and-availability-at-or-before-cutoff', 'action': 'research'}

    def test_derivation_matches_the_backend_vectors(self):
        derived = model_benchmark.derive(self.CASE, self.CORRECT)
        self.assertEqual((derived['netProfitPaise'], derived['maxDrawdownBps'], derived['eligibleRecordIds']), (950, 2500.0, ['record-1']))
        self.assertEqual(model_benchmark.grade(self.CASE, derived), dict.fromkeys(model_benchmark.SKILLS, True))
        self.assertEqual(model_benchmark.derive(self.CASE, {**self.CORRECT, 'drawdownMethod': 'maximum-to-minimum'})['maxDrawdownBps'], 4000.0)
        wrong = model_benchmark.derive(self.CASE, {**self.CORRECT, 'timingRule': 'event-at-or-before-cutoff'})
        self.assertFalse(model_benchmark.grade(self.CASE, wrong)['informationTiming'])

    def test_method_answers_are_strictly_validated_by_rubric(self):
        from knowledge_assessment import validate_answers
        from adapter import HermesError
        context = {'rubric': 'research-methods-v1', 'cases': [{'id': str(i)} for i in range(4)]}
        good = {'answers': [{'caseId': str(i), 'answers': dict(self.CORRECT)} for i in range(4)]}
        self.assertEqual(validate_answers(good, context), good)
        numeric = {'answers': [{'caseId': str(i), 'answers': {'netProfitPaise': 1, 'maxDrawdownBps': 0, 'eligibleRecordIds': [], 'action': 'wait'}}
                               for i in range(4)]}
        with self.assertRaises(HermesError):
            validate_answers(numeric, context)  # numbers are refused under the methods rubric
        with self.assertRaises(HermesError):
            validate_answers(good, {'cases': context['cases']})  # and methods are refused under basics
        for change in ({'costTerms': ['+feesPaise', '-feesPaise']}, {'costTerms': []}, {'drawdownMethod': 'guess'}, {'timingRule': 'any'}):
            bad = {'answers': [{'caseId': str(i), 'answers': {**self.CORRECT, **change}} for i in range(4)]}
            with self.assertRaises(HermesError):
                validate_answers(bad, context)
        schema = contracts.output_schema('knowledge-assessment-methods', {'cases': [{'id': 'a'}, {'id': 'b'}, {'id': 'c'}, {'id': 'd'}]})
        item = schema['properties']['answers']['items']['properties']
        self.assertEqual(item['caseId']['enum'], ['a', 'b', 'c', 'd'])
        self.assertEqual(set(item['answers']['properties']), {'costTerms', 'drawdownMethod', 'timingRule', 'action'})
        self.assertEqual(contracts.assessment_task(context), 'knowledge-assessment-methods')
        self.assertEqual(contracts.assessment_task({'rubric': 'research-basics-v1'}), 'knowledge-assessment')
