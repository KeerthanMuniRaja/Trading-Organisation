from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch
import desk_learning as dl
import export_evidence
from test_desk import StubModel, synthetic

NOW = datetime(2026, 1, 20, tzinfo=timezone.utc)
CONFIG = {'sourceId': 'desk-replay', 'batches': ['b1'], 'bots': {'trend-analyst': 'org-trend', 'portfolio-manager': 'org-pm'}}


class FakeBackend:
    """The real routes' rules: roles, content dedupe, author != reviewer, verified evidence for lessons, idempotent retries."""

    def __init__(self):
        self.evidence, self.lessons, self.done, self.mutations = {}, {}, {}, []

    def api(self, role):
        def call(method, route, body=None):
            if method == 'POST':
                key = (role, route, json.dumps(body, sort_keys=True))
                if key not in self.done:
                    self.mutations.append((role, route))
                    self.done[key] = self.handle(role, route, body)
                return self.done[key]
            return self.handle(role, route, body)
        return call

    def handle(self, role, route, body):
        if route == '/v1/evidence':
            assert role == 'researcher' and body['kind'] == 'dataset'
            for e in self.evidence.values():
                if e['content'] == body['content']:
                    return {'id': e['id'], 'status': e['status']}
            evidence_id = f'ev-{len(self.evidence) + 1}'
            self.evidence[evidence_id] = {**body, 'id': evidence_id, 'status': 'unverified', 'author': role}
            return {'id': evidence_id, 'status': 'unverified'}
        if route == '/v1/evidence/reviews':
            e = self.evidence[body['evidenceId']]
            assert role == 'evaluator' and e['author'] != role and e['status'] == 'unverified'
            e['status'] = body['status']
            return body
        if route == '/v1/lessons':
            assert role == 'researcher' and self.evidence[body['evidenceId']]['status'] == 'verified'
            lesson_id = f'lesson-{len(self.lessons) + 1}'
            self.lessons[lesson_id] = {**body, 'id': lesson_id, 'status': 'unverified', 'author': role}
            return {'id': lesson_id, 'status': 'unverified'}
        if route == '/v1/lessons/reviews':
            lesson = self.lessons[body['lessonId']]
            assert role == 'evaluator' and lesson['author'] != role and self.evidence[lesson['evidenceId']]['status'] == 'verified'
            lesson['status'] = 'verified'
            return {'id': lesson['id'], 'status': 'verified'}
        if route == '/v1/evidence/revocations':
            assert role == 'evaluator'
            self.evidence[body['targetId']]['status'] = 'revoked'
            return {'id': body['targetId']}
        if route == '/v1/knowledge':
            verified = {i for i, e in self.evidence.items() if e['status'] == 'verified'}
            return {'evidence': [{'id': i, 'content': self.evidence[i]['content']} for i in verified],
                    'lessons': [{'id': l['id'], 'bot_id': l['botId'], 'content': l['content'], 'evidence_id': l['evidenceId']}
                                for l in self.lessons.values() if l['status'] == 'verified' and l['evidenceId'] in verified]}
        raise AssertionError(route)


class DeskLearningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.original = dl.BATCHES
        dl.BATCHES = root / 'batches'
        self.state = root / 'state'
        paths = []
        for k, (drift, day) in enumerate((((3, -2, 4), 5), ((-2, 3, -1), 12))):
            path = root / f'w{k}.json'
            path.write_text(json.dumps(synthetic(drift=drift, start_day=day)), encoding='utf-8')
            paths.append(path)
        batch.run_batch(paths, StubModel(), dl.BATCHES / 'b1', every=12, max_decisions=12, max_calls=200, model='stub')

    def tearDown(self):
        dl.BATCHES = self.original
        self.tmp.cleanup()

    def cycle(self, backend, until=None):
        out = {'report': dl.desk_report(backend.api('researcher'), self.state, CONFIG)}
        if until == 'report':
            return out
        out['evidence'] = dl.desk_verify_evidence(backend.api('evaluator'), self.state, CONFIG, NOW)
        out['lessons'] = dl.desk_lessons(backend.api('researcher'), self.state, CONFIG)
        out['review'] = dl.desk_verify_lessons(backend.api('evaluator'), self.state, CONFIG, NOW)
        return out

    def test_recomputation_reproduces_every_reported_number(self):
        windows = list(dl.windows(CONFIG))
        self.assertEqual(len(windows), 2)
        for _, row, decisions in windows:
            own = dl.recompute(row, decisions)['row']
            for field in ('deskNetPaise', 'deskTrades', 'momentumNetPaise', 'momentumTrades', 'buyAndHoldPaise', 'from', 'to', 'bars'):
                self.assertEqual(own[field], row[field], field)
            self.assertEqual(own['scorecards']['portfolioManager'], row['scorecards']['portfolioManager'])
            self.assertEqual(dl.recompute(row, decisions)['content'], export_evidence.evidence_text(row))

    def test_desk_results_become_verified_lessons_automatically(self):
        backend = FakeBackend()
        out = self.cycle(backend)
        self.assertEqual(out['report'], {'reported': 2})
        self.assertEqual((out['evidence']['verified'], out['evidence']['rejected']), (2, 0))
        self.assertEqual((out['lessons']['proposed'], out['review']['verified']), (4, 4))
        knowledge = backend.handle('evaluator', '/v1/knowledge', None)
        self.assertEqual({l['bot_id'] for l in knowledge['lessons']}, {'org-trend', 'org-pm'})
        self.assertTrue(all(l['content'].startswith('Your past') for l in knowledge['lessons']))
        writes = len(backend.mutations)
        again = self.cycle(backend)
        self.assertEqual((again['report']['reported'], again['lessons']['proposed']), (0, 0))
        self.assertEqual(len(backend.mutations), writes)

    def test_a_misreported_result_is_rejected_and_teaches_nothing(self):
        row_path = next(p for p in (dl.BATCHES / 'b1').glob('*.json') if p.name != 'summary.json' and not p.name.endswith('.decisions.json'))
        row = json.loads(row_path.read_text(encoding='utf-8'))
        row['deskNetPaise'] += 100_000  # a report claiming Rs 1,000 more profit than the decisions produced
        row_path.write_text(json.dumps(row), encoding='utf-8')
        backend = FakeBackend()
        out = self.cycle(backend)
        self.assertEqual((out['evidence']['verified'], out['evidence']['rejected']), (1, 1))
        self.assertEqual(out['lessons']['proposed'], 2)  # only the honest week teaches its bots
        rejected = [e for e in backend.evidence.values() if e['status'] == 'rejected']
        self.assertEqual(len(rejected), 1)
        self.assertIn(str(row['deskNetPaise']), rejected[0]['content'])

    def test_stored_evidence_that_differs_from_the_recomputation_is_revoked(self):
        backend = FakeBackend()
        self.cycle(backend, until='report')
        first = next(iter(backend.evidence.values()))
        first['content'] = first['content'].replace('Desk net after modelled costs', 'Desk net (guaranteed)')
        out = dl.desk_verify_evidence(backend.api('evaluator'), self.state, CONFIG, NOW)
        self.assertEqual((out['verified'], out['revoked']), (2, 1))
        self.assertEqual(first['status'], 'revoked')

    def test_configuration_is_validated(self):
        path = Path(self.tmp.name) / 'c.json'
        for bad in ({}, {**CONFIG, 'bots': {'cfo': 'x'}}, {**CONFIG, 'batches': ['../x']}, {**CONFIG, 'extra': 1}):
            path.write_text(json.dumps(bad), encoding='utf-8')
            with self.assertRaises(ValueError):
                dl.load_config(path)
        path.write_text(json.dumps(CONFIG), encoding='utf-8')
        self.assertEqual(dl.load_config(path), CONFIG)


if __name__ == '__main__':
    unittest.main()
