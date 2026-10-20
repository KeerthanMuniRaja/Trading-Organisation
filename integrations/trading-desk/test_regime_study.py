import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily
import portfolio_daily as pd
import regime_study as rs
from test_daily import synthetic_daily

SYMBOLS = sorted(daily.datasets.UNIVERSE)


class RegimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cache = Path(cls.tmp.name)
        for k, symbol in enumerate(SYMBOLS):
            (cache / f'{symbol}-1d.json').write_text(json.dumps(synthetic_daily(symbol, drift=0.0003 - 0.0002 * (k % 3), seed=31 + k)), encoding='utf-8')
        cls.dates, cls.table = pd.aligned(daily.load(SYMBOLS, cache))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_regimes_follow_breadth(self):
        self.assertEqual([rs.regime(n) for n in (8, 6, 5, 3, 2, 0)], [rs.REGIMES[0]] * 2 + [rs.REGIMES[1]] * 2 + [rs.REGIMES[2]] * 2)
        i = 500
        expected = sum(self.table[s][self.dates[i]]['closePaise'] > sum(self.table[s][d]['closePaise'] for d in self.dates[i - 199:i + 1]) / 200
                       for s in SYMBOLS)
        self.assertEqual(rs.breadth(self.table, self.dates, i), expected)

    def test_rule_months_are_measured_against_the_same_basket(self):
        rows = rs.monthly_rows(self.table, self.dates, {'basket': pd.equal_weight, 'cash': pd.cash_only})
        self.assertGreater(len(rows), 20)
        for r in rows:
            self.assertAlmostEqual(r['rules']['basket'], r['basketPct'], places=2)  # the basket rule matches the yardstick
            self.assertEqual(r['rules']['cash'], 0)
        summary = rs.summarise(rows)
        self.assertEqual(summary['basket']['all months']['ahead'] + summary['basket']['all months']['behind'], 0)
        self.assertEqual(sum(summary['cash'][label]['months'] for label in rs.REGIMES), len(rows))


if __name__ == '__main__':
    unittest.main()
