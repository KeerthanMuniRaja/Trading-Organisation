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
        self.assertEqual(found['honest'], {'lookahead': [], 'warmup': []})

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

    def test_walk_forward_holds_the_best_of_the_past_window_out_of_sample(self):
        rows = [{'month': f'2020-{k:02d}', 'basketPct': 0.0, 'rules': {'a': 1.0 if k <= 6 else -1.0, 'b': 0.5 if k <= 6 else 2.0}} for k in range(1, 13)]
        wf = rc.walk_forward(rows, ['a', 'b'], train=6, test=6)
        self.assertEqual(wf['picks'], [{'from': '2020-07', 'to': '2020-12', 'chosen': 'a'}])  # best in training, worst after
        self.assertEqual((wf['ahead'], wf['behind'], wf['averageExcessPct']), (0, 6, -1.0))


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
                r = rs.scout(cache=cache, randoms=20)
            finally:
                rnd_ideas.LEDGER = real
            self.assertEqual(r['randomBaseline']['rules'], 20)
            self.assertTrue(r['walkForward']['outOfSampleMonths'] > 0)
            best = next(c for c in r['candidates'] if c['name'] == 'momentum-6m-top2')
            self.assertEqual(best['beatsRandomPct'], 100.0)  # two persistent winners: momentum beats every random picker
            self.assertIn('sharpe', best['stats'])
            self.assertTrue(all(not any('lookahead' in x for x in c['reasons']) for c in r['candidates']))  # the catalogue is honest

    def test_the_research_universe_keeps_only_shares_with_the_full_history(self):
        long = {'A.NS': [{'date': '2016-10-20'}], 'B.NS': [{'date': '2016-11-01'}], 'C.NS': [{'date': '2021-07-23'}]}
        kept, left = rs.full_history(long)
        self.assertEqual((sorted(kept), left), (['A.NS', 'B.NS'], {'C.NS': '2021-07-23'}))


if __name__ == '__main__':
    unittest.main()
