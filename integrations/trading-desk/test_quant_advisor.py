import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily
import portfolio_daily as pd
import quant_advisor as qa
from test_daily import synthetic_daily

SYMBOLS = sorted(daily.datasets.UNIVERSE)


class AdvisorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.cache = Path(cls.tmp.name)
        for k, symbol in enumerate(SYMBOLS):
            data = synthetic_daily(symbol, drift=0.0002, seed=11 + k)
            if k == 0:  # one very calm share
                first = data['bars'][0]['closePaise']
                for n, b in enumerate(data['bars']):
                    price = first + (n % 3)
                    b.update(openPaise=price, highPaise=price + 1, lowPaise=price - 1, closePaise=price)
            (cls.cache / f'{symbol}-1d.json').write_text(json.dumps(data), encoding='utf-8')
        cls.all_bars = daily.load(SYMBOLS, cls.cache)
        cls.dates, cls.table = pd.aligned(cls.all_bars)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_weights_are_long_only_capped_and_complete(self):
        w = qa.hrp_weights(self.table, self.dates, 600)
        self.assertEqual(sorted(w), SYMBOLS)
        self.assertAlmostEqual(sum(w.values()), 1.0, places=4)
        self.assertTrue(all(0 <= v <= qa.MAX_WEIGHT + 1e-6 for v in w.values()))
        self.assertAlmostEqual(w[SYMBOLS[0]], qa.MAX_WEIGHT, places=4)  # the calmest share gets the cap
        self.assertEqual(qa.hrp_weights(self.table, self.dates, 100), {})  # no full year yet

    def test_no_look_ahead(self):
        altered = {s: [dict(b) for b in bars] for s, bars in self.all_bars.items()}
        for bars in altered.values():
            for b in bars[601:]:
                b['openPaise'] = b['highPaise'] = b['lowPaise'] = b['closePaise'] = 1
        dates2, table2 = pd.aligned(altered)
        self.assertEqual(qa.advice(self.table, self.dates, 600), qa.advice(table2, dates2, 600))

    def test_momentum_skips_the_latest_month(self):
        s, i = SYMBOLS[3], 700
        expected = round((self.table[s][self.dates[i - 21]]['closePaise'] / self.table[s][self.dates[i - 252]]['closePaise'] - 1) * 100, 1)
        self.assertEqual(qa.momentum_12_1(self.table, self.dates, i, s), expected)
        self.assertIsNone(qa.momentum_12_1(self.table, self.dates, 200, s))

    def test_evaluation_uses_the_shared_simulator(self):
        report = qa.evaluate([self.dates[700]], cache=self.cache, out=self.cache / 'out')
        results = report['periods'][self.dates[700]]
        self.assertEqual(set(results), {'quant-advisor-hrp', 'momentum-12-1-tilt', 'basket-buy-and-hold', 'basket-monthly', 'inverse-volatility'})
        tilt = qa.momentum_tilt(self.table, self.dates, 700)
        self.assertAlmostEqual(sum(tilt.values()), 1.0)
        self.assertEqual(sorted(tilt.values()), [0.0625] * 4 + [0.1875] * 4)
        self.assertEqual(results['basket-monthly'], pd.simulate(self.table, self.dates, pd.equal_weight, 700, len(self.dates) - 1))


if __name__ == '__main__':
    unittest.main()
