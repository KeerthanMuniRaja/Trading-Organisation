from datetime import date, timedelta
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mentor_broad as mb


def universe(shares=40, years=4, seed=5, tom_boost=0.0, jump_echo=0.0, sd=0.02):
    """Synthetic closes. `tom_boost` adds a return on turn-of-month days; `jump_echo` makes the day after a 5%+ jump
    move that much again (a planted follow-through). Big days are planted both ways (+7%, -7%)."""
    rng = random.Random(seed)
    days, day = [], date(2018, 1, 1)
    while len(days) < 252 * years:
        if day.weekday() < 5:
            days.append(day)
        day += timedelta(days=1)
    turn = {d for k, d in enumerate(days) if (k + 1 < len(days) and days[k + 1].month != d.month) or (k > 0 and days[k - 1].month != d.month)
            or (k > 1 and days[k - 2].month != d.month) or (k > 2 and days[k - 3].month != d.month and days[k - 1].month == d.month)}
    out = {}
    for s in range(shares):
        price, bars, last = 100_000.0, [], 0.0
        for d in days:
            r = rng.gauss(0, sd) + (tom_boost if d in turn else 0.0) + (jump_echo if last >= 0.05 else 0.0)
            draw = rng.random()
            r += 0.07 if draw < 0.01 else -0.07 if draw < 0.02 else 0.0  # occasional big days, both ways
            price *= 1 + r
            last = r
            bars.append({'date': d.isoformat(), 'closePaise': max(1, round(price))})
        out[f'S{s:02d}.NS'] = bars
    return out


class BroadMentorTests(unittest.TestCase):
    def test_returns_are_measured_against_the_market(self):
        shares, mean = mb.prepare({'A.NS': [{'date': '2026-01-01', 'closePaise': 100}, {'date': '2026-01-02', 'closePaise': 110}],
                                   **{f'X{k}.NS': [{'date': '2026-01-01', 'closePaise': 100}, {'date': '2026-01-02', 'closePaise': 100}] for k in range(19)}})
        self.assertAlmostEqual(mean['2026-01-02'], 0.005)                      # 20 shares, one up 10%
        self.assertAlmostEqual(shares['A.NS']['rel'][1], 0.095)

    def test_a_planted_follow_through_is_found_and_noise_is_not(self):
        noise = mb.big_day_follow_through(mb.prepare(universe(sd=0.01)))
        self.assertTrue(noise['holds'], noise['text'])                          # nothing planted: a big day tells little
        echo = mb.big_day_follow_through(mb.prepare(universe(jump_echo=0.03, sd=0.01)))
        self.assertGreater(echo['nextWeekAfterUpPct'], 1.0)                     # planted: the next day echoes the jump
        self.assertFalse(echo['holds'])

    def test_the_turn_of_the_month_is_found_only_when_it_is_there(self):
        self.assertTrue(mb.turn_of_month(mb.prepare(universe(tom_boost=0.004)))['holds'])
        self.assertFalse(mb.turn_of_month(mb.prepare(universe(seed=9)))['holds'])

    def test_a_stop_caps_the_worst_holdings(self):
        r = mb.stop_loss(mb.prepare(universe()))
        self.assertGreater(r['worst5WithStopPct'], r['worst5HeldPct'])
        self.assertGreater(r['stoppedOutPct'], 0)
        self.assertIn('were higher three months later', r['text'])

    def test_momentum_after_falls_and_the_results_season(self):
        r = mb.momentum_in_rebounds(mb.prepare(universe(shares=60, years=6)))
        self.assertIn(r['holds'], (None, True, False))                                   # judged with a t-test, whatever noise gives
        self.assertTrue(r['text'])
        season = universe(shares=60, years=3)
        for s, bars in season.items():                                                    # plant extra stock-specific moves in results weeks
            k = int(s[1:3])
            for i, b in enumerate(bars[1:], start=1):
                m, d = int(b['date'][5:7]), int(b['date'][8:10])
                if (m in (1, 4, 7, 10) and d >= 10) or (m in (2, 5, 8, 11) and d <= 15):
                    bars[i] = {**b, 'closePaise': max(1, round(b['closePaise'] * (1.02 if (k + i) % 2 else 0.98)))}
        planted = mb.results_season(mb.prepare(season))
        self.assertTrue(planted['holds'], planted['text'])
        self.assertGreater(planted['spreadInSeasonPct'], planted['spreadOtherwisePct'])

    def test_results_days_are_judged_on_the_press_calendar_once_there_are_enough(self):
        import json
        import tempfile
        quiet = universe(shares=40, years=3, sd=0.015)
        events = [{'symbol': f'S{k:02d}.NS', 'date': quiet['S00.NS'][400 + 7 * k]['date']} for k in range(40)]
        jumped = {s: [dict(b) for b in bars] for s, bars in quiet.items()}
        for k, e in enumerate(events):                                  # plant a 6% results gap that stays (either way)
            bars = jumped[e['symbol']]
            i = next(n for n, b in enumerate(bars) if b['date'] == e['date'])
            for b in bars[i:]:
                b['closePaise'] = round(b['closePaise'] * (1.06 if k % 2 else 0.94))
        with tempfile.TemporaryDirectory() as d:
            calendar = Path(d) / 'results-calendar.json'
            calendar.write_text(json.dumps({'events': events}), encoding='utf-8')
            gap = mb.results_day_moves(mb.prepare(jumped), calendar)
            self.assertEqual(gap['cases'], 40)
            self.assertTrue(gap['holds'], gap['text'])
            self.assertGreater(gap['medianTimesUsual'], 2)
            calm = mb.results_day_moves(mb.prepare(quiet), calendar)    # the same days with nothing planted
            self.assertFalse(calm['holds'], calm['text'])
            few = mb.results_day_moves(mb.prepare(jumped), calendar, min_cases=50)
            self.assertIsNone(few['holds'])                             # too few: unverified, never guessed
            self.assertIn('judged at 50', few['text'])
            self.assertIn('So far the median move was', few['text'])
            self.assertIsNone(mb.results_day_moves(mb.prepare(jumped), Path(d) / 'none.json')['holds'])

    def test_falling_knives_and_too_little_data(self):
        knives = mb.falling_knives(mb.prepare(universe(shares=80, years=6)))
        self.assertGreaterEqual(knives['samplesNearLow'], 200, knives['text'])
        tiny = mb.prepare(universe(shares=2, years=1))
        self.assertIsNone(mb.stop_loss(tiny)['holds'])
        self.assertIsNone(mb.big_day_follow_through(tiny)['holds'])


if __name__ == '__main__':
    unittest.main()
