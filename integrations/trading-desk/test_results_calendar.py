from datetime import date, datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import results_calendar as rc

ROWS = {'HDFCBANK.NS': 'HDFC Bank Ltd.', 'TVSMOTOR.NS': 'TVS Motor Company Ltd.', 'TIPSMUSIC.NS': 'Tips Music Ltd.',
        'ANGELONE.NS': 'Angel One Ltd.', 'SBIN.NS': 'State Bank of India'}
D = date(2026, 10, 16)


def item(title, at='2026-10-16T13:44:00+05:30', symbols=()):
    return {'publishedAt': at, 'source': 'Mint', 'title': title, 'symbols': list(symbols)}


class DatesTests(unittest.TestCase):
    def test_a_results_word_just_before_the_date_counts(self):
        self.assertEqual(rc.dates_in('4 banking stocks to declare results 2026 on Oct 17 - Expectations', D), [date(2026, 10, 17)])
        self.assertEqual(rc.dates_in('Q2 Results Today Live: HDFC Bank profit up', D), [D])
        self.assertEqual(rc.dates_in('SBI Q2 results tomorrow: what to expect', D), [date(2026, 10, 17)])
        self.assertEqual(rc.dates_in('Board meeting on 7th November to consider Q2 results', D), [date(2026, 11, 7)])
        self.assertEqual(rc.dates_in('Q3 results date: January 15', date(2026, 12, 28)), [date(2027, 1, 15)])  # the nearer year

    def test_other_dates_never_count(self):
        for title in ('Tips Music shares up 6% today after strong Q2 results',            # a move, not the results day
                      'Q2 results: dividend record date Oct 24',                         # a record date
                      'Board meeting on Nov 7 to consider fund raise',                   # no results at all
                      'Bihar election results on Nov 14: what markets expect',          # election results
                      'Q2 results on 31 Nov',                                          # no such day
                      'Q2 results on March 3'):                                          # too far from the headline
            self.assertEqual(rc.dates_in(title, D), [], title)
        self.assertEqual(rc.dates_in('Q2 results on Oct 17 | shares jump 5% today', D), [date(2026, 10, 17)])  # not today too


class PolicyDayTests(unittest.TestCase):
    def test_rbi_and_fed_decision_days_are_read_from_the_press(self):
        d = date(2026, 10, 28)
        self.assertEqual(rc.policy_days("US Fed meeting October 2026 today: Expectations, date and time, when & where to watch "
                                        "Kevin Warsh's speech", d), [('fomc', d)])  # the real 28 Oct headline: the speech comes after
        self.assertEqual(rc.policy_days('RBI MPC meeting on December 4: rate cut likely, say economists', d), [('rbi-policy', date(2026, 12, 4))])
        self.assertEqual(rc.policy_days('RBI monetary policy outcome tomorrow: what to expect', d), [('rbi-policy', date(2026, 10, 29))])
        for title in ('Fed minutes on Oct 8 show split over rates',               # minutes are not a decision
                      'Sensex falls ahead of Fed decision',                        # no date
                      'RBI to curb rupee volatility on Monday, says FM',            # no decision word before the date
                      'Fed governor speech on Nov 3 in focus'):
            self.assertEqual(rc.policy_days(title, d), [], title)

    def test_policy_days_are_market_wide_entries(self):
        found = rc.read([item('US Fed meeting October 2026 today: Expectations', at='2026-10-28T14:50:00+05:30')], rc.market_pulse.aliases(ROWS), ROWS)
        self.assertEqual([(e['date'], e['kind'], e['symbol']) for e in found], [('2026-10-28', 'fomc', None)])
        kept = rc.merge([], found + [{**found[0], 'date': '2026-11-04', 'publishedAt': '2026-10-30T10:00:00+05:30'}], date(2026, 10, 30))
        self.assertEqual([k['date'] for k in kept], ['2026-11-04'])  # rescheduled: the later headline wins


