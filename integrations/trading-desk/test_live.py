from datetime import datetime, timedelta
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import desk
import live
from test_desk import StubModel, synthetic


def completion(bar):
    return datetime.fromisoformat(bar['time']) + timedelta(minutes=5) + live.GRACE


def strip(decisions):
    return json.loads(json.dumps([{k: v for k, v in d.items() if k not in ('modelCalls', 'at')} for d in decisions]))


class LiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def journal(self, name):
        return [json.loads(line) for line in (self.root / name / 'journal.jsonl').read_text(encoding='utf-8').splitlines()]

    def test_live_desk_bar_by_bar_matches_the_replay_desk_exactly(self):
        data = synthetic()
        bars = data['bars']
        replay_model, live_model = StubModel(), StubModel()
        expected = desk.run_desk(data, replay_model, every=12, max_decisions=40)
        book = live.LiveBook('parity', self.root).open('RELIANCE.NS', 12, 'stub', 6)
        try:
            for k in range(len(bars)):  # the provider reveals one more completed bar each time
                book.process(bars[:k + 1], live_model, completion(bars[k]))
        finally:
            book.close()
        result = desk.Book(book.state['book']).result()
        self.assertEqual(result['trades'], expected['desk']['trades'])
        self.assertEqual(result['netPaise'], expected['desk']['netPaise'])
        self.assertEqual(result['maxDrawdownFraction'], expected['desk']['maxDrawdownFraction'])
        self.assertEqual(live_model.calls, replay_model.calls)  # identical prompts, inputs and schemas
        logged = [e for e in self.journal('parity') if e['type'] in ('desk-meeting', 'risk-stop')]
        self.assertEqual(strip(logged), strip(expected['decisions']))
        self.assertTrue(expected['desk']['trades'])

    def test_restart_resumes_without_reprocessing_and_stale_bars_get_no_meeting(self):
        bars = synthetic()['bars']
        model = StubModel()
        first = live.LiveBook('resume', self.root).open('RELIANCE.NS', 12, 'stub', 6)
        first.process(bars[:5], model, completion(bars[4]))
        first.process(bars[:30], model, completion(bars[29]))  # bars 5..28 are stale by bar 29's completion
        first.close()
        calls = len(model.calls)
        again = live.LiveBook('resume', self.root).open('RELIANCE.NS', 12, 'stub', 6)
        self.assertEqual(again.process(bars[:30], model, completion(bars[29])), 0)  # nothing new
        again.close()
        self.assertEqual(len(model.calls), calls)
        journal = self.journal('resume')
        skipped = [e for e in journal if e['type'] == 'meeting-skipped']
        self.assertEqual([e['bar'][11:16] for e in skipped], ['10:10', '11:10'])
        self.assertEqual(skipped[0]['reason'], 'stale-bar')
        self.assertEqual(journal[0]['type'], 'book-started')  # a new book never trades on history

    def test_book_binding_and_single_session_lock(self):
        book = live.LiveBook('bound', self.root).open('RELIANCE.NS', 12, 'stub', 6)
        with self.assertRaisesRegex(ValueError, 'Another session'):
            live.LiveBook('bound', self.root).open('RELIANCE.NS', 12, 'stub', 6)
        book.close()
        with self.assertRaisesRegex(ValueError, 'different symbol'):
            live.LiveBook('bound', self.root).open('INFY.NS', 12, 'stub', 6)
        live.LiveBook('bound', self.root).open('RELIANCE.NS', 12, 'stub', 6).close()  # lock released after refusal
        with self.assertRaises(ValueError):
            live.LiveBook('../escape', self.root)

    def test_verified_news_file_is_reread_every_poll(self):
        bars = synthetic()['bars']
        news = self.root / 'headlines.json'
        news.write_text(json.dumps([{'publishedAt': '2026-01-05T10:00:00+05:30', 'source': 'feed', 'title': 'Reliance beats estimates',
                                     'symbols': ['RELIANCE.NS']}]), encoding='utf-8')
        clock = {'now': datetime.fromisoformat(bars[0]['time']) - timedelta(minutes=30)}
        revoke_at = datetime.fromisoformat('2026-01-05T11:30:00+05:30')

        def fetch(symbol, now):
            if now >= revoke_at and news.exists():
                news.unlink()  # the fact-checker revoked the claim, so the file no longer carries it
            return live.completed(bars, now)
        model = StubModel()
        result = live.run_session('news', 'RELIANCE.NS', 240, model, 'stub', fetch=fetch, clock=lambda: clock['now'],
                                  sleep=lambda s: clock.__setitem__('now', clock['now'] + timedelta(seconds=s)),
                                  root=self.root, news_path=news)
        journal = self.journal('news')
        meetings = {e['bar'][11:16]: e for e in journal if e['type'] == 'desk-meeting'}
        self.assertEqual(meetings['10:10']['bots']['news-analyst']['outcome'], 'valid')
        self.assertEqual(meetings['12:10']['bots']['news-analyst']['outcome'], 'not-consulted')
        self.assertEqual(result['model'], 'stub+news')  # the book is bound to consulting news
        self.assertEqual(sum(e['type'] == 'book-started' for e in journal), 1)
        self.assertTrue(any(role == 'news-analyst' for role, _, _ in model.calls))
        news.write_text('{not json', encoding='utf-8')
        kept, problem = live.load_news(news, ['last-good'])
        self.assertEqual(kept, ['last-good'])
        self.assertTrue(problem)

    def test_session_is_finite_waits_outside_market_hours_and_stops_on_repeated_data_errors(self):
        bars = synthetic()['bars']
        clock = {'now': datetime.fromisoformat(bars[0]['time']) - timedelta(minutes=30)}  # 08:45, before the open
        fetches = []

        def fetch(symbol, now):
            fetches.append(now)
            return live.completed(bars, now)
        result = live.run_session('session', 'RELIANCE.NS', 120, StubModel(), 'stub', fetch=fetch, clock=lambda: clock['now'],
                                  sleep=lambda s: clock.__setitem__('now', clock['now'] + timedelta(seconds=s)), root=self.root)
        self.assertEqual(result['stoppedReason'], 'deadline')
        self.assertTrue(fetches and all(live.in_session(t) for t in fetches))
        self.assertFalse((self.root / 'session' / 'live.lock').exists())
        self.assertGreater(result['meetingsByDay'].get('2026-01-05', 0), 0)

        def broken(symbol, now):
            raise ValueError('EMPTY_PROVIDER_DATA')
        clock['now'] = datetime.fromisoformat(bars[0]['time'])
        result = live.run_session('broken', 'RELIANCE.NS', 60, StubModel(), 'stub', fetch=broken, clock=lambda: clock['now'],
                                  sleep=lambda s: clock.__setitem__('now', clock['now'] + timedelta(seconds=s)), root=self.root)
        self.assertEqual(result['stoppedReason'], 'repeated-data-errors')
        self.assertEqual(sum(e['type'] == 'data-error' for e in self.journal('broken')), 3)


if __name__ == '__main__':
    unittest.main()
