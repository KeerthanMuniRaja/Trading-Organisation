from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from adapter import HermesError, PINNED_REVISION, Settings
from discovered_learning import run_discovered, selected_lessons
from knowledge_worker import run_once

LESSON = '00000000-0000-4000-8000-000000000001'
BODY = {'botId': 'student', 'query': 'fees slippage', 'task': 'Evaluate net returns'}


def discovery(ids=None):
    ids = [LESSON] if ids is None else ids
    return {'scope': 'current-reviewed-cross-bot-lessons', 'botId': 'student', 'modelInvoked': False,
            'suggestedLessonIds': ids, 'lessons': [{'id': item, 'author_bot_id': 'mentor'} for item in ids]}


class DiscoveredLearningTests(unittest.TestCase):
    def test_empty_discovery_is_persisted_without_model_setup(self):
        client = Mock(base='http://127.0.0.1:3000', token='fixture-token')
        client.post.return_value = discovery([])
        settings, runner = Mock(), Mock()
        with tempfile.TemporaryDirectory() as directory:
            args = (client, BODY, 'discovery-one', Path(directory), settings)
            self.assertEqual(run_discovered(*args, proposal_runner=runner)['state'], 'no-matching-lessons')
            run_discovered(*args, proposal_runner=runner)
        client.post.assert_called_once()
        settings.assert_not_called()
        runner.assert_not_called()

    def test_selection_survives_interruption_without_rediscovery(self):
        client = Mock(base='http://127.0.0.1:3000', token='fixture-token')
        client.post.return_value = discovery()
        runner = Mock(side_effect=[TimeoutError(), {'state': 'awaiting-review'}])
        with tempfile.TemporaryDirectory() as directory:
            args = (client, BODY, 'discovery-one', Path(directory), Mock())
            with self.assertRaises(TimeoutError):
                run_discovered(*args, proposal_runner=runner)
            first = runner.call_args
            result = run_discovered(*args, proposal_runner=runner)
            self.assertEqual(result['selectedLessonIds'], [LESSON])
            self.assertEqual(first.args[2:], runner.call_args.args[2:])
            run_discovered(*args, proposal_runner=runner)
            self.assertEqual(runner.call_count, 2)
            client.post.assert_called_once()
            with self.assertRaises(HermesError):
                run_discovered(client, {**BODY, 'query': 'changed'}, 'discovery-one', Path(directory), Mock())
            client.token = 'changed-token'
            with self.assertRaises(HermesError):
                run_discovered(client, BODY, 'discovery-one', Path(directory), Mock())

    def test_actual_proposal_journal_replays_lost_ack_without_second_inference(self):
        settings = Settings(Path('/source'), Path('/python'), 'fixture', 'http://127.0.0.1:8000/v1', 'fixture-key')
        context = {'kind': 'knowledge-transfer-v1', 'bot': {'id': 'student'}, 'task': BODY['task'],
                   'lessons': [{'id': LESSON, 'authorBotId': 'mentor', 'content': 'Deduct costs', 'evidenceId': 'evidence'}]}
        ticket = {'id': 'request', 'contextHash': 'a'*64, 'context': context,
                  'expiresAt': (datetime.now(timezone.utc)+timedelta(minutes=5)).isoformat(),
                  'model': {'name': settings.model, 'baseUrl': settings.base_url,
                            'engine': 'hermes-rd-v1', 'sourceRevision': PINNED_REVISION}}
        proposer = Mock(return_value={'summary': 'Costs matter', 'application': 'Measure net returns',
                                    'lessonIds': [LESSON], 'checks': ['Deduct costs'], 'risks': ['May not generalise']})
        client = Mock(base='http://127.0.0.1:3000', token='fixture-token')
        client.post.side_effect = [discovery(), ticket, {'authorised': True}, {'recorded': True}, TimeoutError(), {'state': 'awaiting-review'}]
        def runner(*args):
            return run_once(*args, proposer=proposer)
        with tempfile.TemporaryDirectory() as directory:
            args = (client, BODY, 'discovery-one', Path(directory), lambda: settings)
            with self.assertRaises(TimeoutError):
                run_discovered(*args, proposal_runner=runner)
            first = client.post.call_args
            result = run_discovered(*args, proposal_runner=runner)
            self.assertEqual(client.post.call_args, first)
            self.assertEqual(result['state'], 'awaiting-review')
            proposer.assert_called_once()

    def test_invalid_selections_fail_closed(self):
        for value in [discovery([LESSON, LESSON]), discovery(['fabricated']),
                      {**discovery(), 'botId': 'other'}, {**discovery(), 'lessons': []},
                      {**discovery(), 'lessons': [{'id': LESSON, 'author_bot_id': 'student'}]}]:
            with self.assertRaises(HermesError):
                selected_lessons(value, 'student')

    def test_withdrawn_support_does_not_trigger_replacement_discovery(self):
        client = Mock(base='http://127.0.0.1:3000', token='fixture-token')
        client.post.return_value = discovery()
        runner = Mock(side_effect=HermesError('Supporting evidence withdrawn'))
        with tempfile.TemporaryDirectory() as directory:
            for _ in range(2):
                with self.assertRaises(HermesError):
                    run_discovered(client, BODY, 'discovery-one', Path(directory), Mock(), proposal_runner=runner)
        client.post.assert_called_once()
        self.assertEqual(runner.call_args.args[2]['lessonIds'], [LESSON])

    def test_unknown_proposal_response_is_not_recorded_as_success(self):
        client = Mock(base='http://127.0.0.1:3000', token='fixture-token')
        client.post.return_value = discovery()
        runner = Mock(side_effect=[{'state': 'failed'}, {'state': 'awaiting-review'}])
        with tempfile.TemporaryDirectory() as directory:
            args = (client, BODY, 'discovery-one', Path(directory), Mock())
            with self.assertRaisesRegex(HermesError, 'acknowledged'):
                run_discovered(*args, proposal_runner=runner)
            self.assertEqual(run_discovered(*args, proposal_runner=runner)['state'], 'awaiting-review')
        client.post.assert_called_once()


if __name__ == '__main__':
    unittest.main()