class CalendarTests(unittest.TestCase):
    def test_headlines_become_one_entry_per_share_and_date(self):
        rows = rc.market_pulse.aliases(ROWS)
        found = rc.read([item('Q2 Preview: ICICI, Axis, HDFC Bank - banking stocks to declare results on Oct 17', symbols=['ICICIBANK.NS']),
                         item('Tips Music shares up 6% today after strong Q2 results'),
                         item('SpaceX to declare earnings today')], rows, ROWS)  # no NIFTY 500 name: nothing
        self.assertEqual([(e['date'], e['symbol'], e['desk']) for e in found],
                         [('2026-10-17', 'HDFCBANK.NS', True), ('2026-10-17', 'ICICIBANK.NS', True)])
        self.assertEqual(found[0]['company'], 'HDFC Bank Ltd.')

    def test_article_text_gives_the_date_a_title_leaves_out(self):
        rows = {**ROWS, 'RELIANCE.NS': 'Reliance Industries Ltd.', 'INFY.NS': 'Infosys Ltd.'}
        snap = {'publishedAt': '2026-10-28T09:29:00+05:30', 'sourceName': 'Mint', 'title': 'Reliance Industries Q2 results 2026 date and time',
                'content': ("Feed summary (not the full article): Reliance Industries’ board will review September-quarter results on "
                            "October 30, 2026, with an analyst meeting to follow. Infosys shares rose 2% on Monday. "
                            "Peers report results on November 5.")}  # a date with no company in its sentence names nobody
        found = rc.read_bodies([snap], rc.market_pulse.aliases(rows), rows)
        self.assertEqual([(e['date'], e['symbol'], e['from']) for e in found], [('2026-10-30', 'RELIANCE.NS', 'article text')])
        with tempfile.TemporaryDirectory() as d:
            heads, snaps, out = Path(d) / 'h.json', Path(d) / 's.json', Path(d) / 'c.json'
            heads.write_text('[]', encoding='utf-8')
            snaps.write_text(json.dumps([snap]), encoding='utf-8')
            r = rc.build(heads, out, now=datetime(2026, 10, 29, 6, tzinfo=timezone.utc), rows=rows, snapshots_path=snaps)
            self.assertEqual([(e['date'], e['symbol']) for e in r['events']], [('2026-10-30', 'RELIANCE.NS')])

    def test_a_later_headline_reschedules_and_old_entries_expire(self):
        e = lambda d, at, s='SBIN.NS': {'date': d, 'symbol': s, 'publishedAt': at}  # noqa: E731
        kept = rc.merge([e('2026-11-05', '2026-10-20T10:00:00+05:30'), e('2025-07-01', '2025-06-20T10:00:00+05:30')],
                        [e('2026-11-07', '2026-10-25T10:00:00+05:30'), e('2026-11-07', '2026-10-26T10:00:00+05:30'),
                         e('2027-02-05', '2026-12-20T10:00:00+05:30'), e('2026-11-05', '2026-10-20T10:00:00+05:30', 'INFY.NS')],
                        date(2026, 10, 28))
        self.assertEqual([(k['date'], k['symbol'], k['publishedAt'][:10]) for k in kept],
                         [('2026-11-05', 'INFY.NS', '2026-10-20'), ('2026-11-07', 'SBIN.NS', '2026-10-25'), ('2027-02-05', 'SBIN.NS', '2026-12-20')])

    def test_the_calendar_accumulates_past_the_headline_history(self):
        with tempfile.TemporaryDirectory() as d:
            heads, out = Path(d) / 'h.json', Path(d) / 'c.json'
            heads.write_text(json.dumps([item('HDFC Bank to announce Q2 results on Oct 17')]), encoding='utf-8')
            rc.build(heads, out, now=datetime(2026, 10, 16, 10, tzinfo=timezone.utc), rows=ROWS, snapshots_path=None)
            heads.write_text(json.dumps([]), encoding='utf-8')  # the headline has rolled out of the history
            r = rc.build(heads, out, now=datetime(2026, 10, 18, 10, tzinfo=timezone.utc), rows=ROWS, snapshots_path=None)
            self.assertEqual([(e['date'], e['symbol']) for e in r['events']], [('2026-10-17', 'HDFCBANK.NS')])
            self.assertIn('unverified', r['note'])

    def test_coming_desk_results_days_are_filed_with_the_backend_by_the_evaluator(self):
        sent = []

        def opener(req, timeout):
            sent.append((req.full_url, json.loads(req.data), req.headers['Authorization']))

            class Response:
                def __enter__(self):
                    return self

                def __exit__(self, *a):
                    return False

                def read(self, n=None):
                    return json.dumps({'filed': 1, 'alreadyKnown': 0}).encode()
            return Response()
        env = {'API_URL': 'http://127.0.0.1:3000', 'PRINCIPALS_JSON': json.dumps([{'role': 'evaluator', 'token': 'e'}])}
        events = [{'date': '2026-10-30', 'kind': 'results', 'symbols': ['RELIANCE']},
                  {'date': '2026-10-20', 'kind': 'results', 'symbols': ['INFY']},     # already past
                  {'date': '2027-02-05', 'kind': 'results', 'symbols': ['SBIN']},     # beyond 60 days
                  {'date': '2026-11-05', 'kind': 'fomc', 'symbols': []}]              # market-wide, not a share's results
        now = datetime(2026, 10, 29, 12, tzinfo=timezone.utc)
        self.assertEqual(rc.file_days(env, opener, now, events), {'filed': 1, 'alreadyKnown': 0})
        url, body, auth = sent[0]
        self.assertEqual((url, body['days'], auth), ('http://127.0.0.1:3000/v1/protections/results-days', [{'symbol': 'RELIANCE', 'day': '2026-10-30'}], 'Bearer e'))
        self.assertEqual(rc.file_days(env, opener, now, events[1:]), {'filed': 0, 'alreadyKnown': 0})  # nothing to file: no call
        self.assertEqual(len(sent), 1)


if __name__ == '__main__':
    unittest.main()
