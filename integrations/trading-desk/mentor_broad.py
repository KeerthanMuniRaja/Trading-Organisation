"""Mentor checks on the broad universe (MENTOR-03): classic trading tips tested on ~480 NIFTY 500 shares over 10 years.

Eight shares are too few to judge a tip about how shares behave; hundreds are not. Each check measures one well-known
claim on the research files (daily-nifty500, never traded) and says whether our data agrees. Every return is against
the equal-weight average of the shares trading that day, so a market-wide rise or fall does not count as skill.
Survivorship: today's members over past years. It flatters anything that bets on recovery (falling knives), so a
check that favours buying weakness says so.
"""
from __future__ import annotations

import statistics

import daily

TOM_DAYS = (-1, 1, 2, 3)  # the last session of a month and the first three of the next


def prepare(bars_by_symbol):
    """Per share: its sessions, closes and daily return against the universe's average that day."""
    raw = {}
    for s, bars in bars_by_symbol.items():
        closes = [b['closePaise'] for b in bars]
        raw[s] = ([b['date'] for b in bars], closes, [None] + [closes[i] / closes[i - 1] - 1 for i in range(1, len(closes))])
    per_day = {}
    for dates, _, rets in raw.values():
        for d, r in zip(dates, rets):
            if r is not None and abs(r) < 0.5:  # a leftover split or listing jump would swamp the day's average
                per_day.setdefault(d, []).append(r)
    mean = {d: statistics.fmean(v) for d, v in per_day.items() if len(v) >= 20}
    return {s: {'dates': dates, 'closes': closes, 'rel': [None if r is None or d not in mean or abs(r) >= 0.5 else r - mean[d] for d, r in zip(dates, rets)]}
            for s, (dates, closes, rets) in raw.items()}, mean


def _ahead(rel, i, n):
    window = rel[i + 1:i + n + 1]
    return sum(window) if len(window) == n and None not in window else None


def big_day_follow_through(prepared, threshold=0.05, ahead=5):
    """After a one-day move of 5%+ against the market, what the next week did, against the market."""
    shares, _ = prepared
    after_up, after_down = [], []
    for p in shares.values():
        rel = p['rel']
        for i, r in enumerate(rel):
            if r is None or abs(r) < threshold:
                continue
            nxt = _ahead(rel, i, ahead)
            if nxt is not None:
                (after_up if r > 0 else after_down).append(nxt)
    if len(after_up) < 100 or len(after_down) < 100:
        return {'text': 'Too few big one-day moves to judge.', 'holds': None}
    u, d = round(100 * statistics.fmean(after_up), 2), round(100 * statistics.fmean(after_down), 2)
    return {'bigUpDays': len(after_up), 'nextWeekAfterUpPct': u, 'bigDownDays': len(after_down), 'nextWeekAfterDownPct': d,
            'text': f'Across our research universe, after {len(after_up):,} one-day jumps of 5%+ against the market the next 5 sessions '
                    f'averaged {u:+}% against it; after {len(after_down):,} drops of 5%+, {d:+}%.',
            'holds': abs(u) < 0.5 and abs(d) < 0.5}


def falling_knives(prepared, near=1.05, lookback=252, ahead=21):
    """Shares within 5% of their 52-week low, judged on the next month against the market (monthly samples)."""
    shares, _ = prepared
    near_low, others = [], []
    for p in shares.values():
        dates, closes, rel = p['dates'], p['closes'], p['rel']
        for i in range(lookback, len(dates) - ahead):
            if dates[i][:7] == dates[i - 1][:7]:
                continue  # one sample a month: the first session
            nxt = _ahead(rel, i, ahead)
            if nxt is None:
                continue
            (near_low if closes[i] <= near * min(closes[i - lookback + 1:i + 1]) else others).append(nxt)
    if len(near_low) < 200:
        return {'text': 'Too few shares near a 52-week low to judge.', 'holds': None}
    a, b = round(100 * statistics.fmean(near_low), 2), round(100 * statistics.fmean(others), 2)
    # lagging must stand out from noise (Welch t on the gap): significant either way, or "no clear difference"
    t = (statistics.fmean(others) - statistics.fmean(near_low)) / (statistics.variance(near_low) / len(near_low) + statistics.variance(others) / len(others)) ** 0.5
    verdict = 'a clear lag' if t >= 2 else 'clearly better, against the lesson' if t <= -2 else 'no clear difference'
    return {'samplesNearLow': len(near_low), 'nextMonthNearLowPct': a, 'nextMonthOthersPct': b, 'tStat': round(t, 2),
            'text': f'A share within 5% of its 52-week low did {a:+}% against the market over the next month ({len(near_low):,} cases), '
                    f'others {b:+}% (t {t:.1f}: {verdict}). Today\'s index members only: shares that kept falling and left the index are missing, '
                    'which flatters the lows.',
            # the lesson claims only that buying near the lows has no edge: contradicted only if they clearly did better
            'holds': t > -2}


