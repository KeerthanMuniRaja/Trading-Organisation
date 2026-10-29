import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import debate
import events_calendar as ec
import scenario_panel as sp

EVENTS = {'events': [
    {'date': '2026-10-28', 'kind': 'results', 'symbols': ['SBIN.NS'], 'title': 'SBI Q2 results'},
    {'date': '2026-10-27', 'kind': 'fomc', 'title': 'Federal Reserve decision'},
    {'date': '2026-11-20', 'kind': 'rbi-policy', 'title': 'RBI policy decision'},
    {'date': '2026-10-29', 'kind': 'results', 'symbols': ['INFY'], 'title': 'Infosys results'},
    {'date': 'soon', 'kind': 'results', 'title': 'bad date'},
    {'date': '2026-10-30', 'kind': 'gossip', 'title': 'unknown kind'},
    {'date': '2026-10-30', 'kind': 'results', 'symbols': ['TSLA'], 'title': 'not one of our shares'}]}


class CalendarTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'events.json'
        self.path.write_text(json.dumps(EVENTS), encoding='utf-8')

    def tearDown(self):
        self.tmp.cleanup()

    def test_invalid_entries_are_skipped_and_counted_never_guessed(self):
        events, skipped = ec.load(self.path, None)
        self.assertEqual((len(events), skipped), (4, 3))
        self.assertEqual(events[0]['title'], 'Federal Reserve decision')   # sorted by date
        self.assertEqual(ec.load(Path(self.tmp.name) / 'none.json', None), (None, 0))

    def test_press_results_days_fill_in_and_the_owner_overrides_them(self):
        press = Path(self.tmp.name) / 'press.json'
        press.write_text(json.dumps({'events': [
            {'date': '2026-10-30', 'symbol': 'SBIN.NS', 'company': 'State Bank of India', 'publisher': 'Mint', 'publishedAt': '2026-10-20T10:00:00+05:30'},
            {'date': '2026-11-04', 'symbol': 'NTPC.NS', 'company': 'NTPC', 'publisher': 'Mint', 'publishedAt': '2026-10-21T10:00:00+05:30'},
            {'date': '2026-11-04', 'symbol': 'TVSMOTOR.NS', 'company': 'TVS Motor'},  # not a desk share
            {'date': '2026-10-28', 'kind': 'fomc', 'symbol': None, 'company': 'US Federal Reserve decision', 'publisher': 'Mint'},
            {'date': '2026-11-21', 'kind': 'rbi-policy', 'symbol': None, 'company': 'RBI monetary policy decision', 'publisher': 'Mint'}]}),
            encoding='utf-8')
        events, _ = ec.load(self.path, press)
        mine = [e for e in events if e['source'] == 'press']
        # the owner's entries win within 20 days: SBI results (28 Oct), the Fed (27 Oct) and the RBI (20 Nov)
        self.assertEqual([(e['date'], e['symbols']) for e in mine], [('2026-11-04', ['NTPC'])])
        self.assertIn('not the exchange filing', mine[0]['title'])
        only, _ = ec.load(Path(self.tmp.name) / 'none.json', press)  # no owner file: the press days still reach the agents
        self.assertEqual(ec.context('2026-10-23', 'SBIN', path=Path(self.tmp.name) / 'none.json', press=press)['status'], ec.PRESS_ONLY)
        self.assertEqual(len(only), 4)
        fed = [e for e in ec.upcoming(only, '2026-10-23', 10, 'HDFCBANK') if e['kind'] == 'fomc']  # market-wide: every share sees it
        self.assertEqual((len(fed), fed[0]['symbols']), (1, []))
        self.assertIn('not the official calendar', fed[0]['title'])
        signal = {'id': 's', 'symbol': 'NTPC', 'createdAt': '2026-10-28T11:00:00Z', 'evidenceIds': []}
        ctx = debate.context(signal, Path(self.tmp.name), [], calendar=ec.context(signal['createdAt'], 'NTPC', path=Path(self.tmp.name) / 'none.json', press=press))
        self.assertEqual([e['source'] for e in ctx['upcomingEvents']['events']], ['press'])
        self.assertEqual(ctx['dataStatus']['eventsCalendar'], ec.PRESS_ONLY)  # an empty list would mean 'none reported'

    def test_a_share_sees_its_own_and_market_wide_events_in_the_window_only(self):
        events, _ = ec.load(self.path, None)
        sbin = ec.upcoming(events, '2026-10-23T11:00:00Z', 10, 'SBIN')
        self.assertEqual([e['title'] for e in sbin], ['Federal Reserve decision', 'SBI Q2 results'])  # not Infosys, not RBI (too far)
        self.assertEqual(len(ec.upcoming(events, '2026-10-23', 40)), 4)
        self.assertEqual(ec.upcoming(events, '2026-10-28', 5, 'SBIN'), [])  # the day itself has passed for a decision made on it
        self.assertIsNone(ec.upcoming(None, '2026-10-23'))

    def test_agents_are_told_what_is_scheduled_or_that_there_is_no_calendar(self):
        signal = {'id': 's', 'symbol': 'SBIN', 'createdAt': '2026-10-23T11:00:00Z', 'evidenceIds': []}
        with tempfile.TemporaryDirectory() as d:
            ctx = debate.context(signal, Path(d), [], calendar=ec.context(signal['createdAt'], 'SBIN', path=self.path, press=None))
            self.assertEqual([e['title'] for e in ctx['upcomingEvents']['events']], ['Federal Reserve decision', 'SBI Q2 results'])
            self.assertEqual(ctx['dataStatus']['eventsCalendar'], 'available')
            none = debate.context(signal, Path(d), [], calendar=ec.context(signal['createdAt'], 'SBIN', path=Path(d) / 'none.json', press=None))
            self.assertEqual(none['dataStatus']['eventsCalendar'], 'no calendar')   # said plainly, not 'nothing scheduled'
            self.assertNotIn('upcomingEvents', none)
        seen = []

        def llm(system, user, schema):
            seen.append(json.loads(user).get('upcomingEvents'))
            return {'calls': []}, {}
        sp.ask_panel(llm, {'title': 't', 'countries': [], 'drivers': [], 'symbols': ['SBIN.NS']}, rounds=1, events=[{'title': 'Fed'}])
        self.assertTrue(all(s == [{'title': 'Fed'}] for s in seen))


if __name__ == '__main__':
    unittest.main()
