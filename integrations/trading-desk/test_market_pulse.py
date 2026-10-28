from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import market_pulse as mp

ROWS = {'BANDHANBNK.NS': 'Bandhan Bank Ltd.', 'KEI.NS': 'KEI Industries Ltd.', 'CYIENT.NS': 'Cyient Ltd.', 'IDEA.NS': 'Vodafone Idea Ltd.',
        'MARUTI.NS': 'Maruti Suzuki India Ltd.', 'NAUKRI.NS': 'Info Edge (India) Ltd.', 'INDIANB.NS': 'Indian Bank',
        'BANKINDIA.NS': 'Bank of India', 'SBIN.NS': 'State Bank of India', 'HDFCBANK.NS': 'HDFC Bank Ltd.'}


class PulseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.al = mp.aliases(ROWS)

    def test_companies_are_named_strictly(self):
        self.assertEqual(mp.named('Maruti Suzuki and Info Edge gain', self.al), ['MARUTI.NS', 'NAUKRI.NS'])   # without 'India', '(India)'
        self.assertEqual(mp.named('State Bank of India raises rates', self.al), ['SBIN.NS'])                  # not also Bank of India
        self.assertEqual(mp.named('Indian bank stocks slide', self.al), [])                                  # case: not Indian Bank
        self.assertEqual(mp.named('SBI Life and SBI Mutual Fund', self.al), [])                              # the desk's exclusions
        self.assertEqual(mp.named('Cyient DLM share price crashes', self.al), [])                            # another company

    def test_a_reported_move_with_its_reason(self):
        m = mp.mover('KEI Industries shares tumble 8% despite Q2 profit rising 29%, revenue up 39%', self.al)
        self.assertEqual((m['symbol'], m['direction'], m['pct'], m['why']), ('KEI.NS', 'down', 8.0, 'Q2 profit rising 29%, revenue up 39%'))
        b = mp.mover("Bandhan Bank shares jump 7% as Abu Dhabi's IHC explores stake. Here is why", self.al)
        self.assertEqual((b['direction'], b['why']), ('up', "Abu Dhabi's IHC explores stake"))
        h = mp.mover('HDFC Bank share price drops over 2%, down 30% YTD - experts', self.al)
        self.assertEqual((h['pct'], h['period']), (2.0, None))                        # today's 2%, not the year's 30%
        self.assertEqual(mp.mover('Bandhan Bank shares surge 230% YTD', self.al)['period'], 'YTD')

    def test_what_is_not_a_share_move(self):
        self.assertIsNone(mp.mover('KEI Industries Q2 profit jumps 29%', self.al))                      # profit, not the shares
        self.assertIsNone(mp.mover('Jefferies says Vodafone Idea shares can soar 143% in bull case', self.al))   # a forecast
        self.assertIsNone(mp.mover('Sensex jumps 2% as banks rally', self.al))                        # no company
        self.assertIsNone(mp.mover('Cyient DLM share price crashes 19% after Q2 results', self.al))   # not our Cyient

    def test_big_players_and_flows(self):
        p = mp.player('Promoter sells 2% stake in Bandhan Bank for ₹1,200 crore', self.al)
        self.assertEqual((p['actors'], p['action'], p['symbols'], p['amountCrore'], p['marketWide']), (['promoter'], 'sell', ['BANDHANBNK.NS'], 1200.0, False))
        f = mp.player('₹4 lakh crore rally, ₹6,500 crore FII buying: are IT stocks back?', self.al)
        self.assertEqual((f['action'], f['amountCrore'], f['marketWide']), ('buy', 6500.0, True))     # the FIIs' amount, not the rally's
        self.assertEqual(mp.player('Ace investor adds 3 new stocks, trims stake in 13 companies', self.al)['action'], 'mixed')
        self.assertIsNone(mp.player('HDFC Bank shares near 52-week low amid insider leak probe', self.al))   # not a trade
        self.assertEqual(mp.player('Bulk deal in focus at Bandhan Bank', self.al)['action'], 'deal')

    def test_the_pulse_and_what_one_share_hears(self):
        now = datetime(2026, 10, 28, 6, tzinfo=timezone.utc)
        heads = [{'publishedAt': '2026-10-27T10:00:00+05:30', 'source': 'Mint', 'title': 'HDFC Bank shares fall 3% after Q2 results', 'symbols': ['HDFCBANK.NS']},
                 {'publishedAt': '2026-10-26T10:00:00+05:30', 'source': 'ET', 'title': 'FPIs sell ₹2,000 crore of Indian equities', 'symbols': []},
                 {'publishedAt': '2026-10-01T10:00:00+05:30', 'source': 'ET', 'title': 'Bandhan Bank shares jump 9% on stake buy', 'symbols': []}]
        with tempfile.TemporaryDirectory() as tmp:
            path, out = Path(tmp) / 'h.json', Path(tmp) / 'pulse.json'
            path.write_text(json.dumps(heads), encoding='utf-8')
            r = mp.build(path, out, cache=None, days=7, now=now, rows=ROWS)
            self.assertEqual((r['headlinesRead'], r['counts']['movers'], r['counts']['flows']), (2, 1, 1))   # the old Bandhan item is outside the window
            self.assertEqual((r['movers'][0]['symbol'], r['movers'][0]['desk']), ('HDFCBANK.NS', True))
            self.assertEqual(r['flows'][0]['action'], 'sell')
            heard = mp.for_share('HDFCBANK', out)
            self.assertEqual(heard['reportedMoves'][0]['why'], 'Q2 results')
            self.assertIn('never evidence', heard['note'])
            self.assertIsNone(mp.for_share('ITC', out))
            self.assertIsNone(mp.for_share('HDFCBANK', out, as_of='2026-10-27T04:00:00Z'))   # a proposal made before the report: not shown


if __name__ == '__main__':
    unittest.main()
