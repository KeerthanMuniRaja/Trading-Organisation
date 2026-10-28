"""Tests for the TradingAgents member with a stand-in engine: the real package is never needed to test the governance."""
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / 'trading-desk'))
import ta_bot  # noqa: E402
import ta_decide  # noqa: E402

NOW = datetime(2026, 10, 24, 12, 0, tzinfo=timezone.utc)
ENV = {'API_URL': 'http://127.0.0.1:3000', 'TA_BOT_ID': 'tradingagents',
       'PRINCIPALS_JSON': json.dumps([{'role': 'researcher', 'token': 'r'}, {'role': 'evaluator', 'token': 'e'},
                                      {'role': 'trader', 'token': 't', 'botId': 'tradingagents'}])}


class StubGraph:
    """Answers like TradingAgentsGraph.propagate: (state, decision)."""
    RATINGS = {'HDFCBANK.NS': 'BUY', 'ITC.NS': 'Underweight', 'INFY.NS': 'HOLD', 'SBIN.NS': 'Buy or Sell'}

    def __init__(self):
        self.calls = []

    def propagate(self, ticker, day):
        self.calls.append((ticker, day))
        if ticker == 'NTPC.NS':
            raise TimeoutError('model server timed out')
        return {'final_trade_decision': f'After debate, the portfolio manager rates {ticker} {self.RATINGS.get(ticker, "HOLD")}.'}, self.RATINGS.get(ticker, 'HOLD')


class Backend:
    def __init__(self, releases=(), allowed=True, scored=0):
        self.calls, self.releases, self.allowed, self.scored = [], list(releases), allowed, scored

    def __call__(self, req, timeout):
        route, body = req.full_url.split('3000', 1)[1], json.loads(req.data) if req.data else None
        self.calls.append((route, body, req.headers['Authorization'].split()[-1]))
        model = 'tradingagents:0.9.0:qwen'
        reply = ({'releases': self.releases} if route == '/v1/releases/view' else {'allowed': self.allowed, 'reason': 'version-not-authorised'}
                 if route == '/v1/releases/check' else {'signals': [{'model': model, 'action': 'enter-long', 'outcome': {'correct': True}}] * self.scored}
                 if route == '/v1/trading/signals/query' else {'id': 'fit', 'verdict': 'adds-value'} if route == '/v1/bots/fitness/live'
                 else {'id': 'rel', 'version': 1} if route == '/v1/releases' else {'activeEligible': True} if route == '/v1/releases/evaluations'
                 else {'bots': [{'botId': 'tradingagents', 'budgetPaise': '500000', 'budgetUsedPaise': '146754',
                                 'openPositions': [{'symbol': 'HDFCBANK', 'quantity': '2', 'costPaise': '146754'}]}]} if route == '/v1/paper/performance'
                 else {'id': 'ev', 'status': 'unverified'} if route == '/v1/evidence' else {'id': 'sig'})

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self, n=None):
                return json.dumps(reply).encode()
        return Response()


