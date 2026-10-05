from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
import uuid

from artifact_executor import digest
from artifact_inspection import inspect_journal, list_journals


class InspectionTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.client = SimpleNamespace(base='http://127.0.0.1:39999', token='private-token', post=Mock(side_effect=AssertionError('no network')))
        self.experiment = str(uuid.uuid4())
        binding = {'origin': self.client.base, 'credentialHash': hashlib.sha256(self.client.token.encode()).hexdigest(), 'experimentId': self.experiment}
        self.journal = digest(binding)
        self.path = self.root / (self.journal + '.sqlite')
        with closing(sqlite3.connect(self.path)) as db:
            db.executescript('''CREATE TABLE job(id INTEGER PRIMARY KEY,binding TEXT,work TEXT,payload TEXT,response TEXT);
                CREATE TABLE attempts(id INTEGER PRIMARY KEY,arm TEXT,state TEXT,error TEXT);''')
            db.execute('INSERT INTO job VALUES(1,?,?,?,NULL)', (json.dumps(binding), 'private work', 'private payload'))
            db.execute("INSERT INTO attempts VALUES(1,'baseline','running','private-error')")
            db.commit()

    def test_read_only_snapshot_excludes_secrets_and_does_not_infer_liveness(self):
        before = self.path.read_bytes()
        files = sorted(p.name for p in self.root.iterdir())
        result = inspect_journal(self.client, self.journal, self.root)
        self.assertEqual(result['localStatus'], 'submission-saved-unconfirmed')
        self.assertEqual(result['nextAction'], 'recover-saved-submission')
        self.assertEqual(result['arms']['baseline']['lastRecordedState'], 'running')
        self.assertEqual(result['liveness'], 'not-established')
        self.assertIsNone(result['queuedReports'])
        self.assertNotIn('private', json.dumps(result))
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), files)
        self.client.post.assert_not_called()

    def test_pending_reports_and_saved_ack_are_separate_local_observations(self):
        with closing(sqlite3.connect(self.path)) as db:
            db.executescript('CREATE TABLE execution_outbox(delivered INTEGER); INSERT INTO execution_outbox VALUES(0),(0),(1);')
            db.execute("UPDATE job SET response='private acknowledgement'")
            db.commit()
        result = inspect_journal(self.client, self.journal, self.root)
        self.assertEqual(result['localStatus'], 'acknowledgement-saved')
        self.assertEqual(result['queuedReports'], 2)
        self.assertEqual(result['backendStatus'], 'not-queried')
        self.assertFalse(result['verifiedExecution'])

    def test_scope_mismatch_and_corrupt_database_do_not_disclose_contents_or_abort_listing(self):
        self.client.token = 'other'
        with self.assertRaisesRegex(ValueError, 'identity'):
            inspect_journal(self.client, self.journal, self.root)
        (self.root / ('a' * 64 + '.sqlite')).write_text('private corrupted content')
        (self.root / 'private-filename.sqlite').write_text('not a generated journal')
        result = list_journals(self.client, self.root)
        self.assertEqual(len(result['journals']), 2)
        self.assertTrue(all(r['localStatus'] == 'unavailable' for r in result['journals']))
        self.assertNotIn('private', json.dumps(result))
        with self.assertRaises(ValueError):
            inspect_journal(self.client, '../escape', self.root)

    def test_missing_directory_does_not_create_state_and_listing_is_capped(self):
        missing = self.root / 'missing'
        self.assertEqual(list_journals(self.client, missing), {'journals': [], 'truncated': False})
        self.assertFalse(missing.exists())
        for n in range(101):
            (self.root / (f'{n:064x}' + '.sqlite')).write_bytes(b'')
        result = list_journals(self.client, self.root)
        self.assertTrue(result['truncated'])
        self.assertEqual(len(result['journals']), 100)

    def test_incomplete_work_is_never_presented_as_a_saved_submission(self):
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('UPDATE job SET payload=NULL')
            db.commit()
        result = inspect_journal(self.client, self.journal, self.root)
        self.assertEqual(result['localStatus'], 'work-incomplete')
        self.assertEqual(result['nextAction'], 'review-original-run')


if __name__ == '__main__':
    unittest.main()
