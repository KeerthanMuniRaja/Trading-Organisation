from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily
import rnd_bot as rb
import rnd_scout
from test_daily import synthetic_daily

SYMBOLS = sorted(daily.datasets.UNIVERSE)
NOW = datetime(2026, 1, 5, 12, 0, tzinfo=timezone.utc)  # after the synthetic history ends
BOT = 'rnd-momentum-6m-top2'


def env(with_trader=True):
    principals = [{'role': 'researcher', 'token': 'r'}, {'role': 'evaluator', 'token': 'e'}]
    if with_trader:
        principals.append({'role': 'trader', 'token': 't', 'botId': BOT})
    return {'API_URL': 'http://127.0.0.1:3000', 'PRINCIPALS_JSON': json.dumps(principals)}


class Backend:
    """Answers like the real routes for what the runner uses, and records who called what."""

    def __init__(self, state='school', allowed=True, holdings=()):
        self.state, self.allowed, self.holdings = state, allowed, list(holdings)
        self.calls, self.signals, self.evaluated, self.releases = [], [], False, {}

    def __call__(self, req, timeout):
        route, body = req.full_url.split('3000', 1)[1], json.loads(req.data) if req.data else None
        token = req.headers['Authorization'].split()[-1]
        self.calls.append((req.get_method(), route, body, token))
        if route == '/v1/bots':
            reply = [{'id': BOT, 'state': self.state}, {'id': 'momentum-rules', 'state': 'paper'}]
        elif route == '/v1/releases':
            key = (body['model'], body['promptVersion'], body['codeFingerprint'])
            reply = {'id': 'rel-1', 'version': 1, 'duplicate': key in self.releases}
            self.releases[key] = True
        elif route == '/v1/releases/view':
            reply = {'releases': [{'id': 'rel-1', 'stage': 'registered', 'evaluations': [{'activeEligible': True}] if self.evaluated else []}]}
        elif route == '/v1/bots/fitness':
            reply = {'id': 'fit-1', 'verdict': 'adds-value' if body['wins'] > body['losses'] else 'no-detectable-skill'}
        elif route == '/v1/releases/evaluations':
            self.evaluated = True
            reply = {'id': 'ev-1', 'activeEligible': True}
        elif route == '/v1/releases/check':
            reply = {'allowed': self.allowed, 'reason': None if self.allowed else 'version-not-authorised'}
        elif route == '/v1/trading/signals/query':
            reply = {'signals': self.signals}
        elif route == '/v1/paper/performance':
            reply = {'bots': [{'botId': BOT, 'openPositions': [{'symbol': s, 'quantity': '1'} for s in self.holdings]}]}
        elif route == '/v1/evidence':
            reply = {'id': 'ev-text', 'status': 'unverified'}
        elif route == '/v1/trading/signals':
            self.signals.append({'id': f's{len(self.signals)}', 'createdAt': NOW.isoformat(), 'model': body['model'], 'botId': body['botId'],
                                 'action': body['action'], 'symbol': body['symbol']})
            reply = {'id': self.signals[-1]['id']}
        else:
            reply = {}

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self, n=None):
                return json.dumps(reply).encode()
        return Response()

    def posts(self, route):
        return [c for c in self.calls if c[0] == 'POST' and c[1] == route]


class RndBotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.cache = Path(cls.tmp.name) / 'cache'
        cls.cache.mkdir()
        for k, symbol in enumerate(SYMBOLS):  # two persistent winners
            (cls.cache / f'{symbol}-1d.json').write_text(json.dumps(synthetic_daily(symbol, drift=0.004 if k < 2 else 0.0, seed=11 + k)), encoding='utf-8')
        cls.report = rnd_scout.scout(cache=cls.cache)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_a_born_bot_is_onboarded_once_with_independent_roles(self):
        backend = Backend()
        out = rb.onboard(env(), opener=backend, report=self.report)
        self.assertEqual([(o['botId'], o['state']) for o in out], [(BOT, 'evaluated')])  # momentum-rules is not an R&D bot
        release, fitness, evaluation = backend.posts('/v1/releases')[0], backend.posts('/v1/bots/fitness')[0], backend.posts('/v1/releases/evaluations')[0]
        self.assertEqual((release[3], fitness[3], evaluation[3]), ('r', 'e', 'e'))  # the researcher registers, the evaluator judges
        self.assertEqual(release[2]['model'], 'rules:momentum-6m-top2')
        c = next(x for x in self.report['candidates'] if x['name'] == 'momentum-6m-top2')
        self.assertEqual((fitness[2]['judged'], fitness[2]['wins'], fitness[2]['losses'], fitness[2]['baseline']), (c['months'], c['ahead'], c['behind'], 'equal-weight-basket'))
        self.assertTrue(fitness[2]['periodTo'].startswith(self.report['through']))
        again = rb.onboard(env(), opener=backend, report=self.report)
        self.assertEqual(again[0]['state'], 'onboarded')
        self.assertEqual(len(backend.posts('/v1/bots/fitness')), 1)  # nothing filed twice

    def test_identity_follows_the_code_and_the_rule(self):
        a, b = rb.identity('momentum-6m-top2'), rb.identity('momentum-3m-top2')
        self.assertEqual(a, rb.identity('momentum-6m-top2'))
        self.assertNotEqual(a['promptVersion'], b['promptVersion'])
        self.assertEqual(a['codeFingerprint'], b['codeFingerprint'])  # same code, different rule

    def test_a_paper_bot_trades_its_rule_monthly_only_while_its_release_is_authorised(self):
        with tempfile.TemporaryDirectory() as state:
            refused = Backend(state='paper', allowed=False)
            self.assertEqual(rb.run('src', env(), self.cache, refused, NOW, Path(state))[0]['state'], 'not-authorised')
            self.assertFalse(refused.posts('/v1/trading/signals'))
            self.assertEqual(rb.run('src', env(with_trader=False), self.cache, Backend(state='paper'), NOW, Path(state))[0]['state'], 'no-credential')

            backend = Backend(state='paper', holdings=['NTPC'])  # holds a share the rule no longer wants
            first = rb.run('src', env(), self.cache, backend, NOW, Path(state))[0]
            self.assertEqual(first['state'], 'proposed')
            self.assertEqual([(p['action'], p['symbol']) for p in first['proposals']], [('exit', 'NTPC')])  # exits first
            self.assertEqual(backend.posts('/v1/evidence/reviews')[0][3], 'e')  # the decision evidence is verified by the evaluator
            waiting = rb.run('src', env(), self.cache, backend, NOW, Path(state))[0]
            self.assertEqual(waiting['state'], 'waiting-for-exits')
            backend.holdings = []  # the exit executed
            backend.signals[0]['execution'] = {'id': 'x'}
            entries = rb.run('src', env(), self.cache, backend, NOW, Path(state))[0]
            weights, _ = rb.targets('momentum-6m-top2', self.cache, NOW)
            self.assertEqual(sorted(p['symbol'] for p in entries['proposals']), sorted(weights))
            sent = backend.posts('/v1/trading/signals')
            self.assertTrue(all(p[2]['targetWeightPct'] == 50 for p in sent if p[2]['action'] == 'enter-long'))
            self.assertTrue(all(p[3] == 't' and p[2]['model'] == 'rules:momentum-6m-top2' for p in sent))  # its own credential and release
            self.assertEqual(rb.run('src', env(), self.cache, backend, NOW, Path(state))[0]['state'], 'month-complete')
            self.assertEqual(len(backend.posts('/v1/evidence')), 1)  # one decision a month, however often it runs


if __name__ == '__main__':
    unittest.main()
