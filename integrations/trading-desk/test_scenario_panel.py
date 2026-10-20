from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily
import scenario_panel as sp
from test_daily import synthetic_daily

SYMBOLS = sorted(daily.datasets.UNIVERSE)
STORY = {'title': 'Federal Reserve signals a pause; Brent climbs', 'countries': ['US', 'WORLD'], 'directShares': ['RELIANCE'],
         'drivers': [{'driver': 'us-fed-rates', 'region': 'US', 'shares': ['HDFCBANK']}]}


def fake_model(answers):
    """answers: persona -> {symbol: direction}; the persona is recognised from the system prompt."""
    def llm(system, user, schema):
        persona = next(p for p, who in sp.PERSONAS.items() if who in system)
        if answers.get(persona) == 'fail':
            raise ValueError('INCOMPLETE_RESPONSE')
        assert set(schema['properties']['calls']['items']['properties']['symbol']['enum']) == {'HDFCBANK.NS', 'RELIANCE.NS'}
        return {'calls': [{'symbol': s, 'direction': d, 'why': f'{persona} view'} for s, d in answers.get(persona, {}).items()]}, {}
    return llm


class PanelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.cache, self.out, self.stories = root / 'daily', root / 'scenario', root / 'latest.json'
        self.cache.mkdir()
        for k, s in enumerate(SYMBOLS):
            (self.cache / f'{s}-1d.json').write_text(json.dumps(synthetic_daily(s, seed=3 + k)), encoding='utf-8')
        self.stories.write_text(json.dumps({'top': [STORY, {'title': 'A football final', 'countries': ['WORLD'], 'directShares': [], 'drivers': []}]}))

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_panel_calls_a_direction_only_when_three_of_five_agree(self):
        llm = fake_model({'foreign-investor': {'RELIANCE.NS': 'up', 'HDFCBANK.NS': 'down'}, 'domestic-fund': {'RELIANCE.NS': 'up', 'HDFCBANK.NS': 'up'},
                          'retail-trader': {'RELIANCE.NS': 'up', 'HDFCBANK.NS': 'flat'}, 'central-bank-watcher': {'RELIANCE.NS': 'down'},
                          'sector-analyst': 'fail'})
        now = datetime(2023, 6, 1, 12, tzinfo=timezone.utc)
        r = sp.run(llm, now=now, stories_path=self.stories, out=self.out, cache=self.cache)
        self.assertEqual((r['state'], r['stories'], r['calls'], r['directional']), ('rehearsed', 1, 2, 1))  # the football story reaches no share
        calls = {c['symbol']: c for c in map(json.loads, (self.out / 'calls.jsonl').read_text().splitlines())}
        self.assertEqual((calls['RELIANCE.NS']['direction'], calls['RELIANCE.NS']['votes']), ('up', {'up': 3, 'down': 1, 'flat': 1}))
        self.assertEqual(calls['HDFCBANK.NS']['direction'], 'flat')  # split views are no call
        self.assertEqual(calls['RELIANCE.NS']['personas']['sector-analyst'], {'direction': 'flat', 'why': ''})  # a failed voice is no view
        self.assertLessEqual(calls['RELIANCE.NS']['asOf'], '2023-06-01')
        self.assertEqual(sp.run(llm, now=now, stories_path=self.stories, out=self.out, cache=self.cache)['state'], 'already-run')

    def test_calls_are_scored_against_the_basket_for_the_panel_and_each_persona(self):
        llm = fake_model({p: {'RELIANCE.NS': 'up', 'HDFCBANK.NS': 'down'} for p in sp.PERSONAS})
        for day in (1, 2, 5):
            sp.run(llm, now=datetime(2023, 6, day, 12, tzinfo=timezone.utc), stories_path=self.stories, out=self.out, cache=self.cache)
        report = sp.score(out=self.out, cache=self.cache)
        self.assertEqual((report['calls'], report['waiting']), (6, 0))
        panel = report['panel']
        self.assertEqual(panel['right'] + panel['wrong'], 6)
        self.assertEqual(panel['verdict'], 'insufficient-evidence')  # six calls prove nothing
        self.assertEqual(report['personas']['retail-trader'], panel)  # everyone agreed, so everyone has the panel's record
        self.assertTrue((self.out / 'record.json').exists())

    def test_without_stories_or_with_recent_calls_nothing_is_judged_early(self):
        self.stories.unlink()
        r = sp.run(fake_model({}), now=datetime(2023, 6, 1, tzinfo=timezone.utc), stories_path=self.stories, out=self.out, cache=self.cache)
        self.assertEqual(r['state'], 'nothing-to-rehearse')
        self.out.mkdir(exist_ok=True)
        last = sp.pd.aligned(daily.load(SYMBOLS, self.cache))[0][-1]
        (self.out / 'calls.jsonl').write_text(json.dumps({'day': last, 'asOf': last, 'story': 's', 'countries': [], 'symbol': 'INFY.NS',
                                                          'direction': 'up', 'votes': {}, 'personas': {}}) + '\n')
        self.assertEqual(sp.score(out=self.out, cache=self.cache)['waiting'], 1)  # five sessions have not passed yet


if __name__ == '__main__':
    unittest.main()
