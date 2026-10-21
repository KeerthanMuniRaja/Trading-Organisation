import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily
import portfolio_daily as pd
import research_checks as rc
import rnd_scout as rs
from test_daily import synthetic_daily

SYMBOLS = sorted(daily.datasets.UNIVERSE)


def table_of(years=5):
    bars = {s: synthetic_daily(s, years=years, drift=0.0004 + 0.0002 * k, seed=5 + k)['bars'] for k, s in enumerate(SYMBOLS)}
    return pd.aligned(bars)


def peeking(table, dates, i):
    """Cheats: picks the share that rises most TOMORROW."""
    best = max(table, key=lambda s: table[s][dates[i + 1]]['closePaise'] / table[s][dates[i]]['closePaise'])
    return {best: 1.0}


def honest(table, dates, i):
    return pd.top_momentum(table, dates, i, months=6, keep=3)


class BiasCheckTests(unittest.TestCase):
    def test_a_rule_that_uses_tomorrow_is_caught_and_an_honest_one_is_not(self):
        dates, table = table_of()
        days = rc.decision_days(dates, 260)
        self.assertEqual(len(days), 6)
        found = rc.check_rules({'peeking': peeking, 'honest': honest}, table, dates, days)
        self.assertEqual(len(found['peeking']['lookahead']), 6)
        self.assertEqual((found['honest']['lookahead'], found['honest']['warmup'], found['honest']['stableFromSessions']), ([], [], 300))

    def test_a_rule_that_depends_on_where_the_data_starts_is_reported(self):
        dates, table = table_of()
        def since_start(t, d, i):  # ranks by the whole history: depends on how far back the data goes
            return {max(t, key=lambda s: t[s][d[i]]['closePaise'] / t[s][d[0]]['closePaise']): 1.0}
        found = rc.check_rules({'since-start': since_start}, table, dates, rc.decision_days(dates, 400))
        self.assertTrue(found['since-start']['warmup'])
        self.assertFalse(found['since-start']['lookahead'])


