import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch
import dashboard
import desk
from test_desk import StubModel, synthetic


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.saved = (dashboard.BATCHES, dashboard.DESK_LOCAL, dashboard.CLAIMS_STATE)
        dashboard.BATCHES, dashboard.DESK_LOCAL, dashboard.CLAIMS_STATE = root / 'batches', root, root / 'claims'
        path = root / 'w.json'
        path.write_text(json.dumps(synthetic()), encoding='utf-8')
        batch.run_batch([path], StubModel(), root / 'batches' / 'control', every=12, max_decisions=12, max_calls=100, model='stub')

    def tearDown(self):
        dashboard.BATCHES, dashboard.DESK_LOCAL, dashboard.CLAIMS_STATE = self.saved
        self.tmp.cleanup()

    def test_new_panels_are_empty_until_their_data_exists(self):
        data = dashboard.collect('control', 'treated')
        self.assertEqual(len(data['weeks']), 1)
        self.assertEqual(set(data['fitness']['trend-analyst']) >= {'verdict', 'wins', 'losses'}, True)
        self.assertEqual(data['knowledge'], {'news': None, 'results': None})
        self.assertIsNone(data['forecast'])
        self.assertEqual(data['live'], [])
        page = dashboard.render(data)
        self.assertIn('Not started', page)
        self.assertIn('No live paper books yet', page)

    def test_panels_summarise_saved_pipeline_records(self):
        root = Path(self.tmp.name)
        claims = root / 'claims'
        claims.mkdir()
        (claims / 'decisions.json').write_text(json.dumps({
            'e1': {'decision': 'verified', 'reason': 'corroborated', 'sent': True},
            'e2': {'decision': 'hold', 'reason': 'awaiting-corroboration', 'sent': False},
            'e3': {'decision': 'rejected', 'reason': 'no-checkable-claims', 'sent': True}}), encoding='utf-8')
        (claims / 'lesson-reviews.json').write_text(json.dumps({'l1': {'status': 'verified'}, 'l2': {'status': 'not-verified'}}), encoding='utf-8')
        (claims / 'verified-headlines.json').write_text(json.dumps([{'title': 'x'}]), encoding='utf-8')
        (claims / 'cycles.jsonl').write_text(json.dumps({'cycle': 1, 'at': '2026-10-09T12:00:00+00:00'}) + '\n', encoding='utf-8')
        learning = root / 'auto-learning'
        learning.mkdir()
        (learning / 'evidence-reviews.json').write_text(json.dumps({'a': {'status': 'verified'}, 'b': {'status': 'rejected'}}), encoding='utf-8')
        reports = root / 'forecast-reports'
        reports.mkdir()
        (reports / 'zero-shot.json').write_text(json.dumps({'weeks': 24, 'start': '2026-09-18', 'buyAndHoldPaise': 1234,
                                                            'arms': {'always-neutral': {'stanceAccuracy': 0.6, 'pearson': None, 'spearman': None,
                                                                                        'paperRuleNetPaise': 0, 'paperRuleTrades': 0}}}), encoding='utf-8')
        book = root / 'live' / 'reliance-w41'
        book.mkdir(parents=True)
        (book / 'state.json').write_text(json.dumps({'symbol': 'RELIANCE.NS', 'lastBar': '2026-10-09T15:25:00+05:30', 'book': desk.Book().s,
                                                     'meetingsByDay': {'2026-10-09': 6}, 'model': 'stub'}), encoding='utf-8')
        data = dashboard.collect('control', 'treated')
        news = data['knowledge']['news']
        self.assertEqual((news['verified'], news['rejected'], news['waiting'], news['lessons'], news['headlines'], news['cycles']), (1, 1, 1, 1, 1, 1))
        self.assertEqual(data['knowledge']['results']['weeks'], {'verified': 1, 'rejected': 1})
        self.assertEqual((data['forecast']['name'], data['forecast']['weeks']), ('zero-shot', 24))
        self.assertEqual(data['live'][0]['meetings'], 6)
        page = dashboard.render(data)
        self.assertIn('"headlines": 1', page)
        self.assertNotIn('</script><', page.split('const D = ')[1].split(';\n')[0])  # data cannot close the script early

    def test_untrusted_text_cannot_break_out_of_the_page_data(self):
        data = dashboard.collect('control', 'treated')
        data['meetings'].append({'when': 'x', 'kind': 'meeting', 'note': '</script><script>alert(1)</script>', 'trend': '', 'reversion': '',
                                 'proposed': 'hold', 'action': 'hold', 'vetoes': []})
        page = dashboard.render(data)
        self.assertNotIn('</script><script>alert(1)', page)


if __name__ == '__main__':
    unittest.main()
