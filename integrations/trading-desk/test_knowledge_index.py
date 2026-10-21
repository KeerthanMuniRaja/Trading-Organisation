import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import debate
import knowledge_index as ki


def item(url, title, content, at, source='news-economictimes'):
    return {'sourceId': source, 'url': url, 'title': title, 'content': 'Feed summary (not the full article):\n' + content, 'publishedAt': at, 'kind': 'news'}


class IndexTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        run = root / '.local' / 'feeds' / 'economictimes' / 'runs' / 'r1'
        run.mkdir(parents=True)
        items = [item('https://economictimes.indiatimes.com/a', 'HDFC Bank profit rises 10%', 'HDFC Bank reported higher profit.', '2026-10-18T05:00:00.000Z'),
                 item('https://economictimes.indiatimes.com/b', 'RBI holds the repo rate', 'The repo rate is unchanged at the policy review.', '2026-10-18T06:00:00.000Z'),
                 item('https://economictimes.indiatimes.com/c', 'HDFC Bank shares slump', 'HDFC Bank fell after the results.', '2026-10-20T05:00:00.000Z'),
                 item('https://economictimes.indiatimes.com/d', 'SBI Life adds new plans', 'SBI Life launched products.', '2026-10-18T07:00:00.000Z')]
        (run / 'selection.json').write_text(json.dumps({'observations': items}), encoding='utf-8')
        world = root / '.local' / 'world'
        world.mkdir(parents=True)
        (world / 'stories-2026-10-18.json').write_text(json.dumps({'top': [{'title': 'RBI holds the repo rate', 'firstSeen': '2026-10-18T06:00:00.000Z',
            'countries': ['IN'], 'publishers': 1, 'sources': ['The Economic Times'], 'crossBorder': False, 'directShares': [],
            'drivers': [{'driver': 'interest-rates', 'region': 'IN', 'shares': ['HDFCBANK']}], 'links': ['https://economictimes.indiatimes.com/b']}]}), encoding='utf-8')
        regime = root / '.local' / 'trading-desk' / 'regime'
        regime.mkdir(parents=True)
        for day, risk in (('2026-10-17', 'CAUTION'), ('2026-10-20', 'SEVERE')):
            (regime / f'regime-{day}.json').write_text(json.dumps({'date': day, 'risk': risk, 'distributionDays': 3, 'breadth200d': 4, 'shares': 8,
                                                                    'exposureCeilingPct': 75, 'inputsComplete': True}), encoding='utf-8')
        scenario = root / '.local' / 'trading-desk' / 'scenario'
        scenario.mkdir(parents=True)
        (scenario / 'calls.jsonl').write_text(json.dumps({'day': '2026-10-18', 'symbol': 'HDFCBANK.NS', 'story': 'RBI holds the repo rate', 'direction': 'flat',
                                                          'votes': {'up': 1, 'down': 1, 'flat': 3}, 'failedVoices': 0, 'personas': {}}) + '\n', encoding='utf-8')
        cls.db = root / 'index.sqlite'
        cls.meta = ki.build(root, cls.db)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_everything_is_connected(self):
        k = self.meta['byKind']
        self.assertEqual((k['share'], k['item'], k['story'], k['regime'], k['call']), (8, 4, 1, 2, 1))
        self.assertGreater(k['driver'], 10)
        self.assertGreater(k['method'], 10)

    def test_the_dossier_is_point_in_time_and_labelled_unverified(self):
        d = ki.dossier('HDFCBANK', '2026-10-19T10:30:00Z', self.db)
        self.assertEqual([x['title'] for x in d['namedInPress']], ['HDFC Bank profit rises 10%'])  # the 20 Oct slump is not known yet
        self.assertEqual([x['title'] for x in d['reachedThroughDrivers']], ['RBI holds the repo rate'])  # through the rates driver
        self.assertIn('interest-rates', [y['driver'] for y in d['reachedThroughDrivers'][0]['drivers']])
        self.assertEqual(len({x['title'] for x in d['reachedThroughDrivers']}), len(d['reachedThroughDrivers']))  # once, even via two drivers
        self.assertEqual([x['title'] for x in d['stories']], ['RBI holds the repo rate'])
        self.assertEqual(d['regime']['state'], 'CAUTION regime')                       # the 20 Oct regime is in the future
        self.assertEqual(d['panelCalls'], [{'call': 'panel: flat HDFCBANK.NS', 'day': '2026-10-18'}])
        self.assertTrue(d['unverified'])
        everything = ki.dossier('HDFCBANK', db=self.db)
        self.assertEqual(everything['namedInPress'][0]['title'], 'HDFC Bank shares slump')
        sbi = ki.dossier('SBIN', db=self.db)
        self.assertEqual(sbi['namedInPress'], [])                                      # 'SBI Life' is not State Bank of India
        with self.assertRaises(ValueError):
            ki.dossier('NOPE', db=self.db)

    def test_search_finds_across_kinds_and_respects_time(self):
        hits = ki.search('repo rate', db=self.db)
        self.assertIn('item', {h['kind'] for h in hits})
        self.assertIn('driver', {h['kind'] for h in hits})
        self.assertEqual(ki.search('slump', db=self.db, as_of='2026-10-19T00:00:00Z'), [])
        self.assertEqual(ki.search('"; DROP TABLE nodes; --', db=self.db), [])          # punctuation is never query syntax
        self.assertTrue(ki.search('slump', db=self.db))

    def test_the_debate_desk_gets_a_compact_dossier_or_none(self):
        press = debate.press_dossier('HDFCBANK', '2026-10-19T10:30:00Z', self.db)
        self.assertEqual(press['named'], ['2026-10-18 HDFC Bank profit rises 10%'])
        self.assertTrue(press['throughDrivers'][0].startswith('2026-10-18 [interest-rates'))
        self.assertIsNone(debate.press_dossier('HDFCBANK', None, Path(self.tmp.name) / 'missing.sqlite'))


if __name__ == '__main__':
    unittest.main()
