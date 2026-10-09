import copy
from datetime import datetime, timedelta
import unittest
from replay import run_replay, validate


def dataset(count=40):
    start = datetime.fromisoformat('2026-10-07T09:15:00+05:30')
    return {'schemaVersion': 1, 'symbol': 'RELIANCE.NS', 'currency': 'INR', 'interval': '5m',
            'source': 'synthetic-test', 'priceBasis': 'unadjusted', 'bars': [
                {'time': (start + timedelta(minutes=5*i)).isoformat(),
                 'openPaise': 140000+i*100, 'highPaise': 140150+i*100,
                 'lowPaise': 139950+i*100, 'closePaise': 140100+i*100, 'volume': 100}
                for i in range(count)]}


class ReplayTests(unittest.TestCase):
    def test_next_bar_fill_and_accounting(self):
        d = dataset()
        r = run_replay(d)
        self.assertGreater(len(r['trades']), 0)
        self.assertEqual(r['trades'][0]['signalBar'], d['bars'][11]['time'])
        self.assertEqual(r['trades'][0]['fillBar'], d['bars'][12]['time'])
        for trade in r['trades']:
            self.assertLess(trade['signalBar'], trade['fillBar'])
        self.assertEqual(r['endingEquityPaise'] - r['initialPaise'],
                         r['realisedNetPaise'] + r['unrealisedNetPaise'])
        self.assertGreaterEqual(r['cashPaise'], 0)
        self.assertEqual(r['realisedNetPaise'], sum(t.get('realisedNetPaise', 0) for t in r['trades']))

    def test_future_bars_cannot_change_earlier_decisions_or_fills(self):
        d = dataset()
        changed = copy.deepcopy(d)
        for b in changed['bars'][25:]:
            for k in ('openPaise', 'highPaise', 'lowPaise', 'closePaise'):
                b[k] //= 2
        a, b = run_replay(d), run_replay(changed)
        self.assertEqual(a['decisions'][:25], b['decisions'][:25])
        cutoff = d['bars'][25]['time']
        self.assertEqual([t for t in a['trades'] if t['fillBar'] < cutoff],
                         [t for t in b['trades'] if t['fillBar'] < cutoff])

    def test_gap_uses_next_open_not_signal_close(self):
        d = dataset(13)
        d['bars'][12].update(openPaise=190000, highPaise=191000, lowPaise=189000, closePaise=190500)
        r = run_replay(d)
        self.assertEqual(r['trades'][0]['fillPaise'], 190095)
        self.assertIsNotNone(r['openPosition'])

    def test_oversized_gap_and_missing_volume_do_not_fill(self):
        for no_volume in (False, True):
            d = dataset(13)
            if no_volume:
                d['bars'][11]['volume'] = 0
            else:
                d['bars'][12].update(openPaise=250000, highPaise=251000, lowPaise=249000, closePaise=250500)
            self.assertEqual(run_replay(d)['trades'], [])

    def test_execution_bar_volume_cannot_change_open_fill(self):
        d = dataset(13)
        normal = run_replay(d)
        d['bars'][12]['volume'] = 0
        self.assertEqual(run_replay(d)['trades'], normal['trades'])

    def test_malformed_data_is_rejected_before_trading(self):
        for mutate in [lambda d: d.update(currency='USD'),
                       lambda d: d['bars'][1].update(time=d['bars'][0]['time']),
                       lambda d: d['bars'][1].update(highPaise=1),
                       lambda d: d['bars'][1].update(openPaise=True),
                       lambda d: d['bars'][1].update(volume=-1),
                       lambda d: d['bars'][1].update(split=2),
                       lambda d: d['bars'][1].update(dividend=5)]:
            d = dataset()
            mutate(d)
            with self.assertRaises(ValueError):
                validate(d)

    def test_final_signal_remains_unfilled_and_input_not_mutated(self):
        d = dataset(13)
        original = copy.deepcopy(d)
        r = run_replay(d)
        self.assertEqual(d, original)
        self.assertIsNotNone(r['openPosition'])
        self.assertEqual(r['realisedNetPaise'], 0)


if __name__ == '__main__':
    unittest.main()
