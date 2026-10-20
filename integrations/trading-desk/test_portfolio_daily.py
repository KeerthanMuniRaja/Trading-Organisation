import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily
import portfolio_daily as pd
from test_daily import synthetic_daily


def universe(drifts=((0.0004, 7), (-0.0003, 11), (0.0001, 23))):
    names = ('RELIANCE.NS', 'INFY.NS', 'ITC.NS')
    return {n: daily.validate(synthetic_daily(n, drift=d, seed=s)) for n, (d, s) in zip(names, drifts)}


class PortfolioTests(unittest.TestCase):
    def setUp(self):
        self.bars = universe()
        self.dates, self.table = pd.aligned(self.bars)

    def run_rule(self, name, start=0, end=None):
        _, fn, once = pd.RULES[name]
        return pd.simulate(self.table, self.dates, fn, start, end if end is not None else len(self.dates) - 1, once=once)

    def test_cash_never_trades_and_buy_and_hold_trades_once_each_way(self):
        self.assertEqual((self.run_rule('cash')['netPaise'], self.run_rule('cash')['fills']), (0, 0))
        held = self.run_rule('buy-and-hold-equal')
        self.assertEqual(held['fills'], 2 * len(self.table))  # one buy and one close-out per share
        self.assertGreater(held['costsPaise'], len(self.table) * daily.DP_PER_SELL_PAISE)
        monthly = self.run_rule('equal-weight-monthly')
        self.assertGreater(monthly['fills'], held['fills'])  # rebalancing trades every month
        self.assertGreater(monthly['costsPaise'], held['costsPaise'])

    def test_weights_are_complete_and_never_exceed_the_portfolio(self):
        for name, (_, fn, _) in pd.RULES.items():
            for i in (0, 100, 300, 900):
                weights = fn(self.table, self.dates, i)
                self.assertLessEqual(sum(weights.values()), 1 + 1e-9, name)
                self.assertTrue(all(w >= 0 for w in weights.values()), name)
                self.assertTrue(set(weights) <= set(self.table), name)

    def test_rules_use_only_completed_days(self):
        altered = {s: [dict(b) for b in bars] for s, bars in self.bars.items()}
        for bars in altered.values():
            for b in bars[700:]:
                b['openPaise'] = b['highPaise'] = b['lowPaise'] = b['closePaise'] = 1
        dates2, table2 = pd.aligned(altered)
        for name, (_, fn, _) in pd.RULES.items():
            for i in range(250, 700, 37):
                self.assertEqual(fn(self.table, self.dates, i), fn(table2, dates2, i), name)

    def test_the_trend_filter_steps_aside_in_a_falling_market(self):
        falling = universe(((-0.0012, 7), (-0.0010, 11), (-0.0011, 23)))
        dates, table = pd.aligned(falling)
        end = len(dates) - 1
        filtered = pd.simulate(table, dates, pd.trend_filtered, 0, end)
        exposed = pd.simulate(table, dates, pd.equal_weight, 0, end)
        self.assertLess(filtered['maxDrawdown'], exposed['maxDrawdown'])
        self.assertGreater(filtered['netPaise'], exposed['netPaise'])

    def test_forward_tests_freeze_the_rules(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache, root = Path(tmp) / 'daily', Path(tmp) / 'forward'
            cache.mkdir()
            for name, bars in self.bars.items():
                data = {'schemaVersion': 1, 'symbol': name, 'interval': '1d', 'priceBasis': 'adjusted', 'source': 'synthetic-test',
                        'bars': bars[:1000]}
                (cache / f'{name}-1d.json').write_text(json.dumps(data), encoding='utf-8')
            record = pd.register('p1', root=root, cache=cache)
            self.assertEqual(pd.forward('p1', root=root, cache=cache)['status'], 'waiting')
            for name, bars in self.bars.items():
                data = {'schemaVersion': 1, 'symbol': name, 'interval': '1d', 'priceBasis': 'adjusted', 'source': 'synthetic-test', 'bars': bars}
                (cache / f'{name}-1d.json').write_text(json.dumps(data), encoding='utf-8')
            running = pd.forward('p1', root=root, cache=cache)
            self.assertEqual(running['status'], 'running')
            self.assertEqual(set(running['results']), set(pd.RULES))
            self.assertEqual(running['results']['cash']['netPaise'], 0)
            self.assertGreater(running['tradingDays'], 200)
            saved = json.loads((root / 'p1.json').read_text(encoding='utf-8'))
            saved['rules'] = 'other'
            (root / 'p1.json').write_text(json.dumps(saved), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'rules changed'):
                pd.forward('p1', root=root, cache=cache)
            self.assertEqual(record['rules'], pd.rules_fingerprint())


if __name__ == '__main__':
    unittest.main()
