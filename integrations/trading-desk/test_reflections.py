from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily
import reflections as rf

SYMBOLS = sorted(daily.datasets.UNIVERSE)
ENV = {'API_URL': 'http://127.0.0.1:3000', 'PRINCIPALS_JSON': json.dumps([{'role': 'researcher', 'token': 'r'}, {'role': 'evaluator', 'token': 'e'}])}
NOW = datetime(2026, 3, 2, 12, 0, tzinfo=timezone.utc)


def bars(start, step):
    """Business days from 2026-01-01; HDFCBANK rises 1% a day, everything else is flat."""
    out, d, price = [], date(2026, 1, 1), start
    while d < date(2026, 3, 1):
        if d.weekday() < 5:
            out.append({'date': d.isoformat(), 'openPaise': int(price), 'highPaise': int(price), 'lowPaise': int(price), 'closePaise': int(price), 'volume': 1000})
            price *= 1 + step
        d += timedelta(days=1)
    return {'schemaVersion': 1, 'symbol': '', 'interval': '1d', 'priceBasis': 'adjusted', 'source': 'synthetic-test', 'bars': out}


SIGNALS = [
    {'id': 's-right', 'botId': 'momentum-rules', 'symbol': 'HDFCBANK', 'action': 'enter-long', 'conviction': 'high', 'horizonDays': 10,
     'thesis': 'Rank 1 of 8 by 126-session return.', 'createdAt': '2026-01-05T11:00:00.000Z', 'evidenceIds': ['ev-1'],
     'review': {'outcome': 'accepted'}, 'outcome': {'moveBps': 1047, 'correct': True}},
    {'id': 's-wrong', 'botId': 'momentum-rules', 'symbol': 'ITC', 'action': 'enter-long', 'conviction': 'high', 'horizonDays': 10,
     'thesis': 'Rank 3 of 8.', 'createdAt': '2026-01-05T11:00:00.000Z', 'evidenceIds': ['ev-2'],
     'review': {'outcome': 'accepted'}, 'outcome': {'moveBps': -30, 'correct': False}},
    {'id': 's-open', 'botId': 'momentum-rules', 'symbol': 'INFY', 'action': 'enter-long', 'conviction': 'high', 'horizonDays': 10,
     'thesis': 'Not scored yet.', 'createdAt': '2026-02-20T11:00:00.000Z', 'evidenceIds': ['ev-3'], 'review': {'outcome': 'accepted'}, 'outcome': None},
]


class Backend:
    def __init__(self, signals):
        self.signals, self.calls = signals, []

    def __call__(self, req, timeout):
        route, body = req.full_url.split('3000', 1)[1], json.loads(req.data) if req.data else None
        self.calls.append((route, body, req.headers['Authorization'].split()[-1]))
        reply = {'signals': self.signals} if route == '/v1/trading/signals/query' else {'id': f'lesson-{len(self.calls)}'}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self, n=None):
                return json.dumps(reply).encode()
        return Response()


class ReflectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name)
        for s in SYMBOLS:
            (self.cache / f'{s}-1d.json').write_text(json.dumps(bars(100_000, 0.01 if s == 'HDFCBANK.NS' else 0.0)), encoding='utf-8')
        self.state = self.cache / 'state.json'

    def tearDown(self):
        self.tmp.cleanup()

    def test_each_scored_call_becomes_a_verified_factual_lesson_for_its_bot(self):
        backend = Backend(SIGNALS)
        out = rf.run(ENV, self.cache, backend, NOW, self.state)
        self.assertEqual([(o['signalId'], o['state']) for o in out], [('s-right', 'reflected'), ('s-wrong', 'reflected')])  # unscored waits
        lessons = [c for c in backend.calls if c[0] == '/v1/lessons']
        reviews = [c for c in backend.calls if c[0] == '/v1/lessons/reviews']
        self.assertEqual(([c[2] for c in lessons], [c[2] for c in reviews]), (['r', 'r'], ['e', 'e']))  # proposed and verified by different identities
        right = lessons[0][1]
        self.assertEqual((right['botId'], right['evidenceId']), ('momentum-rules', 'ev-1'))
        self.assertIn('the share had moved +10.47%', right['content'])
        self.assertIn('Judged right against holding cash. The call worked and beat simply holding the basket', right['content'])
        self.assertIn('Judged wrong against holding cash. The call lost against cash', lessons[1][1]['content'])
        self.assertEqual(reviews[0][1]['expected']['content'], right['content'])  # content-bound review
        again = Backend(SIGNALS)
        self.assertEqual(rf.run(ENV, self.cache, again, NOW, self.state), [])  # never reflected twice
        self.assertFalse([c for c in again.calls if c[0] == '/v1/lessons'])

    def test_the_basket_comparison_and_takeaways_follow_fixed_rules(self):
        self.assertAlmostEqual(rf.basket_move(self.cache, '2026-01-05', '2026-01-15'), round(100 * ((1.01 ** 8) - 1) / 8, 2), places=2)
        self.assertIsNone(rf.basket_move(self.cache, '2025-01-01', '2026-01-15'))
        self.assertIn('did not beat the basket', rf.takeaway('enter-long', True, -1.0))
        self.assertIn('Selling was early', rf.takeaway('exit', False, None))


if __name__ == '__main__':
    unittest.main()
