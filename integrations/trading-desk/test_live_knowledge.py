import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import live_knowledge as lk

SCOUT = {'from': '2017-12', 'through': '2026-09', 'ideasTried': 17, 'bonferroniThreshold': 0.0029,
         'basketStats': {'cagrPct': 13.6, 'sharpe': 0.79, 'maxDrawdownPct': -35.3},
         'randomBaseline': {'medianExcessPct': -0.16}, 'walkForward': {'outOfSampleMonths': 70, 'ahead': 33, 'behind': 37, 'averageExcessPct': -0.35, 'picks': []},
         'candidates': [
             {'name': 'momentum-6m-top3', 'ahead': 61, 'behind': 45, 'averageExcessPct': 0.0, 'pValue': 0.07, 'beatsRandomPct': 81, 'passes': False,
              'stats': {'sharpe': 0.66, 'maxDrawdownPct': -42.2}},
             {'name': 'trend-filter-200d', 'ahead': 7, 'behind': 18, 'averageExcessPct': -0.12, 'pValue': 1.0, 'beatsRandomPct': 40, 'passes': False,
              'stats': {'sharpe': 0.95, 'maxDrawdownPct': -12.7}}]}


class LiveKnowledgeTests(unittest.TestCase):
    def test_refresh_gathers_the_newest_evidence_and_briefing_stays_short(self):
        with tempfile.TemporaryDirectory() as tmp:
            desk = Path(tmp)
            for sub, name, value in (('rnd', 'scout-2026-09.json', SCOUT),
                                     ('rnd', 'scout-nifty50-2026-09.json', {**SCOUT, 'warning': 'RESEARCH ONLY'}),
                                     ('regime', 'latest.json', {'date': '2026-10-19', 'risk': 'SEVERE', 'distributionDays': 9, 'breadth200d': 1, 'shares': 8,
                                                                'aboveTrend200d': False, 'exposureCeilingPct': 0}),
                                     ('regime', 'study.json', {'verdict': 'warns-of-falls'}),
                                     ('chains', 'link-study.json', {'headlines': 279, 'drivers': {'crude-oil': {'verdict': 'link-carries-information'},
                                                                                                  'us-fed-rates': {'verdict': 'insufficient-evidence'}}})):
                (desk / sub).mkdir(exist_ok=True)
                (desk / sub / name).write_text(json.dumps(value), encoding='utf-8')
            live = lk.refresh(desk)
            self.assertEqual(live['research']['lowestRisk']['name'], 'trend-filter-200d')
            self.assertEqual(live['research']['walkForward']['averageExcessPct'], -0.35)
            self.assertEqual(live['researchNifty50']['warning'], 'RESEARCH ONLY')
            self.assertEqual((live['regime']['risk'], live['regime']['studyVerdict']), ('SEVERE', 'warns-of-falls'))
            self.assertEqual(live['newsLinks']['carrying'], ['crude-oil'])
            self.assertIsNone(live['scenarioPanel'])
            brief = lk.briefing(desk)
            self.assertIn('SEVERE on 2026-10-19', brief['marketRegime'])
            self.assertEqual(len(brief['lessons']), len(lk.DECISION_LESSONS))
            self.assertLess(len(json.dumps(brief)), 4000)  # small enough for a 4B model's prompt

    def test_without_evidence_the_briefing_says_unknown(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(lk.briefing(Path(tmp))['marketRegime'], 'unknown')
            self.assertIsNone(lk.refresh(Path(tmp))['research'])


if __name__ == '__main__':
    unittest.main()
