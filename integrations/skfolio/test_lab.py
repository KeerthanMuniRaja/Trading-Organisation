import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd
import lab


def sample():
    rng = np.random.default_rng(42)
    return pd.DataFrame(rng.normal(0.0002, 0.01, (378, 20)),
                        index=pd.date_range('2020-01-01', periods=378),
                        columns=[f'asset{i}' for i in range(20)])


class AcademyTests(unittest.TestCase):
    def test_report_replace_retries_temporary_windows_lock(self):
        with patch.object(Path, 'replace', side_effect=[PermissionError(), None]) as replace, patch('lab.time.sleep'):
            lab.replace_report(Path('temporary'), Path('report'))
            self.assertEqual(replace.call_count, 2)

    def test_flat_market_loses_entry_and_exit_cost(self):
        result = lab.score([.25] * 4, np.zeros((10, 4)), 15)
        self.assertAlmostEqual(result['netReturnBps'], ((1 - .0015) ** 2 - 1) * 10000)
        self.assertAlmostEqual(result['maxDrawdownBps'], -result['netReturnBps'])

    def test_buy_hold_weights_drift_without_hidden_free_rebalance(self):
        result = lab.score([.25] * 4, [[1, -.5, 0, 0], [1, -.5, 0, 0]], 15)
        self.assertAlmostEqual(result['netReturnBps'], (1.5625 * .9985 ** 2 - 1) * 10000)

    def test_rejects_invalid_weights_and_returns(self):
        for weights in ([.5, .2, .2, .1], [float('nan')] * 4, [-.1, .3, .4, .4]):
            with self.assertRaises(ValueError):
                lab.score(weights, np.zeros((10, 4)), 15)
        with self.assertRaises(ValueError):
            lab.score([.25] * 4, [[float('nan')] * 4], 15)

    def test_actual_library_resume_skips_finished_trials(self):
        with tempfile.TemporaryDirectory() as directory, patch('lab.load_returns', return_value=sample()):
            state = Path(directory)
            self.assertEqual(lab.run(state, max_trials=1)['newAttempts'], 1)
            finished = lab.run(state)
            self.assertEqual(finished['status'], 'completed')
            self.assertEqual(finished['completedTrials'], 6)
            self.assertEqual(lab.run(state)['newAttempts'], 0)
            report = json.loads((state / 'report.json').read_text())
            self.assertFalse(report['promotionAllowed'])
            self.assertTrue(all(r['rewardBps'] == 0 for r in report['results'] if r['method'] == 'equal_weight'))
            self.assertTrue(all(r['trainEnd'] < r['testStart'] for r in report['results']))

    def test_future_prices_cannot_change_first_fold_fitted_weights(self):
        original = sample()
        changed = original.copy()
        changed.iloc[252:] += .05
        reports = []
        for data in (original, changed):
            with tempfile.TemporaryDirectory() as directory, patch('lab.load_returns', return_value=data):
                state = Path(directory)
                lab.run(state, max_trials=3)
                reports.append(json.loads((state / 'report.json').read_text())['results'])
        for left, right in zip(*reports):
            np.testing.assert_allclose(left['weights'], right['weights'])
            self.assertNotEqual(left['netReturnBps'], right['netReturnBps'])

    def test_failed_experiments_preserved_and_retry_budget_exhausts(self):
        with tempfile.TemporaryDirectory() as directory, patch('lab.load_returns', return_value=sample()), patch('lab.weights_for', side_effect=ValueError('test fit failure')):
            state = Path(directory)
            self.assertEqual(lab.run(state)['failedAttempts'], 6)
            self.assertEqual(lab.run(state)['failedAttempts'], 12)
            result = lab.run(state)
            self.assertEqual(result['newAttempts'], 0)
            self.assertEqual(result['status'], 'needs_attention')

    def test_crash_is_recorded_on_resume(self):
        with tempfile.TemporaryDirectory() as directory, patch('lab.load_returns', return_value=sample()):
            state = Path(directory)
            plan = lab.run(state, max_trials=1)['planId']
            with sqlite3.connect(state / 'academy.sqlite') as db:
                db.execute("INSERT INTO attempts(plan,trial,started,state) VALUES(?,?,?,'running')", (plan, '000:inverse_volatility', lab.now()))
            db.close()
            result = lab.run(state)
            self.assertEqual(result['status'], 'completed')
            self.assertEqual(result['failedAttempts'], 1)

    def test_second_runner_cannot_acquire_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / 'lock'
            with lab.exclusive_run(lock):
                with self.assertRaises(OSError):
                    with lab.exclusive_run(lock):
                        self.fail('second runner acquired lock')


if __name__ == '__main__':
    unittest.main()
