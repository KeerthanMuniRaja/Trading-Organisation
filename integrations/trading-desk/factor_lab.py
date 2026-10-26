"""Factor lab (RESEARCH-02): which signals actually predict next month's returns across a broad universe?

The R&D scout picks 2 to 5 of our 8 shares, where even a real edge would take centuries to prove. With hundreds of shares,
each month carries hundreds of independent outcomes, so a pattern can be told apart from luck in years. Each month the lab
ranks every share with enough history on each factor and measures, net of costs:
  top quintile      the best-ranked fifth, equal weights, against the equal-weight universe (the "basket")
  spread            the top fifth minus the bottom fifth: does the ranking separate winners from losers at all?
  IC                the information coefficient: the rank correlation between the factor and next month's return. A real
                    signal has a positive mean IC month after month (t-statistic), however small each month's IC is.
Timing is the scout's: decide on the first session of a month (its close included), enter at the next session's open,
hold to the open after the next month's first session. Cost: ONE_WAY_COST_PCT on each unit of weight traded.

A factor PASSES only if its monthly IC t-statistic and its top-quintile excess both clear a Bonferroni bar over every
factor in the catalogue, it is ahead of the basket in both halves of the history, and in most years. Then it is a
candidate for a pre-registered live test, never proof. The NIFTY 500 files hold today's members (survivorship bias): a
pass here must be re-tested on point-in-time membership (founder review B14) before anyone relies on it.
Research only: no orders, no wallets, no network.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\factor_lab.py [--through YYYY-MM]
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import daily  # noqa: E402
import research_checks as rc  # noqa: E402
from rnd_scout import ONE_WAY_COST_PCT, sign_p  # noqa: E402

VERSION = 'factor-lab-v1'
OUT = daily.ROOT / '.local' / 'trading-desk' / 'rnd'
ALPHA = 0.05
QUINTILE = 0.2
MIN_SHARES = 25          # a month with fewer eligible shares is not judged: a "quintile" of three proves nothing
MIN_MONTHS = 36
LOOKBACK = 300           # sessions of history kept per share and month


# ---------- factors: (closes up to and including the decision day) -> score, higher = buy; None = not enough history ----
def _ret(c, start, end):
    return c[-1 - end] / c[-1 - start] - 1 if len(c) > start and c[-1 - start] > 0 else None


def _vol(c, n):
    if len(c) <= n:
        return None
    r = [c[i] / c[i - 1] - 1 for i in range(len(c) - n, len(c))]
    return statistics.pstdev(r)


def _near_high(c, n=252):
    if len(c) < n:
        return None
    return c[-1] / max(c[-n:])


def _trend(c, n=200):
    if len(c) < n:
        return None
    return c[-1] / (sum(c[-n:]) / n) - 1


FACTORS = {
    'momentum-12-1': ('12-month return, skipping the latest month (the classic momentum factor)', 253, lambda c: _ret(c, 252, 21)),
    'momentum-6m': ('6-month return', 127, lambda c: _ret(c, 126, 0)),
    'momentum-3m': ('3-month return', 64, lambda c: _ret(c, 63, 0)),
    'reversal-1m': ('the latest month\'s loss (short-term reversal: last month\'s losers)', 22, lambda c: (lambda r: None if r is None else -r)(_ret(c, 21, 0))),
    'low-vol-60d': ('calm: low volatility of daily returns over 60 sessions', 61, lambda c: (lambda v: None if v is None else -v)(_vol(c, 60))),
    'low-vol-250d': ('calm: low volatility over a year', 251, lambda c: (lambda v: None if v is None else -v)(_vol(c, 250))),
    'near-52w-high': ('closeness to the 52-week high', 252, _near_high),
    'trend-200d': ('distance above the 200-day average', 200, _trend),
}


def catalogue_fingerprint():
    import inspect
    parts = [VERSION, str(ONE_WAY_COST_PCT), str(QUINTILE), str(MIN_SHARES), json.dumps({k: [v[0], v[1]] for k, v in FACTORS.items()}),
             inspect.getsource(_ret), inspect.getsource(_vol), inspect.getsource(_near_high), inspect.getsource(_trend)]
    return hashlib.sha256('\n'.join(parts).encode()).hexdigest()[:16]


# ---------- statistics ----------
def _ranks(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    ranks = [0.0] * len(xs)
    i = 0
    while i < len(order):  # ties share their average rank
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2
        i = j + 1
    return ranks


def spearman(a, b):
    """Rank correlation of two equal-length lists (ties averaged); None when either is constant."""
    if len(a) < 3:
        return None
    ra, rb = _ranks(a), _ranks(b)
    ma, mb = statistics.fmean(ra), statistics.fmean(rb)
    cov = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    va, vb = sum((x - ma) ** 2 for x in ra), sum((y - mb) ** 2 for y in rb)
    return cov / math.sqrt(va * vb) if va and vb else None


def t_stat(xs):
    """Mean over its standard error. Monthly values overlap in no data (each is one month), so plain t is fair."""
    if len(xs) < 3:
        return None
    sd = statistics.stdev(xs)
    return statistics.fmean(xs) / (sd / math.sqrt(len(xs))) if sd else None


def t_p(t, n):
    """One-sided p-value of a t-statistic, by the normal approximation (fine for 36+ months)."""
    return None if t is None else 1 - statistics.NormalDist().cdf(t)


# ---------- the monthly panel ----------
def panel(all_bars, through=None, factors=FACTORS):
    """Per month: the basket's return, and for each factor its top and bottom quintile returns (top net of turnover cost),
    its IC and its top-quintile turnover. Shares join a month only with bars on the three dates the month trades on."""
    index = {s: {b['date']: i for i, b in enumerate(bars)} for s, bars in all_bars.items()}
    closes = {s: [b['closePaise'] for b in bars] for s, bars in all_bars.items()}
    opens = {s: [b['openPaise'] for b in bars] for s, bars in all_bars.items()}
    dates = sorted({d for idx in index.values() for d in idx})
    starts = [i for i in range(1, len(dates)) if dates[i][:7] != dates[i - 1][:7]]
    rows, held = [], {name: set() for name in factors}
    for a, b in zip(starts, starts[1:]):
        if b + 1 >= len(dates):
            break
        decide, enter, leave = dates[a], dates[a + 1], dates[b + 1]
        if through and decide[:7] > through:
            break
        ret, history = {}, {}
        for s, idx in index.items():
            if decide in idx and enter in idx and leave in idx:
                ret[s] = opens[s][idx[leave]] / opens[s][idx[enter]] - 1
                history[s] = closes[s][max(0, idx[decide] - LOOKBACK):idx[decide] + 1]  # the longest factor needs 254
        if len(ret) < MIN_SHARES:
            continue
        row = {'month': decide[:7], 'shares': len(ret), 'basketPct': 100 * statistics.fmean(ret.values()), 'factors': {}}
        for name, (_, need, score) in factors.items():
            scored = {s: score(history[s][-(need + 1):]) for s in ret if len(history[s]) >= need}
            scored = {s: v for s, v in scored.items() if v is not None and math.isfinite(v)}
            if len(scored) < MIN_SHARES:
                continue
            ranked = sorted(scored, key=lambda s: (scored[s], s))
            k = max(1, int(len(ranked) * QUINTILE))
            top, bottom = set(ranked[-k:]), set(ranked[:k])
            changed = len(top - held[name])
            turnover = 2 * changed / k  # sells plus buys, as a share of the portfolio
            held[name] = top
            top_pct = 100 * statistics.fmean(ret[s] for s in top) - ONE_WAY_COST_PCT * turnover
            names = sorted(scored)
            row['factors'][name] = {'topPct': top_pct, 'bottomPct': 100 * statistics.fmean(ret[s] for s in bottom),
                                    'ic': spearman([scored[s] for s in names], [ret[s] for s in names]), 'turnover': turnover,
                                    'eligible': len(scored)}
        rows.append(row)
    return rows


def judge(rows, factors=FACTORS):
    """Each factor's record over the months it was judged, against a Bonferroni bar over the whole catalogue."""
    threshold = ALPHA / len(factors)
    out = []
    series = {n: [r['factors'][n]['topPct'] - r['basketPct'] for r in rows if n in r['factors']] for n in factors}
    srs = [rc.per_period_sharpe(xs) for xs in series.values() if len(xs) >= 3]  # for the deflated Sharpe: every factor tried
    for name, (description, need, _) in factors.items():
        mine = [r for r in rows if name in r['factors']]
        if len(mine) < MIN_MONTHS:
            out.append({'name': name, 'description': description, 'months': len(mine), 'passes': False,
                        'reasons': [f'only {len(mine)} months judged (needs {MIN_MONTHS})']})
            continue
        excess = [r['factors'][name]['topPct'] - r['basketPct'] for r in mine]
        spread = [r['factors'][name]['topPct'] - r['factors'][name]['bottomPct'] for r in mine]
        ics = [r['factors'][name]['ic'] for r in mine if r['factors'][name]['ic'] is not None]
        ahead, behind = sum(e > 0 for e in excess), sum(e < 0 for e in excess)
        half = len(excess) // 2
        halves = [[sum(e > 0 for e in part), sum(e < 0 for e in part)] for part in (excess[:half], excess[half:])]
        ic_t = t_stat(ics)
        ic_p = t_p(ic_t, len(ics))
        p = sign_p(ahead, behind)
        months = [r['month'] for r in mine]
        robust = rc.robustness(months, excess, [r['factors'][name]['turnover'] for r in mine], ONE_WAY_COST_PCT)
        reasons = ([f'IC t={ic_t:.2f}: p={ic_p:.4f} is not below {threshold:.4f}'] if ic_p is None or ic_p >= threshold else []) \
            + ([f'top quintile ahead {ahead}/{behind} months: p={p:.4f} is not below {threshold:.4f}'] if p >= threshold else []) \
            + ([f'not ahead in both halves ({halves[0][0]}/{halves[0][1]}, {halves[1][0]}/{halves[1][1]})'] if any(x <= y for x, y in halves) else []) \
            + ([f'ahead of the basket in only {robust["yearsAheadOfBasket"]} of {robust["years"]} years'] if robust['years'] and robust['yearsAheadOfBasket'] * 2 <= robust['years'] else [])
        top_pct = [r['factors'][name]['topPct'] for r in mine]
        out.append({'name': name, 'description': description, 'months': len(mine), 'from': months[0], 'through': months[-1],
                    'averageShares': round(statistics.fmean(r['factors'][name]['eligible'] for r in mine)),
                    'ic': {'mean': round(statistics.fmean(ics), 4) if ics else None, 'tStat': round(ic_t, 2) if ic_t is not None else None,
                           'pValue': round(ic_p, 6) if ic_p is not None else None, 'positiveMonthsPct': round(100 * sum(x > 0 for x in ics) / len(ics), 1) if ics else None},
                    'topQuintile': {'averageExcessPct': round(statistics.fmean(excess), 3), 'ahead': ahead, 'behind': behind, 'pValue': round(p, 6),
                                    'halves': halves, 'turnoverPctPerMonth': round(100 * statistics.fmean(r['factors'][name]['turnover'] for r in mine[1:]), 1),
                                    'stats': rc.stats(top_pct, excess),
                                    'afterTaxCagrPct': rc.after_tax_cagr(top_pct, [0.0] + [r['factors'][name]['turnover'] for r in mine[1:]])},
                    'spread': {'averagePct': round(statistics.fmean(spread), 3), 'tStat': round(t_stat(spread), 2) if t_stat(spread) is not None else None},
                    'robustness': robust, 'deflatedSharpe': rc.deflated_sharpe(excess, srs),
                    'passes': not reasons, 'reasons': reasons})
    out.sort(key=lambda f: (f.get('ic', {}).get('pValue') if f.get('ic', {}).get('pValue') is not None else 2, f['name']))
    return out, threshold


