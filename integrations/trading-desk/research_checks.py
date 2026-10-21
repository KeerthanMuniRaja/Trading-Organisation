"""Research checks (RESEARCH-01): the tests a backtest must survive before anyone believes it. Model-free; no network.

Methods adopted from open-source trading frameworks (ideas only; their code is not used):
  lookahead   freqtrade's lookahead-analysis: a decision on day i must not change when every day after i is removed.
              A rule that changes is using the future and fails outright.
  warm-up     freqtrade's recursive-analysis: a decision should not change when history far in the past is removed
              (here: everything older than 300 sessions). One that changes depends on where the data happens to start;
              it is reported, not failed, because some honest rules (an index normalised to its first day) do this.
  stats       backtesting.py / vectorbt result statistics on the monthly series: annualised return and volatility,
              Sharpe and Sortino (no risk-free rate), maximum drawdown and its length, Calmar, profit factor and
              expectancy of the monthly excess over the basket, and the system quality number (SQN).
  random      vectorbt's random-signal baseline: the same number of shares picked at random each month, many times.
              A rule that does not beat most random pickers has no edge, whatever its backtest looks like.
  walk-forward  vectorbt / Lean walk-forward: each year, choose the idea with the best record over the previous three
              years and hold it for the next year. The out-of-sample record tests the organisation's own way of
              choosing, which is the honest question: does picking the best backtest work?
  risk lens   a circular block bootstrap of the paired monthly returns: how often the rule's Sharpe stays above the
              basket's; plus the worst fall, the average cash share and the result if cash earned an ASSUMED yield.
              Report only: whether risk may ever pass an idea is the owner's decision.
  proof time  how many months of a record like this one it would take to prove the edge at the scout's bar (80% power).
  tax         an approximate after-tax yearly growth: what a rule sells each year pays short-term tax on that year's gain,
              what it keeps (and the buy-and-hold basket) pays long-term tax once at the end; with the monthly turnover,
              it shows what trading really costs.
"""
from __future__ import annotations

import math
import random
import statistics

WARMUP_SESSIONS = 300


def truncated(table, dates, i, start=0):
    """The table as it looked on day i (and, with `start`, without the days before `start`)."""
    keep = dates[start:i + 1]
    return keep, {s: {d: table[s][d] for d in keep} for s in table}


def same(a, b):
    return set(a) == set(b) and all(abs(a[s] - b[s]) < 1e-9 for s in a)


def decision_days(dates, first, count=6):
    """Up to `count` month-start days spread over the history after `first`."""
    starts = [i for i in range(max(first, 1), len(dates)) if dates[i][:7] != dates[i - 1][:7]]
    if len(starts) <= count:
        return starts
    step = (len(starts) - 1) / (count - 1)
    return [starts[round(k * step)] for k in range(count)]


def check_rules(rules, table, dates, days):
    """name -> {'lookahead': [dates that changed], 'warmup': [dates that changed]} for every rule, sharing the cut tables."""
    out = {name: {'lookahead': [], 'warmup': []} for name in rules}
    for i in days:
        past_dates, past = truncated(table, dates, i)
        recent = None
        if i - WARMUP_SESSIONS > 0:
            recent = truncated(table, dates, i, i - WARMUP_SESSIONS)
        for name, rule in rules.items():
            full = rule(table, dates, i)
            try:
                cut = rule(past, past_dates, i)
            except (IndexError, KeyError):
                cut = None  # it reached for a day that had not happened yet
            if cut is None or not same(full, cut):
                out[name]['lookahead'].append(dates[i])
            if recent is not None:
                r_dates, r_table = recent
                try:
                    short = rule(r_table, r_dates, len(r_dates) - 1)
                except (IndexError, KeyError):
                    short = None
                if short is None or not same(full, short):
                    out[name]['warmup'].append(dates[i])
    return out


def drawdown(levels):
    peak, worst, length, longest = levels[0], 0.0, 0, 0
    for v in levels:
        if v >= peak:
            peak, length = v, 0
        else:
            length += 1
            longest = max(longest, length)
            worst = min(worst, v / peak - 1)
    return worst, longest


def stats(returns_pct, excess_pct):
    """Monthly returns and excess over the basket (both percent) -> the result statistics."""
    n = len(returns_pct)
    if n < 2:
        return None
    r = [x / 100 for x in returns_pct]
    levels, v = [1.0], 1.0
    for x in r:
        v *= 1 + x
        levels.append(v)
    years = n / 12
    cagr = levels[-1] ** (1 / years) - 1 if levels[-1] > 0 else -1.0
    vol = statistics.pstdev(r) * math.sqrt(12)
    down = [min(0.0, x) for x in r]
    downside = math.sqrt(sum(x * x for x in down) / n) * math.sqrt(12)
    worst, months = drawdown(levels)
    gains, losses = sum(x for x in excess_pct if x > 0), -sum(x for x in excess_pct if x < 0)
    sd = statistics.pstdev(excess_pct)
    return {'cagrPct': round(100 * cagr, 2), 'volatilityPct': round(100 * vol, 2),
            'sharpe': round(statistics.fmean(r) * 12 / vol, 2) if vol else None,
            'sortino': round(statistics.fmean(r) * 12 / downside, 2) if downside else None,
            'maxDrawdownPct': round(100 * worst, 2), 'longestDrawdownMonths': months,
            'calmar': round(cagr / -worst, 2) if worst < 0 else None,
            'profitFactor': round(gains / losses, 2) if losses else None,
            'expectancyPct': round(statistics.fmean(excess_pct), 3),
            'sqn': round(math.sqrt(n) * statistics.fmean(excess_pct) / sd, 2) if sd else None}


