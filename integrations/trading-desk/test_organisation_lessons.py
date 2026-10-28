import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import organisation_lessons as ol


def factor(name, t, passes=False, mean=0.03, excess=0.5, ahead=60, behind=40):
    return {'name': name, 'description': f'the {name} signal', 'passes': passes, 'reasons': [] if passes else ['bar'],
            'ic': {'mean': mean, 'tStat': t}, 'topQuintile': {'averageExcessPct': excess, 'ahead': ahead, 'behind': behind}}


LAB = {'sharesWithData': 480, 'months': 119, 'through': '2026-09', 'factorsTried': 8, 'fingerprint': 'f1',
       'factors': [factor('momentum-6m', 2.6, passes=True), factor('momentum-12-1', 2.2), factor('low-vol-60d', -2.4, mean=-0.02, excess=-0.7),
                   factor('reversal-1m', 0.6), factor('near-52w-high', 1.1)]}
SCOUT = {'through': '2026-09', 'fingerprint': 's1', 'ideasTried': 22, 'basketStats': {'afterTaxCagrPct': 12.55},
         'candidates': [{'name': 'momentum-6m-top3', 'passes': False, 'proof': {'afterTaxCagrPct': 9.8}},
                        {'name': 'reversal-1m-bottom3', 'passes': False, 'proof': {'afterTaxCagrPct': 12.1}}]}


class OrganisationLessonsTests(unittest.TestCase):
    def test_every_finding_becomes_an_honest_lesson(self):
        lessons = {l['id']: l for l in ol.from_factor_lab(LAB)}
        self.assertIn('passed', lessons['org-factor-momentum-6m']['title'])
        self.assertIn('not yet proof', lessons['org-factor-momentum-6m']['lesson'])            # a pass is a candidate, never proof
        self.assertIn('lead, not an edge', lessons['org-factor-momentum-12-1']['title'])
        self.assertIn('WRONG way', lessons['org-factor-low-vol-60d']['lesson'])
        self.assertIn('reversal-1m, near-52w-high', lessons['org-factor-no-signal']['lesson'])
        self.assertEqual(lessons['org-factor-momentum-12-1']['appliesTo'], {'methods': ['momentum']})
        self.assertTrue(all('survivorship' in l['lesson'] for k, l in lessons.items() if k != 'org-factor-low-vol-60d' and k != 'org-factor-no-signal'))
        [scout] = ol.from_scout(SCOUT)
        self.assertIn('none of the 22 ideas', scout['lesson'])
        self.assertIn('reversal-1m-bottom3', scout['lesson'])  # the best after tax, against the basket
        self.assertEqual((ol.from_factor_lab(None), ol.from_scout(None)), ([], []))

    def test_when_the_factors_work_after_a_deep_fall(self):
        side = lambda after, other: {'afterDeepFall': {'months': 4, 'averageExcessPct': after, 'ahead': int(after > 0) * 4, 'behind': int(after < 0) * 4},  # noqa: E731
                                     'otherwise': {'months': 100, 'averageExcessPct': other, 'ahead': 60, 'behind': 40}}
        lab = {**LAB, 'factors': [{**f, 'byCondition': side(a, o)} for f, (a, o) in zip(LAB['factors'], ((-1.7, 0.9), (-1.5, 0.7), (-2.3, -0.7), (3.1, -0.4), (-4.2, 0.2)))]}
        [lesson] = ol.from_conditions(lab)
        self.assertEqual(lesson['title'], 'After a deep market fall, reversal-1m led and near-52w-high lagged')
        self.assertIn('momentum-12-1 -1.5% a month', lesson['lesson'])
        self.assertIn('Only 4 months', lesson['lesson'])
        self.assertEqual(lesson['appliesTo'], {'regimes': ['HIGH', 'SEVERE'], 'methods': ['momentum', 'reversal', 'trend']})
        self.assertEqual(ol.from_conditions(LAB), [])            # an older report without the split: no lesson
        self.assertNotIn('Now:', lesson['lesson'])                 # a report without the current condition says nothing about now
        [held] = ol.from_conditions({**lab, 'now': {'universeSixMonthPct': -18.2, 'afterDeepFall': True}})
        self.assertIn('Now: the universe moved -18.2% over the 6 months to 2026-09, so this condition HOLDS', held['lesson'])
        [calm] = ol.from_conditions({**lab, 'now': {'universeSixMonthPct': 4.0, 'afterDeepFall': False}})
        self.assertIn('the condition does not hold now', calm['lesson'])

    def test_a_kind_of_news_speaks_only_when_it_stands_out(self):
        report = {'horizonSessions': 5, 'byKind': [
            {'kind': 'results', 'direction': 'up', 'cases': 40, 'avgNextWeekPct': 1.2, 'continuedPct': 62, 'tStat': 2.4, 'enough': True},
            {'kind': 'broker-call', 'direction': 'up', 'cases': 35, 'avgNextWeekPct': -0.2, 'continuedPct': 48, 'tStat': -0.5, 'enough': True},
            {'kind': 'deal-or-stake', 'direction': 'down', 'cases': 5, 'avgNextWeekPct': -6.0, 'continuedPct': 100, 'tStat': -5.0, 'enough': False}]}
        [lesson] = ol.from_reactions(report)
        self.assertEqual(lesson['title'], 'After a press-reported rise on results news, the move continued')
        self.assertIn('never act on it alone', lesson['lesson'])
        self.assertEqual(ol.from_reactions(None), [])

    def test_the_lessons_are_rebuilt_from_the_newest_reports(self):
        with tempfile.TemporaryDirectory() as tmp:
            rnd = Path(tmp)
            (rnd / 'factor-lab-2026-08.json').write_text(json.dumps({**LAB, 'through': '2026-08', 'factors': [factor('momentum-6m', 0.4)]}), encoding='utf-8')
            (rnd / 'factor-lab-2026-09.json').write_text(json.dumps(LAB), encoding='utf-8')
            (rnd / 'scout-2026-09.json').write_text(json.dumps(SCOUT), encoding='utf-8')
            (rnd / 'scout-nifty50-2026-09.json').write_text(json.dumps({**SCOUT, 'ideasTried': 99}), encoding='utf-8')
            report = ol.build(rnd=rnd, out=rnd / 'out.json', reactions=None)
            self.assertEqual(report['sources']['factorLab']['through'], '2026-09')   # the newest lab
            self.assertIn('none of the 22 ideas', next(l for l in report['lessons'] if l['id'] == 'org-scout-summary')['lesson'])  # the desk scout
            self.assertTrue(all(l['author'] == 'organisation' and l['status'] == 'checked' for l in report['lessons']))
            self.assertEqual({l['evidence'] for l in report['lessons']}, {'our factor lab, through 2026-09', 'our R&D scout, through 2026-09'})


if __name__ == '__main__':
    unittest.main()
