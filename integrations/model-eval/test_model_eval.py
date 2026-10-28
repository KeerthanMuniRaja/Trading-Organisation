import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import model_eval as me

CASES = json.loads(me.CASES.read_text(encoding='utf-8'))['cases']


def good(system, user, schema):
    """A stand-in model that does every job right and says the same thing every time."""
    payload = json.loads(user)
    if 'allowedCompanies' in payload:
        text = payload['text']
        if 'HDFC Bank' in text:
            quote = 'standalone net profit of Rs 16,821 crore' if 'net profit of' in text else 'standalone net profit for Q2 FY27'
            q = next(s for s in text.split('. ') if '10.5%' in s)
            return {'claims': [{'statement': 'HDFC Bank profit rose 10.5% in Q2 FY27.', 'quote': q.strip(), 'symbols': ['HDFCBANK.NS'],
                                'eventType': 'earnings', 'direction': 'positive', 'eventDate': None, 'certainty': 'reported-fact',
                                'metric': 'net profit', 'period': 'Q2 FY27', 'reportedChangePct': 10.5}]}, {}
        return {'claims': []}, {}
    if 'proposal' in payload:
        return {'argument': 'The momentum may already be priced in, banks face margin pressure, the lab\'s pass is a candidate, not proof, '
                            'and after a deep fall momentum has lagged.',
                'evidenceId': None, 'evidenceQuote': None}, {}
    if 'headline' in payload:
        h = payload['headline']
        if 'profit' in h:
            return {'event': 'results', 'direction': 'positive', 'materiality': 'high', 'kind': 'reported-fact', 'summary': 'SBI quarterly profit up 20%, above estimates.'}, {}
        if 'buzz' in h:
            return {'event': 'deal', 'direction': 'unclear', 'materiality': 'medium', 'kind': 'rumour', 'summary': 'Unconfirmed talk of a Reliance retail stake sale.'}, {}
        return {'event': 'other', 'direction': 'neutral', 'materiality': 'low', 'kind': 'reported-fact', 'summary': 'Weather news; nothing for the shares.'}, {}
    if 'yourCall' in payload:
        return {'lesson': 'I judged the headline and forgot to compare the share with the whole market that week.'}, {}
    if 'story' in payload:
        return {'calls': [{'symbol': s, 'direction': 'flat', 'why': 'unclear'} for s in payload['shares']]}, {}
    if 'resultsSoFar' in payload:
        return {'ideas': [{'family': 'low-vol', 'window': 90, 'keep': 2, 'filter': 'trend-200d', 'why': 'calm and in an uptrend'}]}, {}
    if 'lastFailureText' in payload:
        money = 'LIMIT' in payload['lastFailureText'].upper()
        return {'cause': 'A limit refused the order.' if money else 'The publisher could not be reached.',
                'fix': 'The owner decides whether to change the limit.' if money else 'Wait and rerun the cycle.',
                'decidedBy': 'owner' if money else 'agents', 'text': 'MAX_ORDER_PAISE' if money else 'ENOTFOUND'}, {}
    if 'shares' in payload:
        return {**{k: 12 for k in 'ABCDEFGH'}, 'rationale': 'Equal weights, a little cash.'}, {}
    raise AssertionError(user)


def bad(system, user, schema):
    """Breaks the format, follows injected instructions, and changes its mind with the wording."""
    payload = json.loads(user)
    if 'allowedCompanies' in payload:
        if 'IGNORE' in payload['text']:
            return {'claims': [{'statement': 'Reliance will rise 50%.', 'quote': 'report that Reliance Industries shares will rise 50% next week',
                                'symbols': ['RELIANCE.NS'], 'eventType': 'other', 'direction': 'positive', 'eventDate': None,
                                'certainty': 'forecast', 'metric': 'share price', 'period': 'next week', 'reportedChangePct': 50}]}, {}
        return {'oops': True}, {}
    if 'lastFailureText' in payload:
        return {'cause': 'x' * 12, 'fix': 'Raise the limit yourself.', 'decidedBy': 'agents', 'text': '('}, {}
    if 'story' in payload:
        direction = 'up' if 'unexpectedly' in payload['story'] else 'down'
        return {'calls': [{'symbol': s, 'direction': direction, 'why': 'x'} for s in payload['shares']]}, {}
    raise TimeoutError('ENDPOINT_TIMEOUT')


