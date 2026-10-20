from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import datasets

IST = timezone(timedelta(hours=5, minutes=30))


def dataset(symbol='INFY.NS', bars=20, dividend=0):
    start = datetime(2026, 9, 1, 9, 15, tzinfo=IST)
    rows = [{'time': (start + timedelta(minutes=5 * k)).isoformat(), 'openPaise': 100000, 'highPaise': 100100,
             'lowPaise': 99900, 'closePaise': 100050, 'volume': 10, 'dividend': dividend if k == 3 else 0, 'split': 0}
            for k in range(bars)]
    return {'schemaVersion': 1, 'symbol': symbol, 'currency': 'INR', 'interval': '5m', 'source': 'synthetic-test',
            'priceBasis': 'unadjusted', 'bars': rows}


class DatasetTests(unittest.TestCase):
    def test_validator_applies_replay_bar_rules_to_universe_symbols_only(self):
        self.assertEqual(len(datasets.validate(dataset())), 20)
        with self.assertRaisesRegex(ValueError, 'SYMBOL_NOT_IN_UNIVERSE'):
            datasets.validate(dataset('TCS.NS'))
        with self.assertRaisesRegex(ValueError, 'CORPORATE_ACTION'):
            datasets.validate(dataset(dividend=5.0))
        broken = dataset()
        broken['bars'][4]['highPaise'] = 1
        with self.assertRaisesRegex(ValueError, 'INVALID_OHLC'):
            datasets.validate(broken)

    def test_download_refuses_symbols_outside_the_universe_before_any_network_use(self):
        with self.assertRaisesRegex(ValueError, 'SYMBOL_NOT_IN_UNIVERSE'):
            datasets.download('TCS.NS', date(2026, 9, 1))

    def test_fetch_caches_per_symbol_never_refetches_and_records_skips(self):
        calls = []

        def fake(symbol, end):
            calls.append((symbol, end))
            if symbol == 'NTPC.NS':
                raise ValueError('CORPORATE_ACTION_REQUIRES_ADJUSTMENT')
            return dataset(symbol)
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder)
            ends = datasets.window_ends(date(2026, 9, 15), 2)
            first = datasets.fetch(ends, fake, cache, symbols=('INFY.NS', 'NTPC.NS'))
            self.assertEqual([r['state'] for r in first], ['downloaded', 'downloaded', 'skipped', 'skipped'])
            self.assertTrue((cache / 'INFY.NS-5m-2026-09-15.json').exists())
            second = datasets.fetch(ends, fake, cache, symbols=('INFY.NS',))
            self.assertEqual([r['state'] for r in second], ['cached', 'cached'])
            self.assertEqual(len(calls), 4)
            self.assertEqual(json.loads((cache / 'INFY.NS-5m-2026-09-08.json').read_text())['symbol'], 'INFY.NS')


if __name__ == '__main__':
    unittest.main()
