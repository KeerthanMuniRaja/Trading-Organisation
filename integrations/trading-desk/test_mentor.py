import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily
import debate
import mentor
from test_daily import synthetic_daily


class MentorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.cache, self.out = root / 'daily', root / 'mentor.json'
        self.cache.mkdir()
        for k, s in enumerate(sorted(daily.datasets.UNIVERSE)):
            (self.cache / f'{s}-1d.json').write_text(json.dumps(synthetic_daily(s, years=3, seed=40 + k)), encoding='utf-8')

    def tearDown(self):
        self.tmp.cleanup()

    def test_every_lesson_is_checked_on_our_data_or_labelled_unverified(self):
        r = mentor.refresh(out=self.out, cache=self.cache, broad=({}, {}))   # no research universe here: broad lessons stay unverified
        by = {l['id']: l for l in r['lessons']}
        self.assertEqual(set(by), {l['id'] for l in json.loads(mentor.CURRICULUM.read_text(encoding='utf-8'))['lessons']})
        self.assertIn(by['bank-concentration']['status'], ('checked', 'contradicted'))   # a check ran and judged it
        self.assertIn('correlate', by['bank-concentration']['evidence'])
        self.assertEqual(by['results-gap-risk']['status'], 'unverified')                 # no check yet: said plainly
        self.assertNotIn('evidence', by['results-gap-risk'])
        # curriculum v2: every new check runs on the data and states a measured number
        for lesson in ('small-sales-pay-the-dp-charge', 'volatility-clusters', 'diversification', 'losses-need-bigger-gains', 'base-rates-first'):
            self.assertIn(by[lesson]['status'], ('checked', 'contradicted'), lesson)
            self.assertTrue(by[lesson]['measured'], lesson)
        # a check that cannot measure (a synthetic trend never sat on both sides of its 200-day average) says so, never guesses
        self.assertIn(by['below-trend-falls-deeper']['status'], ('checked', 'contradicted', 'unverified'))
        self.assertIn('evidence', by['below-trend-falls-deeper'])
        self.assertEqual(by['small-sales-pay-the-dp-charge']['measured']['dpPctOfSale'], 0.96)  # Rs 15.93 on Rs 1,666
        self.assertEqual(by['losses-need-bigger-gains']['status'], 'checked')                     # arithmetic always holds
        self.assertEqual(by['stops-cost-return']['status'], 'unverified')                         # MENTOR-03 without the broad files

    def test_tax_and_past_winners(self):
        dates = [f'd{k:05d}' for k in range(252 * 5)]   # five years of sessions: only their number matters to the tax check
        table = {'A.NS': {d: {'closePaise': 100 * 1.0004 ** k} for k, d in enumerate(dates)}}
        r = mentor.tax_drag(table, dates)
        self.assertTrue(r['holds'])
        self.assertAlmostEqual(r['soldYearlyAfterTaxPct'], round(r['grossCagrPct'] * 0.8, 2), places=1)   # 20% of every year's gain
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(mentor.past_winners(table, dates, rnd=tmp)['holds'])                        # no scout report yet
            (Path(tmp) / 'scout-2026-09.json').write_text(json.dumps({'walkForward': {'outOfSampleMonths': 70, 'ahead': 31, 'behind': 39,
                                                                                       'averageExcessPct': -0.118}}), encoding='utf-8')
            w = mentor.past_winners(table, dates, rnd=tmp)
            self.assertEqual((w['holds'], w['averageExcessPct']), (True, -0.118))

    def test_recovery_needs_more_than_the_fall(self):
        dates = [f'2026-01-{d:02d}' for d in range(1, 6)]
        table = {'A.NS': {d: {'closePaise': c} for d, c in zip(dates, (100, 50, 50, 75, 100))}}
        r = mentor.recovery_maths(table, dates)
        self.assertEqual((r['worstFallPct'], r['gainNeededPct'], r['longestUnderwaterSessions']), (-50.0, 100.0, 3))

    def test_a_decision_gets_only_the_lessons_that_fit_it_and_never_a_contradicted_one(self):
        lessons = [
            {'id': 'banks', 'title': 'Banks', 'lesson': 'b', 'appliesTo': {'symbols': ['SBIN', 'HDFCBANK']}, 'status': 'checked', 'evidence': 'e'},
            {'id': 'results', 'title': 'Results', 'lesson': 'r', 'appliesTo': {'events': ['results']}, 'status': 'unverified'},
            {'id': 'severe', 'title': 'Severe', 'lesson': 's', 'appliesTo': {'regimes': ['SEVERE']}, 'status': 'checked'},
            {'id': 'costs', 'title': 'Costs', 'lesson': 'c', 'appliesTo': {'always': True}, 'status': 'checked'},
            {'id': 'wrong', 'title': 'Wrong', 'lesson': 'w', 'appliesTo': {'symbols': ['SBIN']}, 'status': 'contradicted'}]
        self.out.write_text(json.dumps({'lessons': lessons}), encoding='utf-8')
        titles = lambda **kw: [n['title'] for n in mentor.notes_for(path=self.out, **kw)]  # noqa: E731
        self.assertEqual(titles(symbol='SBIN.NS', events=['results'], regime='SEVERE'), ['Banks', 'Results', 'Severe'])  # most specific first, at most 3
        self.assertEqual(titles(symbol='ITC'), ['Costs'])                 # the bank lesson does not apply to ITC
        self.assertNotIn('Wrong', titles(symbol='SBIN'))                  # contradicted by our data: never shown
        self.assertEqual(mentor.notes_for(symbol='SBIN', path=Path(self.tmp.name) / 'none.json'), [])
        # MENTOR-02: the organisation's own lessons beside the mentor's are read too, and reach the method they are about
        (self.out.parent / 'organisation-lessons.json').write_text(json.dumps({'lessons': [
            {'id': 'org-factor-momentum-6m', 'title': 'A lead, not an edge: momentum-6m', 'lesson': 'm', 'appliesTo': {'methods': ['momentum']}, 'status': 'checked'}]}), encoding='utf-8')
        self.assertIn('A lead, not an edge: momentum-6m', titles(symbol='ITC', method=mentor.method_of('rules:top3-momentum-6m')))
        self.assertNotIn('A lead, not an edge: momentum-6m', titles(symbol='ITC'))
        self.assertEqual((mentor.method_of('rules:top3-momentum-6m'), mentor.method_of('qwen3.5-4b'), mentor.method_of(None)), ('momentum', None, None))

    def test_the_debate_sees_the_notes_as_background_data(self):
        signal = {'id': 's', 'symbol': 'SBIN', 'createdAt': '2026-10-23T11:00:00Z', 'evidenceIds': []}
        notes = [{'title': 'Banks', 'lesson': 'Four of our shares are banks.', 'status': 'checked'}]
        ctx = debate.context(signal, self.cache, [], mentor_notes=notes)
        self.assertEqual(ctx['mentorNotes']['lessons'], notes)
        self.assertIn('never evidence', ctx['mentorNotes']['note'])
        self.assertNotIn('mentorNotes', debate.context(signal, self.cache, []))
        pulse = {'reportedMoves': [{'direction': 'down', 'pct': 3.0, 'why': 'Q2 results'}], 'note': 'press reports read by rules: unverified context, never evidence'}
        self.assertEqual(debate.context(signal, self.cache, [], pulse=pulse)['marketPulse'], pulse)   # AWARE-01
        self.assertNotIn('marketPulse', debate.context(signal, self.cache, []))


if __name__ == '__main__':
    unittest.main()
