import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import review_scorecard as rs


def call(n, fate='executed', correct=True, action='enter-long', reasons=(), created='2026-10-15T11:00:00Z', move=150):
    review = {'outcome': 'accepted' if fate in ('executed', 'lapsed', 'accepted-open') else fate, 'reasons': list(reasons)}
    return {'id': f's{n}', 'action': action, 'createdAt': created, 'review': review,
            'execution': {'id': 'x'} if fate == 'executed' else None, 'lapse': {'releasedPaise': '1'} if fate == 'lapsed' else None,
            'outcome': {'correct': correct, 'moveBps': move if correct else -move}}


class ScorecardTests(unittest.TestCase):
    def test_calls_are_grouped_by_fate_reason_and_regime(self):
        days = [{'date': '2026-10-13', 'risk': 'NORMAL'}, {'date': '2026-10-14', 'risk': 'SEVERE'}, {'date': '2026-10-15', 'risk': 'HIGH'}]
        signals = [call(1), call(2, 'lapsed', False), call(3, 'rejected', True, reasons=['over-budget', 'priced-from-verified-close']),
                   call(4, 'rejected', False, reasons=['over-budget', 'stale-quote'], created='2026-10-15T09:00:00Z'),
                   call(5, 'acknowledged', True, action='no-action'),
                   {**call(6), 'outcome': None}]                       # not scored yet: left out
        card = rs.scorecard(signals, days)
        self.assertEqual(card['calls'], 5)
        self.assertEqual({k: v['scored'] for k, v in card['byFate'].items()}, {'acknowledged': 1, 'executed': 1, 'lapsed': 1, 'rejected': 2})
        self.assertEqual(card['byRejectionReason']['over-budget'], {'scored': 2, 'right': 1, 'rightPct': 50.0, 'averageMovePct': 0.0})
        self.assertNotIn('priced-from-verified-close', card['byRejectionReason'])  # a pricing note, not a reason to refuse
        # 11:00 UTC on the 15th is after that day's close settled (10:30): its regime is known; 09:00 is not, so the 14th's
        self.assertEqual({k: v['scored'] for k, v in card['byRegimeAtCall'].items()}, {'HIGH': 4, 'SEVERE': 1})
        self.assertEqual(card['verdict'], 'insufficient-evidence')
        self.assertIsNone(rs.regime_at(days, '2026-10-13T09:00:00Z'))

    def test_the_verdict_compares_turned_down_calls_with_taken_ones_only_on_enough_evidence(self):
        taken = [call(k, correct=k % 10 < 6) for k in range(20)]                            # 60% right
        worse = [call(100 + k, 'rejected', correct=k % 10 < 3, reasons=['x']) for k in range(20)]   # 30% right
        better = [call(200 + k, 'rejected', correct=k % 10 < 8, reasons=['x']) for k in range(20)]  # 80% right
        close = [call(300 + k, 'rejected', correct=k % 10 < 6, reasons=['x']) for k in range(20)]   # 60% right
        self.assertEqual(rs.scorecard(taken + worse)['verdict'], 'review-turns-down-worse-calls')
        self.assertEqual(rs.scorecard(taken + better)['verdict'], 'review-turns-down-better-calls')
        self.assertEqual(rs.scorecard(taken + close)['verdict'], 'no-clear-difference')
        self.assertEqual(rs.scorecard(taken + worse[:19])['verdict'], 'insufficient-evidence')
        # standing aside is never compared with trading calls
        no_action = [call(400 + k, 'rejected', correct=False, action='no-action') for k in range(20)]
        self.assertEqual(rs.scorecard(taken + no_action)['rejected']['scored'], 0)

    def test_run_reads_every_page_with_the_evaluator_and_writes_the_card(self):
        pages = [{'signals': [call(1)], 'nextBefore': 'cursor'}, {'signals': [call(2, 'rejected', False, reasons=['x'])], 'nextBefore': None}]
        seen = []

        def opener(req, timeout=None):
            seen.append((req.full_url, json.loads(req.data), req.headers.get('Authorization')))
            body = io.BytesIO(json.dumps(pages[len(seen) - 1]).encode())
            body.status = 200
            return body
        env = {'API_URL': 'http://127.0.0.1:3000', 'PRINCIPALS_JSON': json.dumps([{'id': 'e', 'role': 'evaluator', 'token': 'eval-token'}])}
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / 'card.json'
            card = rs.run(env, opener=opener, out=out, regimes=Path(d) / 'none.json')
            self.assertEqual(json.loads(out.read_text(encoding='utf-8'))['calls'], 2)
        self.assertEqual(card['byFate']['rejected']['scored'], 1)
        self.assertEqual([s[1].get('before') for s in seen], [None, 'cursor'])
        self.assertTrue(all(s[0].endswith('/v1/trading/signals/query') and s[2] == 'Bearer eval-token' for s in seen))


if __name__ == '__main__':
    unittest.main()
