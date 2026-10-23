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
        events, skipped = ec.load(self.path)
        self.assertEqual((len(events), skipped), (4, 3))
        self.assertEqual(events[0]['title'], 'Federal Reserve decision')   # sorted by date
        self.assertEqual(ec.load(Path(self.tmp.name) / 'none.json'), (None, 0))

    def test_a_share_sees_its_own_and_market_wide_events_in_the_window_only(self):
        events, _ = ec.load(self.path)
        sbin = ec.upcoming(events, '2026-10-23T11:00:00Z', 10, 'SBIN')
        self.assertEqual([e['title'] for e in sbin], ['Federal Reserve decision', 'SBI Q2 results'])  # not Infosys, not RBI (too far)
        self.assertEqual(len(ec.upcoming(events, '2026-10-23', 40)), 4)
        self.assertEqual(ec.upcoming(events, '2026-10-28', 5, 'SBIN'), [])  # the day itself has passed for a decision made on it
        self.assertIsNone(ec.upcoming(None, '2026-10-23'))

    def test_agents_are_told_what_is_scheduled_or_that_there_is_no_calendar(self):
        signal = {'id': 's', 'symbol': 'SBIN', 'createdAt': '2026-10-23T11:00:00Z', 'evidenceIds': []}
        with tempfile.TemporaryDirectory() as d:
            ctx = debate.context(signal, Path(d), [], calendar=ec.context(signal['createdAt'], 'SBIN', path=self.path))
            self.assertEqual([e['title'] for e in ctx['upcomingEvents']['events']], ['Federal Reserve decision', 'SBI Q2 results'])
            self.assertEqual(ctx['dataStatus']['eventsCalendar'], 'available')
            none = debate.context(signal, Path(d), [], calendar=ec.context(signal['createdAt'], 'SBIN', path=Path(d) / 'none.json'))
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
