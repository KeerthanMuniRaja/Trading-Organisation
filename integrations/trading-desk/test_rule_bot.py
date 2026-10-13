from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rule_bot as rb

NOW = datetime(2026, 11, 5, 12, 0, tzinfo=timezone.utc)
# 6-month growth per share; RELIANCE, ICICIBANK and NTPC lead, SBIN is held but falls back, AXISBANK has too little history
GROWTH = {'RELIANCE.NS': 1.30, 'HDFCBANK.NS': 1.02, 'ICICIBANK.NS': 1.25, 'INFY.NS': 0.95, 'SBIN.NS': 1.01, 'ITC.NS': 1.05, 'NTPC.NS': 1.20}
ENV = {'API_URL': 'http://127.0.0.1:3000', 'PRINCIPALS_JSON': json.dumps([
    {'id': 'r', 'role': 'researcher', 'token': 'reporter-token'}, {'id': 'e', 'role': 'evaluator', 'token': 'checker-token'},
    {'id': 'bot', 'role': 'trader', 'botId': 'momentum-rules', 'token': 'bot-token'}])}


def bars(growth, sessions=rb.LOOKBACK + 5):
    start = date(2026, 4, 1)
    days = [start + timedelta(days=i) for i in range(sessions)]
    out = []
    for i, d in enumerate(days):
        p = round(100_000 * growth ** (i / (sessions - 1)))
        out.append({'date': d.isoformat(), 'openPaise': p, 'highPaise': p, 'lowPaise': p, 'closePaise': p, 'volume': 1})
    return out


def cache_with(tmp):
    cache = Path(tmp)
    for symbol, growth in GROWTH.items():
        (cache / f'{symbol}-1d.json').write_text(json.dumps({'symbol': symbol, 'bars': bars(growth)}), encoding='utf-8')
    (cache / 'AXISBANK.NS-1d.json').write_text(json.dumps({'symbol': 'AXISBANK.NS', 'bars': bars(2.0, 40)}), encoding='utf-8')
    return cache


class Fake:
    def __init__(self, signals=(), holdings=()):
        self.signals, self.holdings, self.calls, self.evidence = list(signals), list(holdings), [], {}

    def __call__(self, req, timeout):
        route = req.full_url.split('3000')[1]
        body = json.loads(req.data) if req.data else None
        self.calls.append((route, req.headers['Authorization'], body))
        if route == '/v1/trading/signals/query':
            answer = {'signals': self.signals}
        elif route == '/v1/paper/performance':
            answer = {'bots': [{'botId': 'momentum-rules', 'openPositions': [{'symbol': s, 'quantity': '3'} for s in self.holdings]}]}
        elif route == '/v1/evidence':
            self.evidence['ev-1'] = body
            answer = {'id': 'ev-1', 'status': 'unverified'}
        elif route == '/v1/evidence/reviews':
            assert body['expected']['content'] == self.evidence[body['evidenceId']]['content']  # content-bound verification
            answer = {'evidenceId': body['evidenceId'], 'status': 'verified'}
        else:
            answer = {'id': f"sig-{body['symbol']}"}

        class R:
            def __enter__(s): return s
            def __exit__(s, *a): return False
            def read(s, n): return json.dumps(answer).encode()
        return R()