def turn_of_month(prepared):
    """The market's average day around the turn of the month against the rest."""
    _, mean = prepared
    days = sorted(mean)
    month_pos = {}
    for k, d in enumerate(days):
        first = k == 0 or days[k - 1][:7] != d[:7]
        if first:
            start = k
        month_pos[d] = k - start + 1
    last = {days[k] for k in range(len(days) - 1) if days[k + 1][:7] != days[k][:7]}
    # the market's own level: the average share's return that day (mean is relative to nothing here: the raw average)
    tom = [mean[d] for d in days if d in last or month_pos[d] in TOM_DAYS[1:]]
    rest = [mean[d] for d in days if not (d in last or month_pos[d] in TOM_DAYS[1:])]
    if len(tom) < 100:
        return {'text': 'Too little history for the turn of the month.', 'holds': None}
    a, b = round(100 * statistics.fmean(tom), 3), round(100 * statistics.fmean(rest), 3)
    share = round(100 * len(tom) / (len(tom) + len(rest)))
    gain_share = round(100 * sum(tom) / (sum(tom) + sum(rest))) if sum(tom) + sum(rest) > 0 else None
    # the gap must stand out from day-to-day noise (Welch t), not just be larger: noise alone wins "larger" half the time
    t = (statistics.fmean(tom) - statistics.fmean(rest)) / (statistics.variance(tom) / len(tom) + statistics.variance(rest) / len(rest)) ** 0.5
    return {'turnDays': len(tom), 'turnDayAvgPct': a, 'otherDayAvgPct': b, 'turnShareOfDaysPct': share, 'turnShareOfGainPct': gain_share,
            'tStat': round(t, 2),
            'text': f'The last session of a month and the first three of the next averaged {a:+}% a day for the average share, other days {b:+}% '
                    f'(t {t:.1f}): {share}% of the days, {gain_share}% of the total gain.',
            'holds': t >= 2}


