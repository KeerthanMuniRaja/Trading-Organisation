from datetime import date, timedelta
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import factor_lab as fl


def universe(shares=60, years=6, persistent=0.0, seed=7):
    """Synthetic daily bars. With `persistent` > 0 each share has its own lasting drift (some always rise faster), so
    past winners keep winning: momentum is real. With 0 the moves are pure noise."""
    rng = random.Random(seed)
    days, day = [], date(2016, 1, 4)
    while len(days) < 252 * years:
        if day.weekday() < 5:
            days.append(day.isoformat())
        day += timedelta(days=1)
    out = {}
    for k in range(shares):
        drift = persistent * (k / shares - 0.5)
        price, bars = 100_000.0, []
        for d in days:
            open_ = price
            price *= 1 + drift + rng.gauss(0, 0.015)
            bars.append({'date': d, 'openPaise': round(open_), 'highPaise': round(max(open_, price)), 'lowPaise': round(min(open_, price)),
                         'closePaise': round(price), 'volume': 1000})
        out[f'S{k:02d}.NS'] = bars
    return out


class FactorLabTests(unittest.TestCase):
    def test_rank_correlation(self):
        self.assertAlmostEqual(fl.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1.0)
        self.assertAlmostEqual(fl.spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1.0)
        self.assertAlmostEqual(fl.spearman([1, 1, 2, 2], [1, 1, 2, 2]), 1.0)  # ties share a rank
        self.assertIsNone(fl.spearman([1, 1, 1], [1, 2, 3]))                 # a constant ranking says nothing

    def test_a_real_persistent_pattern_is_found_and_passes(self):
        rows = fl.panel(universe(persistent=0.003))  # about 3% a month between the strongest and weakest drifts
        factors = {f['name']: f for f in fl.judge(rows)[0]}
        momentum = factors['momentum-12-1']
        self.assertTrue(momentum['passes'], momentum['reasons'])
        self.assertGreater(momentum['ic']['mean'], 0.1)
        self.assertGreater(momentum['spread']['averagePct'], 0)
        self.assertFalse(factors['reversal-1m']['passes'])  # the opposite bet loses when momentum is real

    def test_months_after_a_deep_fall_are_reported_apart(self):
        rows = [{'month': f'2020-{m:02d}', 'basketPct': p} for m, p in zip(range(1, 13), (-1, -2, -20, 3, 2, -3, 5, 4, 1, 2, 3, 1))]
        self.assertEqual(fl.after_deep_fall(rows), {'2020-07', '2020-08'})  # 6 months to June -20.9%, to July -16.1%, to Aug -11.0%
        factors = {f['name']: f for f in fl.judge(fl.panel(universe(persistent=0.003)))[0]}
        split = factors['momentum-12-1']['byCondition']
        self.assertEqual(split['afterDeepFall']['months'] + split['otherwise']['months'], factors['momentum-12-1']['months'])

    def test_noise_passes_nothing(self):
        rows = fl.panel(universe(persistent=0.0, seed=3))
        factors, threshold = fl.judge(rows)
        self.assertAlmostEqual(threshold, 0.05 / len(fl.FACTORS))
        self.assertEqual([f['name'] for f in factors if f['passes']], [])

    def test_shares_join_only_with_enough_history_and_costs_count(self):
        bars = universe(shares=40, years=4, persistent=0.0012)
        late = {s: b[400:] for s, b in list(bars.items())[:10]}  # ten shares list later
        rows = fl.panel({**bars, **late})
        # a month after the late listers joined, but before they have a year of history: they trade in the basket, but
        # 12-month momentum cannot rank them yet, while 3-month momentum already can
        joined = next(r for r in rows if r['shares'] == 40 and r['factors'].get('momentum-3m', {}).get('eligible') == 40)
        self.assertEqual(joined['factors']['momentum-12-1']['eligible'], 30)
        opening = next(r for r in rows if 'momentum-3m' in r['factors'])['factors']['momentum-3m']
        self.assertEqual(opening['turnover'], 2.0)  # the first month buys the whole quintile, and pays for it


class ForwardTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        from unittest import mock
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.bars = universe(persistent=0.003)  # 2016-01 to late 2021
        patcher = mock.patch.object(fl.daily, 'load', lambda symbols, cache=None: {s: self.bars[s] for s in symbols if s in self.bars})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.tmp.cleanup)

    def register(self, **kw):
        from datetime import datetime, timezone
        return fl.register_forward('m12', 'momentum-12-1', symbols=sorted(self.bars), root=self.root,
                                   now=datetime(2019, 12, 15, tzinfo=timezone.utc), **kw)

    def test_only_months_after_registration_count_and_the_verdict_waits_for_the_horizon(self):
        record = self.register()
        self.assertEqual((record['firstMonth'], record['fullMonthShares'], len(record['symbols'])), ('2020-01', 60, 60))
        with self.assertRaises(ValueError):
            self.register()                                          # a name is registered once
        report = fl.forward('m12', root=self.root)
        self.assertEqual(report['status'], 'running')                # under 24 months: descriptive only
        self.assertEqual(report['months'][0]['month'], '2020-01')
        self.assertTrue(all(m['month'] >= '2020-01' for m in report['months']))
        self.assertGreater(report['ahead'], report['behind'])        # the planted momentum shows

    def test_a_partial_month_waits_and_the_verdict_is_the_pre_registered_one(self):
        self.register()
        path = self.root / 'm12.json'
        record = fl.json.loads(path.read_text(encoding='utf-8'))
        path.write_text(fl.json.dumps({**record, 'criterion': {**record['criterion'], 'months': 12}}), encoding='utf-8')
        self.assertEqual(fl.forward('m12', root=self.root)['status'], 'passed')
        # a third of the files not yet refreshed past mid-2020: those months are not judged on the fresh shares alone
        for s in sorted(self.bars)[:20]:
            self.bars[s] = [b for b in self.bars[s] if b['date'] < '2020-07-01']
        report = fl.forward('m12', root=self.root)
        self.assertEqual((report['status'], report['waitingForDataFrom'], report['monthsJudged']), ('running', '2020-06', 5))
        # most files stale: the month drops out of the panel entirely, and is still waited for, never skipped
        for s in sorted(self.bars)[:40]:
            self.bars[s] = [b for b in self.bars[s] if b['date'] < '2020-07-01']
        report = fl.forward('m12', root=self.root)
        self.assertEqual((report['waitingForDataFrom'], report['monthsJudged']), ('2020-06', 5))

    def test_a_changed_rule_ends_the_test(self):
        self.register()
        path = self.root / 'm12.json'
        path.write_text(fl.json.dumps({**fl.json.loads(path.read_text(encoding='utf-8')), 'rules': 'something-else'}), encoding='utf-8')
        self.assertEqual(fl.forward('m12', root=self.root)['status'], 'ended')
        self.assertEqual(fl.forward_all(root=self.root)[0]['status'], 'ended')
        self.assertTrue((self.root / 'reports' / 'm12.json').exists())


if __name__ == '__main__':
    unittest.main()
