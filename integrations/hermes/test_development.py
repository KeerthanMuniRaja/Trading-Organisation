from datetime import datetime, timedelta, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

import adapter
import development_worker as development


def context():
    return {'datasetId': 'target', 'method': 'equal_weight', 'beforeTrainingEnd': '2021-01-01T00:00:00Z',
            'memories': [{'id': 'memory-one', 'content': 'One example observation only.'}], 'existingCapabilities': []}


def proposal():
    return {'specialty': 'regime-research', 'method': 'equal_weight', 'hypothesis': 'Evaluate unseen regimes',
            'expectedContribution': 'Measure stability', 'risks': ['Example observations may not generalise'], 'memoryIds': ['memory-one']}


class DevelopmentTests(unittest.TestCase):
    def test_proposal_contract_refuses_tools_wrong_methods_and_invented_memory(self):
        valid = proposal()
        self.assertEqual(adapter.validate_capability(valid, context()), valid)
        for bad in ({**valid, 'shell': 'command'}, {**valid, 'method': 'momentum'},
                    {**valid, 'memoryIds': ['invented']}, {**valid, 'risks': []}):
            with self.assertRaises(adapter.HermesError):
                adapter.validate_capability(bad, context())

    def test_lost_submission_response_reuses_exact_proposal_without_another_model_call(self):
        settings = adapter.Settings(Path('/source'), Path('/python'), 'model', 'http://127.0.0.1:8000/v1', 'local-placeholder')
        ticket = {'id': 'request', 'contextHash': 'a'*64, 'context': context(),
                  'expiresAt': (datetime.now(timezone.utc)+timedelta(seconds=180)).isoformat(),
                  'model': {'name': settings.model, 'baseUrl': settings.base_url, 'sourceRevision': adapter.PINNED_REVISION, 'engine': 'hermes-rd-v1'}}
        client = Mock(base='http://127.0.0.1:3000', token='researcher-token')
        client.post.side_effect = [ticket, {'authorised': True}, {'recorded': True}, TimeoutError('lost response')]
        proposer = Mock(return_value=proposal())
        with tempfile.TemporaryDirectory() as directory:
            args = (client, settings, 'target', 'equal_weight', 'stable-request', Path(directory))
            with self.assertRaises(TimeoutError):
                development.run_once(*args, proposer=proposer)
            first = client.post.call_args
            client.post.side_effect = [{'id': 'request', 'state': 'awaiting-review'}]
            development.run_once(*args, proposer=proposer)
            self.assertEqual(first, client.post.call_args)
            proposer.assert_called_once()
            report = client.post.call_args_list[2]
            self.assertEqual(report.args[0], '/v1/development/inference-reports')
            self.assertEqual((report.args[1]['outcome'], report.args[1]['promptVersion']), ('completed', '788c3a60a187ca80'))

    def test_uncertain_inference_is_not_automatically_regenerated(self):
        settings = adapter.Settings(Path('/source'), Path('/python'), 'model', 'http://127.0.0.1:8000/v1', 'local-placeholder')
        ticket = {'id': 'request', 'contextHash': 'b'*64, 'context': context(),
                  'expiresAt': (datetime.now(timezone.utc)+timedelta(seconds=180)).isoformat(),
                  'model': {'name': settings.model, 'baseUrl': settings.base_url, 'sourceRevision': adapter.PINNED_REVISION, 'engine': 'hermes-rd-v1'}}
        client = Mock(base='http://127.0.0.1:3000', token='researcher-token')
        client.post.side_effect = [ticket, {'authorised': True}, {'recorded': True}]
        proposer = Mock(side_effect=RuntimeError('provider outcome unknown'))
        with tempfile.TemporaryDirectory() as directory:
            args = (client, settings, 'target', 'equal_weight', 'stable-request', Path(directory))
            with self.assertRaises(RuntimeError):
                development.run_once(*args, proposer=proposer)
            failed = client.post.call_args_list[2].args[1]
            self.assertEqual((failed['outcome'], failed['failureCode']), ('failed', 'INFERENCE_FAILED'))
            with self.assertRaisesRegex(adapter.HermesError, 'uncertain'):
                development.run_once(*args, proposer=proposer)
            proposer.assert_called_once()
            self.assertEqual(client.post.call_count, 3)  # the acknowledged failure report is not resent


if __name__ == '__main__':
    unittest.main()