def stop_loss(prepared, stop=0.10, hold=63):
    """Buy at each month's first close, sell at a 10% stop or after ~3 months: against simply holding the 3 months."""
    shares, _ = prepared
    held, stopped, whipsaw, hits = [], [], 0, 0
    for p in shares.values():
        dates, closes = p['dates'], p['closes']
        for i in range(1, len(dates) - hold):
            if dates[i][:7] == dates[i - 1][:7]:
                continue
            path = closes[i + 1:i + hold + 1]
            end = path[-1] / closes[i] - 1
            hit = next((c for c in path if c <= (1 - stop) * closes[i]), None)
            held.append(end)
            if hit is None:
                stopped.append(end)
            else:
                hits += 1
                stopped.append(hit / closes[i] - 1)
                whipsaw += path[-1] > hit  # stopped out, and the share was higher three months later
    if len(held) < 500:
        return {'text': 'Too few entries to judge a stop.', 'holds': None}
    q = lambda xs: sorted(xs)[len(xs) // 20]  # noqa: E731 - the worst 5%
    h, s = round(100 * statistics.fmean(held), 2), round(100 * statistics.fmean(stopped), 2)
    hw, sw = round(100 * q(held), 1), round(100 * q(stopped), 1)
    rate = round(100 * whipsaw / hits) if hits else None
    out = round(100 * hits / len(held))
    # whole numbers per 100 holdings: the 4B model merged "41% stopped out, 58% of those higher" into "41% recover" (28 Oct)
    later = round(out * (rate or 0) / 100)
    return {'entries': len(held), 'stoppedOutPct': out, 'avgHeldPct': h, 'avgWithStopPct': s,
            'worst5HeldPct': hw, 'worst5WithStopPct': sw, 'stoppedThenHigherPct': rate,
            'text': f'A 10% stop on {len(held):,} three-month holdings: average {s:+}% with the stop against {h:+}% held, worst 5% {sw}% against {hw}%. '
                    f'Of every 100 holdings, {out} hit the stop, and {later} of those {out} were higher three months later.',
            'holds': sw > hw and s <= h + 0.1}


def _welch(a, b):
    """Welch t of mean(a) - mean(b); None when either side is too small or flat."""
    if len(a) < 3 or len(b) < 3:
        return None
    se = (statistics.variance(a) / len(a) + statistics.variance(b) / len(b)) ** 0.5
    return (statistics.fmean(a) - statistics.fmean(b)) / se if se else None


def momentum_in_rebounds(prepared, fall=-0.10, lookback=126, quint=0.2):
    """6-month momentum's top fifth, next month against the market: in months after the market fell 10%+ over three
    months, against the rest. The 8-share version had too few shares to judge this; ~480 have enough per month."""
    shares, mean = prepared
    days = sorted(mean)
    level = [1.0]
    for d in days:
        level.append(level[-1] * (1 + mean[d]))
    index = {s: {d: i for i, d in enumerate(p['dates'])} for s, p in shares.items()}
    starts = [k for k in range(1, len(days)) if days[k][:7] != days[k - 1][:7]]
    after, normal = [], []
    for a, b in zip(starts, starts[1:]):
        if a < 63:
            continue
        crashed = level[a + 1] / level[a - 62] - 1 <= fall
        scored = []
        for s, p in shares.items():
            i, j = index[s].get(days[a]), index[s].get(days[b])
            if i is None or j is None or i < lookback or p['closes'][i - lookback] <= 0:
                continue
            nxt = p['rel'][i + 1:j + 1]
            if not nxt or None in nxt:
                continue
            scored.append((p['closes'][i] / p['closes'][i - lookback] - 1, sum(nxt)))
        if len(scored) < 50:
            continue
        scored.sort()
        top = scored[-max(1, int(len(scored) * quint)):]
        (after if crashed else normal).append(statistics.fmean(x for _, x in top) - statistics.fmean(x for _, x in scored))
    if len(after) < 3:
        return {'text': 'Too few months after a 10%+ market fall to judge.', 'holds': None}
    t = _welch(normal, after)
    a, n = round(100 * statistics.fmean(after), 2), round(100 * statistics.fmean(normal), 2)
    verdict = 'momentum clearly lagged' if t is not None and t >= 2 else 'momentum clearly did better' if t is not None and t <= -2 else 'no clear difference'
    return {'monthsAfterFalls': len(after), 'excessAfterFallsPct': a, 'excessOtherwisePct': n, 'tStat': None if t is None else round(t, 2),
            'text': f'Across our research universe, in the {len(after)} months after the market fell 10%+ over three months, 6-month momentum\'s top fifth '
                    f'did {a:+}% a month against the average share, against {n:+}% in other months (t {t:.1f}: {verdict}).',
            'holds': True if t is not None and t >= 2 else False if t is not None and t <= -2 else None}


def results_season(prepared, min_shares=50):
    """How far apart single shares move on a day (the spread of returns against the market) in the results weeks
    (the second half of January, April, July and October and the first half of the month after) against other days."""
    shares, _ = prepared
    per_day = {}
    for p in shares.values():
        for d, r in zip(p['dates'], p['rel']):
            if r is not None:
                per_day.setdefault(d, []).append(r)
    season, other = [], []
    for d, xs in per_day.items():
        if len(xs) < min_shares:
            continue
        m, day = int(d[5:7]), int(d[8:10])
        in_season = (m in (1, 4, 7, 10) and day >= 10) or (m in (2, 5, 8, 11) and day <= 15)
        (season if in_season else other).append(statistics.pstdev(xs))
    if len(season) < 50 or len(other) < 50:
        return {'text': 'Too little history for the results season.', 'holds': None}
    t = _welch(season, other)
    a, b = round(100 * statistics.fmean(season), 2), round(100 * statistics.fmean(other), 2)
    return {'seasonDays': len(season), 'spreadInSeasonPct': a, 'spreadOtherwisePct': b, 'tStat': round(t, 2),
            'text': f'In the results weeks single shares\' daily moves against the market spread {a}% on average, against {b}% on other days '
                    f'(t {t:.1f}): {round(100 * (a / b - 1))}% more of each share\'s own news.',
            'holds': t >= 2}


CHECKS = {'big_day_follow_through': big_day_follow_through, 'falling_knives': falling_knives, 'turn_of_month': turn_of_month,
          'stop_loss': stop_loss, 'momentum_in_rebounds_broad': momentum_in_rebounds, 'results_season': results_season}


def load(cache=daily.BROAD):
    import datasets
    return prepare(daily.load(sorted(datasets.nifty500()), cache))