class RuleBotTests(unittest.TestCase):
    def test_ranking_uses_settled_bars_and_skips_short_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            datasets, fingerprint = rb.load(cache_with(tmp))
            rows = rb.ranking(datasets, NOW)
            self.assertEqual([r[0] for r in rows[:3]], ['RELIANCE', 'ICICIBANK', 'NTPC'])
            self.assertNotIn('AXISBANK', [r[0] for r in rows])
            self.assertEqual(len(fingerprint), 16)
            last = rows[0][4]
            just_after_close = rb.sc.close_time(last) + timedelta(minutes=5)  # not settled: the ranking ends one bar earlier
            self.assertLess(rb.ranking(datasets, just_after_close)[0][4], last)

    def test_proposals_exit_dropped_holdings_and_enter_new_leaders_only(self):
        rows = [('RELIANCE', 30.0, 1, 2, '2026-08-01'), ('ICICIBANK', 25.0, 1, 2, '2026-08-01'), ('NTPC', 20.0, 1, 2, '2026-08-01'),
                ('SBIN', 1.0, 1, 2, '2026-08-01')]
        plan = rb.proposals(rows, {'SBIN', 'ICICIBANK'}, 'momentum-rules', 'ev', NOW)
        self.assertEqual([(p['action'], p['symbol']) for p in plan], [('exit', 'SBIN'), ('enter-long', 'RELIANCE'), ('enter-long', 'NTPC')])
        entry = plan[1]
        self.assertEqual((entry['targetWeightPct'], entry['horizonDays'], entry['model'], entry['promptVersion']),
                         (33, 30, 'rules:top3-momentum-6m', rb.RULE_VERSION))
        self.assertEqual(entry['expiresAt'], '2026-11-12T12:00:00Z')
        self.assertNotIn('targetWeightPct', plan[0])
        self.assertEqual(rb.proposals(rows, {'RELIANCE', 'ICICIBANK', 'NTPC'}, 'momentum-rules', 'ev', NOW), [])

    def test_a_run_reports_verifies_and_proposes_under_the_bots_own_credential(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Fake(holdings=['SBIN'])
            result = rb.run('momentum-rules', 'market-yahoo-daily', ENV, cache_with(tmp), fake, NOW)
            self.assertEqual(result['state'], 'proposed')
            self.assertEqual([(p['action'], p['symbol']) for p in result['proposals']],
                             [('exit', 'SBIN'), ('enter-long', 'RELIANCE'), ('enter-long', 'ICICIBANK'), ('enter-long', 'NTPC')])
            routes = [(route, auth) for route, auth, _ in fake.calls]
            self.assertEqual(routes[:4], [('/v1/trading/signals/query', 'Bearer bot-token'), ('/v1/paper/performance', 'Bearer bot-token'),
                                          ('/v1/evidence', 'Bearer reporter-token'), ('/v1/evidence/reviews', 'Bearer checker-token')])
            self.assertTrue(all(r == ('/v1/trading/signals', 'Bearer bot-token') for r in routes[4:]))
            evidence = fake.calls[2][2]
            self.assertRegex(evidence['content'], r'1\. NSE:RELIANCE \+\d+\.\d\d% \(\d+ -> \d+ paise\); 2\. NSE:ICICIBANK ')
            self.assertEqual(evidence['kind'], 'dataset')
            self.assertTrue(all(body['evidenceIds'] == ['ev-1'] for _, _, body in fake.calls[4:]))

    def test_one_decision_per_month_and_dry_runs_send_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = cache_with(tmp)
            done = Fake(signals=[{'botId': 'momentum-rules', 'model': rb.MODEL, 'createdAt': '2026-11-02T04:00:00Z'}])
            self.assertEqual(rb.run('momentum-rules', 'src', ENV, cache, done, NOW)['state'], 'already-decided')
            last_month = Fake(signals=[{'botId': 'momentum-rules', 'model': rb.MODEL, 'createdAt': '2026-10-02T04:00:00Z'}])
            dry = rb.run('momentum-rules', 'src', ENV, cache, last_month, NOW, dry_run=True)
            self.assertEqual(dry['proposals'], [['enter-long', 'RELIANCE'], ['enter-long', 'ICICIBANK'], ['enter-long', 'NTPC']])
            self.assertEqual([c[0] for c in last_month.calls], ['/v1/trading/signals/query', '/v1/paper/performance'])

    def test_holding_the_leaders_proposes_nothing_and_cites_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = Fake(holdings=['RELIANCE', 'ICICIBANK', 'NTPC'])
            self.assertEqual(rb.run('momentum-rules', 'src', ENV, cache_with(tmp), fake, NOW)['state'], 'nothing-to-change')
            self.assertNotIn('/v1/evidence', [c[0] for c in fake.calls])

    def test_describe_names_the_release_identity(self):
        d = rb.describe()
        self.assertEqual((d['model'], d['promptVersion'], len(d['codeFingerprint'])), (rb.MODEL, rb.RULE_VERSION, 64))

    def test_the_bot_needs_its_own_credential(self):
        with self.assertRaisesRegex(ValueError, 'bound to other-bot'):
            rb.run('other-bot', 'src', ENV, Path('.'), Fake(), NOW)


if __name__ == '__main__':
    unittest.main()
