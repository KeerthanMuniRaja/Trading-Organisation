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
        self.assertEqual((calls['RELIANCE.NS']['direction'], calls['RELIANCE.NS']['votes']), ('up', {'up': 3, 'down': 1, 'flat': 0}))
        self.assertEqual(calls['HDFCBANK.NS']['direction'], 'flat')  # split views are no call
        self.assertEqual(calls['RELIANCE.NS']['personas']['sector-analyst'], {'direction': 'flat', 'why': '', 'failed': True})  # marked, not passed off as a view
        self.assertEqual(calls['RELIANCE.NS']['failedVoices'], 1)
        self.assertEqual(calls['RELIANCE.NS']['votes'], {'up': 3, 'down': 1, 'flat': 0})  # failed voices do not vote
        self.assertEqual(r['failedVoices'], 2 + 1)  # the analyst failed on both shares; the bank watcher left HDFC Bank out
        self.assertLessEqual(calls['RELIANCE.NS']['asOf'], '2023-06-01')
        self.assertEqual(sp.run(llm, now=now, stories_path=self.stories, out=self.out, cache=self.cache)['state'], 'already-run')

    def test_the_regime_reaches_the_panel_with_what_it_does_not_tell_a_share_call(self):
        seen = []

        def llm(system, user, schema):
            seen.append(json.loads(user))
            return {'calls': [{'symbol': s, 'direction': 'flat', 'why': 'no effect'} for s in ('RELIANCE.NS', 'HDFCBANK.NS')]}, {}
        sp.ask_panel(llm, {'title': STORY['title'], 'countries': ['US'], 'drivers': ['us-fed-rates'], 'symbols': ['RELIANCE.NS', 'HDFCBANK.NS']},
                     regime='SEVERE on 2026-10-27: 11 distribution days', rounds=1)
        self.assertEqual(seen[0]['marketRegime']['summary'], 'SEVERE on 2026-10-27: 11 distribution days')
        self.assertIn('never a reason for up or down', seen[0]['marketRegime']['note'])

    def test_a_world_event_that_echoed_in_india_is_rehearsed_first_with_its_indian_coverage(self):
        echo = {'driver': 'us-fed-rates', 'abroad': {'title': 'Federal Reserve issues FOMC statement', 'countries': ['US'], 'firstSeen': '2026-10-28T18:00:00Z'},
                'indianStories': 2, 'india': [{'title': 'Sensex jumps after Fed keeps rates unchanged', 'firstSeen': '2026-10-29T04:00:00Z'}],
                'shares': ['HDFCBANK', 'ICICIBANK', 'NOT-OURS']}
        self.stories.write_text(json.dumps({'top': [STORY], 'echoes': [echo]}), encoding='utf-8')
        first, second = sp.linked_stories(self.stories, limit=2)
        self.assertEqual((first['title'], first['countries'], first['symbols']), ('Federal Reserve issues FOMC statement', ['US'], ['HDFCBANK.NS', 'ICICIBANK.NS']))
        self.assertEqual(first['indianCoverage'], ['Sensex jumps after Fed keeps rates unchanged'])
        self.assertEqual(second['title'], STORY['title'])
        seen = []

        def llm(system, user, schema):
            seen.append(json.loads(user))
            return {'calls': []}, {}
        sp.ask_panel(llm, first, rounds=1)
        self.assertEqual(seen[0]['indianCoverage'], ['Sensex jumps after Fed keeps rates unchanged'])  # data for the panel, not instructions

    def test_a_day_when_nobody_answered_is_not_filed_and_can_be_rerun(self):
        now = datetime(2023, 6, 1, 12, tzinfo=timezone.utc)
        r = sp.run(fake_model({p: 'fail' for p in sp.PERSONAS}), now=now, stories_path=self.stories, out=self.out, cache=self.cache)
        self.assertEqual((r['state'], r['failedVoices']), ('no-voices', 10))   # 5 voices on 2 shares, none answered
        self.assertFalse((self.out / 'calls.jsonl').exists())                   # no day of empty calls on file
        later = sp.run(fake_model({p: {'RELIANCE.NS': 'up', 'HDFCBANK.NS': 'flat'} for p in sp.PERSONAS}),
                       now=now, stories_path=self.stories, out=self.out, cache=self.cache)
        self.assertEqual((later['state'], later['directional']), ('rehearsed', 1))  # the model came back: the same day is rehearsed

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

    def test_the_weighted_panel_listens_only_to_personas_that_earned_it_before_the_day(self):
        self.assertEqual(sp.weight(0, 0), 0.0)                      # no record: no say
        self.assertEqual(sp.weight(1, 5), 0.0)                      # a losing record: no say
        self.assertGreater(sp.weight(8, 2), sp.weight(3, 2))         # a better record: more say
        call = {'personas': {'foreign-investor': {'direction': 'up'}, 'retail-trader': {'direction': 'down'}, 'sector-analyst': {'direction': 'down', 'failed': True}}}
        nobody = {p: [0, 0] for p in sp.PERSONAS}
        self.assertEqual(sp.weighted_direction(call, nobody), 'flat')
        earned = {**nobody, 'foreign-investor': [9, 1], 'retail-trader': [2, 6], 'sector-analyst': [9, 0]}
        self.assertEqual(sp.weighted_direction(call, earned), 'up')  # the good record wins; a failed voice never votes
        # in the record: early calls have no earned weights yet, so the weighted panel is silent on them (no hindsight)
        llm = fake_model({p: {'RELIANCE.NS': 'up', 'HDFCBANK.NS': 'down'} for p in sp.PERSONAS})
        sp.run(llm, now=datetime(2023, 6, 1, 12, tzinfo=timezone.utc), stories_path=self.stories, out=self.out, cache=self.cache)
        report = sp.score(out=self.out, cache=self.cache)
        self.assertEqual(report['weightedPanel']['right'] + report['weightedPanel']['wrong'], 0)
        self.assertEqual(set(report['personaWeights']), set(sp.PERSONAS))

    def test_in_round_two_personas_see_the_panel_and_may_change_their_minds(self):
        seen = []

        def llm(system, user, schema):
            persona = next(p for p, who in sp.PERSONAS.items() if who in system)
            payload = json.loads(user)
            seen.append((persona, 'panelFirstRound' in payload))
            # the retail trader follows the crowd in round 2; everyone else keeps their view
            first = {'foreign-investor': 'up', 'domestic-fund': 'up', 'retail-trader': 'down', 'central-bank-watcher': 'flat', 'sector-analyst': 'up'}[persona]
            d = 'up' if persona == 'retail-trader' and 'panelFirstRound' in payload else first
            return {'calls': [{'symbol': s, 'direction': d, 'why': f'{persona} round'} for s in ('RELIANCE.NS', 'HDFCBANK.NS')]}, {}
        answers = sp.ask_panel(llm, {'title': 't', 'countries': [], 'drivers': [], 'symbols': ['HDFCBANK.NS', 'RELIANCE.NS']})
        self.assertEqual(sum(1 for _, second in seen if second), len(sp.PERSONAS))          # everyone who answered joins round 2
        self.assertEqual(answers['retail-trader']['RELIANCE.NS']['direction'], 'up')
        self.assertEqual(answers['retail-trader']['RELIANCE.NS']['firstRound'], 'down')      # the first answer is kept
        calls = sp.panel_calls({'title': 't', 'countries': [], 'symbols': ['RELIANCE.NS']}, answers, '2023-06-01', '2023-06-01')
        self.assertEqual((calls[0]['direction'], calls[0]['firstRoundDirection']), ('up', 'up'))
        summary = sp.first_round_summary(answers, ['RELIANCE.NS'])
        self.assertNotIn('retail-trader', json.dumps(summary))                              # reasons are shown unattributed
        one = sp.ask_panel(llm, {'title': 't', 'countries': [], 'drivers': [], 'symbols': ['RELIANCE.NS']}, rounds=1)
        self.assertNotIn('firstRound', one['retail-trader']['RELIANCE.NS'])

    def test_a_wrong_call_becomes_a_lesson_shown_to_that_persona_next_time(self):
        llm = fake_model({p: {'RELIANCE.NS': 'up', 'HDFCBANK.NS': 'down'} for p in sp.PERSONAS})
        sp.run(llm, now=datetime(2023, 6, 1, 12, tzinfo=timezone.utc), stories_path=self.stories, out=self.out, cache=self.cache)
        asked = []

        def teacher(system, user, schema):
            asked.append(json.loads(user))
            assert schema == sp.REFLECT_SCHEMA
            return {'lesson': 'I followed the headline and ignored that the basket was rising faster.'}, {}
        results = sp.reflect(teacher, out=self.out, cache=self.cache)
        report = sp.score(out=self.out, cache=self.cache)
        wrong = sum(v['wrong'] for v in report['personas'].values())
        self.assertEqual(len([r for r in results if r['state'] == 'learned']), min(wrong, sp.MAX_REFLECT))  # one per wrong call
        if wrong <= sp.MAX_REFLECT:
            self.assertEqual(sp.reflect(teacher, out=self.out, cache=self.cache), [])  # each wrong call is asked about once
        if wrong:
            self.assertIn('moved', asked[0]['outcome'])
            lessons = sp.latest_lessons(self.out)
            self.assertTrue(all(len(v) <= sp.LESSONS_SHOWN for v in lessons.values()))
            shown = []

            def remembering(system, user, schema):
                shown.append(json.loads(user).get('yourRecentLessons'))
                return {'calls': []}, {}
            sp.ask_panel(remembering, {'title': 't', 'countries': [], 'drivers': [], 'symbols': ['RELIANCE.NS']}, lessons=lessons, rounds=1)
            self.assertTrue(any(shown))

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