class DecideTests(unittest.TestCase):
    def test_a_weekly_run_rates_its_holdings_and_a_rotating_few(self):
        week = lambda day: ta_decide.rotation(day)  # noqa: E731
        self.assertEqual(len(week('2026-10-30')), ta_decide.PER_RUN)                          # nothing held: two shares
        covered = {s for d in ('2026-10-30', '2026-11-06', '2026-11-13', '2026-11-20') for s in week(d)}
        self.assertEqual(covered, set(ta_decide.SYMBOLS))                                     # all 8 within 4 weeks
        held = ta_decide.rotation('2026-10-30', held={'ITC', 'NTPC'})
        self.assertTrue({'ITC', 'NTPC'} <= set(held) and len(held) == 2 + ta_decide.PER_RUN)  # it can always exit what it holds
        self.assertEqual(ta_decide.SETTINGS['max_tool_rounds'], 3)                            # short enough for a laptop

    def test_the_local_model_key_reaches_the_openai_compatible_provider(self):
        environ = {}
        ta_decide.provide_key({'HERMES_MODEL_API_KEY': 'local-key'}, environ)
        self.assertEqual(environ, {'OPENAI_COMPATIBLE_API_KEY': 'local-key'})       # a 401 on every call otherwise
        kept = {'OPENAI_COMPATIBLE_API_KEY': 'set-by-owner'}
        ta_decide.provide_key({'HERMES_MODEL_API_KEY': 'local-key'}, kept)
        self.assertEqual(kept['OPENAI_COMPATIBLE_API_KEY'], 'set-by-owner')         # an explicit setting is never replaced
        empty = {}
        ta_decide.provide_key({}, empty)
        self.assertEqual(empty, {})

    def test_ratings_are_read_strictly_and_failures_are_recorded_not_guessed(self):
        self.assertEqual([ta_decide.rating_of(x) for x in ('BUY', 'Overweight', {'rating': 'SELL'}, 'Buy or Sell', 'no view')],
                         ['BUY', 'OVERWEIGHT', 'SELL', None, None])
        with tempfile.TemporaryDirectory() as tmp:
            graph = StubGraph()
            meta = {'engine': 'tradingagents', 'engineVersion': '0.9.0', 'model': 'qwen'}
            record = ta_decide.decide('2026-10-23', ta_decide.SYMBOLS, graph, meta, out=Path(tmp), now=NOW)
            self.assertEqual(record['decisions']['HDFCBANK']['rating'], 'BUY')
            self.assertEqual(record['decisions']['ITC']['rating'], 'UNDERWEIGHT')
            self.assertIsNone(record['decisions']['SBIN']['rating'])  # ambiguous: no rating, no trade
            self.assertTrue(record['decisions']['SBIN']['unreadable'])   # and counted, with what it said
            self.assertTrue(record['decisions']['SBIN']['excerpt'])
            self.assertIn('TimeoutError', record['decisions']['NTPC']['error'])
            self.assertNotIn('unreadable', record['decisions']['NTPC'])   # an error is a failure, not an unreadable answer
            r = record['readability']
            self.assertEqual((r['decisions'], r['unreadable'], r['errors'], r['rated']), (len(ta_decide.SYMBOLS), 1, 1, len(ta_decide.SYMBOLS) - 2))
            self.assertEqual(ta_decide.report(Path(tmp))['days'], 1)
            again = StubGraph()
            ta_decide.decide('2026-10-23', ta_decide.SYMBOLS, again, meta, out=Path(tmp), now=NOW)
            self.assertEqual(sorted(t for t, _ in again.calls), ['NTPC.NS', 'SBIN.NS'])  # resumable: only undecided shares rerun
            self.assertTrue(all(t.endswith('.NS') and d == '2026-10-23' for t, d in graph.calls))


class MemberTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.decisions, self.cache, self.state = root / 'decisions', root / 'cache', root / 'proposed.json'
        self.cache.mkdir()
        for s in ta_decide.SYMBOLS:
            (self.cache / f'{s}.NS-1d.json').write_text(json.dumps({'bars': [{'date': '2026-10-23', 'closePaise': 100_000, 'openPaise': 100_000}]}), encoding='utf-8')
        ta_decide.decide('2026-10-23', ta_decide.SYMBOLS, StubGraph(), {'engine': 'tradingagents', 'engineVersion': '0.9.0', 'model': 'qwen'},
                         out=self.decisions, now=NOW)

    def tearDown(self):
        self.tmp.cleanup()

    def test_in_shadow_it_proposes_its_ratings_with_verified_price_evidence_once_per_decided_day(self):
        backend = Backend()
        out = ta_bot.propose('market-yahoo-daily', ENV, self.cache, backend, NOW, self.decisions, self.state)
        self.assertEqual((out['state'], out['shadow']), ('proposed', True))
        self.assertEqual(sorted((p['symbol'], p['action']) for p in out['proposals']), [('HDFCBANK', 'enter-long'), ('ITC', 'exit')])  # HOLD and unclear: nothing
        sent = [c for c in backend.calls if c[0] == '/v1/trading/signals']
        buy = next(c[1] for c in sent if c[1]['symbol'] == 'HDFCBANK')
        self.assertEqual((buy['conviction'], buy['targetWeightPct'], buy['evidenceIds'], sent[0][2]), ('high', 25, ['ev'], 't'))
        self.assertIn('model opinion, not evidence', buy['thesis'])
        self.assertTrue(buy['model'].startswith('tradingagents:0.9.0:qwen'))
        evidence = next(c for c in backend.calls if c[0] == '/v1/evidence')
        self.assertIn('NSE:HDFCBANK 100000 paise', evidence[1]['content'])  # evidence is data, not the model's view
        self.assertEqual(ta_bot.propose('market-yahoo-daily', ENV, self.cache, Backend(), NOW, self.decisions, self.state)['state'], 'already-proposed')

    def test_it_decides_against_its_own_book(self):
        holdings = Path(self.tmp.name) / 'holdings.json'
        ta_bot.propose('src', ENV, self.cache, Backend(), NOW, self.decisions, self.state, holdings)
        book = ta_decide.book(holdings)
        self.assertEqual(book.holdings['positions'], {'HDFCBANK': {'quantity': '2', 'costPaise': '146754'}})
        text = book.render('HDFCBANK.NS')
        self.assertIn('Holds 2 share(s) of HDFCBANK at a cost of Rs 1,467.54', text)
        self.assertIn('It holds HDFCBANK', text)
        self.assertIn('It does not hold ITC', book.render('ITC.NS'))
        seen = []

        class Graph(StubGraph):
            def propagate(self, ticker, day, portfolio=None):
                seen.append(portfolio.render(ticker))
                return super().propagate(ticker, day)
        ta_decide.decide('2026-10-30', ['HDFCBANK'], Graph(), {'engine': 'tradingagents', 'engineVersion': '0.9.0', 'model': 'qwen'},
                         out=self.decisions, now=NOW, portfolio=book)
        self.assertIn('Holds 2 share(s) of HDFCBANK', seen[0])  # TradingAgents' trader, risk team and manager see the real book
        self.assertNotEqual(book.fingerprint(), ta_decide.Book({'positions': {}}).fingerprint())

    def test_under_release_control_only_the_authorised_identity_proposes(self):
        refused = Backend(releases=[{'id': 'rel'}], allowed=False)
        self.assertEqual(ta_bot.propose('src', ENV, self.cache, refused, NOW, self.decisions, self.state)['state'], 'not-authorised')
        self.assertFalse([c for c in refused.calls if c[0] == '/v1/trading/signals'])
        self.assertEqual(ta_bot.propose('src', {**ENV, 'TA_BOT_ID': ''}, self.cache, Backend(), NOW, self.decisions, self.state)['state'], 'not-configured')
        stale = datetime(2026, 11, 5, tzinfo=timezone.utc)
        self.assertEqual(ta_bot.propose('src', ENV, self.cache, Backend(), stale, self.decisions, self.state)['state'], 'waiting')

    def test_it_earns_a_release_only_after_20_scored_shadow_calls(self):
        self.assertEqual(ta_bot.onboard(ENV, Backend(scored=19), self.decisions, NOW), {'state': 'earning', 'scoredShadowCalls': 19, 'needed': 20})
        backend = Backend(scored=20)
        out = ta_bot.onboard(ENV, backend, self.decisions, NOW)
        self.assertEqual((out['state'], out['fitness'], out['activeEligible']), ('evaluated', 'adds-value', True))
        fitness = next(c for c in backend.calls if c[0] == '/v1/bots/fitness/live')
        self.assertEqual((fitness[1]['model'], fitness[2]), ('tradingagents:0.9.0:qwen', 'e'))  # judged on its own shadow calls
        release = next(c for c in backend.calls if c[0] == '/v1/releases')
        self.assertEqual(release[2], 'r')  # the researcher registers; the evaluator judges
        self.assertEqual(ta_bot.onboard(ENV, Backend(releases=[{'id': 'rel'}]), self.decisions, NOW)['state'], 'has-release')


if __name__ == '__main__':
    unittest.main()
