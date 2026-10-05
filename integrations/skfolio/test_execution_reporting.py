import json
import sqlite3
import unittest
from execution_reporting import publish_execution


class Client:
    def __init__(self):
        self.calls = []
        self.fail = False

    def post(self, path, body, key):
        self.calls.append((path, body, key))
        if self.fail:
            raise OSError('private transport details')
        return {'experimentId': body['experimentId'], 'lastSequence': body['events'][-1]['sequence']}


class ReportingTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.executescript('''CREATE TABLE job(id INTEGER PRIMARY KEY,work TEXT);
          CREATE TABLE attempts(id INTEGER PRIMARY KEY,arm TEXT,state TEXT,error TEXT);
          CREATE TABLE events(id INTEGER PRIMARY KEY,kind TEXT);''')
        self.work = dict(experimentId='experiment', planHash='a'*64, baselineHash='b'*64, candidateHash='c'*64)
        self.db.execute('INSERT INTO job VALUES(1,?)', (json.dumps(self.work),))
        self.client = Client()

    def publish(self):
        return publish_execution(self.db, self.client, 'trusted-local-process-only')

    def test_lost_ack_replays_stable_key_then_delivers_new_suffix(self):
        self.db.execute("INSERT INTO attempts VALUES(1,'baseline','running',NULL)")
        self.client.fail = True
        self.assertEqual(self.publish()['pending'], 1)
        first = self.client.calls[-1]
        self.assertEqual(self.publish()['pending'], 1)
        self.assertEqual(self.client.calls[-1], first)
        self.db.execute("UPDATE attempts SET state='completed'")
        self.client.fail = False
        self.assertTrue(self.publish()['reported'])
        self.assertEqual([e['sequence'] for e in self.client.calls[-1][1]['events']], [1, 2])
        count = len(self.client.calls)
        self.publish()
        self.assertEqual(len(self.client.calls), count)
        self.db.execute("INSERT INTO events VALUES(1,'submission-confirmed')")
        self.publish()
        self.assertEqual([e['sequence'] for e in self.client.calls[-1][1]['events']], [3])

    def test_retry_cleanup_and_submission_codes_exclude_raw_error_details(self):
        self.db.executemany('INSERT INTO attempts VALUES(?,?,?,?)', [
            (1, 'baseline', 'interrupted', 'ProcessInterrupted'),
            (2, 'baseline', 'completed', None),
            (3, 'candidate', 'failed', 'SandboxCleanupError'),
            (4, 'candidate', 'failed', 'private path and secret')])
        self.db.executemany('INSERT INTO events VALUES(?,?)', [(1, 'submission-unconfirmed'), (2, 'submission-unconfirmed'), (3, 'submission-confirmed')])
        self.publish()
        body = self.client.calls[-1][1]
        self.assertNotIn('private', json.dumps(body))
        self.assertEqual([e['code'] for e in body['events']], ['NONE', 'INTERRUPTED', 'NONE', 'NONE', 'NONE', 'CLEANUP_UNCONFIRMED', 'NONE', 'EXECUTION_FAILED', 'SUBMISSION_UNCONFIRMED', 'NONE'])
        self.assertEqual(body['events'][6]['attempt'], 2)

    def test_mismatched_ack_retains_durable_pending_events(self):
        self.db.execute("INSERT INTO attempts VALUES(1,'baseline','failed','TimeoutError')")
        self.client.post = lambda *args: {'experimentId': 'wrong', 'lastSequence': 100}
        self.assertEqual(self.publish(), {'pending': 2, 'reported': False})
        self.assertEqual(self.db.execute('SELECT sum(delivered) FROM execution_outbox').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
