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
        r = mentor.refresh(out=self.out, cache=self.cache)
        by = {l['id']: l for l in r['lessons']}
        self.assertEqual(set(by), {l['id'] for l in json.loads(mentor.CURRICULUM.read_text(encoding='utf-8'))['lessons']})
        self.assertIn(by['bank-concentration']['status'], ('checked', 'contradicted'))   # a check ran and judged it
        self.assertIn('correlate', by['bank-concentration']['evidence'])
        self.assertEqual(by['results-gap-risk']['status'], 'unverified')                 # no check yet: said plainly
        self.assertNotIn('evidence', by['results-gap-risk'])

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

    def test_the_debate_sees_the_notes_as_background_data(self):
        signal = {'id': 's', 'symbol': 'SBIN', 'createdAt': '2026-10-23T11:00:00Z', 'evidenceIds': []}
        notes = [{'title': 'Banks', 'lesson': 'Four of our shares are banks.', 'status': 'checked'}]
        ctx = debate.context(signal, self.cache, [], mentor_notes=notes)
        self.assertEqual(ctx['mentorNotes']['lessons'], notes)
        self.assertIn('never evidence', ctx['mentorNotes']['note'])
        self.assertNotIn('mentorNotes', debate.context(signal, self.cache, []))


if __name__ == '__main__':
    unittest.main()
