from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid

from artifact_executor import run_verified_pair
from artifact_recovery import recover
from test_artifact_executor import artifact, FakeClient


class ReportingClient(FakeClient):
    def post(self, route, body, key):
        if route.endswith('/execution-reports'):
            self.calls.append(route)
            return {'experimentId': body['experimentId'], 'lastSequence': body['events'][-1]['sequence']}
        return super().post(route, body, key)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.a, self.b = artifact(self.root, 'baseline'), artifact(self.root, 'candidate')
        self.state = self.root / 'state'
        self.experiment = str(uuid.uuid4())
        self.client = ReportingClient(self.experiment, self.a, self.b, lose=True)

    def lost(self):
        with self.assertRaises(OSError):
            run_verified_pair(self.client, self.experiment, self.a, self.b, self.state, trusted_local=True)
        return next(self.state.glob('*.sqlite')).stem

    def test_replay_without_artifacts_or_original_runtime_then_only_report_on_replay(self):
        journal = self.lost()
        self.a.rename(self.a.with_suffix('.removed'))
        self.b.rename(self.b.with_suffix('.removed'))
        with closing(sqlite3.connect(self.state / (journal + '.sqlite'))) as db:
            binding = json.loads(db.execute('SELECT binding FROM job').fetchone()[0])
            binding['executorHash'] = 'old-runtime'
            db.execute('UPDATE job SET binding=?', (json.dumps(binding),))
            db.commit()
        with patch('artifact_executor.execute_artifact', side_effect=AssertionError('no execution')):
            result = recover(self.client, journal, self.state)
            self.assertEqual(result['status'], 'submitted')
            self.assertEqual(result['executionReporting'], {'pending': 0, 'reported': True})
            self.assertEqual(result['executedArtifacts'], 0)
            count = len(self.client.calls)
            self.assertEqual(recover(self.client, journal, self.state)['status'], 'already-submitted')
            self.assertEqual(len(self.client.calls), count)
        with closing(sqlite3.connect(self.state / (journal + '.sqlite'))) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM attempts').fetchone()[0], 2)

    def test_wrong_scope_and_path_are_rejected_before_contact(self):
        journal = self.lost()
        count = len(self.client.calls)
        self.client.token += 'other'
        with self.assertRaisesRegex(ValueError, 'identity'):
            recover(self.client, journal, self.state)
        with self.assertRaises(ValueError):
            recover(self.client, '../' + journal, self.state)
        self.assertEqual(len(self.client.calls), count)

    def test_missing_payload_can_report_but_cannot_execute(self):
        self.client.lose = False
        with patch('artifact_executor.execute_artifact', side_effect=TimeoutError()):
            with self.assertRaises(TimeoutError):
                run_verified_pair(self.client, self.experiment, self.a, self.b, self.state, trusted_local=True)
        journal = next(self.state.glob('*.sqlite')).stem
        with self.assertRaisesRegex(ValueError, 'cannot execute'):
            recover(self.client, journal, self.state)
        result = recover(self.client, journal, self.state, report_only=True)
        self.assertEqual(result['status'], 'reports-only')
        self.assertEqual(result['executionReporting'], {'pending': 0, 'reported': True})
        self.assertIsNone(self.client.saved)

    def test_changed_payload_rejected_and_failed_resubmission_keeps_saved_body(self):
        journal = self.lost()
        self.client.lose = True
        with self.assertRaises(OSError):
            recover(self.client, journal, self.state)
        with closing(sqlite3.connect(self.state / (journal + '.sqlite'))) as db:
            self.assertIsNone(db.execute('SELECT response FROM job').fetchone()[0])
            body = json.loads(db.execute('SELECT payload FROM job').fetchone()[0])
            body['candidateHash'] = 'd' * 64
            db.execute('UPDATE job SET payload=?', (json.dumps(body),))
            db.commit()
        count = len(self.client.calls)
        with self.assertRaisesRegex(ValueError, 'identity'):
            recover(self.client, journal, self.state)
        self.assertEqual(len(self.client.calls), count)


if __name__ == '__main__':
    unittest.main()
