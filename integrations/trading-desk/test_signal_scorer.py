from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import signal_scorer as sc

BARS = [{'date': d, 'openPaise': p, 'highPaise': p, 'lowPaise': p, 'closePaise': p, 'volume': 1}
        for d, p in [('2026-11-02', 250000), ('2026-11-03', 252000), ('2026-11-04', 255000), ('2026-11-05', 251000)]]
ENV = {'API_URL': 'http://127.0.0.1:3000', 'PRINCIPALS_JSON': json.dumps([
    {'id': 'r', 'role': 'researcher', 'token': 'reporter-token'}, {'id': 'e', 'role': 'evaluator', 'token': 'checker-token'},
    {'id': 'bot', 'role': 'trader', 'botId': 'bot-one', 'token': 'bot-token'}])}


def signal(sid, created, horizon, scored=False, reviewed=True):
    return {'id': sid, 'symbol': 'RELIANCE', 'createdAt': created, 'horizonDays': horizon,
            'review': {'referencePricePaise': '248000'} if reviewed else None, 'outcome': {'correct': True} if scored else None}


class Fake:
    def __init__(self, signals):
        self.signals, self.calls, self.evidence = signals, [], {}

    def __call__(self, req, timeout):
        body = json.loads(req.data)
        route = req.full_url.split('3000')[1]
        self.calls.append((route, req.headers['Authorization'], body))
        if route == '/v1/trading/signals/query':
            answer = {'signals': self.signals}
        elif route == '/v1/evidence':
            self.evidence['ev-1'] = body
            answer = {'id': 'ev-1', 'status': 'unverified'}
        elif route == '/v1/evidence/reviews':
            assert body['expected']['content'] == self.evidence[body['evidenceId']]['content']  # content-bound verification
            answer = {'evidenceId': body['evidenceId'], 'status': 'verified'}
        else:
            answer = {'moveBps': 282, 'correct': True}

        class R:
            def __enter__(s): return s
            def __exit__(s, *a): return False
            def read(s, n): return json.dumps(answer).encode()
        return R()


class ScorerTests(unittest.TestCase):
    def test_exit_bar_is_the_first_settled_close_after_the_horizon(self):
        now = datetime(2026, 11, 5, 12, 0, tzinfo=timezone.utc)
        self.assertEqual(sc.exit_bar(BARS, '2026-11-01T09:00:00Z', 2, now)['date'], '2026-11-03')  # due 3 Nov 09:00, closes 10:00
        self.assertEqual(sc.exit_bar(BARS, '2026-11-01T11:00:00Z', 2, now)['date'], '2026-11-04')  # due after 3 Nov's close
        self.assertIsNone(sc.exit_bar(BARS, '2026-11-04T11:00:00Z', 1, datetime(2026, 11, 5, 10, 10, tzinfo=timezone.utc)))  # not settled yet
        self.assertIsNone(sc.exit_bar(BARS, '2026-11-10T00:00:00Z', 1, now))  # horizon not reached in the data

    def test_due_signals_are_scored_by_two_identities_and_others_are_left_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            (cache / 'RELIANCE.NS-1d.json').write_text(json.dumps({'symbol': 'RELIANCE.NS', 'bars': BARS}), encoding='utf-8')
            fake = Fake([signal('due', '2026-11-01T09:00:00Z', 2), signal('scored', '2026-11-01T09:00:00Z', 2, scored=True),
                         signal('unreviewed', '2026-11-01T09:00:00Z', 2, reviewed=False), signal('later', '2026-11-04T11:00:00Z', 30)])
            results = sc.score('market-yahoo-daily', ENV, cache, fake, datetime(2026, 11, 5, 12, 0, tzinfo=timezone.utc))
            self.assertEqual([(r['signalId'], r['state']) for r in results], [('due', 'scored'), ('later', 'not-due-or-not-settled')])
            routes = [(route, auth) for route, auth, _ in fake.calls]
            self.assertEqual(routes, [('/v1/trading/signals/query', 'Bearer checker-token'), ('/v1/evidence', 'Bearer reporter-token'),
                                      ('/v1/evidence/reviews', 'Bearer checker-token'), ('/v1/trading/signals/outcomes', 'Bearer checker-token')])
            evidence = fake.calls[1][2]
            self.assertIn('NSE:RELIANCE on 2026-11-03: 252000 paise', evidence['content'])
            self.assertEqual((evidence['sourceId'], evidence['publishedAt']), ('market-yahoo-daily', '2026-11-03T10:00:00Z'))
            self.assertEqual(fake.calls[3][2]['exitPricePaise'], '252000')

    def test_credentials_must_be_unambiguous(self):
        with self.assertRaisesRegex(ValueError, 'exactly one researcher'):
            sc.principals({'PRINCIPALS_JSON': json.dumps([{'role': 'evaluator', 'token': 'x'}]), 'API_URL': 'http://127.0.0.1:3000'}, 'researcher')


if __name__ == '__main__':
    unittest.main()
