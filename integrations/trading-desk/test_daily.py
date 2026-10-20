from datetime import date, timedelta
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily


def synthetic_daily(symbol='RELIANCE.NS', years=5, drift=0.0004, seed=7):
    """Business-day bars with a deterministic noisy drift."""
    bars, day, price, x = [], date(2021, 1, 4), 100_000.0, seed
    while len(bars) < 252 * years:
        if day.weekday() < 5:
            x = (1103515245 * x + 12345) % 2 ** 31
            o = int(price)
            price *= 1 + drift + (x / 2 ** 31 - 0.5) * 0.03
            c = int(price)
            bars.append({'date': day.isoformat(), 'openPaise': o, 'highPaise': max(o, c) + 50, 'lowPaise': min(o, c) - 50,
                         'closePaise': c, 'volume': 1000})
        day += timedelta(days=1)
    return {'schemaVersion': 1, 'symbol': symbol, 'interval': '1d', 'priceBasis': 'adjusted', 'source': 'synthetic-test', 'bars': bars}


class HistoryLengthTests(unittest.TestCase):
    def test_a_refresh_never_asks_for_less_history_than_the_file_holds(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'X.NS-1d.json'
            self.assertEqual(daily.years_to_fetch(path, 5), 5)          # no file yet: what was asked
            self.assertEqual(daily.years_to_fetch(path, 15), 10)        # capped
            path.write_text(json.dumps({'bars': [{'date': '2016-10-20'}]}), encoding='utf-8')
            self.assertEqual(daily.years_to_fetch(path, 5, today=date(2026, 10, 20)), 10)  # a 10-year file stays 10 years
            path.write_text(json.dumps({'bars': [{'date': '2023-10-20'}]}), encoding='utf-8')
            self.assertEqual(daily.years_to_fetch(path, 5, today=date(2026, 10, 20)), 5)


class SettledBarTests(unittest.TestCase):
    def test_todays_bar_is_kept_only_after_the_session_has_settled(self):
        from datetime import datetime, timezone
        bars = [{'date': '2026-10-14'}, {'date': '2026-10-15'}]
        during = datetime(2026, 10, 15, 8, 0, tzinfo=timezone.utc)   # 13:30 IST, market open
        after = datetime(2026, 10, 15, 10, 31, tzinfo=timezone.utc)  # 16:01 IST
        self.assertEqual([b['date'] for b in daily.settled_only(bars, during)], ['2026-10-14'])
        self.assertEqual(len(daily.settled_only(bars, after)), 2)
        self.assertEqual(len(daily.settled_only(bars[:1], during)), 1)  # yesterday's bar is never touched


class CostTests(unittest.TestCase):
    def test_delivery_costs_on_one_lakh(self):
        self.assertEqual(daily.buy_costs(10_000_000), 11_863)   # STT + stamp + exchange/SEBI with GST
        self.assertEqual(daily.sell_costs(10_000_000), 11_956)  # STT + exchange/SEBI with GST + depository charge


class SimulationTests(unittest.TestCase):
    def setUp(self):
        self.bars = daily.validate(synthetic_daily())

    def test_cash_never_trades_and_buy_and_hold_pays_costs_once_each_way(self):
        end = len(self.bars) - 1
        self.assertEqual(daily.simulate(self.bars, daily.cash(self.bars), 0, end), {'netPaise': 0, 'trades': 0, 'maxDrawdown': 0.0})
        held = daily.simulate(self.bars, daily.buy_and_hold(self.bars), 0, end)
        self.assertEqual(held['trades'], 2)
        # Exact: whole shares bought at day 1's open plus slippage, sold at the last close minus slippage, costs each way.
        fill = self.bars[1]['openPaise'] * (10000 + daily.SLIPPAGE_BPS) / 10000
        qty = max(q for q in range(1, daily.CAPITAL // int(fill) + 1)
                  if daily.ceil_paise(q * fill) + daily.buy_costs(daily.ceil_paise(q * fill)) <= daily.CAPITAL)
        bought = daily.ceil_paise(qty * fill)
        sold = int(qty * self.bars[-1]['closePaise'] * (10000 - daily.SLIPPAGE_BPS) / 10000)
        self.assertEqual(held['netPaise'], sold - daily.sell_costs(sold) - bought - daily.buy_costs(bought))

    def test_entrants_use_only_completed_days(self):
        altered = [dict(b) for b in self.bars]
        for b in altered[800:]:
            b['closePaise'] = b['openPaise'] = b['highPaise'] = b['lowPaise'] = 1
        for name, (_, make) in daily.ENTRANTS.items():
            a, b = make(self.bars), make(altered)
            for i in range(300, 800):
                self.assertEqual(a(i, False), b(i, False), name)

    def test_trades_stay_inside_the_period(self):
        start, end = 300, 600
        result = daily.simulate(self.bars, daily.buy_and_hold(self.bars), start, end)
        self.assertEqual(result['trades'], 2)
        expected_fill = self.bars[start + 1]['openPaise']
        self.assertGreater(result['netPaise'], daily.CAPITAL * (self.bars[end]['closePaise'] / expected_fill - 1) - daily.CAPITAL * 0.01)

    def test_validation_rejects_broken_data(self):
        data = synthetic_daily()
        data['bars'][10]['lowPaise'] = data['bars'][10]['highPaise'] + 1
        with self.assertRaisesRegex(ValueError, 'PRICE'):
            daily.validate(data)
        data = synthetic_daily()
        data['bars'][5]['date'] = data['bars'][4]['date']  # a repeated day
        with self.assertRaisesRegex(ValueError, 'ORDER'):
            daily.validate(data)
        data = synthetic_daily()
        data['bars'][5]['date'] = '2021-01-09'  # a special Saturday session is real data, still in order
        data['bars'][6]['date'] = '2021-01-11'
        self.assertEqual(len(daily.validate(data)), len(data['bars']))


class TournamentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = Path(self.tmp.name) / 'daily'
        self.cache.mkdir()
        for symbol, drift, seed in (('RELIANCE.NS', 0.0004, 7), ('INFY.NS', -0.0002, 11)):
            (self.cache / f'{symbol}-1d.json').write_text(json.dumps(synthetic_daily(symbol, drift=drift, seed=seed)), encoding='utf-8')
        self.root = Path(self.tmp.name) / 't'

    def tearDown(self):
        self.tmp.cleanup()

    def test_selection_needs_both_baselines_beaten_and_sealed_judged_once(self):
        record = daily.run('d1', ['INFY.NS', 'RELIANCE.NS'], root=self.root, cache=self.cache)
        p = record['periods']
        self.assertLess(p['train'][0], p['train'][1])
        self.assertEqual(p['train'][1], p['validation'][0])
        self.assertEqual(p['validation'][1], p['sealed'][0])
        self.assertEqual(record['results']['cash']['validation']['netPaise'], 0)
        if record['winner']:
            v = record['results'][record['winner']]['validation']['netPaise']
            self.assertGreater(v, max(record['results'][b]['validation']['netPaise'] for b in daily.BASELINES))
        outcome = daily.finalise('d1', root=self.root, cache=self.cache)
        self.assertIn(outcome['verdict'], ('beat-both-baselines-on-sealed-period', 'failed-on-sealed-period', 'no-entrant-qualified'))
        with self.assertRaisesRegex(ValueError, 'already used'):
            daily.finalise('d1', root=self.root, cache=self.cache)
        with self.assertRaisesRegex(ValueError, 'exists'):
            daily.run('d1', ['INFY.NS', 'RELIANCE.NS'], root=self.root, cache=self.cache)
        daily.run('d2', ['INFY.NS', 'RELIANCE.NS'], root=self.root, cache=self.cache)
        data = json.loads((self.cache / 'INFY.NS-1d.json').read_text(encoding='utf-8'))
        data['bars'][-1]['closePaise'] += 1
        data['bars'][-1]['highPaise'] += 1
        (self.cache / 'INFY.NS-1d.json').write_text(json.dumps(data), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'changed'):
            daily.finalise('d2', root=self.root, cache=self.cache)


class ForwardTests(unittest.TestCase):
    def test_forward_tests_count_only_new_days_and_end_if_rules_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache, root = Path(tmp) / 'daily', Path(tmp) / 'forward'
            cache.mkdir()
            full = synthetic_daily()
            early = {**full, 'bars': full['bars'][:1000]}
            (cache / 'RELIANCE.NS-1d.json').write_text(json.dumps(early), encoding='utf-8')
            record = daily.register('f1', ['RELIANCE.NS'], root=root, cache=cache)
            self.assertEqual(record['startAfter'], full['bars'][999]['date'])
            self.assertEqual(record['rules'], daily.rules_fingerprint())
            self.assertEqual(daily.forward('f1', root=root, cache=cache)['status'], 'waiting')
            with self.assertRaisesRegex(ValueError, 'exists'):
                daily.register('f1', ['RELIANCE.NS'], root=root, cache=cache)
            (cache / 'RELIANCE.NS-1d.json').write_text(json.dumps(full), encoding='utf-8')  # new days arrive
            result = daily.forward('f1', root=root, cache=cache)
            self.assertEqual((result['status'], result['tradingDays']), ('running', len(full['bars']) - 1000))
            self.assertEqual(set(result['results']), set(daily.ENTRANTS))
            self.assertEqual(result['results']['cash']['netPaise'], 0)
            for name in result['aheadOfBothBaselines']:
                self.assertGreater(result['results'][name]['netPaise'], max(result['results'][b]['netPaise'] for b in daily.BASELINES))
            saved = json.loads((root / 'f1.json').read_text(encoding='utf-8'))
            saved['rules'] = 'changed-rules'
            (root / 'f1.json').write_text(json.dumps(saved), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'rules changed'):
                daily.forward('f1', root=root, cache=cache)


if __name__ == '__main__':
    unittest.main()
