from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_allocator as ai
import daily
import signals_bridge as sb

NOW = datetime(2026, 11, 2, 4, 0, tzinfo=timezone.utc)
LETTERS = ai.mapping('forward', daily.datasets.UNIVERSE)


def month(weights, outcome='valid'):
    return {'outcome': outcome, 'weights': dict(zip(ai.LETTERS, weights)), 'rationale': 'Tilt to trend.', 'facts': {}}


class AllocatorTests(unittest.TestCase):
    def test_only_material_changes_become_proposals(self):
        state = {'model': 'Qwen3.5-4B-Q4_K_M', 'promptVersion': '0634b9cf839d47d2', 'months': {
            '2026-10-01': month([12, 12, 12, 12, 12, 12, 12, 12]),
            '2026-10-15': month([0] * 8, outcome='failed'),  # a failed month is skipped when finding the previous weights
            '2026-11-02': month([20, 13, 12, 0, 12, 12, 14, 12])}}
        out = sb.from_allocator(state, '2026-11-02', LETTERS, 'org-allocator', ['e1'], NOW)
        by = {p['symbol']: p for p in out}
        self.assertEqual(sorted((p['symbol'], p['action'], p['conviction']) for p in out),
                         sorted([(sb.ticker(LETTERS['A']), 'enter-long', 'high'), (sb.ticker(LETTERS['D']), 'exit', 'medium')]))
        self.assertNotIn(sb.ticker(LETTERS['G']), by)  # +2 points is not material; B's +1 neither
        long = by[sb.ticker(LETTERS['A'])]
        self.assertIn('from 12% to 20%', long['thesis'])
        self.assertTrue(long['invalidation'].startswith('Rule-derived'))
        self.assertEqual((long['expiresAt'], long['horizonDays'], long['evidenceIds']), ('2026-11-05T04:00:00Z', 30, ['e1']))
        self.assertEqual(long['targetWeightPct'], 20)  # the review never sizes beyond the allocator's own weight
        self.assertFalse(long['symbol'].endswith('.NS'))
        first = sb.from_allocator(state, '2026-10-01', LETTERS, 'org-allocator', ['e1'], NOW)
        self.assertEqual(len(first), 8)  # from cash, every 12% position is a new long
        self.assertEqual(sb.from_allocator(state, '2026-10-15', LETTERS, 'b', ['e1'], NOW), [])


class MeetingTests(unittest.TestCase):
    def record(self, action, stances):
        bots = {role: {'outcome': 'valid', 'opinion': {'stance': s, 'conviction': c, 'reasons': ['r'], 'invalidation': f'{role} stop'}}
                for role, (s, c) in stances.items()}
        bots['portfolio-manager'] = {'outcome': 'valid', 'decision': {'action': action, 'rationale': 'Momentum confirmed', 'reliedOn': []}}
        return {'action': action, 'bots': bots}

    def test_a_buy_takes_conviction_and_invalidation_from_the_strongest_agreeing_analyst(self):
        record = self.record('buy', {'trend-analyst': ('bullish', 'medium'), 'reversion-analyst': ('bullish', 'high'),
                                     'news-analyst': ('bearish', 'high')})
        p = sb.from_meeting(record, 'RELIANCE.NS', 'desk-pm', ['e1'], NOW, model='m')
        self.assertEqual((p['action'], p['conviction'], p['invalidation'], p['symbol']), ('enter-long', 'high', 'reversion-analyst stop', 'RELIANCE'))
        self.assertEqual(p['horizonDays'], 1)

    def test_hold_is_an_explicit_no_action_call_and_unsupported_sells_are_low_conviction(self):
        hold = sb.from_meeting(self.record('hold', {'trend-analyst': ('neutral', 'low')}), 'INFY.NS', 'pm', [], NOW)
        self.assertEqual(hold['action'], 'no-action')
        self.assertNotIn('invalidation', hold)
        sell = sb.from_meeting(self.record('sell', {'trend-analyst': ('bullish', 'high')}), 'INFY.NS', 'pm', ['e1'], NOW)
        self.assertEqual((sell['action'], sell['conviction'], sell['invalidation']), ('exit', 'low', 'The desk risk stop is hit.'))


