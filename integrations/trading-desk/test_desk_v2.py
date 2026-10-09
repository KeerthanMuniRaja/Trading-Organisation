from datetime import datetime, timedelta
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import desk
import learning
from test_desk import IST, StubModel, synthetic


def headline(minutes_after_open, title, symbols=('RELIANCE.NS',), day=5):
    t = datetime(2026, 1, day, 9, 15, tzinfo=IST) + timedelta(minutes=minutes_after_open)
    return {'publishedAt': t.isoformat(), 'source': 'owner-test-feed', 'title': title, 'symbols': list(symbols)}


class BookTests(unittest.TestCase):
    def test_book_resumed_from_saved_state_matches_an_uninterrupted_run(self):
        bars = synthetic()['bars']
        decide = desk.momentum_decider(bars)
        whole = desk.simulate(bars, decide)
        book = desk.Book()
        for i, bar in enumerate(bars):
            if i % 37 == 0:  # persist and reload, as the live desk does between bars
                book = desk.Book(json.loads(json.dumps(book.s)))
            book.step(i, bar, decide)
        self.assertEqual(book.result(), json.loads(json.dumps(whole)))
        self.assertTrue(whole['trades'])


class ScheduleTests(unittest.TestCase):
    def test_meetings_follow_the_session_clock_and_never_span_the_overnight_gap(self):
        bars = synthetic()['bars']
        points = desk.meeting_points(bars, 12, 40)
        self.assertEqual({bars[i]['time'][11:16] for i in points}, {'10:10', '11:10', '12:10', '13:10', '14:10', '15:10'})
        for i in points:
            self.assertTrue(desk.data_steward(bars, i)['usable'])
            self.assertEqual(bars[i - 11]['time'][:10], bars[i]['time'][:10])
        result = desk.run_desk(synthetic(), StubModel(), every=12, max_decisions=18)
        self.assertEqual(result['decisionPoints'], 18)
        self.assertTrue(all('portfolio-manager' in d['bots'] for d in result['decisions'] if d['type'] == 'desk-meeting'))


class ScoreTests(unittest.TestCase):
    def test_analysts_are_compared_with_always_neutral_on_the_same_meetings(self):
        bars = synthetic()['bars']
        points = desk.meeting_points(bars, 12, 18)

        def meeting(i):
            return {'type': 'desk-meeting', 'index': i, 'allowed': ['buy', 'hold'], 'bots': {
                'trend-analyst': {'outcome': 'valid', 'opinion': {'stance': 'neutral'}},
                'reversion-analyst': {'outcome': 'failed'}, 'portfolio-manager': {'outcome': 'failed'}}}
        card = desk.scorecards(bars, [meeting(i) for i in points], 12)['analysts']['trend-analyst']
        self.assertEqual(card['correct'], card['alwaysNeutralCorrect'])  # always saying neutral is the baseline itself
        self.assertEqual(card['hitRate'], card['alwaysNeutralRate'])
        moves = [desk.bps(bars[min(i + 12, len(bars) - 1)]['closePaise'], bars[i]['closePaise']) for i in points]
        self.assertEqual(card['alwaysNeutralCorrect'], sum(abs(m) <= desk.COST_BPS_ROUND_TRIP for m in moves))


class NewsTests(unittest.TestCase):
    def test_news_analyst_sees_only_past_headlines_about_its_own_symbol(self):
        bars = synthetic()['bars']
        i = desk.meeting_points(bars, 12, 1)[0]  # 10:10 bar, completed at 10:15
        items = [headline(55, 'Reliance beats estimates'), headline(61, 'Future headline'),
                 headline(30, 'Infosys wins deal', ('INFY.NS',)), headline(-60 * 30, 'Too old')]
        view = desk.news_view(desk.validate_headlines(items), 'RELIANCE.NS', bars[i])
        self.assertEqual([h['title'] for h in view['headlines']], ['Reliance beats estimates'])
        self.assertEqual(view['headlines'][0]['minutesAgo'], 5)
        with self.assertRaisesRegex(ValueError, 'HEADLINE_TIME_NEEDS_OFFSET'):
            desk.validate_headlines([{**items[0], 'publishedAt': '2026-01-05T10:00:00'}])
        with self.assertRaisesRegex(ValueError, 'INVALID_HEADLINE'):
            desk.validate_headlines([{**items[0], 'symbols': ['TCS.NS']}])

    def test_news_analyst_is_consulted_only_with_recent_news_and_stays_independent(self):
        model = StubModel()
        result = desk.run_desk(synthetic(), model, every=12, max_decisions=6, headlines=[headline(50, 'Reliance beats estimates')])
        meetings = [d for d in result['decisions'] if d['type'] == 'desk-meeting']
        self.assertEqual(meetings[0]['bots']['news-analyst']['outcome'], 'valid')
        later = [d for d in meetings if d['bar'] > '2026-01-06']
        self.assertTrue(all(d['bots']['news-analyst']['outcome'] == 'not-consulted' for d in later))
        for role, payload, schema in model.calls:
            if role == 'news-analyst':
                self.assertEqual(set(payload), {'headlines', 'minutesToClose'})  # no prices, no other opinions
            if role == 'portfolio-manager':
                self.assertEqual(set(schema['properties']['reliedOn']['items']['enum']), set(payload['opinions']))
        cards = result['scorecards']['analysts']['news-analyst']
        self.assertEqual(cards['opinions'] + cards['notConsulted'], len(meetings))
        self.assertEqual(result['modelCalls'], len(model.calls))
        exp = learning.experience([(synthetic()['bars'], result['decisions'])], 12)
        self.assertEqual(sum(sum(c.values()) for c in exp['analysts']['news-analyst'].values()), cards['opinions'])


class NewsBatchTests(unittest.TestCase):
    def test_batch_passes_news_to_every_window_and_budgets_the_extra_call(self):
        import tempfile
        import batch
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            path = tmp / 'w.json'
            path.write_text(json.dumps(synthetic()), encoding='utf-8')
            news = [headline(50, 'Reliance beats estimates')]
            summary = batch.run_batch([path], StubModel(), tmp / 'b', every=12, max_decisions=6, max_calls=23,
                                      model='stub+news', headlines=news)
            self.assertEqual(summary['stoppedReason'], 'call-budget')  # 6 meetings x 4 calls exceeds 23
            summary = batch.run_batch([path], StubModel(), tmp / 'b', every=12, max_decisions=6, max_calls=24,
                                      model='stub+news', headlines=news)
            self.assertGreater(summary['analysts']['news-analyst']['opinions'], 0)


class SymbolTests(unittest.TestCase):
    def test_every_prompt_names_the_traded_symbol_and_routes_to_its_role(self):
        data = synthetic()
        data['symbol'] = 'INFY.NS'
        model = StubModel()
        desk.run_desk(data, model, every=12, max_decisions=2)
        self.assertTrue(model.calls)
        systems = desk.prompts('INFY.NS')
        for role, system in systems.items():
            self.assertIn('NSE:INFY (Infosys)', system)
            self.assertEqual(learning.role_of(system), role)
        with self.assertRaises(ValueError):
            learning.role_of('You are a helpful assistant')


if __name__ == '__main__':
    unittest.main()
