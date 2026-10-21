"""Market regime (REGIME-01): is the market of our eight shares healthy, under pressure or breaking down?

Inspired by claude-trading-skills (MIT, github.com/tradermonty/claude-trading-skills), mainly its IBD distribution-day
monitor. Our version is a SIMPLER VARIANT, not their specification (their source was read on 21 Oct 2026, see
docs/research-notes/trading-skills-finance-plugins-a-stock-data.md): they call SEVERE at 6 days and also escalate on
5- and 15-session clusters, count stalling days and use index volume; our exposure table equals their table for a 3x
leveraged ETF, and the trend and breadth deductions below are our own design, as is the "breadth" of eight shares (a
concentration measure, not market breadth). It is model-free and runs on the desk's own daily data for its eight NSE
shares, treated as one equal-weight basket (there is no index feed):
  - distribution day: the basket falls at least 0.2% on higher volume than the day before (the shares' average volume
    ratio above 1). It counts for 25 sessions, unless the basket later closes 5% above that day's close;
  - risk: NORMAL (0-2 active distribution days), CAUTION (3-4), HIGH (5-6), SEVERE (7 or more);
  - breadth: how many of the eight close above their 50-day and 200-day averages;
  - trend: whether the basket is above its 200-day average;
  - exposure ceiling: NORMAL 100%, CAUTION 75%, HIGH 50%, SEVERE 25%, a further 25 points lower below the 200-day trend
    and again with 2 or fewer shares above their 200-day average (never below 0).
The ceiling is ADVICE: limits and money are the owner's. A rule that uses the regime is an R&D idea like any other (the
`distribution-days` filter) and has to pass the scout before a bot can be born from it.
`study` checks the regime against what followed on our own history: the basket's next-20-session return and worst fall
for each risk level. Seen history, overlapping windows: a description, not proof.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\market_regime.py [now|study]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import daily  # noqa: E402
import portfolio_daily as pd  # noqa: E402

OUT = daily.ROOT / '.local' / 'trading-desk' / 'regime'
DROP_PCT, EXPIRY, INVALIDATE_PCT = -0.2, 25, 5.0
LEVELS = ((7, 'SEVERE'), (5, 'HIGH'), (3, 'CAUTION'), (0, 'NORMAL'))
CEILING = {'NORMAL': 100, 'CAUTION': 75, 'HIGH': 50, 'SEVERE': 25}
HORIZON = 20


def basket(table, dates, start, end):
    """Equal-weight index levels, daily returns (%) and average volume ratios for dates[start..end]."""
    first = {s: table[s][dates[start]]['closePaise'] for s in table}
    level = [sum(table[s][dates[k]]['closePaise'] / first[s] for s in table) / len(table) for k in range(start, end + 1)]
    ret, ratio = [None], [None]
    for k in range(start + 1, end + 1):
        ret.append(100 * sum(table[s][dates[k]]['closePaise'] / table[s][dates[k - 1]]['closePaise'] - 1 for s in table) / len(table))
        ratio.append(sum(table[s][dates[k]]['volume'] / max(1, table[s][dates[k - 1]]['volume']) for s in table) / len(table))
    return level, ret, ratio


def distribution_days(table, dates, i):
    """The dates of active distribution days at day i (completed days only)."""
    start = max(0, i - EXPIRY - 1)
    if i - start < 2:
        return []
    level, ret, ratio = basket(table, dates, start, i)
    active = []
    for j in range(1, len(level)):
        k = start + j
        if i - k >= EXPIRY or ret[j] > DROP_PCT or ratio[j] <= 1:
            continue
        if max(level[j + 1:], default=0) >= level[j] * (1 + INVALIDATE_PCT / 100):
            continue  # the market recovered well above it
        active.append(dates[k])
    return active


def risk_of(count):
    return next(name for floor, name in LEVELS if count >= floor)


def above(table, dates, i, window):
    if i < window:
        return None
    return sum(table[s][dates[i]]['closePaise'] > sum(pd.closes(table, s, dates, i, window)) / window for s in table)


def regime(table, dates, i):
    days = distribution_days(table, dates, i)
    risk = risk_of(len(days))
    trend = bool(pd.trend_filtered(table, dates, i)) if i >= 200 else None
    b50, b200 = above(table, dates, i, 50), above(table, dates, i, 200)
    ceiling = CEILING[risk] - (25 if trend is False else 0) - (25 if b200 is not None and b200 <= 2 else 0)
    return {'date': dates[i], 'distributionDays': len(days), 'distributionDates': days, 'risk': risk, 'aboveTrend200d': trend,
            'breadth50d': b50, 'breadth200d': b200, 'shares': len(table), 'exposureCeilingPct': max(0, ceiling),
            'followThrough': follow_through(table, dates, i)['state'],
            # readers check these before trusting it (trading-skills' provenance gate): which shares it rests on
            'inputsComplete': len(table) == len(daily.datasets.UNIVERSE)}


CEILING_V2 = {'NORMAL': 100, 'CAUTION': 100, 'HIGH': 75, 'SEVERE': 50}  # their unlevered row for HIGH/SEVERE; CAUTION assumed


def distribution_ages_v2(table, dates, i):
    """REGIME v2 (closer to the cited specification): a distribution day is a basket fall of at least 0.2% on higher
    TRADED VALUE (sum of volume x close over the shares) than the day before; same 25-session expiry and 5% removal.
    Returns the ages (sessions ago) of the active ones. Stalling days are not counted (their exact rule was not confirmed)."""
    start = max(0, i - EXPIRY - 1)
    if i - start < 2:
        return []
    level, ret, _ = basket(table, dates, start, i)
    value = [sum(table[s][dates[k]]['volume'] * table[s][dates[k]]['closePaise'] for s in table) for k in range(start, i + 1)]
    ages = []
    for j in range(1, len(level)):
        k = start + j
        if i - k >= EXPIRY or ret[j] > DROP_PCT or value[j] <= value[j - 1]:
            continue
        if max(level[j + 1:], default=0) >= level[j] * (1 + INVALIDATE_PCT / 100):
            continue
        ages.append(i - k)
    return ages


def below_short_trend(table, dates, i):
    """The basket below its 21-day EMA or its 50-day average (completed days only)."""
    if i < 50:
        return False
    level, _, _ = basket(table, dates, i - 60, i)
    ema = level[0]
    for x in level[1:]:
        ema += (x - ema) * 2 / 22
    return level[-1] < ema or level[-1] < sum(level[-50:]) / 50


def risk_v2(table, dates, i):
    ages = distribution_ages_v2(table, dates, i)
    d5, d15, d25 = (sum(a < n for a in ages) for n in (5, 15, 25))
    if d25 >= 6 or d15 >= 4 or (d25 >= 5 and below_short_trend(table, dates, i)):
        return 'SEVERE'
    if d25 >= 5 or d5 >= 2 or d15 >= 3:
        return 'HIGH'
    return 'CAUTION' if d25 >= 3 else 'NORMAL'


def calm(table, dates, i):
    """The R&D filter: true unless distribution risk is HIGH or SEVERE."""
    return risk_of(len(distribution_days(table, dates, i))) in ('NORMAL', 'CAUTION')


# REGIME-02 follow-through day: the re-entry half of a distribution-day regime, adapted from claude-trading-skills
# (MIT, skills/ftd-detector, ftd_methodology.md). A correction is a fall of at least 3% from the highest close of the last
# 40 sessions, with at least 3 down days. Day 1 of a rally attempt is the first up close after the low (a lower close
# restarts the count from a new low). A follow-through day is day 4 to 10 of the attempt with a basket gain of at least
# 1.25% on higher traded value than the day before. It confirms a new uptrend for FTD_VALID sessions, unless the basket
# closes below the rally's low (a failed follow-through) or a new correction begins. Their quality score and the
# second-index confirmation are left out: there is one basket and no index feed.
CORRECTION_PCT, PEAK_LOOKBACK, MIN_DOWN_DAYS = 3.0, 40, 3
FTD_GAIN_PCT, FTD_DAYS, FTD_VALID = 1.25, (4, 10), 25
FTD_HISTORY = PEAK_LOOKBACK + FTD_DAYS[1] + FTD_VALID + 15


def follow_through(table, dates, i):
    """The follow-through state at day i (completed days only): {'state': 'none' | 'correction' | 'rally' | 'confirmed',
    'lowDate', 'rallyDay', 'ftdDate'}."""
    start = max(0, i - FTD_HISTORY)
    if i - start < 5:
        return {'state': 'none', 'lowDate': None, 'rallyDay': None, 'ftdDate': None}
    level, ret, _ = basket(table, dates, start, i)
    value = [sum(table[s][dates[k]]['volume'] * table[s][dates[k]]['closePaise'] for s in table) for k in range(start, i + 1)]
    def falling(k, since=0):
        """A correction at k: at least CORRECTION_PCT below the highest close of the last PEAK_LOOKBACK sessions (from
        `since` on), with MIN_DOWN_DAYS down days after that high."""
        peak = max(range(max(since, k - PEAK_LOOKBACK), k + 1), key=lambda j: (level[j], j))
        return level[k] <= level[peak] * (1 - CORRECTION_PCT / 100) and sum(ret[j] < 0 for j in range(peak + 1, k + 1)) >= MIN_DOWN_DAYS

    low = day1 = ftd = None
    for k in range(1, len(level)):
        if ftd is not None:
            if level[k] < level[low]:
                low, day1, ftd = k, None, None          # a failed follow-through: back to the correction, from a new low
            elif falling(k, since=ftd):
                low, day1, ftd = k, None, None          # a new correction, measured from the high made after the confirmation
            continue
        if low is None:
            if falling(k):
                low = k
            continue
        if level[k] < level[low]:
            low, day1 = k, None                          # a deeper low restarts the rally attempt
        elif day1 is None:
            if ret[k] > 0:
                day1 = k
        else:
            day = k - day1 + 1
            if FTD_DAYS[0] <= day <= FTD_DAYS[1] and ret[k] >= FTD_GAIN_PCT and value[k] > value[k - 1]:
                ftd = k
            elif day > FTD_DAYS[1]:
                day1 = None                              # the attempt ran out without a follow-through; wait for the next
    n = len(level) - 1
    out = {'lowDate': dates[start + low] if low is not None else None, 'rallyDay': (n - day1 + 1) if day1 is not None and ftd is None else None,
           'ftdDate': dates[start + ftd] if ftd is not None else None}
    if ftd is not None and n - ftd < FTD_VALID:
        return {'state': 'confirmed', **out}
    if ftd is not None:
        return {'state': 'none', **out}                  # an old confirmation: the uptrend is simply the normal state now
    return {'state': 'rally' if day1 is not None else 'correction' if low is not None else 'none', **out}


def calm_or_followed_through(table, dates, i):
    """The R&D filter `distribution-ftd`: invested while distribution risk is NORMAL or CAUTION, and also under HIGH or
    SEVERE once a follow-through day has confirmed a new uptrend (the regime's way back in)."""
    return calm(table, dates, i) or follow_through(table, dates, i)['state'] == 'confirmed'


def ftd_study(table, dates, start=200, horizon=HORIZON):
    """What followed confirmed follow-through days, against stressed days (HIGH or SEVERE) without one: the basket's
    next-`horizon`-session return and worst fall. Seen history, overlapping windows: a description, not proof."""
    level, _, _ = basket(table, dates, 0, len(dates) - 1)
    groups = {'confirmed': [], 'stressed-without-ftd': []}
    for i in range(start, len(dates) - horizon):
        ahead = level[i + 1:i + horizon + 1]
        row = (100 * (ahead[-1] / level[i] - 1), 100 * (min(ahead) / level[i] - 1))
        if follow_through(table, dates, i)['state'] == 'confirmed':
            groups['confirmed'].append(row)
        elif not calm(table, dates, i):
            groups['stressed-without-ftd'].append(row)
    return {name: {'days': len(xs), 'averageReturnPct': round(statistics.fmean(r for r, _ in xs), 2) if xs else None,
                   'averageWorstFallPct': round(statistics.fmean(f for _, f in xs), 2) if xs else None} for name, xs in groups.items()}


def study(table, dates, start=200, horizon=HORIZON, risk_at=None):
    """Per risk level: how often it occurred and the basket's next-`horizon`-session return and worst fall. `risk_at`
    chooses the regime version (default v1)."""
    risk_at = risk_at or (lambda t, d, i: risk_of(len(distribution_days(t, d, i))))
    level, _, _ = basket(table, dates, 0, len(dates) - 1)
    by = {name: [] for _, name in LEVELS}
    for i in range(start, len(dates) - horizon):
        risk = risk_at(table, dates, i)
        ahead = level[i + 1:i + horizon + 1]
        by[risk].append((100 * (ahead[-1] / level[i] - 1), 100 * (min(ahead) / level[i] - 1)))
    rows = {}
    for name, xs in by.items():
        rows[name] = {'days': len(xs), 'averageReturnPct': round(statistics.fmean(r for r, _ in xs), 2) if xs else None,
                      'averageWorstFallPct': round(statistics.fmean(f for _, f in xs), 2) if xs else None,
                      'fallOver5PctShare': round(sum(f <= -5 for _, f in xs) / len(xs), 3) if xs else None}
    normal, stressed = rows['NORMAL'], [rows[n] for n in ('HIGH', 'SEVERE') if rows[n]['days'] >= 20]
    verdict = ('insufficient-evidence' if not stressed or normal['days'] < 20 else
               'warns-of-falls' if all(r['averageWorstFallPct'] < normal['averageWorstFallPct'] for r in stressed) else 'no-clear-warning')
    return {'horizonSessions': horizon, 'from': dates[start], 'through': dates[len(dates) - horizon - 1], 'levels': rows, 'verdict': verdict,
            'note': 'Seen history, overlapping windows: describes how the regime and later falls went together; it is not proof.'}


def history(table, dates, start=200):
    """The regime of every session from `start` (completed days only, the same rules as `regime`), so any past day's
    regime can be looked up point-in-time (the knowledge index loads it)."""
    return [{k: v for k, v in regime(table, dates, i).items() if k != 'distributionDates'} for i in range(start, len(dates))]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', nargs='?', choices=['now', 'study'], default='now')
    args = parser.parse_args(argv)
    dates, table = pd.aligned(daily.load(sorted(daily.datasets.UNIVERSE)))
    OUT.mkdir(parents=True, exist_ok=True)
    if args.command == 'now':
        r = regime(table, dates, len(dates) - 1)
        r['note'] = 'Advice only: the exposure ceiling is not applied to any bot or limit.'
        batch.save(OUT / 'latest.json', r)
        batch.save(OUT / f"regime-{r['date']}.json", r)
        print(json.dumps({k: r[k] for k in ('date', 'risk', 'distributionDays', 'breadth50d', 'breadth200d', 'aboveTrend200d', 'exposureCeilingPct')}))
        return
    report = study(table, dates)
    # v2 is studied on the same days, side by side, so the better-evidenced version can be chosen (owner decision)
    report['v2'] = {**study(table, dates, risk_at=risk_v2), 'rules': 'SEVERE at 6, 5- and 15-session clusters, below the 21-day EMA or '
                    '50-day average, traded-value volume; no stalling days', 'ceiling': CEILING_V2}
    report['followThrough'] = {**ftd_study(table, dates), 'rules': f'correction {CORRECTION_PCT}% in {PEAK_LOOKBACK} sessions with {MIN_DOWN_DAYS}+ down days; '
                               f'day {FTD_DAYS[0]}-{FTD_DAYS[1]} of a rally, gain {FTD_GAIN_PCT}%+ on higher traded value; valid {FTD_VALID} sessions'}
    batch.save(OUT / 'study.json', report)
    batch.save(OUT / 'history.json', {'note': 'The regime of every session, computed with completed days only.', 'days': history(table, dates)})
    for version, r in (('v1', report), ('v2', report['v2'])):
        for name, row in r['levels'].items():
            print(f"  {version} {name:8s} days {row['days']:>5}  next {HORIZON} sessions: return {row['averageReturnPct']}%  worst fall {row['averageWorstFallPct']}%"
                  f"  falls over 5%: {row['fallOver5PctShare']}")
    for name, row in report['followThrough'].items():
        if isinstance(row, dict):
            print(f"  ftd {name:22s} days {row['days']:>5}  next {HORIZON} sessions: return {row['averageReturnPct']}%  worst fall {row['averageWorstFallPct']}%")
    print(json.dumps({'verdict': report['verdict'], 'verdictV2': report['v2']['verdict'], 'from': report['from'], 'through': report['through']}))


if __name__ == '__main__':
    main()
