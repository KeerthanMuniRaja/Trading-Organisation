import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily
import rnd_scout as rs
from test_daily import synthetic_daily

SYMBOLS = sorted(daily.datasets.UNIVERSE)
ENV = {'API_URL': 'http://127.0.0.1:3000', 'PRINCIPALS_JSON': json.dumps([{'role': 'researcher', 'token': 'r-token'},
                                                                         {'role': 'evaluator', 'token': 'e-token'}])}


class FakeBackend:
    def __init__(self, bots=('momentum-rules',), births=()):
        self.calls, self.bots, self.births = [], list(bots), list(births)

    def __call__(self, req, timeout):
        route, body = req.full_url.split('3000', 1)[1], json.loads(req.data) if req.data else None
        self.calls.append((req.get_method(), route, body, req.headers['Authorization'].split()[-1]))
        reply = ([{'id': b} for b in self.bots] if route == '/v1/bots' else {'proposals': [{'botId': b, 'status': 'pending'} for b in self.births]}
                 if route == '/v1/bots/births' else {'id': 'e-1', 'status': 'unverified'} if route == '/v1/evidence' else {'id': 'p-1'})

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self, n):
                return json.dumps(reply).encode()
        return Response()


class PointInTimeTests(unittest.TestCase):
    def test_each_month_ranks_and_judges_only_that_months_members(self):
        import tempfile
        from test_research_checks import table_of
        dates, table = table_of(years=2)
        first, second = sorted(table)[:2]
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'membership.json'
            months = sorted({x[:7] for x in dates})
            mid = months[int(len(months) * 0.8)]  # after the scout's first year of warm-up, so there are months before and after
            # the first share joins only halfway; the second is a member throughout; an unknown company has no prices
            path.write_text(json.dumps({'months': {months[0]: [second.removesuffix('.NS'), 'GONE'],
                                                   mid: [first.removesuffix('.NS'), second.removesuffix('.NS'), 'GONE']}}), encoding='utf-8')
            members_at = rs.membership(path)
            self.assertEqual(members_at(months[0] + '-15'), {second, 'GONE.NS'})
            self.assertIsNone(members_at('1999-01-01'))
            self.assertIsNone(rs.membership(Path(d) / 'none.json'))
            seen = []

            def rule(t, d_, i):
                seen.append((d_[i][:7], set(t)))
                return {s: 1 / len(t) for s in t}
            rows = rs.monthly(table, dates, {'all': rule}, universe_at=members_at)
            early = [s for m, s in seen if m < mid]
            self.assertTrue(early and all(s == {second} for s in early))           # before joining, the first share is invisible
            self.assertTrue(all(first in s for m, s in seen if m >= mid))
            self.assertEqual(rows[0]['coverage'], 0.5)                             # one of two members has prices
            self.assertAlmostEqual(rows[1]['rules']['all'], rows[1]['basketPct'], places=6)  # the basket is the members too (month 1 pays the first purchase)


class ScoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.cache = Path(cls.tmp.name)
        import rnd_ideas
        cls.real_ledger, rnd_ideas.LEDGER = rnd_ideas.LEDGER, Path(cls.tmp.name) / 'no-ideas-yet.jsonl'  # never the owner's ledger
        cls.real_samples, rs.BOOTSTRAP_SAMPLES = rs.BOOTSTRAP_SAMPLES, 300  # the risk lens's resolution is not what these tests check
        for k, symbol in enumerate(SYMBOLS):  # two persistent winners: momentum should find them, month after month
            drift = 0.004 if k < 2 else 0.0
            (cls.cache / f'{symbol}-1d.json').write_text(json.dumps(synthetic_daily(symbol, drift=drift, seed=11 + k)), encoding='utf-8')
        cls.report = rs.scout(cache=cls.cache)

    @classmethod
    def tearDownClass(cls):
        import rnd_ideas
        rnd_ideas.LEDGER = cls.real_ledger
        rs.BOOTSTRAP_SAMPLES = cls.real_samples
        cls.tmp.cleanup()

    def test_invented_ideas_are_tested_too_and_raise_the_bar_for_every_idea(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Path(tmp) / 'ideas.jsonl'
            added = rs.invent('explorer', cache=self.cache, ledger_path=ledger)
            new = [o for o in added if o['outcome'] == 'added']
            self.assertEqual(len(new), 3)  # bounded per month
            report = rs.scout(cache=self.cache, ledger_path=ledger)
            self.assertEqual(report['ideasTried'], 25)
            self.assertAlmostEqual(report['bonferroniThreshold'], 0.05 / 25, places=6)
            invented = [c for c in report['candidates'] if c['source'] == 'ledger:explorer']
            self.assertEqual(sorted(c['name'] for c in invented), sorted(o['name'] for o in new))
            self.assertNotEqual(report['fingerprint'], self.report['fingerprint'])  # what was tried is part of the identity
            # the model may only add specifications; a duplicate of a catalogue idea is refused
            llm = lambda system, user, schema: ({'ideas': [{'family': 'momentum', 'months': 6, 'keep': 3, 'filter': None, 'why': 'copy'},
                                                           {'family': 'low-vol', 'window': 90, 'keep': 2, 'filter': 'trend-200d', 'why': 'calm, out of downtrends'}]}, {})
            from datetime import datetime, timezone
            outcomes = rs.invent('model', cache=self.cache, ledger_path=ledger, llm=llm, now=datetime(2026, 11, 3, tzinfo=timezone.utc))
            self.assertEqual([o['outcome'] for o in outcomes], ['duplicate', 'added'])
            self.assertEqual(outcomes[1]['why'], 'calm, out of downtrends')

    def test_every_idea_is_reported_and_only_robust_skill_passes(self):
        r = self.report
        self.assertEqual((r['ideasTried'], len(r['candidates'])), (22, 22))  # losers stay visible
        self.assertAlmostEqual(r['bonferroniThreshold'], 0.05 / 22, places=6)
        passing = {c['name'] for c in r['candidates'] if c['passes']}
        self.assertIn('momentum-6m-top2', passing)
        for c in r['candidates']:
            self.assertEqual(c['passes'], not c['reasons'])
            if c['passes']:
                self.assertTrue(c['pValue'] < r['bonferroniThreshold'] and all(a > b for a, b in c['halves']))
        self.assertEqual(rs.sign_p(5, 5), 1.0)
        self.assertAlmostEqual(rs.sign_p(15, 5), 0.020695, places=5)
        self.assertEqual(rs.sign_p(3, 9), 1.0)  # behind is never "significant" for the rule

    def test_costs_count_against_turnover(self):
        dates, table = rs.pd.aligned(daily.load(SYMBOLS, self.cache))
        rows = rs.monthly(table, dates, {'equal': lambda t, d, i: {s: 1 / 8 for s in t}})
        first, later = rows[0], rows[1]
        self.assertAlmostEqual(first['rules']['equal'], first['basketPct'] - rs.ONE_WAY_COST_PCT, places=6)  # buying in costs once
        # rebalancing back to equal weights after the month's drift costs what it really would: a little, never nothing
        self.assertGreater(later['turnover']['equal'], 0)
        self.assertLess(later['turnover']['equal'], 0.2)
        self.assertAlmostEqual(later['rules']['equal'], later['basketPct'] - rs.ONE_WAY_COST_PCT * later['turnover']['equal'], places=6)

    def test_decisions_trade_at_the_next_open_and_a_yearly_rule_holds_without_trading(self):
        import rnd_ideas
        dates, table = rs.pd.aligned(daily.load(SYMBOLS, self.cache))
        rows = rs.monthly(table, dates, {'one': lambda t, d, i: {SYMBOLS[0]: 1.0}})
        a = next(i for i in range(rs.START, len(dates)) if dates[i][:7] != dates[i - 1][:7])
        b = next(i for i in range(a + 1, len(dates)) if dates[i][:7] != dates[i - 1][:7])
        expected = 100 * (table[SYMBOLS[0]][dates[b + 1]]['openPaise'] / table[SYMBOLS[0]][dates[a + 1]]['openPaise'] - 1) - rs.ONE_WAY_COST_PCT
        self.assertAlmostEqual(rows[0]['rules']['one'], expected, places=6)  # entered at the open after the decision
        yearly = rnd_ideas.rule_of({'family': 'momentum', 'months': 6, 'keep': 3, 'rebalance': 12})
        held = rs.monthly(table, dates, {'yearly': yearly})
        trades = sum(r['turnover']['yearly'] > 0 for r in held)
        self.assertLessEqual(trades, len(held) // 12 + 1)  # no monthly rebalancing of drift between yearly decisions

    def test_a_result_is_reproducible_for_the_months_it_names(self):
        again = rs.scout(self.report['through'], cache=self.cache)
        c = next(x for x in self.report['candidates'] if x['passes'])
        mine = next(x for x in again['candidates'] if x['name'] == c['name'])
        self.assertEqual(rs.evidence_text(again, mine), rs.evidence_text(self.report, c))
        earlier = rs.scout('2024-06', cache=self.cache)
        self.assertEqual(earlier['through'], '2024-06')
        self.assertNotEqual(rs.evidence_text(earlier, next(x for x in earlier['candidates'] if x['name'] == c['name'])), rs.evidence_text(self.report, c))

    def test_a_passing_idea_becomes_verified_evidence_and_a_birth_proposal(self):
        backend = FakeBackend()
        outcomes = rs.propose(self.report, 'desk', 'desk-research', env=ENV, opener=backend,
                              recompute=lambda through: rs.scout(through, cache=self.cache))
        born = [o for o in outcomes if o['outcome'] == 'birth proposed']
        self.assertTrue(born)
        posts = [c for c in backend.calls if c[0] == 'POST']
        evidence, review, birth = posts[0], posts[1], posts[2]
        self.assertEqual((evidence[1], evidence[3], evidence[2]['kind'], evidence[2]['sourceId']), ('/v1/evidence', 'r-token', 'dataset', 'desk-research'))
        self.assertEqual((review[1], review[3], review[2]['status']), ('/v1/evidence/reviews', 'e-token', 'verified'))  # a different identity
        self.assertEqual(review[2]['expected']['content'], evidence[2]['content'])  # content-bound review
        self.assertEqual((birth[1], birth[3], birth[2]['department'], birth[2]['evidenceIds']), ('/v1/bots/births/proposals', 'r-token', 'desk', ['e-1']))
        self.assertTrue(birth[2]['botId'].startswith('rnd-'))
        # an idea already served by a bot, or already proposed, is not proposed again
        again = FakeBackend(births=[o['botId'] for o in born])
        self.assertEqual({o['outcome'] for o in rs.propose(self.report, 'desk', 'desk-research', env=ENV, opener=again,
                          recompute=lambda through: rs.scout(through, cache=self.cache))}, {'already served'})

    def test_the_evaluator_rejects_evidence_it_cannot_reproduce(self):
        tampered = json.loads(json.dumps(self.report))
        for c in tampered['candidates']:
            if c['passes']:
                c['ahead'] += 1  # an inflated result
        backend = FakeBackend()
        outcomes = rs.propose(tampered, 'desk', 'desk-research', env=ENV, opener=backend, recompute=lambda through: rs.scout(through, cache=self.cache))
        new = [o for o in outcomes if o['outcome'] != 'already served']  # the idea the momentum bot already serves is skipped first
        self.assertTrue(new and all('rejected' in o['outcome'] for o in new))
        self.assertEqual({c[2]['status'] for c in backend.calls if c[1] == '/v1/evidence/reviews'}, {'rejected'})
        self.assertFalse([c for c in backend.calls if c[1] == '/v1/bots/births/proposals'])


if __name__ == '__main__':
    unittest.main()