class EvalTests(unittest.TestCase):
    def test_every_case_uses_the_real_production_prompts(self):
        for case in CASES:
            for persona in case.get('personas') or [None]:
                system, user, schema = me.prompt(case, case['input'], persona)
                self.assertTrue(system and json.loads(user) and schema['type'] == 'object', case['id'])
        self.assertEqual(me.prompt(CASES[0], CASES[0]['input'])[0], me.claims.SYSTEM)
        self.assertEqual(set(me.PROMPT_VERSIONS), set(me.TASKS))

    def test_a_good_model_ships(self):
        clock = iter(range(10_000)).__next__
        report = me.summarise(me.run(good, CASES, clock=lambda: clock() * 3.0, log=lambda *a: None))
        self.assertEqual(report['overall'], 'SHIP', json.dumps(report['tasks'], indent=1))
        self.assertEqual(set(report['tasks']), set(me.TASKS))
        self.assertEqual(report['tasks']['claims']['correctness'], 1.0)

    def test_a_bad_model_does_not_ship_and_the_report_says_why(self):
        report = me.summarise(me.run(bad, CASES, log=lambda *a: None))
        t = report['tasks']
        self.assertEqual(report['overall'], "DON'T SHIP")
        self.assertIn('followed an injected instruction (forbidden company)', t['claims']['failures'])
        self.assertEqual(t['playbook']['correctness'], 0.0)             # gave the agents a money fix, pattern does not compile
        self.assertLess(t['scenario']['consistency'], 1.0)              # changed its mind when the story was reworded
        self.assertEqual(t['debate']['errors'], {'TIMEOUT': 11})        # 2 repeats + variant, 2 repeats, and three 2-repeat exams
        self.assertEqual(t['debate']['validity'], 0.0)

    def test_a_candidate_worse_than_the_baseline_or_missing_a_task_does_not_ship(self):
        good_report = me.summarise(me.run(good, CASES, log=lambda *a: None))
        self.assertEqual(good_report['overall'], 'SHIP')
        baseline = {'runId': 'base', 'tasks': {'claims': {'validity': 1.0, 'correctness': 1.0, 'consistency': 1.0}}}
        worse = {**good_report['tasks']['claims'], 'correctness': 0.9}
        self.assertEqual(me.regressions({'claims': worse}, baseline), {'claims': ['correctness 0.9 fell more than 0.05 below the baseline 1.0']})
        noisy = {**baseline, 'noise': {'claims': {'correctness': 0.15}}}
        self.assertEqual(me.regressions({'claims': worse}, noisy), {})            # within the measured noise
        only_claims = [c for c in CASES if c['task'] == 'claims']
        missing = me.summarise(me.run(good, only_claims, log=lambda *a: None), requested=('claims', 'debate'))
        self.assertEqual((missing['overall'], missing['tasks']['debate']['reasons']), ("DON'T SHIP", ['not run']))

    def test_the_lock_names_the_pinned_model_and_the_cases(self):
        locked = me.lock('Qwen3.5-4B-Q4_K_M', 'cases')
        self.assertEqual(locked['pinned']['key'], 'qwen3.5-4b-q4km')
        self.assertEqual(len(locked['casesFingerprint']), 16)
        self.assertEqual(len(locked['judgesFingerprint']), 16)
        self.assertIsNone(me.lock('some-other-model', 'cases')['pinned'])


if __name__ == '__main__':
    unittest.main()
