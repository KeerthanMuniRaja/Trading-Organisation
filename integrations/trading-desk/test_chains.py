import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import chains
import daily
import desk
import portfolio_daily as pd
from test_daily import synthetic_daily

SYMBOLS = sorted(daily.datasets.UNIVERSE)
BANKS = ['AXISBANK.NS', 'HDFCBANK.NS', 'ICICIBANK.NS', 'SBIN.NS']


def headline(title, symbols=(), at='2024-06-03T18:00:00+05:30'):
    return {'publishedAt': at, 'source': 'Example Wire', 'title': title, 'symbols': list(symbols)}


class ExpandTests(unittest.TestCase):
    def test_the_reviewed_links_load_and_cover_only_the_universe(self):
        links = chains.load_links()
        self.assertTrue(all(link['basis'] for link in links))
        self.assertLessEqual({s for link in links for s in link['symbols']}, set(SYMBOLS))

    def test_driver_news_reaches_linked_shares_labelled_as_inferred(self):
        links = chains.load_links()
        out = chains.expand([headline('RBI holds the repo rate at 6.5%'), headline('Weather is pleasant'),
                             headline('HDFC Bank reports deposit growth of 15%', ['HDFCBANK.NS'])], links)
        rate = [h for h in out if 'interest-rates' in h['title']]
        self.assertEqual(sorted(rate[0]['symbols']), BANKS)
        self.assertTrue(rate[0]['title'].startswith('[inferred link: interest-rates] '))
        self.assertNotIn('Weather is pleasant', [h['title'] for h in out])  # no share and no driver: nowhere to route it
        deposit = [h for h in out if 'bank-asset-quality' in h['title']][0]
        self.assertNotIn('HDFCBANK.NS', deposit['symbols'])  # already named directly, so not repeated as an inference
        desk.validate_headlines(out)  # the desk's news analyst accepts the output unchanged

    def test_world_drivers_reach_the_shares_labelled_with_their_region(self):
        links = chains.load_links()
        self.assertTrue({'US', 'CN', 'WORLD'} <= {link.get('region', 'IN') for link in links})
        out = chains.expand([headline('Federal Reserve signals a pause as Treasury yields climb'),
                             headline('OPEC+ extends supply cuts; Brent rises')], links)
        fed = [h for h in out if 'us-fed-rates' in h['title']][0]
        self.assertIn('INFY.NS', fed['symbols'])
        self.assertTrue({h['title'].split(']')[0] for h in out if 'Brent' in h['title']}
                        >= {'[inferred link: crude-oil', '[inferred link: energy-geopolitics'})
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / 'links.json'
            bad.write_text(json.dumps({'links': [{'driver': 'x', 'region': 'MARS', 'keywords': ['x'], 'symbols': ['INFY.NS'], 'basis': 'b'}]}))
            with self.assertRaises(ValueError):
                chains.load_links(bad)

    def test_keywords_match_whole_words_only(self):
        self.assertTrue(chains.matches('FII selling continues', ['fii']))
        self.assertFalse(chains.matches('Fiinancial wrap', ['fii']))
        self.assertTrue(chains.matches('Brent crude jumps', ['crude']))


class StudyTests(unittest.TestCase):
    def test_a_link_that_precedes_big_moves_is_detected_and_timing_uses_the_next_open(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp)
            for k, symbol in enumerate(SYMBOLS):
                (cache / f'{symbol}-1d.json').write_text(json.dumps(synthetic_daily(symbol, drift=0.0001, seed=21 + k)), encoding='utf-8')
            dates, table = pd.aligned(daily.load(SYMBOLS, cache))
            link = {'driver': 'power-demand', 'keywords': ['power demand'], 'symbols': ['NTPC.NS'], 'basis': 'test'}
            # make NTPC jump 8% over the five sessions after each of 24 news days; nothing else changes
            news_days = list(range(300, 300 + 24 * 30, 30))
            for d in news_days:
                for k in range(d + 2, len(dates)):
                    bar = table['NTPC.NS'][dates[k]]
                    factor = 1.08 if k <= d + 1 + chains.HORIZON else 1.0
                    for field in ('openPaise', 'highPaise', 'lowPaise', 'closePaise'):
                        bar[field] = int(bar[field] * factor)
            news = [headline('Power demand hits a record', at=f'{dates[d]}T19:00:00+05:30') for d in news_days]
            result = chains.study(news, [link], table, dates)['power-demand']
            self.assertEqual(result['events'], 24)
            self.assertEqual(result['verdict'], 'link-carries-information')
            quiet = chains.study([headline('Power demand steady', at=f'{dates[d]}T19:00:00+05:30') for d in range(320, 340)],
                                 [{**link, 'symbols': ['ITC.NS']}], table, dates)['power-demand']
            self.assertNotEqual(quiet['verdict'], 'link-carries-information')


if __name__ == '__main__':
    unittest.main()
