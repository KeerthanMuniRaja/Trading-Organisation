import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_allocator as ai
import allocator_review as review
from test_ai_allocator import SYMBOLS, Stub
from test_daily import synthetic_daily

HALF = {**{k: 6 for k in ai.LETTERS}, 'rationale': 'Half in cash.'}  # 48% invested


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name) / 'daily'
        self.cache.mkdir()
        for k, symbol in enumerate(SYMBOLS):
            data = synthetic_daily(symbol, drift=0.0006, seed=5 + k)
            (self.cache / f'{symbol}-1d.json').write_text(json.dumps(data), encoding='utf-8')
        self.root = Path(self.tmp.name) / 'runs'
        ai.replay('r1', Stub(HALF), 'stub', '2024-06-03', cache=self.cache, root=self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_gap_splits_exactly_into_cash_drag_and_selection(self):
        result = review.review('r1', cache=self.cache, root=self.root)
        for row in result['months']:
            self.assertAlmostEqual(row['modelPct'] - row['basketPct'], row['cashDragPct'] + row['selectionPct'], delta=0.02)
            self.assertEqual(row['cashPct'], 52.0)
        self.assertLess(result['summary']['averageCashDragPct'], 0)  # rising market: idle cash costs return
        self.assertAlmostEqual(result['summary']['averageSelectionPct'], 0, delta=0.02)  # equal tilts select nothing

    def test_fully_investing_equal_picks_matches_the_monthly_rebalanced_basket(self):
        import daily
        import portfolio_daily as pd
        result = review.fully_invested('r1', cache=self.cache, root=self.root)
        self.assertLess(result['modelAsDecided']['netPaise'], result['modelFullyInvested']['netPaise'])
        dates, table = pd.aligned(daily.load(SYMBOLS, self.cache))
        start = next(k for k, d in enumerate(dates) if d >= '2024-06-03')
        monthly = pd.simulate(table, dates, pd.equal_weight, start, len(dates) - 1)
        self.assertEqual(result['modelFullyInvested']['netPaise'], monthly['netPaise'])  # same weights, same trades

    def test_teacher_answers_use_the_same_arithmetic_and_make_training_records(self):
        teacher = {f'{n:02d}': {**{k: 12 for k in ai.LETTERS}, 'rationale': 'Even.'} for n in range(1, 40)}
        teacher['01']['A'] = 30  # invalid: over the cap, so that month is ignored rather than guessed
        result = review.review('r1', teacher, cache=self.cache, root=self.root)
        self.assertGreater(result['summary']['teacher']['months'], 5)
        simulated = review.teacher_simulation('r1', teacher, cache=self.cache, root=self.root)
        self.assertGreater(simulated['netPaise'], 0)
        records = review.training_records('r1', teacher, result, root=self.root)
        self.assertTrue(records)
        self.assertEqual(set(records[0]), {'brief', 'teacher', 'model', 'nextMonth'})
        self.assertNotIn('2024', json.dumps(records[0]['brief']))  # no dates leak into training data


if __name__ == '__main__':
    unittest.main()
