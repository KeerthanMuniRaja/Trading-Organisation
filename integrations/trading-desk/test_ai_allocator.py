import json
from pathlib import Path
import re
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_allocator as ai
import daily
import portfolio_daily as pd
from test_daily import synthetic_daily

SYMBOLS = sorted(daily.datasets.UNIVERSE)
EVEN = {**{k: 12 for k in ai.LETTERS}, 'rationale': 'Hold the basket evenly.'}


class Stub:
    def __init__(self, reply=EVEN, fail_on=()):
        self.reply, self.fail_on, self.calls = reply, set(fail_on), []

    def __call__(self, system, user, schema):
        self.calls.append(json.loads(user))
        if len(self.calls) in self.fail_on:
            raise ValueError('ENDPOINT_TIMEOUT')
        return dict(self.reply), {'promptTokens': 300, 'completionTokens': 60}


class AllocatorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name) / 'daily'
        self.cache.mkdir()
        for k, symbol in enumerate(SYMBOLS):
            data = synthetic_daily(symbol, drift=0.0003 - 0.0001 * (k % 4), seed=5 + k)
            (self.cache / f'{symbol}-1d.json').write_text(json.dumps(data), encoding='utf-8')
        self.root = Path(self.tmp.name) / 'runs'

    def tearDown(self):
        self.tmp.cleanup()

    def replay(self, llm, name='r1', model='stub', start='2024-06-03', **kw):
        return ai.replay(name, llm, model, start, cache=self.cache, root=self.root, **kw)

    def test_the_brief_hides_names_dates_and_prices_and_uses_only_past_days(self):
        all_bars = daily.load(SYMBOLS, self.cache)
        dates, table = pd.aligned(all_bars)
        letters = ai.mapping('r1', table)
        self.assertEqual(sorted(letters.values()), SYMBOLS)
        self.assertEqual(letters, ai.mapping('r1', table))
        text = json.dumps(ai.brief(table, dates, 900, letters))
        self.assertNotRegex(text, r'\.NS|20\d\d-\d\d|Paise')
        self.assertEqual(set(json.loads(text)), set(ai.LETTERS))
        altered = {s: [dict(b) for b in bars] for s, bars in all_bars.items()}
        for bars in altered.values():
            for b in bars[901:]:
                b['openPaise'] = b['highPaise'] = b['lowPaise'] = b['closePaise'] = 1
        dates2, table2 = pd.aligned(altered)
        self.assertEqual(ai.brief(table, dates, 900, letters), ai.brief(table2, dates2, 900, letters))

    def test_caps_are_enforced_and_code_does_the_arithmetic(self):
        self.assertTrue(ai.valid(EVEN))
        self.assertFalse(ai.valid({**EVEN, 'A': 26}))
        self.assertFalse(ai.valid({**EVEN, 'cash': 4}))  # the model no longer reports cash
        self.assertFalse(ai.valid({**EVEN, 'A': 12.5}))
        self.assertEqual(ai.SCHEMA['properties']['A']['maximum'], 25)
        self.assertEqual(ai.allocation(EVEN), ({k: 12 for k in ai.LETTERS}, 4, False))
        weights, cash, scaled = ai.allocation({**{k: 25 for k in ai.LETTERS}, 'rationale': 'All in.'})  # 200 in total
        self.assertEqual((set(weights.values()), cash, scaled), ({12}, 4, True))
        weights, cash, scaled = ai.allocation({**{k: 0 for k in ai.LETTERS}, 'rationale': 'Stay out.'})
        self.assertEqual((sum(weights.values()), cash, scaled), (0, 100, False))

    def test_replay_compares_the_ai_with_the_basket_on_identical_terms(self):
        stub = Stub()
        report = self.replay(stub)
        self.assertGreater(report['months'], 10)
        self.assertEqual(report['failedMonths'], 0)
        self.assertEqual(len(stub.calls), report['months'])
        self.assertEqual(set(report['results']), {'ai-allocator'} | set(pd.RULES))
        self.assertEqual(report['averageCashPct'], 4.0)
        ai_net, monthly = report['results']['ai-allocator']['netPaise'], report['results']['equal-weight-monthly']['netPaise']
        self.assertLess(abs(ai_net - monthly), pd.CAPITAL * 0.05)  # 96% evenly invested tracks the monthly basket closely
        again = self.replay(stub)
        self.assertEqual(again['callsThisRun'], 0)  # every month resumed from saved decisions
        with self.assertRaisesRegex(ValueError, 'different model'):
            self.replay(stub, model='other')

    def test_failed_months_keep_the_previous_allocation_and_budget_stops_safely(self):
        stub = Stub(fail_on={1, 3})
        with self.assertRaisesRegex(ValueError, 'Call budget'):
            self.replay(stub, name='r2', max_calls=4)
        report = self.replay(stub, name='r2')
        decisions = json.loads((self.root / 'r2' / 'decisions.json').read_text(encoding='utf-8'))
        months = sorted(decisions['months'])
        self.assertEqual(decisions['months'][months[0]]['outcome'], 'failed')
        self.assertEqual(decisions['weights'][months[0]], {})  # nothing decided yet: cash
        self.assertEqual(decisions['weights'][months[2]], decisions['weights'][months[1]])  # failure keeps the last weights
        self.assertEqual(report['failedMonths'], 2)
        self.assertEqual(len(stub.calls), report['months'])  # the budget stop lost no work


class ForwardTests(unittest.TestCase):
    def test_forward_decides_only_new_months_with_the_registered_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache, root = Path(tmp) / 'daily', Path(tmp) / 'runs'
            cache.mkdir()
            full = {}
            for k, symbol in enumerate(SYMBOLS):
                full[symbol] = synthetic_daily(symbol, drift=0.0002, seed=5 + k)
                (cache / f'{symbol}-1d.json').write_text(json.dumps({**full[symbol], 'bars': full[symbol]['bars'][:1100]}), encoding='utf-8')
            record = ai.register('f1', 'stub', cache=cache, root=root)
            self.assertEqual(record['startAfter'], full[SYMBOLS[0]]['bars'][1099]['date'])
            stub = Stub()
            self.assertEqual(ai.forward('f1', stub, 'stub', cache=cache, root=root)['status'], 'waiting')
            self.assertEqual(stub.calls, [])
            for symbol in SYMBOLS:  # new days arrive
                (cache / f'{symbol}-1d.json').write_text(json.dumps(full[symbol]), encoding='utf-8')
            result = ai.forward('f1', stub, 'stub', cache=cache, root=root)
            self.assertEqual(result['status'], 'running')
            self.assertGreater(result['from'], record['startAfter'])  # every decision is after registration
            self.assertEqual(len(stub.calls), result['months'])
            self.assertEqual(ai.forward('f1', stub, 'stub', cache=cache, root=root)['callsThisRun'], 0)
            with self.assertRaisesRegex(ValueError, 'model or prompt changed'):
                ai.forward('f1', stub, 'bigger-model', cache=cache, root=root)
            with self.assertRaisesRegex(ValueError, 'exists'):
                ai.register('f1', 'stub', cache=cache, root=root)


if __name__ == '__main__':
    unittest.main()
