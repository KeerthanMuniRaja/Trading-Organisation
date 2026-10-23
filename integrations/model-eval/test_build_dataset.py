import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_dataset as bd
import model_eval as me
from test_model_eval import CASES

NEWS = {'title': 'HDFC Bank Q2 profit rises 10.5%', 'publishedAt': '2026-10-18T10:00:00+05:30',
        'text': 'HDFC Bank reported a standalone net profit of Rs 16,821 crore for Q2 FY27, up 10.5% from a year earlier.'}
GOOD_CLAIM = {'statement': 'HDFC Bank profit rose 10.5%.', 'quote': 'standalone net profit of Rs 16,821 crore for Q2 FY27, up 10.5%',
              'symbols': ['HDFCBANK.NS'], 'eventType': 'earnings', 'direction': 'positive', 'eventDate': None, 'certainty': 'reported-fact',
              'metric': 'net profit', 'period': 'Q2 FY27', 'reportedChangePct': 10.5}
INVENTED = {**GOOD_CLAIM, 'quote': 'net profit jumped 25% to a record high', 'reportedChangePct': 25.0}


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.journal, self.evals, self.out = root / 'calls', root / 'evals', root / 'data'
        self.journal.mkdir()
        user = json.dumps({'allowedCompanies': {}, **NEWS})
        playbook_user = json.dumps({'step': 'eod-trading', 'failures': 2, 'lastFailureText': 'Order exceeds configured limit'})
        rows = [
            {'system': me.claims.SYSTEM, 'user': user, 'answer': {'claims': [GOOD_CLAIM]}},                  # all checks pass
            {'system': me.claims.SYSTEM, 'user': user, 'answer': {'claims': [GOOD_CLAIM, INVENTED]}},        # one invented quote
            {'system': me.claims.SYSTEM, 'user': user, 'answer': {'oops': 1}},                               # unusable
            {'system': me.claims.SYSTEM, 'user': user, 'answer': {'claims': [GOOD_CLAIM]}},                  # an exact repeat
            {'system': me.playbook_drafts.SYSTEM, 'user': playbook_user,
             'answer': {'cause': 'The limit refused it.', 'fix': 'Raise the order limit in .env.', 'decidedBy': 'agents', 'text': 'configured limit'}},
            {'system': me.scenario_panel.SYSTEM.format(who='a retail trader'), 'user': '{"story": "x"}', 'answer': {'calls': []}},
            {'system': 'Some other prompt', 'user': '{}', 'answer': {}},
            {'system': me.claims.SYSTEM, 'user': user, 'answer': None, 'error': 'TIMEOUT'},
        ]
        (self.journal / '2026-10-21.jsonl').write_text('\n'.join(json.dumps(r) for r in rows) + '\n', encoding='utf-8')

    def tearDown(self):
        self.tmp.cleanup()

    def test_answers_are_labelled_by_our_own_checks_and_exported_for_training(self):
        m = bd.build(self.journal, self.evals, self.out)
        self.assertEqual(m['counts']['claims']['production'], {'good': 1, 'fixable': 1, 'bad': 1})  # the repeat is counted once
        self.assertEqual(m['counts']['playbook']['production'], {'fixable': 1})
        self.assertEqual(m['counts']['scenario']['production'], {'awaiting-outcome': 1})  # opinions wait for their outcome
        sft = [json.loads(l) for l in (self.out / 'claims' / 'sft.jsonl').read_text(encoding='utf-8').splitlines()]
        self.assertEqual([m['role'] for m in sft[0]['messages']], ['system', 'user', 'assistant'])
        pref = json.loads((self.out / 'claims' / 'preference.jsonl').read_text(encoding='utf-8'))
        chosen, rejected = json.loads(pref['chosen'][0]['content']), json.loads(pref['rejected'][0]['content'])
        self.assertEqual((len(chosen['claims']), len(rejected['claims'])), (1, 2))   # the invented quote is what was removed
        self.assertIn('quote-not-in-source', pref['reasons'])
        fixed = json.loads(json.loads((self.out / 'playbook' / 'preference.jsonl').read_text(encoding='utf-8'))['chosen'][0]['content'])
        self.assertEqual(fixed['decidedBy'], 'owner')                                  # a limits fix is the owner's
        self.assertEqual(len(m['fingerprint']), 16)

    def test_evaluation_answers_are_included_and_marked_as_such(self):
        run = self.evals / '20261021T060403Z'
        run.mkdir(parents=True)
        case = next(c for c in CASES if c['id'] == 'debate-bull-injection')
        system, user, _ = me.prompt(case, case['input'])
        (run / 'results.jsonl').write_text(json.dumps({'system': system, 'user': user, 'answer': {'argument': 'Defensive earnings may hold up in a slowdown.', 'evidenceId': 'ev-fake-99'}}) + '\n', encoding='utf-8')
        m = bd.build(self.journal, self.evals, self.out)
        self.assertEqual(m['counts']['debate']['evaluation'], {'fixable': 1})   # cited evidence it may not cite: corrected to none
        self.assertIn('invented fixtures', m['note'])
        self.assertIn('eval-only/debate-preference.jsonl', m['files'])            # evaluation rows never reach a training file
        self.assertFalse((self.out / 'debate' / 'preference.jsonl').exists())
        row = json.loads((self.out / 'eval-only' / 'debate-preference.jsonl').read_text(encoding='utf-8'))
        self.assertEqual(row['source'], 'evaluation')
        self.assertTrue((self.out / 'claims' / 'kto.jsonl').exists())              # the unusable production answer, labelled undesirable

    def test_the_production_journal_records_calls_and_can_be_switched_off(self):
        import os
        folder = Path(self.tmp.name) / 'journal'
        me.claims.journal_call('Qwen3.5-4B-Q4_K_M', 'sys', '{"x":1}', {'type': 'object'}, {'ok': True}, None, 1.234, folder)
        me.claims.journal_call('Qwen3.5-4B-Q4_K_M', 'sys', '{"x":1}', {'type': 'object'}, None, 'TIMEOUT', 300, folder)
        rows = [json.loads(l) for f in folder.glob('*.jsonl') for l in f.read_text(encoding='utf-8').splitlines()]
        self.assertEqual([(r['answer'], r['error'], r['seconds']) for r in rows], [({'ok': True}, None, 1.23), (None, 'TIMEOUT', 300)])
        self.assertEqual(set(rows[0]), {'at', 'model', 'system', 'user', 'schemaHash', 'answer', 'error', 'seconds'})  # no key, no endpoint
        os.environ['MODEL_CALL_JOURNAL'] = 'off'
        try:
            me.claims.journal_call('m', 's', 'u', {}, {}, None, 1, folder)
        finally:
            del os.environ['MODEL_CALL_JOURNAL']
        self.assertEqual(sum(len(f.read_text(encoding='utf-8').splitlines()) for f in folder.glob('*.jsonl')), 2)

    def test_every_task_prompt_is_recognised(self):
        for case in CASES:
            for persona in case.get('personas') or [None]:
                self.assertEqual(bd.task_of(me.prompt(case, case['input'], persona)[0]), case['task'], case['id'])


if __name__ == '__main__':
    unittest.main()