class DissentTests(unittest.TestCase):
    def test_analysts_against_the_managers_action_become_challengers_under_their_own_identity(self):
        record = MeetingTests.record(None, 'buy', {'trend-analyst': ('bullish', 'high'), 'news-analyst': ('bearish', 'high'),
                                                   'reversion-analyst': ('bearish', 'low')})
        bots = {'trend-analyst': 'trend-bot', 'news-analyst': 'news-bot'}  # reversion has no organisation identity here
        out = sb.dissent(record, bots)
        self.assertEqual([(c['botId'], c['stance']) for c in out], [('news-bot', 'oppose')])
        self.assertTrue(out[0]['argument'].startswith('news-analyst is bearish (high conviction): r'))
        self.assertEqual(sb.dissent(MeetingTests.record(None, 'hold', {'news-analyst': ('bearish', 'high')}), bots), [])  # nothing to oppose

        sent = []

        class Response:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n): return json.dumps({'id': 'c1'}).encode()

        def opener(req, timeout):
            sent.append((req.full_url, req.headers['Authorization'], json.loads(req.data)))
            return Response()
        env = {'API_URL': 'http://127.0.0.1:3000', 'PRINCIPALS_JSON': json.dumps([{'role': 'researcher', 'botId': 'news-bot', 'token': 'news-token'}])}
        sb.submit_challenges('sig-1', out, env, opener)
        self.assertEqual(sent[0][:2], ('http://127.0.0.1:3000/v1/trading/signals/challenges', 'Bearer news-token'))
        self.assertEqual(sent[0][2]['signalId'], 'sig-1')
        self.assertNotIn('evidenceId', sent[0][2])  # without evidence: recorded, but it cannot change a size
        cited = sb.dissent(record, bots, evidence_id='ev-verified')
        sb.submit_challenges('sig-2', cited, env, opener)
        self.assertEqual(sent[-1][2]['evidenceId'], 'ev-verified')  # an evidenced objection: it sizes a high-conviction long as medium


class SubmitTests(unittest.TestCase):
    def test_each_proposal_uses_the_credential_bound_to_its_bot(self):
        sent = []

        class Response:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n): return json.dumps({'id': 's1', 'duplicate': False}).encode()

        def opener(req, timeout):
            sent.append((req.full_url, req.headers['Authorization'], req.headers['Idempotency-key']))
            return Response()
        env = {'API_URL': 'http://127.0.0.1:3000', 'PRINCIPALS_JSON': json.dumps([
            {'role': 'trader', 'botId': 'org-allocator', 'token': 'alloc-token'}, {'role': 'trader', 'botId': 'other', 'token': 'other-token'},
            {'role': 'evaluator', 'token': 'eval-token'}])}
        proposal = {'botId': 'org-allocator', 'symbol': 'INFY', 'action': 'no-action', 'conviction': 'low', 'horizonDays': 1,
                    'thesis': 't', 'expiresAt': '2026-11-02T10:00:00Z', 'evidenceIds': []}
        sb.submit([proposal], env, opener)
        sb.submit([proposal], env, opener)
        self.assertEqual(sent[0][:2], ('http://127.0.0.1:3000/v1/trading/signals', 'Bearer alloc-token'))
        self.assertEqual(sent[0][2], sent[1][2])  # a retry reuses the same idempotency key
        with self.assertRaisesRegex(ValueError, 'bound to bot nobody'):
            sb.submit([{**proposal, 'botId': 'nobody'}], env, opener)
        with self.assertRaisesRegex(ValueError, 'origin'):
            sb.submit([proposal], {**env, 'API_URL': 'http://evil.example.com'}, opener)


if __name__ == '__main__':
    unittest.main()
