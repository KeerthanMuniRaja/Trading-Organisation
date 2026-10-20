import json
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
from practice_benchmark import study, evaluate, main


def valid(prompt, context, timeout):
    return {'content': json.dumps({'summary': 'Fixture', 'application': 'Proposed test only',
                                  'lessonIds': [x['id'] for x in context['lessons']],
                                  'checks': ['Independent check'], 'risks': ['Limited evidence']}),
            'finishReason': 'stop', 'hasToolCalls': False, 'refused': False,
            'promptTokens': 10, 'completionTokens': 20}


class PracticeBenchmarkTests(unittest.TestCase):
    def test_prepare_only_never_initializes_an_endpoint(self):
        with tempfile.TemporaryDirectory() as directory, patch('practice_benchmark.Endpoint.create') as create:
            main([], directory)
            create.assert_not_called()
            folder = next(Path(directory).iterdir())
            state = json.loads((folder/'state.json').read_text())
            self.assertEqual(state['status'], 'prepared-only')
            self.assertEqual(state['finishedCalls'], 0)
            self.assertFalse((folder/'calls.jsonl').exists())

    def test_interruption_leaves_pre_call_checkpoint_without_completed_report(self):
        env = {'HERMES_MODEL_BASE_URL': 'http://127.0.0.1:8080/v1',
               'HERMES_MODEL': 'fixture', 'HERMES_MODEL_API_KEY': 'fixture-secret'}
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', env), \
             patch('practice_benchmark.chat', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                main(['--run'], directory)
            folder = next(Path(directory).iterdir())
            state = json.loads((folder/'state.json').read_text())
            self.assertEqual(state['status'], 'inference-started')
            self.assertEqual(state['finishedCalls'], 0)
            self.assertIsNotNone(state['activeCall'])
            self.assertFalse((folder/'report.json').exists())
            self.assertNotIn('fixture-secret', (folder/'state.json').read_text())

    def test_pairing_order_and_no_automatic_semantic_pass(self):
        spec, saved, contexts = study(), [], []
        def invoke(prompt, context, timeout):
            contexts.append(context)
            return valid(prompt, context, timeout)
        report = evaluate(spec, invoke, saved.append)
        self.assertEqual(report['completeValidPairs'], 4)
        self.assertEqual(report['attemptedCalls'], 8)
        self.assertFalse(report['improvementDemonstrated'])
        self.assertFalse(report['promotionAllowed'])
        for i in range(0, 8, 2):
            self.assertEqual(contexts[i], contexts[i+1])
            self.assertEqual(saved[i]['contextHash'], saved[i+1]['contextHash'])
        self.assertEqual([saved[i]['arm'] for i in (0, 2, 4, 6)], ['baseline', 'practice', 'baseline', 'practice'])

    def test_failed_arm_remains_counted_and_cannot_be_a_complete_pair(self):
        saved = []
        def invoke(prompt, context, timeout):
            response = valid(prompt, context, timeout)
            if 'research-review-practice-v1' in prompt:
                response['finishReason'] = 'length'
            return response
        result = evaluate(study(), invoke, saved.append)
        self.assertEqual(result['attemptedCalls'], 8)
        self.assertEqual(result['completeValidPairs'], 0)
        self.assertEqual(result['validByArm'], {'baseline': 4, 'practice': 0})
        self.assertEqual(sum(r['status'] == 'failed' for r in saved), 4)

    def test_wrong_citations_and_tools_fail_without_retries(self):
        calls = []
        def invoke(prompt, context, timeout):
            calls.append(1)
            r = valid(prompt, context, timeout)
            if len(calls) % 2:
                answer = json.loads(r['content']); answer['lessonIds'] = ['invented']
                r['content'] = json.dumps(answer)
            else:
                r['hasToolCalls'] = True
            return r
        self.assertEqual(evaluate(study(), invoke, lambda _: None)['completeValidPairs'], 0)
        self.assertEqual(len(calls), 8)

    def test_expired_budget_stops_before_calling_model(self):
        times = iter([0, 301, 302, 303, 304])
        result = evaluate(study(), lambda *args: self.fail('unexpected call'), lambda _: None, clock=lambda: next(times))
        self.assertEqual(result['attemptedCalls'], 0)
        self.assertEqual(result['completeValidPairs'], 0)
