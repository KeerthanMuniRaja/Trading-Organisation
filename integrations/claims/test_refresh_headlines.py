import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import autolearn
import refresh_headlines
from test_autolearn import CONFIG, FakeBackend, cycle


class RefreshTests(unittest.TestCase):
    def test_finite_refresh_observes_revocation_without_model_or_backend_mutations(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            backend = FakeBackend(['e1', 'e2'])
            cycle(backend, state)
            writes = len(backend.mutations)
            sleeps = []
            def sleep(seconds):
                sleeps.append(seconds)
                backend.evidence['e1']['status'] = 'revoked'
            with patch.object(autolearn.claims, 'model_client', side_effect=AssertionError('No model allowed')):
                result = refresh_headlines.run(CONFIG, state, backend.api('researcher'), cycles=2, sleep=sleep)
            self.assertEqual([r['headlines'] for r in result], [2, 0])
            self.assertEqual(sleeps, [120])
            self.assertEqual(len(backend.mutations), writes)
            self.assertFalse((state / 'headline-refresh.lock').exists())

    def test_failure_removes_receipt_stops_and_releases_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            backend = FakeBackend(['e1', 'e2'])
            cycle(backend, state)
            def failed(*args):
                raise RuntimeError('private backend detail')
            result = refresh_headlines.run(CONFIG, state, failed, cycles=3, sleep=lambda _: self.fail('must stop'))
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0]['outcome'], 'failed')
            self.assertNotIn('private backend detail', str(result))
            self.assertFalse(autolearn.headline_receipt.receipt_path(state / 'verified-headlines.json').exists())
            self.assertFalse((state / 'headline-refresh.lock').exists())

    def test_lock_and_capacity_are_enforced(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp)
            for kwargs in ({'cycles': 0}, {'cycles': 121}, {'interval_seconds': 10}):
                with self.assertRaises(ValueError):
                    refresh_headlines.run(CONFIG, state, None, **kwargs)
            (state / 'headline-refresh.lock').write_text('other')
            with self.assertRaisesRegex(ValueError, 'holds this state'):
                refresh_headlines.run(CONFIG, state, None)


if __name__ == '__main__':
    unittest.main()