def random_rule(seed, keep):
    def rule(table, dates, i):
        names = sorted(table)
        picks = random.Random(f'{seed}:{dates[i]}').sample(names, min(keep, len(names)))
        return {s: 1 / keep for s in picks}
    return rule


def percentile(value, population):
    """Share of the population strictly below `value` (0..100)."""
    return round(100 * sum(p < value for p in population) / len(population), 1) if population else None


def _sharpe(xs):
    """Mean over population standard deviation, in plain floats (statistics.pstdev is exact and far too slow here)."""
    n = len(xs)
    mean = sum(xs) / n
    var = sum((x - mean) ** 2 for x in xs) / n
    return mean / math.sqrt(var) if var > 0 else 0.0


def sharpe_test(rule_pct, basket_pct, samples=1000, block=6, seed=0):
    """Risk lens: is the rule's Sharpe really above the basket's? A circular block bootstrap of the paired monthly returns
    (blocks keep runs of months together). Returns the observed difference (annualised) and how often it stays above 0."""
    n = len(rule_pct)
    if n < 2 * block:
        return None
    rng = random.Random(seed)
    observed = (_sharpe(rule_pct) - _sharpe(basket_pct)) * math.sqrt(12)
    above = 0
    for _ in range(samples):
        idx = []
        while len(idx) < n:
            start = rng.randrange(n)
            idx += [(start + k) % n for k in range(block)]
        idx = idx[:n]
        if _sharpe([rule_pct[i] for i in idx]) > _sharpe([basket_pct[i] for i in idx]):
            above += 1
    return {'sharpeDifference': round(observed, 3), 'probabilityBetter': round(above / samples, 3), 'p': round(1 - above / samples, 4)}


def with_cash_yield(rule_pct, cash_share, yearly_pct):
    """Monthly returns if the uninvested share earned `yearly_pct` a year (an ASSUMPTION; backtests otherwise earn 0%)."""
    return [r + c * yearly_pct / 12 for r, c in zip(rule_pct, cash_share)]


def months_to_prove(excess_pct, alpha, power=0.8):
    """How many months of this record it would take to prove the edge at `alpha` (one-sided) with `power`: the normal
    approximation n = ((z_alpha + z_power) * sd / mean)^2 on the monthly excess. None when there is no edge to prove."""
    n = len(excess_pct)
    if n < 2:
        return None
    mean = sum(excess_pct) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in excess_pct) / (n - 1))
    if mean <= 0 or sd == 0:
        return None
    z = statistics.NormalDist().inv_cdf(1 - alpha) + statistics.NormalDist().inv_cdf(power)
    return math.ceil((z * sd / mean) ** 2)


STCG_PCT, LTCG_PCT = 20.0, 12.5   # Indian equity: short-term (held under a year) and long-term capital gains tax, from 23 Jul 2024


def after_tax_cagr(monthly_pct, monthly_turnover=None, months_per_year=12, long_term_sales=False):
    """An APPROXIMATE after-tax yearly growth. Each year the share of the portfolio that was sold (half the year's
    turnover, at most all of it) realises that year's gain at the short-term rate (a loss is offset within the year, no
    carry-forward); the unsold share's gain is deferred and taxed once at the end at the long-term rate. With no turnover
    given (buy and hold), everything is deferred. `long_term_sales`: a rule that rebalances once a year or less often is
    ASSUMED to sell each lot only once it is over 12 months old, so its sales pay the long-term rate. Ignores the
    Rs 1.25 lakh long-term exemption, cess and the exact holding period of each lot."""
    turnover = monthly_turnover or [0.0] * len(monthly_pct)
    rate = LTCG_PCT if long_term_sales else STCG_PCT
    value, deferred = 1.0, 0.0
    for i in range(0, len(monthly_pct), months_per_year):
        growth = 1.0
        for r in monthly_pct[i:i + months_per_year]:
            growth *= 1 + r / 100
        gain = value * (growth - 1)
        sold = min(1.0, sum(turnover[i:i + months_per_year]) / 2)
        realised, kept = gain * sold, gain * (1 - sold)
        value += realised * (1 - rate / 100) if realised > 0 else realised
        value += kept
        deferred += kept
    if deferred > 0:
        value -= deferred * LTCG_PCT / 100
    span = len(monthly_pct) / months_per_year
    return round(100 * (value ** (1 / span) - 1), 2) if value > 0 and span else None


def walk_forward(rows, names, train=36, test=12):
    """Each step: the idea with the best average monthly excess over `train` months, held for the next `test` months."""
    picks, excess = [], []
    for start in range(train, len(rows) - 0, test):
        window, ahead = rows[start - train:start], rows[start:start + test]
        if not ahead:
            break
        best = max(sorted(names), key=lambda n: statistics.fmean(r['rules'][n] - r['basketPct'] for r in window))
        picks.append({'from': ahead[0]['month'], 'to': ahead[-1]['month'], 'chosen': best})
        excess += [r['rules'][best] - r['basketPct'] for r in ahead]
    ahead_n, behind_n = sum(e > 0 for e in excess), sum(e < 0 for e in excess)
    return {'trainMonths': train, 'testMonths': test, 'outOfSampleMonths': len(excess), 'ahead': ahead_n, 'behind': behind_n,
            'averageExcessPct': round(statistics.fmean(excess), 3) if excess else None, 'picks': picks}
