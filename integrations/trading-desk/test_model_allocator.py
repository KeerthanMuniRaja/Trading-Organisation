from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_allocator as ai
import daily
import model_allocator as ma
import portfolio_daily as pd

DAY = '2026-11-02'
NOW = datetime(2026, 11, 2, 12, 0, tzinfo=timezone.utc)
ENV = {'API_URL': 'http://127.0.0.1:3000', 'PRINCIPALS_JSON': json.dumps([
    {'id': 'r', 'role': 'researcher', 'token': 'reporter-token'}, {'id': 'e', 'role': 'evaluator', 'token': 'checker-token'},
    {'id': 'a', 'role': 'trader', 'botId': 'ai-allocator', 'token': 'allocator-token'}])}


def build(tmp, months=None, tamper=False):
    """Eight shares of weekday history up to DAY, and one decided month as the forward test would have stored it."""
    cache, root = Path(tmp) / 'daily', Path(tmp) / 'runs'
    cache.mkdir()
    days, d = [], date(2025, 6, 2)
    while d.isoformat() <= DAY:
        if d.weekday() < 5:
            days.append(d.isoformat())
        d += timedelta(days=1)
    for n, symbol in enumerate(sorted(daily.datasets.UNIVERSE)):
        bars = [{'date': x, 'openPaise': 100000 + n * 1000 + i * (n - 3) * 10, 'highPaise': 100000 + n * 1000 + i * (n - 3) * 10 + 50,
                 'lowPaise': 100000 + n * 1000 + i * (n - 3) * 10 - 50, 'closePaise': 100000 + n * 1000 + i * (n - 3) * 10, 'volume': 1000}
                for i, x in enumerate(days)]
        (cache / f'{symbol}-1d.json').write_text(json.dumps({'schemaVersion': 1, 'symbol': symbol, 'interval': '1d', 'priceBasis': 'adjusted',
                                                             'source': 'synthetic-test', 'bars': bars}), encoding='utf-8')
    dates, table = pd.aligned(daily.load(sorted(daily.datasets.UNIVERSE), cache))
    letters = ai.mapping('ai-forward', daily.datasets.UNIVERSE)
    facts = ai.brief(table, dates, dates.index(DAY), letters)
    if tamper:
        facts['A'] = {**facts['A'], 'return6mPct': facts['A']['return6mPct'] + 5}
    weights = {k: 0 for k in ai.LETTERS}
    weights.update({'A': 20, 'B': 15})
    earlier = {'2026-10-01': {'outcome': 'valid', 'weights': {**{k: 0 for k in ai.LETTERS}, 'B': 15, 'C': 10}, 'rationale': 'Earlier', 'facts': {}}}
    state = {'name': 'ai-forward', 'model': 'Qwen3.5-4B-Q4_K_M', 'promptVersion': ai.PROMPT_VERSION, 'from': '2026-10-01', 'weights': {},
             'months': months if months is not None else {**earlier, DAY: {'outcome': 'valid', 'weights': weights, 'cash': 65, 'scaledDown': False,
                                                                            'rationale': 'Momentum leaders', 'facts': facts}}}
    (root / 'ai-forward').mkdir(parents=True)
    (root / 'ai-forward' / 'decisions.json').write_text(json.dumps(state), encoding='utf-8')
    return cache, root, letters


class Fake:
    def __init__(self, signals=(), positions=()):
        self.signals, self.positions, self.calls, self.evidence = list(signals), list(positions), [], {}

    def __call__(self, req, timeout):
        route = req.full_url.split('3000')[1]
        body = json.loads(req.data) if req.data else None
        self.calls.append((route, req.headers['Authorization'], body))
        if route == '/v1/trading/signals/query':
            answer = {'signals': self.signals}
        elif route == '/v1/evidence':
            self.evidence['ev-1'] = body
            answer = {'id': 'ev-1', 'status': 'unverified'}
        elif route == '/v1/paper/performance':
            answer = {'bots': [{'botId': 'ai-allocator', 'budgetPaise': '1000000', 'openPositions': self.positions}]}
        elif route == '/v1/compute/usage/reports':
            answer = {'id': 'usage-1', 'duplicate': False}
        elif route == '/v1/evidence/reviews':
            assert body['expected']['content'] == self.evidence[body['evidenceId']]['content']
            answer = {'evidenceId': body['evidenceId'], 'status': 'verified'}
        else:
            answer = {'id': f"sig-{body['symbol']}"}

        class R:
            def __enter__(s): return s
            def __exit__(s, *a): return False
            def read(s, n): return json.dumps(answer).encode()
        return R()


