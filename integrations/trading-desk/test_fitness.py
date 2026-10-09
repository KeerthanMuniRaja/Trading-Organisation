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


if __name__ == '__main__':
    unittest.main()
