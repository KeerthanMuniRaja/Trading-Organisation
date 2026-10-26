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


if __name__ == '__main__':
    unittest.main()