class ModelAllocatorTests(unittest.TestCase):
    def test_the_decided_month_is_cited_with_verified_facts_and_proposed_under_the_bots_credential(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache, root, letters = build(tmp)
            fake = Fake()
            result = ma.run('ai-allocator', 'ai-forward', 'market-yahoo-daily', ENV, cache, root, fake, NOW)
            self.assertEqual(result['state'], 'proposed')
            a, b, c = (bridge_ticker(letters[k]) for k in 'ABC')
            # compared with what is actually held (nothing yet), not with last month's decision: A and B are both bought
            self.assertEqual(sorted((p[0], p[1]) for p in result['proposals']), sorted([('enter-long', a), ('enter-long', b)]))
            routes = [(route, auth) for route, auth, _ in fake.calls]
            self.assertEqual(routes[:5], [('/v1/compute/usage/reports', 'Bearer reporter-token'), ('/v1/trading/signals/query', 'Bearer allocator-token'),
                                          ('/v1/paper/performance', 'Bearer allocator-token'), ('/v1/evidence', 'Bearer reporter-token'),
                                          ('/v1/evidence/reviews', 'Bearer checker-token')])
            usage = fake.calls[0][2]
            self.assertEqual((usage['calls'], usage['runLabel'], usage['periodFrom']), (1, f'ai-allocator:ai-forward:{DAY}', DAY))
            self.assertTrue(result['usageReported'])
            evidence = fake.calls[3][2]['content']
            self.assertIn(f'NSE:{a} return 1m', evidence)
            self.assertIn(f'decision on {DAY}', evidence)
            sent = [body for route, _, body in fake.calls if route == '/v1/trading/signals']
            self.assertTrue(all(s['evidenceIds'] == ['ev-1'] and s['model'] == 'Qwen3.5-4B-Q4_K_M' for s in sent))
            self.assertEqual(next(s for s in sent if s['action'] == 'enter-long')['targetWeightPct'], 20)

    def test_proposals_follow_the_real_holdings_so_a_trade_that_never_happened_is_proposed_again(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache, root, letters = build(tmp)
            a, b, c = (bridge_ticker(letters[k]) for k in 'ABC')
            # B is held at its 15% target, C (cut to zero) is still held, A's earlier buy never filled
            fake = Fake(positions=[{'symbol': b, 'quantity': '15', 'marketValuePaise': '150000'}, {'symbol': c, 'quantity': '10', 'marketValuePaise': '100000'}])
            result = ma.run('ai-allocator', 'ai-forward', 'market-yahoo-daily', ENV, cache, root, fake, NOW)
            self.assertEqual(sorted((p[0], p[1]) for p in result['proposals']), sorted([('enter-long', a), ('exit', c)]))

    def test_facts_that_do_not_match_the_checked_data_are_never_proposed_on(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache, root, _ = build(tmp, tamper=True)
            fake = Fake()
            with self.assertRaisesRegex(ValueError, 'no longer match'):
                ma.run('ai-allocator', 'ai-forward', 'src', ENV, cache, root, fake, NOW)
            self.assertNotIn('/v1/evidence', [c[0] for c in fake.calls])

    def test_once_per_month_only_current_decisions_and_never_a_failed_month(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache, root, _ = build(tmp)
            done = Fake([{'createdAt': DAY + 'T12:00:00Z', 'model': 'Qwen3.5-4B-Q4_K_M'}])
            self.assertEqual(ma.run('ai-allocator', 'ai-forward', 'src', ENV, cache, root, done, NOW)['state'], 'already-proposed')
            later = NOW + timedelta(days=10)
            self.assertEqual(ma.run('ai-allocator', 'ai-forward', 'src', ENV, cache, root, Fake(), later)['state'], 'waiting')
            dry = ma.run('ai-allocator', 'ai-forward', 'src', ENV, cache, root, Fake(), NOW, dry_run=True)
            self.assertEqual(dry['state'], 'dry-run')
        with tempfile.TemporaryDirectory() as tmp:
            cache, root, _ = build(tmp, months={DAY: {'outcome': 'failed', 'failure': 'CONTRACT_INVALID'}})
            self.assertEqual(ma.run('ai-allocator', 'ai-forward', 'src', ENV, cache, root, Fake(), NOW)['state'], 'no-valid-decision')


def bridge_ticker(symbol):
    return symbol.removesuffix('.NS')


if __name__ == '__main__':
    unittest.main()
