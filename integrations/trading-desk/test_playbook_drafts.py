import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import playbook_drafts as pb


class DraftTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.unknown, self.drafts, self.playbook = root / 'unknown.jsonl', root / 'drafts.json', root / 'problems.json'
        shutil.copy(pb.PLAYBOOK, self.playbook)
        rows = [{'at': '2026-10-20T11:00:00Z', 'step': 'odd-step', 'status': 'failed', 'text': 'SSL handshake reset by peer'},
                {'at': '2026-10-21T11:00:00Z', 'step': 'odd-step', 'status': 'failed', 'text': 'SSL handshake reset by peer'},
                {'at': '2026-10-21T11:00:00Z', 'step': 'money-step', 'status': 'failed', 'text': 'order refused: over limit'},
                {'at': '2026-10-21T11:00:00Z', 'step': 'flaky-step', 'status': 'failed', 'text': 'boom'}]
        self.unknown.write_text('\n'.join(json.dumps(r) for r in rows) + '\n', encoding='utf-8')

    def tearDown(self):
        self.tmp.cleanup()

    def llm(self, system, user, schema):
        step = json.loads(user)['step']
        if step == 'flaky-step':
            raise ValueError('INCOMPLETE_RESPONSE')
        if step == 'money-step':  # claims the agents may act, but the fix touches a limit
            return {'cause': 'The order is larger than the order limit allows.', 'fix': 'Raise the order limit in .env and restart.',
                    'decidedBy': 'agents', 'text': '(?P<bad'}, {}
        return {'cause': 'The provider dropped the connection.', 'fix': 'Wait and rerun the cycle; it usually passes.', 'decidedBy': 'agents',
                'text': 'handshake reset'}, {}

    def test_drafts_one_entry_per_step_and_never_gives_agents_a_money_fix(self):
        out = {o['step']: o for o in pb.draft(self.llm, self.unknown, self.drafts, playbook=self.playbook)}
        self.assertEqual((out['odd-step']['state'], out['odd-step']['decidedBy']), ('drafted', 'agents'))
        self.assertEqual(out['money-step']['decidedBy'], 'owner')  # a limit is the owner's, whatever the model said
        self.assertEqual(out['flaky-step']['state'], 'failed')
        drafts = {d['stepName']: d for d in json.loads(self.drafts.read_text())['drafts']}
        self.assertEqual(drafts['odd-step']['text'], 'handshake reset')
        self.assertEqual(drafts['odd-step']['failures'], 2)
        self.assertEqual(drafts['money-step']['text'], pb.re.escape('order refused: over limit'))  # an invalid pattern falls back
        again = {o['step']: o['state'] for o in pb.draft(self.llm, self.unknown, self.drafts, playbook=self.playbook)}
        self.assertEqual((again['odd-step'], again['money-step']), ('already-drafted', 'already-drafted'))

    def test_the_owner_accepts_a_draft_into_the_playbook_before_the_catch_all(self):
        pb.draft(self.llm, self.unknown, self.drafts, playbook=self.playbook)
        draft_id = next(d['id'] for d in json.loads(self.drafts.read_text())['drafts'] if d['stepName'] == 'odd-step')
        entry = pb.accept(draft_id, self.drafts, self.playbook)
        problems = json.loads(self.playbook.read_text(encoding='utf-8'))['problems']
        self.assertEqual(problems[-1]['id'], 'unknown')
        self.assertEqual(problems[-2]['id'], entry['id'])
        self.assertEqual(entry['step'], '^odd\\-step$')
        self.assertNotIn(draft_id, [d['id'] for d in json.loads(self.drafts.read_text())['drafts']])
        with self.assertRaises(ValueError):
            pb.accept(draft_id, self.drafts, self.playbook)
        # the accepted entry now covers that failure, so it is not drafted again
        again = {o['step']: o['state'] for o in pb.draft(self.llm, self.unknown, self.drafts, playbook=self.playbook)}
        self.assertEqual(again['odd-step'], 'now-known')

    def test_a_pattern_that_matches_everything_or_not_the_failure_is_replaced(self):
        self.assertEqual(pb.safe_pattern('.*', 'disk full'), 'disk\\ full' if pb.re.escape(' ') == '\\ ' else 'disk full')
        self.assertEqual(pb.safe_pattern('network', 'disk full'), pb.re.escape('disk full'))
        self.assertEqual(pb.safe_pattern('disk', 'disk full'), 'disk')


if __name__ == '__main__':
    unittest.main()