class StatsTests(unittest.TestCase):
    def test_result_statistics(self):
        s = rc.stats([2.0, -1.0, 3.0, -2.0, 1.0, 1.0], [1.0, -0.5, 1.5, -1.0, 0.0, 0.5])
        self.assertEqual(s['profitFactor'], round(3.0 / 1.5, 2))
        self.assertAlmostEqual(s['expectancyPct'], 0.25, places=3)
        self.assertLess(s['maxDrawdownPct'], 0)
        self.assertGreaterEqual(s['longestDrawdownMonths'], 1)
        self.assertIsNotNone(s['sharpe'])
        self.assertIsNone(rc.stats([1.0], [1.0]))

    def test_random_pickers_are_reproducible_and_percentiles_count_below(self):
        dates, table = table_of()
        rule = rc.random_rule(7, 3)
        self.assertEqual(rule(table, dates, 300), rule(table, dates, 300))
        self.assertEqual(len(rule(table, dates, 300)), 3)
        self.assertEqual(rc.percentile(2.0, [1.0, 2.0, 3.0, 0.5]), 50.0)

    def test_the_risk_lens_finds_a_calmer_rule_with_the_same_return_and_values_cash(self):
        import random
        rng = random.Random(1)
        basket = [1.0 + rng.gauss(0, 5) for _ in range(120)]
        calmer = [1.0 + (b - 1.0) * 0.4 for b in basket]           # same average, much less swing
        wilder = [1.0 + (b - 1.0) * 2.0 - 0.8 for b in basket]     # more swing, lower average
        self.assertGreater(rc.sharpe_test(calmer, basket)['probabilityBetter'], 0.9)
        self.assertLess(rc.sharpe_test(wilder, basket)['probabilityBetter'], 0.1)
        self.assertEqual(rc.sharpe_test(calmer, basket), rc.sharpe_test(calmer, basket))  # reproducible
        self.assertIsNone(rc.sharpe_test([1.0] * 5, [1.0] * 5))
        self.assertEqual(rc.with_cash_yield([0.0, 1.0], [1.0, 0.5], 6.0), [0.5, 1.25])

    def test_proof_time_grows_with_noise_and_vanishes_without_an_edge(self):
        steady = [0.3 + (0.5 if k % 2 else -0.5) for k in range(100)]   # +0.3% a month, little noise
        noisy = [0.3 + (3.0 if k % 2 else -3.0) for k in range(100)]    # +0.3% a month, 3% noise
        quick, slow = rc.months_to_prove(steady, 0.0029), rc.months_to_prove(noisy, 0.0029)
        self.assertLess(quick, 80)
        # the scout judges with a sign test, which needs about pi/2 times the months of a t-test
        import math, statistics
        mean, sd = statistics.fmean(steady), statistics.stdev(steady)
        z = statistics.NormalDist().inv_cdf(1 - 0.0029) + statistics.NormalDist().inv_cdf(0.8)
        self.assertEqual(quick, math.ceil((z * sd / mean) ** 2 * math.pi / 2))
        self.assertGreater(slow, 500)  # the honest arithmetic: a small edge in a noisy record takes decades to prove
        self.assertIsNone(rc.months_to_prove([-0.1, 0.1, -0.2], 0.0029))

    def test_after_tax_growth_charges_short_term_tax_on_what_was_sold(self):
        flat = [1.0] * 24   # 1% a month for two years
        held = rc.after_tax_cagr(flat)                       # never sold: long-term tax once at the end
        traded = rc.after_tax_cagr(flat, [2.0] * 24)         # sold everything every year: short-term tax each year
        gross = round(100 * (1.01 ** 12 - 1), 2)
        self.assertLess(traded, held)
        self.assertLess(held, gross)
        self.assertAlmostEqual(traded, round(100 * (1 + (1.01 ** 12 - 1) * 0.8) - 100, 2), places=1)
        self.assertGreater(rc.after_tax_cagr(flat, [2.0] * 24, long_term_sales=True), traded)  # lots sold after a year pay 12.5%

    def test_the_combo_family_ranks_momentum_calm_and_consistency(self):
        import rnd_ideas
        dates, table = table_of()
        spec = {'family': 'combo', 'months': 6, 'window': 60, 'keep': 3}
        self.assertEqual(rnd_ideas.canonical(spec), spec)
        self.assertEqual(rnd_ideas.name_of(spec), 'idea-combo-6m-60d-top3')
        weights = rnd_ideas.rule_of(spec)(table, dates, len(dates) - 1)
        self.assertEqual(len(weights), 3)
        self.assertEqual(rnd_ideas.rule_of(spec)(table, dates, 100), {})  # not enough history for a year of consistency

    def test_a_slower_rebalance_holds_its_decision_and_trades_less(self):
        import rnd_ideas
        monthly = {'family': 'momentum', 'months': 6, 'keep': 3}
        # monthly stays the default and out of the spec, so every earlier idea keeps its hash and name
        self.assertEqual(rnd_ideas.spec_hash({**monthly, 'rebalance': 1}), rnd_ideas.spec_hash(monthly))
        self.assertEqual(rnd_ideas.name_of({**monthly, 'rebalance': 12}), 'idea-momentum-6m-top3-y')
        self.assertIn('rebalanced every 3 months', rnd_ideas.describe({**monthly, 'rebalance': 3}))
        with self.assertRaises(ValueError):
            rnd_ideas.canonical({**monthly, 'rebalance': 2})
        dates, table = table_of()
        rules = {'monthly': rnd_ideas.rule_of(monthly), 'yearly': rnd_ideas.rule_of({**monthly, 'rebalance': 12})}
        rows = rs.monthly(table, dates, rules)
        changes = {n: sum(r['turnover'][n] > 0 for r in rows[1:]) for n in rules}
        self.assertLessEqual(changes['yearly'], len(rows) // 12 + 1)   # at most one change a year
        self.assertGreater(changes['monthly'], changes['yearly'])
        # the held decision is the one taken at the January rebalance, never a later day's
        january = next(i for i in range(300, len(dates)) if dates[i][5:7] == '01' and dates[i][:7] != dates[i - 1][:7])
        june = next(i for i in range(january, len(dates)) if dates[i][5:7] == '06' and dates[i][:7] != dates[i - 1][:7])
        self.assertEqual(rules['yearly'](table, dates, june), rules['monthly'](table, dates, january))
        found = rc.check_rules({'yearly': rules['yearly']}, table, dates, rc.decision_days(dates, 300))
        self.assertEqual(found['yearly']['lookahead'], [])

    def test_luck_checks_deflate_a_sharpe_by_the_number_of_ideas_tried(self):
        import random
        rng = random.Random(3)
        edge = [1.2 + rng.gauss(0, 2) for _ in range(120)]      # a real, strong edge (Sharpe about 0.6 a month)
        noise = [rng.gauss(0, 2) for _ in range(120)]           # none
        self.assertGreater(rc.probabilistic_sharpe(edge), 0.99)
        self.assertLess(rc.probabilistic_sharpe(noise), 0.95)
        lucky_trials = [rc.per_period_sharpe([rng.gauss(0, 2) for _ in range(120)]) for _ in range(50)]
        # against the best of 50 tried ideas, the strong edge still holds; a merely lucky-looking one does not
        self.assertGreater(rc.deflated_sharpe(edge, lucky_trials), 0.95)
        modest = [0.4 + rng.gauss(0, 2) for _ in range(120)]
        self.assertLess(rc.deflated_sharpe(modest, lucky_trials), rc.probabilistic_sharpe(modest))  # deflation always lowers it
        best_noise = max(([rng.gauss(0, 2) for _ in range(120)] for _ in range(50)), key=rc.per_period_sharpe)
        self.assertLess(rc.deflated_sharpe(best_noise, lucky_trials), rc.probabilistic_sharpe(best_noise))
        self.assertIsNone(rc.deflated_sharpe(edge, [0.1]))

    def test_robustness_years_double_costs_and_stress_windows(self):
        months = [f'{y}-{m:02d}' for y in (2018, 2019, 2020) for m in range(1, 13)]
        excess = [0.5 if m.startswith('2019') else -0.2 for m in months]
        r = rc.robustness(months, excess, [1.0] + [0.5] * 35, 0.15)
        self.assertEqual((r['yearsAheadOfBasket'], r['years']), (1, 3))
        self.assertAlmostEqual(r['averageExcessPctAt2xCosts'], round(sum(excess) / 36 - 0.15 * 0.5, 3), places=3)
        self.assertEqual(set(r['stressExcessPct']), {'ilfs-2018', 'covid-2020'})

    def test_slow_random_pickers_hold_between_repicks(self):
        dates, table = table_of()
        yearly = rc.random_rule(1, 3, every=12)
        self.assertTrue(yearly.holdsBetween)
        jan = next(i for i in range(300, len(dates)) if dates[i][5:7] == '01')
        jun = next(i for i in range(jan, len(dates)) if dates[i][5:7] == '06' and dates[i][:4] == dates[jan][:4])
        self.assertEqual(yearly(table, dates, jan), yearly(table, dates, jun))

    def test_walk_forward_holds_the_best_of_the_past_window_out_of_sample(self):
        rows = [{'month': f'2020-{k:02d}', 'basketPct': 0.0, 'rules': {'a': 1.0 if k <= 6 else -1.0, 'b': 0.5 if k <= 6 else 2.0}} for k in range(1, 13)]
        wf = rc.walk_forward(rows, ['a', 'b'], train=6, test=6)
        self.assertEqual(wf['picks'], [{'from': '2020-07', 'to': '2020-12', 'chosen': 'a'}])  # best in training, worst after
        self.assertEqual((wf['ahead'], wf['behind'], wf['averageExcessPct']), (0, 6, -1.0))

    def test_an_expanding_walk_forward_chooses_on_all_the_history_so_far(self):
        # a is best over the first 6 months, b over the next 6; at month 13 the rolling 6-month window picks b, the
        # expanding window (all 12 months) still picks a
        rows = [{'month': f'2020-{k:02d}', 'basketPct': 0.0, 'rules': {'a': 3.0 if k <= 6 else -0.5, 'b': -1.0 if k <= 6 else 1.0}} for k in range(1, 13)]
        rows += [{'month': f'2021-{k:02d}', 'basketPct': 0.0, 'rules': {'a': 0.0, 'b': 0.0}} for k in range(1, 7)]
        rolling, expanding = rc.walk_forward(rows, ['a', 'b'], train=6, test=6), rc.walk_forward(rows, ['a', 'b'], train=6, test=6, expanding=True)
        self.assertEqual([p['chosen'] for p in rolling['picks']], ['a', 'b'])
        self.assertEqual([p['chosen'] for p in expanding['picks']], ['a', 'a'])
        self.assertEqual((rolling['window'], expanding['window']), ('rolling', 'expanding'))

    def test_the_warmup_sweep_finds_how_much_history_a_rule_needs(self):
        dates, table = table_of(years=6)
        days = rc.decision_days(dates, 1250, count=4)

        def slow(t, d, i):  # needs about 900 sessions of history: its answer changes with less
            first = d[max(0, i - 900)]
            return {s: 1 / len(t) for s in sorted(t)[:2]} if first in t[sorted(t)[0]] and i >= 900 else {}
        checks = rc.check_rules({'slow': slow, 'fast': lambda t, d, i: {sorted(t)[0]: 1.0}}, table, dates, days)
        self.assertEqual(checks['fast']['stableFromSessions'], 300)
        self.assertEqual(checks['slow']['stableFromSessions'], 1200)
        self.assertEqual(checks['slow']['warmupSweep'][300]['changed'], len(days))
        self.assertTrue(checks['slow']['warmup'])  # still reported as warm-up sensitive at the usual 300 sessions


class KnowledgeTests(unittest.TestCase):
    def test_the_method_cards_are_complete_and_reach_rnd_invention(self):
        import rnd_ideas
        cards = json.loads(rnd_ideas.KNOWLEDGE.read_text(encoding='utf-8'))['cards']
        self.assertTrue(len(cards) >= 15 and len({c['id'] for c in cards}) == len(cards))
        for c in cards:
            self.assertTrue(all(c.get(k) for k in ('id', 'kind', 'source', 'idea', 'howWeTest', 'result', 'lesson')), c['id'])
        seen = {}

        def llm(system, user, schema):
            seen['user'] = json.loads(user)
            return {'ideas': []}, {}
        rnd_ideas.invent(llm, [{'name': 'x', 'spec': None, 'ahead': 1, 'behind': 2, 'pValue': 1.0, 'beatsRandomPct': 40.0}])
        self.assertEqual(len(seen['user']['lessons']), len(cards))
        self.assertIn('walk-forward', {l['method'] for l in seen['user']['lessons']})
        self.assertEqual(seen['user']['resultsSoFar'][0]['beatsRandomPct'], 40.0)


class ScoutIntegrationTests(unittest.TestCase):
    def test_the_scout_reports_bias_checks_statistics_random_baseline_and_walk_forward(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            for k, s in enumerate(SYMBOLS):
                (cache / f'{s}-1d.json').write_text(json.dumps(synthetic_daily(s, drift=0.004 if k < 2 else 0.0, seed=11 + k)), encoding='utf-8')
            import rnd_ideas
            real, rnd_ideas.LEDGER = rnd_ideas.LEDGER, cache / 'none.jsonl'
            try:
                samples, rs.BOOTSTRAP_SAMPLES = rs.BOOTSTRAP_SAMPLES, 300
                try:
                    r = rs.scout(cache=cache, randoms=20)
                finally:
                    rs.BOOTSTRAP_SAMPLES = samples
            finally:
                rnd_ideas.LEDGER = real
            self.assertEqual(r['randomBaseline']['rules'], 20)
            self.assertTrue(r['walkForward']['outOfSampleMonths'] > 0)
            best = next(c for c in r['candidates'] if c['name'] == 'momentum-6m-top2')
            self.assertEqual(best['beatsRandomPct'], 100.0)  # two persistent winners: momentum beats every random picker
            self.assertIn('sharpe', best['stats'])
            self.assertEqual(set(best['luck']), {'probabilisticSharpe', 'deflatedSharpe'})
            self.assertIn('yearsAheadOfBasket', best['robustness'])
            self.assertIsNotNone(best['beatsMatchedRandomPct'])
            self.assertEqual(set(r['randomBaseline']['matchedByTurnover']), {'every1m', 'every3m', 'every6m', 'every12m'})
            lens = best['riskLens']
            self.assertEqual(set(lens), {'sharpeTest', 'worstFallPct', 'basketWorstFallPct', 'averageCashPct', 'atAssumedCashYield', 'wouldPassRiskBar'})
            trend = next(c for c in r['candidates'] if c['name'] == 'trend-filter-200d')
            self.assertGreaterEqual(trend['riskLens']['atAssumedCashYield']['cagrPct'], trend['stats']['cagrPct'])  # cash earns when it sits out
            self.assertTrue(all(not any('lookahead' in x for x in c['reasons']) for c in r['candidates']))  # the catalogue is honest

    def test_the_research_universe_keeps_only_shares_with_the_full_history(self):
        long = {'A.NS': [{'date': '2016-10-20'}], 'B.NS': [{'date': '2016-11-01'}], 'C.NS': [{'date': '2021-07-23'}]}
        kept, left = rs.full_history(long)
        self.assertEqual((sorted(kept), left), (['A.NS', 'B.NS'], {'C.NS': '2021-07-23'}))


if __name__ == '__main__':
    unittest.main()
