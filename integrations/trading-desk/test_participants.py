import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily
import participants
import portfolio_daily as pd
from test_daily import synthetic_daily

SYMBOLS = sorted(daily.datasets.UNIVERSE)
BULK = ('Date,Symbol,Security Name,Client Name,Buy/Sell,Quantity Traded,Trade Price / Wght. Avg. Price,Remarks\n'
        '01-Oct-2024,RELIANCE,Reliance Industries Ltd,ALPHA FUND  LTD.,BUY,"1,20,000",2850.55,-\n'
        '01-OCT-2024,INFY,Infosys Ltd,Beta Capital,SELL,50000,1900,-\n'
        '02-Oct-2024,TINYCO,Tiny Co,Alpha Fund Ltd,HOLD,10,5,-\n'
        '03-Oct-2024,TINYCO,Tiny Co,Alpha Fund Ltd,BUY,0,5,-\n')


class ParseTests(unittest.TestCase):
    def test_reads_the_exchange_report_and_counts_bad_rows(self):
        deals, skipped = participants.parse_deals(BULK, 'bulk')
        self.assertEqual(skipped, 2)  # an unknown side and a zero quantity are never guessed
        self.assertEqual(deals[0], {'kind': 'bulk', 'date': '2024-10-01', 'symbol': 'RELIANCE', 'client': 'ALPHA FUND LTD',
                                    'side': 'buy', 'quantity': 120000, 'pricePaise': 285055})
        self.assertEqual((deals[1]['side'], deals[1]['date']), ('sell', '2024-10-01'))
        with self.assertRaisesRegex(ValueError, 'missing columns'):
            participants.parse_deals('Date,Symbol\n01-Oct-2024,X\n', 'bulk')

    def test_ingest_is_idempotent_and_keeps_the_source_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'inbox').mkdir()
            (root / 'inbox' / 'bulk-oct.csv').write_text(BULK, encoding='utf-8')
            (root / 'inbox' / 'bulk-copy.csv').write_text(BULK + '\n', encoding='utf-8')  # same deals in another file
            first = participants.ingest(root)
            self.assertEqual((first['deals'], first['added'], first['files']), (2, 2, 2))
            self.assertEqual(participants.ingest(root)['added'], 0)
            stored = json.loads((root / 'deals.json').read_text(encoding='utf-8'))
            self.assertTrue(all(d['sourceFile'].startswith('bulk-') for d in stored['deals'].values()))


class StudyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cache = Path(cls.tmp.name)
        for k, symbol in enumerate(SYMBOLS):
            (cache / f'{symbol}-1d.json').write_text(json.dumps(synthetic_daily(symbol, drift=0.0002, seed=3 + k)), encoding='utf-8')
        cls.dates, cls.table = pd.aligned(daily.load(SYMBOLS, cache))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def excess(self, symbol, i):
        a, b = self.dates[i + 1], self.dates[i + 1 + participants.HORIZON]
        stock = self.table[symbol][b]['openPaise'] / self.table[symbol][a]['openPaise'] - 1
        basket = sum(self.table[s][b]['openPaise'] / self.table[s][a]['openPaise'] - 1 for s in self.table) / len(self.table)
        return stock - basket

    def test_followers_enter_at_the_next_open_and_sells_mean_staying_out(self):
        symbol = SYMBOLS[0]
        deal = {'kind': 'bulk', 'date': self.dates[500], 'symbol': symbol.removesuffix('.NS'), 'client': 'X', 'side': 'buy',
                'quantity': 1, 'pricePaise': 1}
        events, unpriced = participants.event_returns([deal, {**deal, 'side': 'sell'}, {**deal, 'symbol': 'TINYCO'}],
                                                      self.table, self.dates)
        self.assertEqual(unpriced, 1)
        buy, sell = sorted(events, key=lambda e: e['side'])
        self.assertEqual(buy['entry'], self.dates[501])  # never the deal day itself
        self.assertEqual(buy['excessPct'], round(100 * self.excess(symbol, 500), 2))
        self.assertEqual(sell['excessPct'], -buy['excessPct'])
        late = {**deal, 'date': self.dates[-5]}
        self.assertEqual(participants.event_returns([late], self.table, self.dates)[0], [])  # outcome not known yet

    def test_leaders_are_chosen_before_the_split_and_judged_after(self):
        def event(client, date, excess):
            return {'client': client, 'date': date, 'excessPct': excess}
        events = ([event('GOOD', f'2024-0{m}-01', 2.0) for m in range(1, 5)] + [event('LUCKY', '2024-02-01', 9.0)]
                  + [event('BAD', f'2024-0{m}-01', -1.0) for m in range(1, 5)]
                  + [event('GOOD', '2025-02-01', -3.0), event('GOOD', '2025-03-01', 1.0), event('LATE', '2025-04-01', 50.0)])
        report = participants.study(events, '2025-01-01', min_events=3)
        self.assertEqual(list(report['leadersChosenBefore']), ['GOOD'])  # one lucky deal or a later star never qualifies
        self.assertEqual(report['followingLeadersAfter']['events'], 2)
        self.assertEqual((report['followingLeadersAfter']['aheadOfBasket'], report['followingLeadersAfter']['behindBasket']), (1, 1))
        self.assertEqual(report['followingLeadersAfter']['verdict'], 'insufficient-evidence')
        self.assertEqual(report['allDealsAfter']['events'], 3)


if __name__ == '__main__':
    unittest.main()
