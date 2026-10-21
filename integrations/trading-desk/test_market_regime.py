from datetime import date, timedelta
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import market_regime as mr
import rnd_ideas

SHARES = [f'S{k}.NS' for k in range(8)]


def market(moves, volumes=None, n_shares=8):
    """A table where every share follows the same daily moves (percent) and volumes."""
    dates = [(date(2020, 1, 1) + timedelta(days=k)).isoformat() for k in range(len(moves) + 1)]
    table = {}
    for s in SHARES[:n_shares]:
        price, rows = 100_000.0, {}
        for k, d in enumerate(dates):
            if k:
                price *= 1 + moves[k - 1] / 100
            rows[d] = {'openPaise': int(price), 'closePaise': int(price), 'highPaise': int(price) + 1, 'lowPaise': int(price) - 1,
                       'volume': (volumes[k - 1] if volumes and k else 1000)}
        table[s] = rows
    return dates, table


class DistributionDayTests(unittest.TestCase):
    def test_a_quiet_uptrend_is_normal_with_full_breadth(self):
        dates, table = market([0.1] * 260)
        r = mr.regime(table, dates, len(dates) - 1)
        self.assertEqual((r['risk'], r['distributionDays'], r['breadth50d'], r['breadth200d'], r['aboveTrend200d'], r['exposureCeilingPct']),
                         ('NORMAL', 0, 8, 8, True, 100))

    def test_falls_on_higher_volume_count_and_raise_the_risk(self):
        moves, volumes = [0.1] * 250, [1000] * 250
        for k in range(230, 250, 3):   # seven down days, each on more volume than the day before
            moves[k], volumes[k] = -0.5, 2000
        dates, table = market(moves, volumes)
        r = mr.regime(table, dates, len(dates) - 1)
        self.assertEqual((r['distributionDays'], r['risk'], r['exposureCeilingPct']), (7, 'SEVERE', 25))
        self.assertFalse(mr.calm(table, dates, len(dates) - 1))
        # a fall on lower volume, or a small fall, is not a distribution day
        quiet = market([0.1] * 240 + [-0.5] * 3, [1000] * 240 + [500] * 3)
        small = market([0.1] * 240 + [-0.1, 0.1] * 3, [1000] * 240 + [2000, 1000] * 3)
        for d, t in (quiet, small):
            self.assertEqual(mr.regime(t, d, len(d) - 1)['distributionDays'], 0)

    def test_distribution_days_expire_after_25_sessions_or_a_5_percent_recovery(self):
        moves, volumes = [0.1] * 240, [1000] * 240
        moves[200], volumes[200] = -0.5, 2000
        dates, table = market(moves, volumes)
        self.assertEqual(len(mr.distribution_days(table, dates, 210)), 1)
        self.assertEqual(len(mr.distribution_days(table, dates, 230)), 0)  # 30 sessions later
        rally = market([0.1] * 200 + [-0.5] + [1.5] * 5, [1000] * 200 + [2000] + [1000] * 5)
        self.assertEqual(len(mr.distribution_days(rally[1], rally[0], len(rally[0]) - 1)), 0)  # recovered over 5%

    def test_below_trend_and_weak_breadth_lower_the_ceiling(self):
        dates, table = market([0.1] * 220 + [-0.3] * 60)
        r = mr.regime(table, dates, len(dates) - 1)
        self.assertEqual((r['aboveTrend200d'], r['breadth200d']), (False, 0))
        self.assertEqual(r['exposureCeilingPct'], 50)  # 100 - 25 (trend) - 25 (breadth)

    def test_the_study_reports_each_level_and_says_when_evidence_is_thin(self):
        dates, table = market([0.1] * 300)
        report = mr.study(table, dates)
        self.assertEqual(set(report['levels']), {'NORMAL', 'CAUTION', 'HIGH', 'SEVERE'})
        self.assertEqual(report['levels']['NORMAL']['days'], len(dates) - 20 - 200)
        self.assertEqual(report['verdict'], 'insufficient-evidence')  # never stressed: nothing to compare


