from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily
import portfolio_daily as pd
import risk_monitor as rm
from test_daily import synthetic_daily


def basket(drifts_and_seeds):
    names = ('RELIANCE.NS', 'INFY.NS', 'ITC.NS')
    return pd.aligned({n: daily.validate(synthetic_daily(n, drift=d, seed=s)) for n, (d, s) in zip(names, drifts_and_seeds)})


class RiskMonitorTests(unittest.TestCase):
    def test_a_steady_diversified_basket_is_normal(self):
        dates, table = basket(((0.0006, 7), (0.0006, 11), (0.0006, 23)))
        state = rm.assess(table, dates, len(dates) - 1)
        self.assertLess(state['metrics']['averageCorrelation'], rm.CORRELATION[0])
        self.assertIn(state['level'], ('normal', 'caution'))
        self.assertEqual(set(state['metrics']), {'drawdown', 'volatilityRatio', 'breadthAbove200d', 'averageCorrelation', 'worstDayLast20'})

    def test_a_falling_basket_raises_an_alert_with_reasons(self):
        dates, table = basket(((-0.002, 7), (-0.002, 11), (-0.002, 23)))
        state = rm.assess(table, dates, len(dates) - 1)
        self.assertEqual(state['level'], 'alert')
        self.assertGreaterEqual(state['metrics']['drawdown'], rm.DRAWDOWN[1])
        self.assertTrue(any('below its 1-year peak' in r for r in state['reasons']))
        self.assertTrue(any('above their 200-day average' in r for r in state['reasons']))

    def test_shares_moving_together_flag_failing_diversification(self):
        dates, table = basket(((0.0004, 7), (0.0004, 7), (0.0004, 7)))  # identical paths
        state = rm.assess(table, dates, len(dates) - 1)
        self.assertGreaterEqual(state['metrics']['averageCorrelation'], rm.CORRELATION[1])
        self.assertEqual(state['level'], 'alert')

    def test_only_completed_days_are_used(self):
        names = ('RELIANCE.NS', 'INFY.NS', 'ITC.NS')
        raw = {n: daily.validate(synthetic_daily(n, drift=0.0003, seed=s)) for n, s in zip(names, (7, 11, 23))}
        dates, table = pd.aligned(raw)
        altered = {n: [dict(b) for b in bars] for n, bars in raw.items()}
        for bars in altered.values():
            for b in bars[700:]:
                b['openPaise'] = b['highPaise'] = b['lowPaise'] = b['closePaise'] = 1
        dates2, table2 = pd.aligned(altered)
        self.assertEqual(rm.assess(table, dates, 650), rm.assess(table2, dates2, 650))

    def test_history_groups_every_day_by_level(self):
        dates, table = basket(((0.0003, 7), (-0.0004, 11), (0.0001, 23)))
        result = rm.history(table, dates, start=300, horizon=21)
        self.assertEqual(set(result), set(rm.LEVELS))
        self.assertEqual(sum(v['days'] for v in result.values()), len(dates) - 21 - 300)


if __name__ == '__main__':
    unittest.main()
