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

    def test_falling_knives_and_too_little_data(self):
        knives = mb.falling_knives(mb.prepare(universe(shares=80, years=6)))
        self.assertGreaterEqual(knives['samplesNearLow'], 200, knives['text'])
        tiny = mb.prepare(universe(shares=2, years=1))
        self.assertIsNone(mb.stop_loss(tiny)['holds'])
        self.assertIsNone(mb.big_day_follow_through(tiny)['holds'])


if __name__ == '__main__':
    unittest.main()