class RegimeV2Tests(unittest.TestCase):
    def test_v2_escalates_on_clusters_and_uses_traded_value(self):
        moves, volumes = [0.1] * 250, [1000] * 250
        for k in (246, 248):   # two distribution days within 5 sessions: a cluster
            moves[k], volumes[k] = -0.5, 2000
        dates, table = market(moves, volumes)
        i = len(dates) - 1
        self.assertEqual(mr.risk_of(len(mr.distribution_days(table, dates, i))), 'NORMAL')  # v1 counts only the 25-session total
        self.assertEqual(mr.risk_v2(table, dates, i), 'HIGH')                                 # v2 sees the cluster
        quiet = market([0.1] * 240 + [-0.5], [1000] * 240 + [500])
        self.assertEqual(mr.distribution_ages_v2(quiet[1], quiet[0], len(quiet[0]) - 1), [])  # a fall on lower traded value is not one

    def test_the_study_reports_both_versions(self):
        dates, table = market([0.1] * 300)
        v2 = mr.study(table, dates, risk_at=mr.risk_v2)
        self.assertEqual(set(v2['levels']), {'NORMAL', 'CAUTION', 'HIGH', 'SEVERE'})


class AdoptedFamilyTests(unittest.TestCase):
    def test_the_new_families_are_valid_ideas_with_bounds(self):
        for spec in ({'family': 'trend-template', 'nearHighPct': 25, 'keep': 3}, {'family': 'pullback', 'rsiMax': 40, 'keep': 3},
                     {'family': 'momentum', 'months': 6, 'keep': 3, 'filter': 'distribution-days'}):
            self.assertEqual(rnd_ideas.canonical(spec), spec)
        self.assertEqual(rnd_ideas.name_of({'family': 'momentum', 'months': 6, 'keep': 3, 'filter': 'distribution-days'}), 'idea-momentum-6m-top3-dd')
        for bad in ({'family': 'pullback', 'rsiMax': 70, 'keep': 3}, {'family': 'trend-template', 'nearHighPct': 2, 'keep': 3},
                    {'family': 'momentum', 'months': 6, 'keep': 3, 'filter': 'astrology'}):
            with self.assertRaises(ValueError):
                rnd_ideas.canonical(bad)

    def test_trend_template_holds_only_shares_in_a_strong_uptrend_near_their_high(self):
        dates, table = market([0.1] * 300, n_shares=4)
        falling = market([0.1] * 200 + [-0.2] * 100, n_shares=1)[1]['S0.NS']
        table['S7.NS'] = falling
        weights = rnd_ideas.rule_of({'family': 'trend-template', 'nearHighPct': 25, 'keep': 3})(table, dates, len(dates) - 1)
        self.assertEqual(len(weights), 3)
        self.assertNotIn('S7.NS', weights)
        self.assertTrue(all(abs(w - 1 / 3) < 1e-9 for w in weights.values()))

    def test_pullback_buys_oversold_shares_only_above_their_200_day_average(self):
        dates, table = market([0.2] * 280 + [-1.0] * 8, n_shares=2)
        table['S2.NS'] = market([0.1] * 288, n_shares=1)[1]['S0.NS']     # still rising: RSI high
        table['S3.NS'] = market([-0.3] * 280 + [-1.0] * 8, n_shares=1)[1]['S0.NS']  # oversold but in a downtrend
        self.assertLess(rnd_ideas.rsi(table, 'S0.NS', dates, len(dates) - 1), 40)
        weights = rnd_ideas.rule_of({'family': 'pullback', 'rsiMax': 40, 'keep': 3})(table, dates, len(dates) - 1)
        self.assertEqual(sorted(weights), ['S0.NS', 'S1.NS'])  # the rest of the money stays in cash

    def test_the_distribution_filter_moves_a_rule_to_cash_under_pressure(self):
        moves, volumes = [0.1] * 290, [1000] * 290
        for k in range(270, 290, 3):
            moves[k], volumes[k] = -0.5, 2000
        dates, table = market(moves, volumes)
        rule = rnd_ideas.rule_of({'family': 'momentum', 'months': 6, 'keep': 3, 'filter': 'distribution-days'})
        self.assertEqual(rule(table, dates, len(dates) - 1), {})
        self.assertEqual(len(rule(table, dates, 260)), 3)


if __name__ == '__main__':
    unittest.main()
