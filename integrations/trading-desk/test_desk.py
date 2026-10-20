from datetime import datetime, timedelta, timezone
import glob
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import desk
import learning
from replay import run_replay

IST = timezone(timedelta(hours=5, minutes=30))


def synthetic(days=3, drift=(3, -2, 4), start_day=5):
    """Valid 5-minute session bars with alternating trends, plus a gap so the data steward has work to do."""
    bars, price = [], 150_000  # about Rs 1,500, inside the 20% position cap
    for d in range(days):
        start = datetime(2026, 1, start_day + d, 9, 15, tzinfo=IST)
        for k in range(75):
            step = drift[d % len(drift)] * (1 if (k // 10) % 2 == 0 else -1) * 40
            o, c = price, price + step
            bars.append({'time': (start + timedelta(minutes=5 * k)).isoformat(), 'openPaise': o, 'highPaise': max(o, c) + 50,
                         'lowPaise': min(o, c) - 50, 'closePaise': c, 'volume': 1000 + 10 * k})
            price = c
    return {'schemaVersion': 1, 'symbol': 'RELIANCE.NS', 'currency': 'INR', 'interval': '5m', 'source': 'synthetic-test',
            'priceBasis': 'unadjusted', 'bars': bars}


class StubModel:
    """Records every prompt; analysts answer by their own inputs, the manager follows the trend analyst."""
    def __init__(self, fail_roles=()):
        self.calls, self.fail_roles = [], fail_roles

    def __call__(self, system, user, schema):
        payload = json.loads(user)
        role = learning.role_of(system)
        self.calls.append((role, payload, schema))
        if role in self.fail_roles:
            raise ValueError('ENDPOINT_TIMEOUT')
        meta = {'latencyMs': 1.0, 'promptTokens': 10, 'completionTokens': 5}
        if role == 'trend-analyst':
            stance = 'bullish' if payload['return1HourBps'] > 30 else 'bearish' if payload['return1HourBps'] < -30 else 'neutral'
            return {'stance': stance, 'conviction': 'medium', 'reasons': ['1h return'], 'invalidation': 'reversal'}, meta
        if role == 'reversion-analyst':
            stance = 'bearish' if payload['distanceFromVwapBps'] > 50 else 'bullish' if payload['distanceFromVwapBps'] < -50 else 'neutral'
            return {'stance': stance, 'conviction': 'low', 'reasons': ['vwap distance'], 'invalidation': 'trend'}, meta
        if role == 'news-analyst':
            stance = 'bullish' if any('beats' in h['title'] for h in payload['headlines']) else 'neutral'
            return {'stance': stance, 'conviction': 'medium', 'reasons': ['headline'], 'invalidation': 'denial'}, meta
        trend = payload['opinions']['trend-analyst']['stance']
        allowed = payload['allowedActions']
        action = 'buy' if trend == 'bullish' and 'buy' in allowed else 'sell' if trend == 'bearish' and 'sell' in allowed else 'hold'
        return {'action': action, 'rationale': 'Follow trend view.', 'reliedOn': ['trend-analyst']}, meta


class DeskTests(unittest.TestCase):
    def test_simulator_reproduces_the_momentum_baseline_exactly(self):
        datasets = [synthetic()] + [json.loads(Path(p).read_text(encoding='utf-8'))
                                    for p in sorted(glob.glob(str(desk.ROOT / '.local' / 'market-replay' / '*' / 'dataset.json')))[:2]]
        for dataset in datasets:
            expected = run_replay(dataset)
            got = desk.simulate(dataset['bars'], desk.momentum_decider(dataset['bars']))
            self.assertEqual(got['realisedNetPaise'], expected['realisedNetPaise'])
            self.assertEqual(got['endingEquityPaise'], expected['endingEquityPaise'])
            self.assertEqual([(t['side'], t['fillBar'], t['fillPaise']) for t in got['trades']],
                             [(t['side'], t['fillBar'], t['fillPaise']) for t in expected['trades']])
            self.assertAlmostEqual(got['maxDrawdownFraction'], expected['maxDrawdownFraction'], places=6)

    def test_bots_see_only_completed_bars_and_analysts_stay_independent(self):
        data = synthetic()
        bars = data['bars']
        before = (desk.trend_view(bars, 40), desk.reversion_view(bars, 40))
        altered = [dict(b) for b in bars]
        for b in altered[41:]:
            b['closePaise'] += 9999
            b['highPaise'] += 9999
        self.assertEqual(before, (desk.trend_view(altered, 40), desk.reversion_view(altered, 40)))
        model = StubModel()
        result = desk.run_desk(data, model, every=12, max_decisions=6)
        for role, payload, _ in model.calls:
            if role != 'portfolio-manager':
                text = json.dumps(payload)
                self.assertNotIn('"stance"', text)
                self.assertNotIn('opinions', text)
        managers = [p for r, p, _ in model.calls if r == 'portfolio-manager']
        self.assertTrue(managers and all(set(p['opinions']) == {'trend-analyst', 'reversion-analyst'} for p in managers))
        self.assertEqual(result['modelCalls'], len(model.calls))
        # Fills only ever happen on a later bar than the signal.
        for t in result['desk']['trades']:
            self.assertLess(t['signalBar'], t['fillBar'])

    def test_manager_schema_only_offers_valid_actions_and_risk_officer_vetoes(self):
        model = StubModel()
        desk.run_desk(synthetic(), model, every=12, max_decisions=6)
        for role, payload, schema in model.calls:
            if role == 'portfolio-manager':
                self.assertEqual(schema['properties']['action']['enum'], payload['allowedActions'])
        book = {'cash': desk.INITIAL, 'position': None, 'realised': -10_000, 'trades': []}
        bar = {'time': '2026-01-05T15:10:00+05:30', 'closePaise': 150_000}
        self.assertEqual(set(desk.risk_officer(book, bar, {'usable': False})),
                         {'data-unusable', 'too-close-to-session-end', 'loss-limit-reached'})

    def test_unusable_data_skips_the_models_and_failures_become_abstentions(self):
        data = synthetic()
        bars = data['bars']
        steward = desk.data_steward(bars, 80)  # its last hour spans the overnight gap
        self.assertFalse(steward['usable'])
        self.assertIn('missing-or-overnight-bars-in-last-hour', steward['reasons'])
        model = StubModel(fail_roles=('trend-analyst', 'portfolio-manager'))
        result = desk.run_desk(data, model, every=12, max_decisions=8)
        meetings = [d for d in result['decisions'] if d['type'] == 'desk-meeting' and 'portfolio-manager' in d['bots']]
        self.assertTrue(meetings)
        self.assertTrue(all(d['action'] == 'hold' for d in meetings))
        self.assertTrue(all(d['bots']['trend-analyst']['outcome'] == 'failed' for d in meetings))
        self.assertEqual(result['desk']['trades'], [])
        self.assertEqual(result['scorecards']['analysts']['trend-analyst']['abstained'], len(meetings))
        unusable = [d for d in result['decisions'] if d['type'] == 'desk-meeting' and 'portfolio-manager' not in d['bots']]
        for d in unusable:
            self.assertFalse(d['bots']['data-steward']['usable'])

    def test_scorecards_judge_each_role_against_the_cost_threshold(self):
        result = desk.run_desk(synthetic(), StubModel(), every=12, max_decisions=8)
        cards = result['scorecards']['analysts']
        for card in cards.values():
            self.assertEqual(card['opinions'] + card['abstained'] + card['notConsulted'], sum(
                1 for d in result['decisions'] if d['type'] == 'desk-meeting' and 'portfolio-manager' in d['bots']))
            self.assertTrue(card['hitRate'] is None or 0 <= card['hitRate'] <= 1)
        self.assertIsNotNone(result['scorecards']['analystAgreementRate'])
        self.assertIn('momentum', result['baselines'])
        self.assertEqual(result['baselines']['cashPaise'], 0)
        self.assertLessEqual(result['decisionPoints'], 8)
        manager = result['scorecards']['portfolioManager']
        self.assertEqual(manager['decisions'], sum(manager['actions'].values()))
        self.assertTrue(0 <= manager['accuracy'] <= 1 and 0 <= manager['alwaysHoldAccuracy'] <= 1)

    def test_manager_is_judged_against_what_the_next_hour_rewarded(self):
        bars = synthetic()['bars']
        i = 30
        forward = desk.bps(bars[i + 12]['closePaise'], bars[i]['closePaise'])
        def meeting(action, allowed):
            return {'type': 'desk-meeting', 'index': i, 'allowed': allowed, 'bots': {
                'trend-analyst': {'outcome': 'failed'}, 'reversion-analyst': {'outcome': 'failed'},
                'portfolio-manager': {'outcome': 'valid', 'decision': {'action': action}}}}
        flat_best = 'buy' if forward > desk.COST_BPS_ROUND_TRIP else 'hold'
        for action in ('buy', 'hold'):
            card = desk.scorecards(bars, [meeting(action, ['buy', 'hold'])], 12)['portfolioManager']
            self.assertEqual(card['correct'], int(action == flat_best))
            self.assertEqual(card['alwaysHoldCorrect'], int(flat_best == 'hold'))
            self.assertEqual(card['badEntries'], int(action == 'buy' and flat_best != 'buy'))


if __name__ == '__main__':
    unittest.main()


class BatchTests(unittest.TestCase):
    def test_batch_resumes_without_repeating_calls_and_respects_the_budget(self):
        import tempfile
        import batch
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            paths = []
            for k, drift in enumerate(((3, -2, 4), (-2, 3, -1), (1, 1, 1))):
                data = synthetic(drift=drift)
                path = tmp / f'w{k}.json'
                path.write_text(json.dumps(data), encoding='utf-8')
                paths.append(path)
            model = StubModel()
            out = tmp / 'batch'
            first = batch.run_batch(paths, model, out, every=12, max_decisions=4, max_calls=25, model='stub')
            self.assertEqual(first['stoppedReason'], 'call-budget')  # 3 windows x 4 meetings x 3 calls exceeds 25
            self.assertEqual(first['windows'], 2)
            calls_after_first = len(model.calls)
            second = batch.run_batch(paths, model, out, every=12, max_decisions=4, max_calls=25, model='stub')
            self.assertEqual(second['windows'], 3)
            self.assertLessEqual(len(model.calls) - calls_after_first, 12)  # only the missing window ran
            third = batch.run_batch(paths, model, out, every=12, max_decisions=4, max_calls=25, model='stub')
            self.assertEqual(third['modelCallsThisRun'], 0)  # everything resumed from saved results
            self.assertEqual(third['desk']['netPaise'], sum(w['deskNetPaise'] for w in third['perWindow']))
            # A different model or cadence never reuses saved results.
            fourth = batch.run_batch(paths[:1], model, out, every=12, max_decisions=4, max_calls=25, model='other')
            self.assertGreater(fourth['modelCallsThisRun'], 0)


class LearningTests(unittest.TestCase):
    def test_lessons_are_counted_facts_from_past_decisions_only(self):
        import learning
        data = synthetic()
        result = desk.run_desk(data, StubModel(), every=12, max_decisions=8)
        exp = learning.experience([(data['bars'], result['decisions'])], 12)
        meetings = [d for d in result['decisions'] if d['type'] == 'desk-meeting' and 'portfolio-manager' in d['bots']]
        for role in desk.MARKET_VIEWS:
            self.assertEqual(sum(sum(c.values()) for c in exp['analysts'][role].values()), len(meetings))
        self.assertEqual(exp['analysts']['news-analyst'], {})  # no news supplied, so nothing to learn from
        flat = [d for d in meetings if d['allowed'] == ['buy', 'hold']]
        self.assertEqual(exp['manager']['meetings'], len(flat))
        self.assertEqual(exp['manager']['held'] + exp['manager']['entries'], len(flat))
        role_lessons = learning.lessons(exp, '2026-01-05 to 2026-01-07')
        self.assertEqual(set(role_lessons), set(learning.ROLES))
        self.assertTrue(all(isinstance(line, str) for lines in role_lessons.values() for line in lines))

    def test_each_bot_receives_only_its_own_lessons(self):
        import learning
        model = StubModel()
        role_lessons = {'trend-analyst': ['T'], 'reversion-analyst': ['R'], 'portfolio-manager': ['P']}
        desk.run_desk(synthetic(), learning.with_lessons(model, role_lessons), every=12, max_decisions=3)
        for role, payload, _ in model.calls:
            self.assertEqual(payload['lessonsFromYourPastResults'], role_lessons[role])

    def test_walk_forward_split_is_strictly_chronological(self):
        import walkforward
        rows = [{'from': f'2026-01-0{k}T09:15', 'to': f'2026-01-0{k}T15:25'} for k in range(1, 6)]
        train, test = walkforward.split(rows, 3)
        self.assertEqual(len(train), 3)
        self.assertLess(max(r['to'] for r in train), min(r['from'] for r in test))
        with self.assertRaises(ValueError):
            walkforward.split([{'from': '2026-01-02', 'to': '2026-01-09'}, {'from': '2026-01-05', 'to': '2026-01-06'}], 1)
        with self.assertRaises(ValueError):
            walkforward.split(rows[:2], 2)


    def test_walk_forward_end_to_end_pairs_each_test_week_with_its_control(self):
        import tempfile
        import batch
        import walkforward
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            original = walkforward.BATCHES
            walkforward.BATCHES = tmp / 'batches'
            try:
                paths = []
                for k, day in enumerate((5, 12, 19, 26)):  # four consecutive Monday-start weeks
                    path = tmp / f'w{k}.json'
                    path.write_text(json.dumps(synthetic(drift=((3, -2, 4), (-2, 3, -1), (1, -3, 2), (2, 2, -2))[k], start_day=day)), encoding='utf-8')
                    paths.append(path)
                model = StubModel()
                batch.run_batch(paths, model, walkforward.BATCHES / 'control', every=12, max_decisions=4, max_calls=100, model='stub')
                result = walkforward.run('control', 'treated', 2, model, 'stub', max_calls=100)
                self.assertEqual(result['testWindows'], 2)
                self.assertEqual(len(result['train']), 2)
                self.assertLess(result['train'][-1].split('..')[1], result['pairs'][0]['from'] + 'T')
                treated_calls = [p for r, p, _ in model.calls if 'lessonsFromYourPastResults' in p]
                self.assertTrue(treated_calls)
                self.assertTrue((walkforward.BATCHES / 'treated' / 'comparison.json').exists())
                with self.assertRaises(ValueError):  # a name cannot be reused with different lessons
                    (walkforward.BATCHES / 'treated' / 'lessons.json').write_text('{"tampered": []}', encoding='utf-8')
                    walkforward.run('control', 'treated', 2, model, 'stub', max_calls=100)
            finally:
                walkforward.BATCHES = original


class ExportTests(unittest.TestCase):
    def test_evidence_then_reviewed_lessons_with_stable_retry_keys(self):
        import tempfile
        import batch
        import export_evidence as ex
        from urllib.error import HTTPError

        class Response:
            def __init__(self, body): self.body = body
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n): return json.dumps(self.body).encode()

        sent = []
        def opener(req, timeout):
            sent.append((req.full_url, req.headers['Idempotency-key'], json.loads(req.data)))
            return Response({'id': f'00000000-0000-4000-8000-{len(sent):012d}', 'status': 'unverified'})
        env = {'API_URL': 'http://127.0.0.1:3000', 'PRINCIPALS_JSON': json.dumps([{'role': 'researcher', 'token': 'secret-token'}])}
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            data = synthetic()
            path = tmp / 'w.json'
            path.write_text(json.dumps(data), encoding='utf-8')
            batch.run_batch([path], StubModel(), tmp / 'batches' / 'b1', every=12, max_decisions=4, max_calls=50, model='stub')
            bundles = ex.prepare('b1', 'desk-replay', out=tmp / 'exports', batches=tmp / 'batches')
            bundle = json.loads(Path(bundles[0]).read_text(encoding='utf-8'))
            self.assertEqual(set(bundle['evidence']), {'sourceId', 'kind', 'content', 'publishedAt'})
            self.assertEqual(bundle['evidence']['publishedAt'], data['bars'][-1]['time'])
            self.assertLessEqual(len(bundle['evidence']['content']), 4000)
            self.assertEqual(set(bundle['lessons']), set(learning.ROLES))
            self.assertNotIn('news-analyst', bundle['evidence']['content'])  # never consulted, so not reported
            with self.assertRaises(ValueError):
                ex.submit_lessons(bundles[0], {'trend-analyst': 'desk-trend'}, env=env, opener=opener)  # evidence first
            first = ex.submit_evidence(bundles[0], env=env, opener=opener)
            ex.submit_evidence(bundles[0], env=env, opener=opener)
            self.assertEqual(sent[0][1], sent[1][1])  # a retry reuses the same idempotency key
            self.assertTrue(sent[0][0].endswith('/v1/evidence'))
            with self.assertRaises(ValueError):
                ex.submit_lessons(bundles[0], {'unknown-role': 'desk-x'}, env=env, opener=opener)
            receipt = ex.submit_lessons(bundles[0], {'trend-analyst': 'desk-trend', 'portfolio-manager': 'desk-pm'}, env=env, opener=opener)
            self.assertEqual(set(receipt['lessons']), {'trend-analyst', 'portfolio-manager'})
            lesson_bodies = [body for url, _, body in sent if url.endswith('/v1/lessons')]
            self.assertTrue(first['evidenceId'])
            self.assertTrue(all(body['evidenceId'] == receipt['evidenceId'] for body in lesson_bodies))
            self.assertEqual({b['botId'] for b in lesson_bodies}, {'desk-trend', 'desk-pm'})
            def refusing(req, timeout):
                raise HTTPError(req.full_url, 409, 'secret-token detail', {}, None)
            with self.assertRaises(RuntimeError) as raised:
                ex.submit_evidence(bundles[0], env=env, opener=refusing)
            self.assertNotIn('secret-token', str(raised.exception))
            with self.assertRaises(ValueError):
                ex.prepare('../escape', 'desk-replay', out=tmp / 'exports', batches=tmp / 'batches')
