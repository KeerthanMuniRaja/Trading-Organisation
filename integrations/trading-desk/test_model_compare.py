import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch
import model_compare
from test_desk import StubModel, synthetic


class ModelCompareTests(unittest.TestCase):
    def test_results_from_two_models_appear_side_by_side(self):
        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp)
            path = local / 'w.json'
            path.write_text(json.dumps(synthetic()), encoding='utf-8')
            for model in ('small-local', 'big-cloud'):
                batch.run_batch([path], StubModel(), local / 'batches' / f'eight-{model}', every=12, max_decisions=12,
                                max_calls=100, model=model)
            run = local / 'ai-allocator' / 'ai-big'
            run.mkdir(parents=True)
            (run / 'report.json').write_text(json.dumps({
                'name': 'ai-big', 'model': 'big-cloud', 'promptVersion': 'p1', 'from': '2022-10-10', 'through': '2026-10-09',
                'months': 48, 'failedMonths': 0, 'averageCashPct': 20.0,
                'results': {'ai-allocator': {'netPaise': 9, 'cagr': 0.1, 'maxDrawdown': 0.1, 'costsPaise': 5},
                            'buy-and-hold-equal': {'netPaise': 7, 'cagr': 0.09, 'maxDrawdown': 0.17, 'costsPaise': 1}}}), encoding='utf-8')
            report = model_compare.compare(local)
            self.assertEqual(report['models'], ['big-cloud', 'small-local'])
            self.assertEqual({r['model'] for r in report['desk']}, {'small-local', 'big-cloud'})
            self.assertTrue(all(r['deskVersion'] and r['fitness'] for r in report['desk']))
            self.assertEqual(report['allocator'][0]['beatBasket'], True)
            self.assertEqual(report['allocator'][0]['monthly']['netPaise'], None)  # missing arms stay visibly empty

    def test_nothing_saved_yet_is_an_empty_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = model_compare.compare(Path(tmp))
            self.assertEqual((report['desk'], report['allocator'], report['models']), ([], [], []))


if __name__ == '__main__':
    unittest.main()
