from datetime import datetime
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import desk
import tournament as t
from test_desk import synthetic

WEEKS = {'2026-01-12': ((3, -2, 4), 5), '2026-01-19': ((-2, 3, -1), 12), '2026-01-26': ((4, -4, 3), 19), '2026-02-02': ((-3, 4, -2), 26)}


class TournamentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cache = self.root / 'datasets'
        self.cache.mkdir()
        for end, (drift, day) in WEEKS.items():
            for symbol, scale in (('RELIANCE.NS', 1), ('INFY.NS', 2)):
                data = synthetic(drift=tuple(d * scale for d in drift), start_day=day)
                data['symbol'] = symbol
                (self.cache / f'{symbol}-5m-{end}.json').write_text(json.dumps(data), encoding='utf-8')

    def tearDown(self):
        self.tmp.cleanup()

    def run_t(self, name):
        return t.run(name, ['INFY.NS', 'RELIANCE.NS'], validation=1, sealed=1, root=self.root / 'tournaments', cache=self.cache)

    def test_split_is_chronological_and_every_entrant_is_recorded(self):
        record = self.run_t('t1')
        self.assertEqual(record['split'], {'train': ['2026-01-12', '2026-01-19'], 'validation': ['2026-01-26'], 'sealed': ['2026-02-02']})
        self.assertEqual(record['entrantsTried'], len(t.ENTRANTS))
        self.assertEqual(set(record['results']), set(t.ENTRANTS))
        self.assertEqual(record['results']['cash']['validation'], {'netPaise': 0, 'trades': 0, 'profitableWindows': 0, 'windows': 2})
        if record['winner']:
            self.assertGreater(record['results'][record['winner']]['validation']['netPaise'], 0)
        else:
            self.assertTrue(all(r['validation']['netPaise'] <= 0 for r in record['results'].values()))
        with self.assertRaisesRegex(ValueError, 'exists'):
            self.run_t('t1')

    def test_sealed_weeks_are_judged_once_and_only_on_unchanged_data(self):
        self.run_t('t1')
        outcome = t.finalise('t1', root=self.root / 'tournaments', cache=self.cache)
        self.assertEqual(outcome['weeks'], ['2026-02-02'])
        self.assertEqual(outcome['cash']['netPaise'], 0)
        self.assertIn(outcome['verdict'], ('beat-cash-on-sealed-weeks', 'failed-on-sealed-weeks', 'no-entrant-qualified'))
        with self.assertRaisesRegex(ValueError, 'already used'):
            t.finalise('t1', root=self.root / 'tournaments', cache=self.cache)
        self.run_t('t2')
        path = self.cache / 'INFY.NS-5m-2026-02-02.json'
        data = json.loads(path.read_text(encoding='utf-8'))
        data['bars'][-1]['closePaise'] += 1
        data['bars'][-1]['highPaise'] += 1
        path.write_text(json.dumps(data), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'changed'):
            t.finalise('t2', root=self.root / 'tournaments', cache=self.cache)
        with self.assertRaises(ValueError):
            t.split(['a', 'b'], 1, 1)

    def test_every_entrant_exits_within_the_hour_and_never_holds_overnight(self):
        bars = synthetic()['bars']
        always = lambda bars, i: True  # noqa: E731 - the most aggressive possible entrant
        result = desk.simulate(bars, t.decider(bars, always))
        index = {b['time']: k for k, b in enumerate(bars)}
        fills = result['trades']
        self.assertTrue(fills)
        self.assertIsNone(result['openPosition'])
        for buy, sell in zip(fills[::2], fills[1::2]):
            self.assertEqual((buy['side'], sell['side']), ('buy', 'sell'))
            self.assertLessEqual(index[sell['fillBar']] - index[buy['fillBar']], t.HOLD_BARS + 1)
            self.assertEqual(buy['fillBar'][:10], sell['fillBar'][:10])
            self.assertGreaterEqual(desk.minutes_to_close(bars[index[buy['signalBar']]]), 30)
            self.assertGreaterEqual(index[buy['signalBar']] - desk.session(bars, index[buy['signalBar']]), desk.WARMUP - 1)
        self.assertLessEqual(len(fills), desk.MAX_TRADES)
        self.assertEqual(desk.simulate(bars, t.decider(bars, None))['trades'], [])


if __name__ == '__main__':
    unittest.main()
