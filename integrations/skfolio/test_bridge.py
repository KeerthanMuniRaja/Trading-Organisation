import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import bridge
from test_lab import sample


def payload():
    frame = sample().iloc[:60].copy()
    frame.columns = [f'A{i}' for i in range(20)]
    return {"datasetId": "example-id", "datasetDigest": "a" * 64,
            "assets": list(frame.columns), "training": [
                {"timestamp": date.isoformat() + 'Z', "returns": row.tolist()}
                for date, row in frame.iterrows()], "purpose": "example-testing",
            "costBps": 15, "weightCap": .25, "methods": list(bridge.METHODS)}


class BridgeTests(unittest.TestCase):
    def test_rejects_holdout_policy_drift_and_nonchronological_input(self):
        valid = payload()
        for changed in ({**valid, 'holdout': []}, {**valid, 'costBps': 0}):
            with self.assertRaises(ValueError):
                bridge.training_frame(changed)
        changed = copy.deepcopy(valid)
        changed['training'][1]['timestamp'] = changed['training'][0]['timestamp']
        with self.assertRaises(ValueError):
            bridge.training_frame(changed)

    def test_lost_response_reuses_saved_weights_and_exact_key_without_refitting(self):
        client = Mock(base='http://127.0.0.1:3000')
        valid = payload()
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            client.post.side_effect = [valid, TimeoutError('lost response')]
            with self.assertRaises(TimeoutError):
                bridge.submit(client, 'student', valid['datasetId'], 'inverse_volatility', state)
            first_submission = client.post.call_args
            client.post.side_effect = [valid, {'id': 'trial', 'state': 'submitted'}]
            with patch('bridge.weights_for', side_effect=AssertionError('must not refit')):
                bridge.submit(client, 'student', valid['datasetId'], 'inverse_volatility', state)
            self.assertEqual(first_submission, client.post.call_args)
            saved = json.loads(next(state.glob('*.json')).read_text())
            self.assertNotIn('holdout', saved['body'])
            self.assertNotIn('report', saved['body'])

    def test_reviewer_sends_only_trial_identity(self):
        client = Mock()
        bridge.review(client, 'trial')
        first = client.post.call_args
        bridge.review(client, 'trial')
        self.assertEqual(client.post.call_args, first)
        self.assertEqual(first.args[1], {'trialId': 'trial'})

    def test_reclaimed_assignment_reuses_fit_with_a_new_lease_receipt(self):
        client = Mock(base='http://127.0.0.1:3000')
        valid = payload()
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            client.post.side_effect = [valid, {'id': 'trial'}]
            bridge.submit(client, 'student', valid['datasetId'], 'inverse_volatility', state,
                          assignment={'id': 'assignment', 'leaseToken': 'first-lease'})
            first = client.post.call_args
            client.post.side_effect = [valid, {'id': 'trial'}]
            with patch('bridge.weights_for', side_effect=AssertionError('must reuse fit')):
                bridge.submit(client, 'student', valid['datasetId'], 'inverse_volatility', state,
                              assignment={'id': 'assignment', 'leaseToken': 'second-lease'})
            second = client.post.call_args
            self.assertEqual(first.args[1]['weights'], second.args[1]['weights'])
            self.assertNotEqual(first.args[2], second.args[2])
            self.assertEqual(second.args[1]['assignment']['leaseToken'], 'second-lease')


if __name__ == '__main__':
    unittest.main()
