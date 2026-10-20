from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily
import portfolio_daily as pd
import rnd_ideas as ri
from test_daily import synthetic_daily

SYMBOLS = sorted(daily.datasets.UNIVERSE)
OCT, NOV = datetime(2026, 10, 20, tzinfo=timezone.utc), datetime(2026, 11, 2, tzinfo=timezone.utc)


class GrammarTests(unittest.TestCase):
    def test_only_specifications_inside_the_grammar_are_ideas(self):
        self.assertEqual(ri.canonical({'family': 'momentum', 'months': 4, 'keep': 2}), {'family': 'momentum', 'months': 4, 'keep': 2})
        self.assertEqual(ri.name_of({'keep': 2, 'months': 4, 'family': 'momentum', 'filter': 'trend-200d'}), 'idea-momentum-4m-top2-trend')
        for bad in ({'family': 'martingale'}, {'family': 'momentum', 'months': 13, 'keep': 2}, {'family': 'momentum', 'months': 4, 'keep': 2, 'code': 'x'},
                    {'family': 'momentum', 'months': 4.5, 'keep': 2}, {'family': 'momentum', 'months': True, 'keep': 2},
                    {'family': 'reversal', 'days': 10, 'keep': 2, 'filter': 'martingale'}, 'momentum'):
            with self.assertRaises(ValueError, msg=str(bad)):
                ri.canonical(bad)
        self.assertEqual(ri.spec_hash({'keep': 2, 'family': 'momentum', 'months': 4}), ri.spec_hash({'family': 'momentum', 'months': 4, 'keep': 2}))

    def test_each_family_builds_an_audited_rule_from_completed_days(self):
        with tempfile.TemporaryDirectory() as tmp:
            for k, s in enumerate(SYMBOLS):
                (Path(tmp) / f'{s}-1d.json').write_text(json.dumps(synthetic_daily(s, drift=0.004 if k < 2 else 0.0, seed=11 + k)), encoding='utf-8')
            dates, table = pd.aligned(daily.load(SYMBOLS, Path(tmp)))
        i = len(dates) - 1
        momentum = ri.rule_of({'family': 'momentum', 'months': 6, 'keep': 2})(table, dates, i)
        self.assertEqual(momentum, pd.top_momentum(table, dates, i, months=6, keep=2))
        calm = ri.rule_of({'family': 'low-vol', 'window': 60, 'keep': 3})(table, dates, i)
        weak = ri.rule_of({'family': 'reversal', 'days': 21, 'keep': 3})(table, dates, i)
        self.assertEqual((len(calm), len(weak)), (3, 3))
        self.assertTrue(all(abs(sum(w.values()) - 1) < 1e-9 for w in (momentum, calm, weak)))
        filtered = ri.rule_of({'family': 'momentum', 'months': 6, 'keep': 2, 'filter': 'trend-200d'})(table, dates, i)
        self.assertEqual(filtered, momentum if pd.trend_filtered(table, dates, i) else {})


class LedgerTests(unittest.TestCase):
    def test_ideas_are_appended_once_bounded_per_month_and_never_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'ideas.jsonl'
            known = {ri.spec_hash({'family': 'momentum', 'months': 6, 'keep': 3})}  # already in the fixed catalogue
            first = ri.propose([{'family': 'momentum', 'months': 6, 'keep': 3}, {'family': 'momentum', 'months': 4, 'keep': 2},
                                {'family': 'momentum', 'months': 4, 'keep': 2}, {'family': 'nope'}], 'model:qwen', known, path, OCT)
            self.assertEqual([o['outcome'] for o in first], ['duplicate', 'added', 'duplicate', 'invalid'])
            more = ri.propose([{'family': 'reversal', 'days': d, 'keep': 2} for d in (5, 10, 15, 20)], 'explorer', known, path, OCT)
            self.assertEqual([o['outcome'] for o in more], ['added', 'added', 'monthly-limit', 'monthly-limit'])  # 3 a month in all
            self.assertEqual([o['outcome'] for o in ri.propose([{'family': 'reversal', 'days': 15, 'keep': 2}], 'explorer', known, path, NOV)], ['added'])
            entries = ri.ledger(path)
            self.assertEqual(len(entries), 4)
            self.assertEqual(entries[0]['proposer'], 'model:qwen')

    def test_the_model_can_only_propose_specifications_and_each_is_checked_again(self):
        seen = []

        def llm(system, user, schema):
            seen.append((system, json.loads(user), schema))
            return {'ideas': [{'family': 'momentum', 'months': 3, 'keep': 2, 'filter': 'trend-200d', 'why': 'Shorter trend, but out of downtrends'},
                              {'family': 'reversal', 'days': 99, 'keep': 2, 'filter': None, 'why': 'out of bounds'}]}, {}
        ideas = ri.invent(llm, [{'name': 'momentum-6m-top3', 'spec': {'family': 'momentum', 'months': 6, 'keep': 3}, 'ahead': 30, 'behind': 16, 'pValue': 0.027}])
        system, payload, schema = seen[0]
        self.assertIn('never write code', system)
        self.assertEqual(payload['resultsSoFar'][0]['name'], 'momentum-6m-top3')
        self.assertEqual(schema['properties']['ideas']['maxItems'], ri.MAX_NEW_PER_MONTH)
        self.assertEqual(ideas[0], {'spec': {'family': 'momentum', 'months': 3, 'keep': 2, 'filter': 'trend-200d'}, 'why': 'Shorter trend, but out of downtrends'})
        with tempfile.TemporaryDirectory() as tmp:  # a schema-ignoring server still cannot store an out-of-grammar idea
            outcomes = ri.propose([i['spec'] for i in ideas], 'model:test', (), Path(tmp) / 'ideas.jsonl', OCT)
        self.assertEqual([o['outcome'] for o in outcomes], ['added', 'invalid'])

    def test_the_explorer_proposes_close_variants_of_the_best_ideas(self):
        variants = ri.explore([{'spec': {'family': 'momentum', 'months': 6, 'keep': 3}}])
        self.assertIn({'family': 'momentum', 'months': 5, 'keep': 3}, variants)
        self.assertIn({'family': 'momentum', 'months': 6, 'keep': 3, 'filter': 'trend-200d'}, variants)
        self.assertNotIn({'family': 'momentum', 'months': 6, 'keep': 3}, variants)  # itself is not a new idea
        self.assertTrue(all(ri.canonical(v) == v for v in variants))


if __name__ == '__main__':
    unittest.main()
