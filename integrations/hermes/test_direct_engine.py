from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import adapter
import openai_compat
from inference_reporting import timed_inference
from adapter import HermesError, PINNED_REVISION, Settings, profile_matches
from knowledge import propose_knowledge
from knowledge_worker import run_once
from test_model_tools import KEY, FakeModel

LESSONS = [{'id': 'lesson-a', 'authorBotId': 'mentor', 'content': 'Deduct costs', 'evidenceId': 'evidence'}]


class DirectEngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), FakeModel)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f'http://127.0.0.1:{cls.server.server_address[1]}/v1'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close()

    def setUp(self):
        FakeModel.mode, FakeModel.hits, FakeModel.bodies = 'solver', [], []

    def env(self, **extra):
        return {'HERMES_ENABLED': 'true', 'HERMES_ENGINE': 'direct', 'HERMES_MODEL': 'fixture-model',
                'HERMES_MODEL_BASE_URL': self.base, 'HERMES_MODEL_API_KEY': KEY, **extra}

    def test_direct_settings_need_no_hermes_checkout_and_bind_to_their_engine(self):
        settings = Settings.from_env(self.env())
        self.assertEqual(settings.engine, 'direct')
        adapter.verify_checkout(settings)  # no upstream checkout is executed or required
        with self.assertRaises(HermesError):
            Settings.from_env(self.env(HERMES_ENGINE='other'))
        with self.assertRaises(HermesError):
            Settings.from_env({**self.env(HERMES_ENGINE='hermes')})  # hermes still requires source and Python
        direct = {'name': 'fixture-model', 'baseUrl': self.base + '/', 'engine': 'direct-structured-v1', 'sourceRevision': None}
        hermes = {**direct, 'engine': 'hermes-rd-v1', 'sourceRevision': PINNED_REVISION}
        self.assertTrue(profile_matches(direct, settings))
        self.assertFalse(profile_matches(hermes, settings))
        hermes_settings = Settings(Path('/s'), Path('/p'), 'fixture-model', self.base, KEY)
        self.assertTrue(profile_matches(hermes, hermes_settings))
        self.assertFalse(profile_matches(direct, hermes_settings))
        self.assertFalse(profile_matches({**hermes, 'sourceRevision': 'other'}, hermes_settings))
        self.assertFalse(profile_matches({**direct, 'name': 'another-model'}, settings))

    def test_direct_engine_sends_schema_validates_output_and_maps_failures(self):
        settings = Settings.from_env(self.env())
        context = {'kind': 'knowledge-transfer-v1', 'task': 'fresh comparison', 'lessons': LESSONS}
        plan = propose_knowledge(settings, context)
        self.assertEqual(plan['lessonIds'], ['lesson-a'])
        body = FakeModel.bodies[-1]
        self.assertEqual(body['response_format']['json_schema']['schema']['properties']['lessonIds']['items']['enum'], ['lesson-a'])
        self.assertEqual(body['temperature'], 0)
        from contracts import RESEARCH_PRACTICE_VERSION
        self.assertIn(RESEARCH_PRACTICE_VERSION, body['messages'][0]['content'])
        FakeModel.mode = 'fenced'  # constrained decoding should prevent this; if a server ignores it, validation still refuses
        with self.assertRaises(HermesError):
            propose_knowledge(settings, context)
        FakeModel.mode = 'solver'
        with self.assertRaisesRegex(HermesError, 'ENDPOINT_UNAUTHORISED'):
            propose_knowledge(Settings.from_env(self.env(HERMES_MODEL_API_KEY='wrong')), context)

    def test_worker_reports_real_usage_and_refuses_engine_mismatch(self):
        settings = Settings.from_env(self.env())
        ticket = {'id': 'request', 'contextHash': 'a' * 64,
                  'context': {'kind': 'knowledge-transfer-v1', 'task': 'fresh comparison', 'lessons': LESSONS},
                  'expiresAt': (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
                  'model': {'name': 'fixture-model', 'baseUrl': self.base, 'engine': 'direct-structured-v1', 'sourceRevision': None}}
        client = Mock(base='http://127.0.0.1:3000', token='fixture')
        client.post.side_effect = [ticket, {'authorised': True}, {'recorded': True}, {'state': 'awaiting-review'}]
        with tempfile.TemporaryDirectory() as directory:
            result = run_once(client, settings, {'botId': 'student', 'lessonIds': ['lesson-a'], 'task': 'x'}, 'direct-key-01', Path(directory))
        self.assertEqual(result['state'], 'awaiting-review')
        report = client.post.call_args_list[2].args[1]
        self.assertEqual(report['engine'], 'direct-structured-v1')
        self.assertEqual(report['outcome'], 'completed')
        self.assertIsInstance(report['promptTokens'], int)
        self.assertIsInstance(report['completionTokens'], int)
        self.assertEqual(report['reportedModel'], 'fixture-model')
        hermes_ticket = {**ticket, 'model': {**ticket['model'], 'engine': 'hermes-rd-v1', 'sourceRevision': PINNED_REVISION}}
        client = Mock(base='http://127.0.0.1:3000', token='fixture')
        client.post.side_effect = [hermes_ticket]
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(HermesError, 'profile'):
                run_once(client, settings, {'botId': 'student', 'lessonIds': ['lesson-a'], 'task': 'x'}, 'direct-key-02', Path(directory))
        self.assertEqual(client.post.call_count, 1)  # no preflight, inference or report for a mismatched engine

    def test_incomplete_refused_and_tool_responses_fail_even_with_valid_json(self):
        settings = Settings.from_env(self.env())
        valid = {'content': '{"kind":"momentum","lookback":7}', 'finishReason': 'stop',
                 'hasToolCalls': False, 'refused': False, 'promptTokens': 20,
                 'completionTokens': 10, 'reportedModel': 'fixture-model', 'latencyMs': 1}
        variants = [{'finishReason': reason} for reason in ('length', 'tool_calls', 'content_filter', None, 'unknown')]
        variants += [{'hasToolCalls': True}, {'refused': True}, {'content': 'invalid JSON'}]
        for change in variants:
            with self.subTest(change=change), patch.object(openai_compat, 'chat', return_value={**valid, **change}) as chat:
                record, saved = {}, []
                with self.assertRaises(HermesError):
                    timed_inference(record, Path('unused'), lambda p, r: saved.append(dict(r)), 'candidate',
                                    lambda: adapter.invoke(settings, {'trials': []}, adapter.validate_candidate),
                                    engine='direct-structured-v1')
                chat.assert_called_once()  # no retry or alternate engine on rejection
                report = saved[0]['inferenceReport']
                self.assertEqual(report['outcome'], 'failed')
                self.assertEqual(report['failureCode'], 'INFERENCE_FAILED')
                self.assertEqual(report['promptTokens'], 20)
                self.assertEqual(report['completionTokens'], 10)
                self.assertIsNone(adapter.USAGE.get())
        with patch.object(openai_compat, 'chat', return_value=valid):
            self.assertEqual(adapter.invoke(settings, {'trials': []}, adapter.validate_candidate)['lookback'], 7)

    def test_transport_exposes_tool_and_refusal_signals_without_executing_them(self):
        endpoint = openai_compat.Endpoint.create(self.base, 'fixture-model', KEY)
        for extra in ({'tool_calls': [{'id': 'x'}]}, {'function_call': {'name': 'x'}}, {'refusal': 'denied'}):
            response = {'choices': [{'message': {'content': '{}', **extra}, 'finish_reason': 'stop'}]}
            with patch.object(openai_compat, '_call', return_value=(response, 1)):
                result = openai_compat.chat(endpoint, 'system', '{}', 10)
            self.assertEqual(result['hasToolCalls'], 'refusal' not in extra)
            self.assertEqual(result['refused'], 'refusal' in extra)


if __name__ == '__main__':
    unittest.main()