def lab(cache=daily.BROAD, symbols=None, through=None):
    import datasets
    members = sorted(symbols or datasets.nifty500())
    loaded = daily.load(members, cache)
    if len(loaded) < MIN_SHARES:
        raise ValueError(f'Only {len(loaded)} shares have daily files in {cache}: fetch them first (daily.py fetch --universe nifty500)')
    rows = panel(loaded, through)
    if not rows:
        raise ValueError('Not enough overlapping history')
    factors, threshold = judge(rows)
    basket = [r['basketPct'] for r in rows]
    data = hashlib.sha256(json.dumps([[r['month'], r['shares'], round(r['basketPct'], 6)] for r in rows]).encode()).hexdigest()[:16]
    return {'version': VERSION, 'fingerprint': catalogue_fingerprint(), 'dataFingerprint': data, 'universe': 'nifty500',
            'sharesWithData': len(loaded), 'from': rows[0]['month'], 'through': rows[-1]['month'], 'months': len(rows),
            'factorsTried': len(FACTORS), 'bonferroniThreshold': round(threshold, 6), 'oneWayCostPct': ONE_WAY_COST_PCT,
            'basketStats': {**(rc.stats(basket, [0.0] * len(basket)) or {}), 'afterTaxCagrPct': rc.after_tax_cagr(basket)},
            'factors': factors,
            'warning': ('RESEARCH ONLY, never traded. Today\'s NIFTY 500 members over past years: companies that left the index '
                        'are missing (survivorship bias), which flatters momentum and trend most. Re-test any pass on '
                        'point-in-time membership (founder review B14) before relying on it.'),
            'at': datetime.now(timezone.utc).isoformat()}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--through', help='last month to judge (YYYY-MM)')
    args = parser.parse_args(argv)
    report = lab(through=args.through)
    OUT.mkdir(parents=True, exist_ok=True)
    batch.save(OUT / f"factor-lab-{report['through']}.json", report)
    print(json.dumps({k: report[k] for k in ('sharesWithData', 'from', 'through', 'months', 'factorsTried', 'bonferroniThreshold')}
                     | {'factors': [{'name': f['name'], 'passes': f['passes'], 'icMean': f.get('ic', {}).get('mean'), 'icT': f.get('ic', {}).get('tStat'),
                                     'topExcessPctPerMonth': f.get('topQuintile', {}).get('averageExcessPct'),
                                     'aheadBehind': [f.get('topQuintile', {}).get('ahead'), f.get('topQuintile', {}).get('behind')],
                                     'afterTaxCagrPct': f.get('topQuintile', {}).get('afterTaxCagrPct')} for f in report['factors']],
                        'basketAfterTaxCagrPct': report['basketStats'].get('afterTaxCagrPct'), 'warning': report['warning']}, indent=2))


if __name__ == '__main__':
    main()
