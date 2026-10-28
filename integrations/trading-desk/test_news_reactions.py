import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mentor_broad
import news_reactions as nr


def mover(title, why, published, symbol='A.NS', direction='up', period=None):
    return {'publishedAt': published, 'symbol': symbol, 'direction': direction, 'pct': 7.0, 'period': period, 'why': why, 'title': title}


class NewsReactionTests(unittest.TestCase):
    def test_kinds_of_news(self):
        self.assertEqual(nr.kind_of('Q2 profit rises 38% to Rs 716 crore'), 'results')
        self.assertEqual(nr.kind_of('Jefferies upgrades, sees 34% upside'), 'broker-call')
        self.assertEqual(nr.kind_of("Abu Dhabi's IHC explores stake"), 'deal-or-stake')
        self.assertEqual(nr.kind_of('bags Rs 2,000 crore order from NHAI'), 'order-or-contract')
        self.assertEqual(nr.kind_of('SEBI probe into trading'), 'policy')
        self.assertEqual(nr.kind_of('no reason given'), 'other')

    def test_reports_are_kept_once_and_measured_from_the_right_close(self):
        bars = {'A.NS': [{'date': f'2026-10-{d:02d}', 'closePaise': 100 + d} for d in range(1, 31)]}
        bars.update({f'X{k}.NS': [{'date': f'2026-10-{d:02d}', 'closePaise': 100} for d in range(1, 31)] for k in range(20)})
        prepared = mentor_broad.prepare(bars)
        with tempfile.TemporaryDirectory() as tmp:
            pulse, history, out = Path(tmp) / 'p.json', Path(tmp) / 'h.jsonl', Path(tmp) / 'r.json'
            pulse.write_text(json.dumps({'movers': [
                mover('A shares jump 7% on Q2 results', 'Q2 results', '2026-10-10T11:00:00+05:30'),         # during the session: from the 10th
                mover('A shares jump 7% after the close', None, '2026-10-10T18:00:00+05:30'),             # after the close: from the 11th
                mover('A shares surge 230% YTD', None, '2026-10-10T11:00:00+05:30', period='YTD'),       # no single day: left out
                mover('A shares jump 7% on an order win', 'order win', '2026-10-28T11:00:00+05:30')]}),  # its week has not happened yet
                encoding='utf-8')
            r = nr.build(pulse, history, out, prepared)
            self.assertEqual((r['reports'], r['newToday'], r['measured'], r['waitingForPrices']), (3, 3, 2, 1))
            self.assertEqual(nr.build(pulse, history, out, prepared)['newToday'], 0)                 # a rerun adds nothing
            measured = {m['title']: m for m in nr.measure([json.loads(l) for l in history.read_text().splitlines()], prepared)}
            self.assertEqual(measured['A shares jump 7% on Q2 results']['from'], '2026-10-10')
            self.assertEqual(measured['A shares jump 7% after the close']['from'], '2026-10-11')
            self.assertGreater(measured['A shares jump 7% on Q2 results']['nextPct'], 0)              # A kept rising against a flat market

    def test_a_kind_speaks_only_with_enough_cases(self):
        rows = [{'kind': 'results', 'direction': 'up', 'nextPct': x} for x in [1.0, -0.5, 2.0] * 10] + [{'kind': 'other', 'direction': 'down', 'nextPct': 1.0}]
        table = {(t['kind'], t['direction']): t for t in nr.study(rows)}
        self.assertEqual((table[('results', 'up')]['cases'], table[('results', 'up')]['enough'], table[('results', 'up')]['continuedPct']), (30, True, 67))
        self.assertFalse(table[('other', 'down')]['enough'])
        self.assertEqual(table[('other', 'down')]['continuedPct'], 0)                                 # it rose after a fall: given back


if __name__ == '__main__':
    unittest.main()
