import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch
import desk
import fitness
from test_desk import StubModel, synthetic


def meetings(bars, stance_of, action_of, every=12):
    """Hand-made decision log: each analyst and the manager answer by the given rules."""
    out = []
    for i in desk.meeting_points(bars, every, 40):
        forward, actual = fitness.truth(bars, i, every)
        out.append({'type': 'desk-meeting', 'index': i, 'allowed': ['buy', 'hold'], 'bots': {
            'trend-analyst': {'outcome': 'valid', 'latencyMs': 100, 'tokens': [10, 5],
                              'opinion': {'stance': stance_of(actual), 'conviction': 'high' if actual != 'neutral' else 'low'}},
            'reversion-analyst': {'outcome': 'failed'},
            'portfolio-manager': {'outcome': 'valid', 'decision': {'action': action_of(forward)}}}})
    return out


class SignTestTests(unittest.TestCase):
    def test_exact_one_sided_sign_test(self):
        self.assertEqual(fitness.sign_test(0, 0), 1.0)
        self.assertEqual(fitness.sign_test(5, 0), 1 / 32)
        self.assertEqual(fitness.sign_test(3, 3), 42 / 64)

    def test_verdicts_need_enough_disagreements_and_significance(self):
        self.assertEqual(fitness.verdict(15, 4), 'insufficient-evidence')  # 19 disagreements
        self.assertEqual(fitness.verdict(16, 4), 'adds-value')
        self.assertEqual(fitness.verdict(4, 16), 'worse-than-baseline')
        self.assertEqual(fitness.verdict(11, 9), 'no-detectable-skill')


class EvaluateTests(unittest.TestCase):
    def test_an_oracle_beats_the_baseline_and_always_neutral_only_ties_it(self):
        windows = []
        for k, drift in enumerate(((3, -2, 4), (-2, 3, -1), (4, -4, 3), (-3, 4, -2))):  # four January weeks
            bars = synthetic(drift=drift, start_day=5 + 7 * k)['bars']
            windows.append((bars, meetings(bars, lambda actual: actual, lambda f: 'buy' if f > desk.COST_BPS_ROUND_TRIP else 'hold'), 12))
        report = fitness.evaluate(windows)
        oracle = report['trend-analyst']
        self.assertEqual((oracle['accuracy'], oracle['losses']), (1.0, 0))
        self.assertEqual(oracle['wins'], oracle['judged'] - oracle['baselineCorrect'])
        self.assertEqual(report['portfolio-manager']['losses'], 0)
        self.assertEqual(report['reversion-analyst']['verdict'], 'no-valid-calls')
        self.assertEqual(report['reversion-analyst']['failureRate'], 1.0)
        self.assertEqual(report['forecast-analyst']['verdict'], 'not-consulted')
        self.assertEqual(oracle['medianLatencyMs'], 100)
        self.assertEqual(oracle['tokens'], 15 * oracle['judged'])
        if oracle['wins'] >= fitness.MIN_DISAGREEMENTS:
            self.assertEqual(oracle['verdict'], 'adds-value')
        self.assertTrue(oracle['byConviction'])
        self.assertTrue(all(c['accuracy'] == 1.0 for c in oracle['byConviction'].values()))
        self.assertEqual(sum(c['judged'] for c in oracle['byConviction'].values()), oracle['judged'])
        neutral = fitness.evaluate([(w[0], meetings(w[0], lambda a: 'neutral', lambda f: 'hold'), 12) for w in windows])
        self.assertEqual(neutral['trend-analyst']['accuracy'], neutral['trend-analyst']['baselineAccuracy'])
        self.assertEqual((neutral['trend-analyst']['wins'], neutral['trend-analyst']['losses']), (0, 0))
        self.assertEqual(neutral['trend-analyst']['verdict'], 'insufficient-evidence')

    def test_reads_saved_batches(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            paths = []
            for k, day in enumerate((5, 12)):
                path = tmp / f'w{k}.json'
                path.write_text(json.dumps(synthetic(start_day=day)), encoding='utf-8')
                paths.append(path)
            batch.run_batch(paths, StubModel(), tmp / 'batches' / 'b1', every=12, max_decisions=12, max_calls=200, model='stub')
            windows = fitness.load(['b1'], batches=tmp / 'batches')
            self.assertEqual(len(windows), 2)
            report = fitness.evaluate(windows)
            held = sum(1 for _, log, _ in windows for d in log if d['type'] == 'desk-meeting' and 'portfolio-manager' in d['bots'])
            self.assertGreater(held, 0)
            self.assertEqual(report['trend-analyst']['judged'] + report['trend-analyst']['failed'], held)
            self.assertIn(report['portfolio-manager']['verdict'], ('insufficient-evidence', 'no-detectable-skill', 'adds-value', 'worse-than-baseline'))


class SubmitTests(unittest.TestCase):
    def test_counts_go_to_the_backend_with_the_right_baseline_and_stable_retry_keys(self):
        cards = {'trend-analyst': {'judged': 86, 'wins': 5, 'losses': 8, 'failed': 0},
                 'portfolio-manager': {'judged': 86, 'wins': 0, 'losses': 2, 'failed': 0},
                 'news-analyst': {'judged': 0, 'wins': 0, 'losses': 0, 'failed': 0}}
        facts = {'periodFrom': '2026-08-14', 'periodTo': '2026-10-08', 'models': ['Qwen3.5-4B-Q4_K_M']}
        payloads = fitness.submissions(cards, {'trend-analyst': 'org-trend', 'portfolio-manager': 'org-pm', 'news-analyst': 'org-news'},
                                       'eight-weeks-v1', facts)
        self.assertEqual([(p['role'], p['baseline']) for p in payloads],
                         [('portfolio-manager', 'always-hold'), ('trend-analyst', 'always-neutral')])  # never-consulted roles skipped
        self.assertNotIn('verdict', payloads[0])  # the backend decides the verdict from the counts
        with self.assertRaisesRegex(ValueError, 'one model'):
            fitness.submissions(cards, {'trend-analyst': 'x'}, 't', {**facts, 'models': ['a', 'b']})

        sent = []

        class Response:
            def __init__(self, body): self.body = body
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, n): return json.dumps(self.body).encode()

        def opener(req, timeout):
            sent.append((req.full_url, req.headers['Idempotency-key'], json.loads(req.data)))
            return Response({'id': 'r1', 'verdict': 'insufficient-evidence', 'duplicate': False})
        env = {'API_URL': 'http://127.0.0.1:3000', 'PRINCIPALS_JSON': json.dumps([{'role': 'evaluator', 'token': 'secret-token'},
                                                                                  {'role': 'researcher', 'token': 'other'}])}
        results = fitness.submit(payloads, env, opener)
        fitness.submit(payloads, env, opener)
        self.assertEqual([r['role'] for r in results], ['portfolio-manager', 'trend-analyst'])
        self.assertTrue(all(url.endswith('/v1/bots/fitness') for url, _, _ in sent))
        self.assertEqual(sent[0][1], sent[2][1])  # a retry reuses the same idempotency key
        with self.assertRaisesRegex(ValueError, 'exactly one evaluator'):
            fitness.submit(payloads, {**env, 'PRINCIPALS_JSON': json.dumps([{'role': 'researcher', 'token': 'x'}])}, opener)
        with self.assertRaisesRegex(ValueError, 'origin'):
            fitness.submit(payloads, {**env, 'API_URL': 'http://evil.example.com'}, opener)


if __name__ == '__main__':
    unittest.main()
