from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rnd_forward as rf
import rnd_scout

OCT = datetime(2026, 10, 29, 12, tzinfo=timezone.utc)


def candidate(name, excess, served=None, p=0.2):
    return {'name': name, 'description': name, 'alreadyServedBy': served, 'averageExcessPct': excess, 'months': 100, 'ahead': 55,
            'behind': 45, 'pValue': p}


REPORT = {'through': '2026-09', 'candidates': [candidate('momentum-6m-top3', 0.3, served='momentum-rules', p=0.05),  # the live bot has it
                                               candidate('low-volatility-top3', -0.1, p=0.08),                   # behind the basket
                                               candidate('reversal-1m-bottom3', 0.2, p=0.1),
                                               candidate('momentum-3m-top2', 0.1, p=0.3)]}


def rows(excess_by_month, name='reversal-1m-bottom3'):
    return lambda n, rule: [{'month': m, 'basketPct': 1.0, 'rules': {name: 1.0 + e}} for m, e in excess_by_month]


class ForwardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root, self.ledger = Path(self.tmp.name) / 'forward', Path(self.tmp.name) / 'no-ledger.jsonl'

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_best_unserved_idea_ahead_of_the_basket_is_registered_once_a_month(self):
        first = rf.register_monthly(REPORT, self.root, OCT, self.ledger)
        self.assertEqual((first['outcome'], first['name'], first['firstMonth']), ('registered', '2026-10-reversal-1m-bottom3', '2026-11'))
        self.assertEqual(rf.register_monthly(REPORT, self.root, OCT, self.ledger)['outcome'], 'already-this-month')
        nov = rf.register_monthly(REPORT, self.root, datetime(2026, 11, 3, tzinfo=timezone.utc), self.ledger)
        self.assertEqual(nov['name'], '2026-11-momentum-3m-top2')  # the next one; never the served or the losing idea
        self.assertEqual(rf.register_monthly(REPORT, self.root, datetime(2026, 12, 3, tzinfo=timezone.utc), self.ledger)['outcome'], 'no-candidate')
        record = json.loads((self.root / '2026-10-reversal-1m-bottom3.json').read_text(encoding='utf-8'))
        self.assertEqual((record['criterion'], record['seen']['through']), ({'months': 24, 'tStatAtLeast': 2.5, 'averageExcessPctAbove': 0}, '2026-09'))

    def test_slots_are_limited_and_a_finished_test_frees_its_slot(self):
        many = {'through': '2026-09', 'candidates': [candidate(f'momentum-{m}m-top{k}', 0.1) for m in (3, 6, 12) for k in (2, 3, 4)]}
        for month in range(1, rf.MAX_LIVE + 1):
            self.assertEqual(rf.register_monthly(many, self.root, datetime(2027, month, 2, tzinfo=timezone.utc), self.ledger)['outcome'], 'registered')
        june = datetime(2027, rf.MAX_LIVE + 1, 2, tzinfo=timezone.utc)
        self.assertEqual(rf.register_monthly(many, self.root, june, self.ledger)['outcome'], 'full')
        self.assertEqual(rf.register_monthly(many, self.root, june, self.ledger, finished=['2027-01-momentum-3m-top2'])['outcome'], 'registered')

    def test_only_months_after_registration_count_and_the_verdict_waits_for_the_horizon(self):
        rf.register_monthly(REPORT, self.root, OCT, self.ledger)
        record = rf.registrations(self.root)[0]
        self.assertEqual(rf.judge(record, rows([('2026-09', 5.0), ('2026-10', 5.0)]), self.ledger)['status'], 'waiting')  # seen months never count
        months = [f'{2026 + (10 + k) // 12}-{(10 + k) % 12 + 1:02d}' for k in range(30)]   # 2026-11 onwards
        running = rf.judge(record, rows([(m, 0.5) for m in months[:6]]), self.ledger)
        self.assertEqual((running['status'], running['monthsJudged']), ('running', 6))
        steady = rf.judge(record, rows([(m, 1.0 if k % 4 else -0.5) for k, m in enumerate(months)]), self.ledger)
        self.assertEqual((steady['status'], steady['monthsJudged']), ('passed', 24))  # later months are not looked at
        noisy = rf.judge(record, rows([(m, 3.0 if k % 2 else -2.8) for k, m in enumerate(months)]), self.ledger)
        self.assertEqual(noisy['status'], 'failed')  # ahead on average, but not convincingly

    def test_a_changed_rule_ends_the_test(self):
        rf.register_monthly(REPORT, self.root, OCT, self.ledger)
        record = rf.registrations(self.root)[0]
        with mock.patch.object(rnd_scout, 'code_fingerprint', return_value='changed'):
            self.assertEqual(rf.judge(record, rows([]), self.ledger)['status'], 'ended')

    def test_the_daily_run_judges_registers_and_reports(self):
        summary = rf.run(self.root, now=OCT, ledger_path=self.ledger, report=REPORT, rows_for=rows([('2026-11', 1.0)]))
        self.assertEqual((summary['registration']['outcome'], summary['running'], summary['passed']), ('registered', 1, []))
        self.assertEqual(json.loads((self.root / 'reports' / 'latest.json').read_text(encoding='utf-8'))['tests'][0]['status'], 'running')

    def test_a_new_idea_in_the_ledger_does_not_end_running_tests(self):
        before = rnd_scout.code_fingerprint()
        ledger = Path(self.tmp.name) / 'ledger.jsonl'
        ledger.write_text(json.dumps({'name': 'idea-x', 'hash': 'abc', 'spec': {'family': 'momentum', 'months': 9, 'keep': 3},
                                      'proposer': 'test'}) + '\n', encoding='utf-8')
        self.assertEqual(rnd_scout.code_fingerprint(), before)
        self.assertNotEqual(rnd_scout.fingerprint(ledger), rnd_scout.fingerprint(self.ledger))  # the scout's own bar still counts it


if __name__ == '__main__':
    unittest.main()
