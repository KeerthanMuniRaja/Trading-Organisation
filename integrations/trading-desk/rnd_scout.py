"""R&D scout (RND-01): the research department's idea pipeline, so the organisation grows only where evidence shows skill.

Every run scores a fixed, pre-registered catalogue of monthly allocation rules for the desk's eight shares on the cached
daily data. Each month every rule's target weights (completed days only) are held to the next month-start. Its return,
net of a one-way cost on every unit of turnover, is compared with the equal-weight basket's. A candidate PASSES only if:
  - at least 20 months disagree with the basket (the sign test needs them);
  - it was ahead in significantly more months, at the Bonferroni level for the whole catalogue (0.05 / ideas tried),
    because picking the best of many rules on the same history finds lucky ones;
  - it was ahead in both halves of the history (one lucky stretch is not a skill).
Every candidate's result, losers included, is written to .local/trading-desk/rnd/scout-<through>.json, so the number of
ideas tried stays visible. All of this history has been seen: it screens ideas, it cannot prove them. Live paper
fitness after birth is the real test.

With --propose, a passing candidate that no bot serves yet goes through the organisation like any idea:
  1. the RESEARCHER reports its result as evidence (kind dataset) from the owner-approved research source;
  2. the EVALUATOR, a different identity, recomputes the catalogue itself and verifies the evidence only if the stored
     text matches its own result exactly (content-bound review), else rejects it;
  3. the RESEARCHER proposes the new specialist's birth with that verified evidence. The owner decides on the agenda.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\rnd_scout.py [--propose --department desk --source desk-research]
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import daily  # noqa: E402
import portfolio_daily as pd  # noqa: E402
from signal_scorer import principals  # noqa: E402

VERSION = 'rnd-catalog-v1'
OUT = daily.ROOT / '.local' / 'trading-desk' / 'rnd'
ONE_WAY_COST_PCT = 0.15   # brokerage, STT, charges and slippage on each unit of weight traded, one way
ALPHA = 0.05
MIN_MONTHS = 20
START = 260               # first decision day: 12-month momentum needs a year of history; every rule is judged on the same months


def low_volatility(table, dates, i, window=60, keep=3):
    """The three calmest shares by 60-day volatility, equal weights."""
    vols = {}
    for s in table:
        c = pd.closes(table, s, dates, i, window + 1)
        if len(c) <= window:
            return {}
        vols[s] = statistics.pstdev([math.log(c[k] / c[k - 1]) for k in range(1, len(c))])
    return {s: 1 / keep for s in sorted(vols, key=lambda s: (vols[s], s))[:keep]}


def reversal(table, dates, i, days=21, keep=3):
    """The three weakest shares over the last month, equal weights (short-term reversal)."""
    if i < days:
        return {}
    ranked = sorted(table, key=lambda s: (table[s][dates[i]]['closePaise'] / table[s][dates[i - days]]['closePaise'], s))
    return {s: 1 / keep for s in ranked[:keep]}


def catalogue():
    """name -> (description, specialty, method, rule, already served by). Fixed: changing it changes the fingerprint."""
    out = {}
    for months in (3, 6, 12):
        for keep in (2, 3, 4):
            out[f'momentum-{months}m-top{keep}'] = (f'The {keep} strongest shares over {months} months, equal weights, monthly',
                'momentum-allocation', f'top{keep}-momentum-{months}m',
                lambda t, d, i, m=months, k=keep: pd.top_momentum(t, d, i, months=m, keep=k),
                'momentum-rules' if (months, keep) == (6, 3) else None)
    out['inverse-volatility-60d'] = ('Weights inversely proportional to 60-day volatility, monthly', 'risk-allocation', 'inverse-volatility-60d',
                                     pd.inverse_volatility, None)
    out['trend-filter-200d'] = ('Equal weights while the universe is above its 200-day average, else cash', 'trend-allocation',
                                'equal-weight-trend-filter-200d', pd.trend_filtered, None)
    out['low-volatility-top3'] = ('The 3 calmest shares by 60-day volatility, equal weights, monthly', 'risk-allocation', 'low-volatility-top3',
                                  low_volatility, None)
    out['reversal-1m-bottom3'] = ('The 3 weakest shares over the last month, equal weights, monthly', 'reversal-allocation', 'reversal-1m-bottom3',
                                  reversal, None)
    # adopted 20 Oct 2026 from claude-trading-skills (MIT): trend template, pullback and the distribution-day regime
    import market_regime
    import rnd_ideas
    for name, spec in ADOPTED_SPECS.items():
        out[name] = (rnd_ideas.describe(spec), rnd_ideas.SPECIALTY[spec['family']], name, rnd_ideas.rule_of(spec), None)
    out['equal-weight-distribution'] = ('Equal weights while distribution-day risk is normal or cautious, else cash', 'trend-allocation',
                                        'equal-weight-distribution-days',
                                        lambda t, d, i: pd.equal_weight(t, d, i) if market_regime.calm(t, d, i) else {}, None)
    # added 21 Oct 2026: the regime's way back in (follow-through day, from claude-trading-skills, MIT)
    out['equal-weight-distribution-ftd'] = ('Equal weights while distribution-day risk is normal or cautious, or once a follow-through day '
                                            'has confirmed a new uptrend; else cash', 'trend-allocation', 'equal-weight-distribution-ftd',
                                            lambda t, d, i: pd.equal_weight(t, d, i) if market_regime.calm_or_followed_through(t, d, i) else {}, None)
    return out


ADOPTED_SPECS = {'trend-template-25pct-top3': {'family': 'trend-template', 'nearHighPct': 25, 'keep': 3},
                 'pullback-rsi40-top3': {'family': 'pullback', 'rsiMax': 40, 'keep': 3},
                 'momentum-6m-top3-distribution': {'family': 'momentum', 'months': 6, 'keep': 3, 'filter': 'distribution-days'},
                 # added 20 Oct 2026: weak signals combined (momentum, calm, consistency), as factor funds do
                 'combo-6m-60d-top3': {'family': 'combo', 'months': 6, 'window': 60, 'keep': 3},
                 # added 21 Oct 2026: the live bot's own rule, traded less often (less cost, tax deferred to the long-term rate)
                 'momentum-6m-top3-quarterly': {'family': 'momentum', 'months': 6, 'keep': 3, 'rebalance': 3},
                 'momentum-6m-top3-yearly': {'family': 'momentum', 'months': 6, 'keep': 3, 'rebalance': 12},
                 # added 21 Oct 2026: the distribution filter with the follow-through re-entry
                 'momentum-6m-top3-distribution-ftd': {'family': 'momentum', 'months': 6, 'keep': 3, 'filter': 'distribution-ftd'}}
# The catalogue ideas the idea grammar can express, so an invented duplicate of one is refused (RND-03)
CATALOGUE_SPECS = {**{f'momentum-{m}m-top{k}': {'family': 'momentum', 'months': m, 'keep': k} for m in (3, 6, 12) for k in (2, 3, 4)},
                   'low-volatility-top3': {'family': 'low-vol', 'window': 60, 'keep': 3}, 'reversal-1m-bottom3': {'family': 'reversal', 'days': 21, 'keep': 3},
                   **ADOPTED_SPECS}


def entries(ledger_path=None):
    """Every idea ever tried: the fixed catalogue, then the ledger of invented ideas (oldest first). name -> (description,
    specialty, method, rule, served by, spec, source)."""
    import rnd_ideas
    out = {name: (*e, CATALOGUE_SPECS.get(name), 'catalogue') for name, e in catalogue().items()}
    for idea in rnd_ideas.ledger(ledger_path or rnd_ideas.LEDGER):
        spec = rnd_ideas.canonical(idea['spec'])
        out.setdefault(idea['name'], (rnd_ideas.describe(spec), rnd_ideas.SPECIALTY[spec['family']], idea['name'][len('idea-'):],
                                      rnd_ideas.rule_of(spec), None, spec, 'ledger:' + idea['proposer']))
    return out


def fingerprint(ledger_path=None):
    import market_regime
    import rnd_ideas
    parts = [VERSION, str(ONE_WAY_COST_PCT), str(ALPHA), str(MIN_MONTHS), str(START), inspect.getsource(catalogue), json.dumps(ADOPTED_SPECS, sort_keys=True)]
    # the families' builders and the regime are part of what the adopted ideas do
    parts += [inspect.getsource(f) for f in (rnd_ideas._trend_template, rnd_ideas._pullback, rnd_ideas.rsi, rnd_ideas._combo, rnd_ideas._every, market_regime.distribution_days,
                                             market_regime.basket, market_regime.calm, market_regime.follow_through, market_regime.calm_or_followed_through)]
    parts += [inspect.getsource(f) for f in (pd.top_momentum, pd.inverse_volatility, pd.trend_filtered, low_volatility, reversal)]
    # the invented ideas are part of what was tried: the grammar's code and every idea in the ledger
    parts += [inspect.getsource(rnd_ideas.rule_of), *sorted(i['hash'] for i in rnd_ideas.ledger(ledger_path or rnd_ideas.LEDGER))]
    return hashlib.sha256('\n'.join(parts).encode()).hexdigest()[:16]


def sign_p(ahead, behind):
    """One-sided exact sign test: P(X >= ahead) for X ~ Binomial(ahead + behind, 1/2)."""
    n = ahead + behind
    if n == 0 or ahead <= behind:
        return 1.0
    return min(1.0, sum(math.comb(n, k) for k in range(ahead, n + 1)) / 2 ** n)


def monthly(table, dates, rules, through=None):
    """Per month: the basket's gross return and each rule's return net of turnover cost (percent).
    Timing (fixed 21 Oct 2026 after the backtesting.py/vectorbt review): a decision uses the month's first session, close
    included, so it trades at the NEXT session's open and is held to the open after the next month's first session, as the
    paper engine fills. Costs: turnover is measured against the holdings as they DRIFTED over the month, so rebalancing
    back to unchanged targets costs what it really would; a rule that rebalances only every few months (rnd_ideas._every,
    marked holdsBetween) does not trade while its decision is unchanged and lets its positions drift."""
    starts = [i for i in range(START, len(dates)) if dates[i][:7] != dates[i - 1][:7]]
    rows, held, previous = [], {name: {} for name in rules}, {name: None for name in rules}
    for a, b in zip(starts, starts[1:]):
        if b + 1 >= len(dates):
            break
        enter, leave = dates[a + 1], dates[b + 1]
        ret = {s: table[s][leave]['openPaise'] / table[s][enter]['openPaise'] - 1 for s in table}
        row = {'month': dates[a][:7], 'basketPct': 100 * sum(ret.values()) / len(ret), 'rules': {}, 'cash': {}, 'turnover': {}}
        for name, rule in rules.items():
            target = rule(table, dates, a)
            holds = getattr(rule, 'holdsBetween', False) and target == previous[name]
            weights = held[name] if holds else target
            turnover = 0.0 if holds else sum(abs(target.get(s, 0) - held[name].get(s, 0)) for s in table)
            row['rules'][name] = 100 * sum(w * ret[s] for s, w in weights.items()) - ONE_WAY_COST_PCT * turnover
            row['cash'][name] = max(0.0, 1 - sum(weights.values()))  # the uninvested share, which earns nothing here
            row['turnover'][name] = turnover
            # the holdings drift with the month's returns until the next decision
            value = sum(w * (1 + ret[s]) for s, w in weights.items()) + row['cash'][name]
            held[name] = {s: w * (1 + ret[s]) / value for s, w in weights.items() if w} if value > 0 else {}
            previous[name] = target
        rows.append(row)
    return [r for r in rows if through is None or r['month'] <= through]


RANDOM_RULES = 100   # random pickers of 3 shares a month: the baseline an edge has to beat (vectorbt)
BOOTSTRAP_SAMPLES = 5000  # risk-lens resamples; the pass rule also adds the p-value's own sampling error
CASH_YIELD_PCT = 6.0  # ASSUMED yearly yield on uninvested cash for the risk lens only (a liquid fund or T-bill; not sourced data)


def full_history(all_bars, slack_days=31):
    """Shares whose history starts with the earliest one (within a month); later listings or joiners are left out, so
    every rule is judged on the same months. Returns (kept bars, {left-out symbol: first date})."""
    if not all_bars:
        return {}, {}
    from datetime import date
    first = {s: b[0]['date'] for s, b in all_bars.items()}
    earliest = min(date.fromisoformat(d) for d in first.values())
    kept = {s: b for s, b in all_bars.items() if (date.fromisoformat(first[s]) - earliest).days <= slack_days}
    return kept, {s: d for s, d in first.items() if s not in kept}


def scout(through=None, cache=daily.DAILY, ledger_path=None, universe='desk', randoms=RANDOM_RULES):
    """Every idea's results, best first. `through` (YYYY-MM) limits the months, so a result can be recomputed later.
    universe 'nifty50' screens the research-only NIFTY 50 files (never traded; survivorship-biased)."""
    import research_checks as rc
    members = daily.datasets.UNIVERSE if universe == 'desk' else daily.datasets.NIFTY50
    loaded, excluded = full_history(daily.load(sorted(members), cache)) if universe != 'desk' else (daily.load(sorted(members), cache), {})
    dates, table = pd.aligned(loaded)
    tried = entries(ledger_path)
    rules = {name: e[3] for name, e in tried.items()}
    rows = monthly(table, dates, rules, through)
    if not rows:
        raise ValueError('Not enough daily history for the catalogue')
    last_index = max(i for i, d in enumerate(dates) if d[:7] <= rows[-1]['month'])
    checks = rc.check_rules(rules, table, dates, [i for i in rc.decision_days(dates, START) if i <= last_index])
    pickers = {f'random-{k}': rc.random_rule(k, 3) for k in range(randoms)}
    random_rows = monthly(table, dates, pickers, through) if randoms else []
    random_avg = sorted(statistics.fmean(r['rules'][n] - r['basketPct'] for r in random_rows) for n in pickers) if randoms else []
    # random pickers that re-pick every 3, 6 or 12 months: a slow rule is compared with equally slow luck (vectorbt review)
    matched = {}
    if randoms:
        per = max(10, randoms // 4)
        for every in (3, 6, 12):
            slow = {f'random-{every}-{k}': rc.random_rule(k, 3, every) for k in range(per)}
            slow_rows = monthly(table, dates, slow, through)
            matched[every] = {'turnoverPct': 100 * statistics.fmean(r['turnover'][n] for r in slow_rows[1:] for n in slow),
                              'averages': sorted(statistics.fmean(r['rules'][n] - r['basketPct'] for r in slow_rows) for n in slow)}
        matched[1] = {'turnoverPct': 100 * statistics.fmean(r['turnover'][n] for r in random_rows[1:] for n in pickers), 'averages': random_avg}
    data = hashlib.sha256(json.dumps([[r['month'], round(r['basketPct'], 6)] for r in rows]).encode()).hexdigest()[:16]
    threshold = ALPHA / len(tried)  # every idea ever tried, invented ones included
    half = len(rows) // 2
    months = [r['month'] for r in rows]
    trial_srs = [rc.per_period_sharpe([r['rules'][n] - r['basketPct'] for r in rows]) for n in tried]  # for the deflated Sharpe
    out = []
    for name, (description, specialty, method, _, served, spec, source) in tried.items():
        excess = [r['rules'][name] - r['basketPct'] for r in rows]
        ahead, behind = sum(e > 0 for e in excess), sum(e < 0 for e in excess)
        halves = [[sum(e > 0 for e in part), sum(e < 0 for e in part)] for part in (excess[:half], excess[half:])]
        p = sign_p(ahead, behind)
        lookahead = checks[name]['lookahead']
        reasons = ([f'only {ahead + behind} months differ from the basket'] if ahead + behind < MIN_MONTHS else []) \
            + ([f'p={p:.4f} is not below {threshold:.4f}'] if p >= threshold else []) \
            + ([f'not ahead in both halves ({halves[0][0]}/{halves[0][1]}, {halves[1][0]}/{halves[1][1]})'] if any(a <= b for a, b in halves) else []) \
            + ([f'lookahead bias: its decision on {lookahead[0]} changes when later days are removed'] if lookahead else [])
        average = sum(excess) / len(excess)
        rule_pct, basket_pct, cash = [r['rules'][name] for r in rows], [r['basketPct'] for r in rows], [r['cash'][name] for r in rows]
        mine, basket_stats = rc.stats(rule_pct, excess), rc.stats(basket_pct, [0.0] * len(rows))
        sharpe = rc.sharpe_test(rule_pct, basket_pct, samples=BOOTSTRAP_SAMPLES)
        at_yield = rc.stats(rc.with_cash_yield(rule_pct, cash, CASH_YIELD_PCT), excess)
        # RISK LENS (report only; the owner decides whether it may ever pass an idea): a better Sharpe than the basket at
        # the same Bonferroni bar, and a smaller worst fall
        risk_lens = {'sharpeTest': sharpe, 'worstFallPct': mine['maxDrawdownPct'], 'basketWorstFallPct': basket_stats['maxDrawdownPct'],
                     'averageCashPct': round(100 * statistics.fmean(cash), 1),
                     'atAssumedCashYield': {'yieldPct': CASH_YIELD_PCT, 'cagrPct': at_yield['cagrPct'], 'sharpe': at_yield['sharpe']},
                     # the bootstrap's own sampling error must not be what carries an idea over the bar
                     'wouldPassRiskBar': bool(sharpe and sharpe['pUpper'] < threshold and mine['maxDrawdownPct'] > basket_stats['maxDrawdownPct'])}
        # PROOF AND REAL COST: how long a record like this would take to prove at the bar, how much it trades, and what
        # it would keep after an approximate capital-gains tax
        turns = [r['turnover'][name] for r in rows]
        needed = rc.months_to_prove(excess, threshold)
        proof = {'monthsToProve': needed, 'yearsToProve': round(needed / 12, 1) if needed else None,
                 'turnoverPctPerMonth': round(100 * statistics.fmean(turns[1:] or turns), 1),
                 # the first month's turnover is the initial purchase, not a sale (fixed 21 Oct 2026)
                 'afterTaxCagrPct': rc.after_tax_cagr(rule_pct, [0.0] + turns[1:], long_term_sales=(spec or {}).get('rebalance', 1) >= 12)}
        out.append({'name': name, 'description': description, 'specialty': specialty, 'method': method, 'alreadyServedBy': served,
                    'months': len(rows), 'ahead': ahead, 'behind': behind, 'averageExcessPct': round(average, 3),
                    'pValue': round(p, 6), 'halves': halves, 'passes': not reasons, 'reasons': reasons, 'spec': spec, 'source': source,
                    'stats': mine, 'riskLens': risk_lens, 'proof': proof,
                    # LUCK: is the excess Sharpe real, and better than the best that selection among all ideas would give?
                    'luck': {'probabilisticSharpe': rc.probabilistic_sharpe(excess), 'deflatedSharpe': rc.deflated_sharpe(excess, trial_srs)},
                    'robustness': rc.robustness(months, excess, turns, ONE_WAY_COST_PCT),
                    'beatsMatchedRandomPct': (lambda m: rc.percentile(average, m['averages']) if m else None)(
                        min(matched.values(), key=lambda m: abs(m['turnoverPct'] - proof['turnoverPctPerMonth'])) if matched else None),
                    'beatsRandomPct': rc.percentile(average, random_avg), 'warmupSensitive': bool(checks[name]['warmup']),
                    'stableFromSessions': checks[name].get('stableFromSessions')})
    out.sort(key=lambda c: (c['pValue'], c['name']))
    last = rows[-1]['month']
    wf = rc.walk_forward(rows, list(tried))
    wf['pValue'] = round(sign_p(wf['ahead'], wf['behind']), 6)
    # the same choice made on all the history so far (expanding), so a bad result is not just a short window's fault
    wfx = rc.walk_forward(rows, list(tried), expanding=True)
    wfx['pValue'] = round(sign_p(wfx['ahead'], wfx['behind']), 6)
    report = {'version': VERSION, 'fingerprint': fingerprint(ledger_path), 'dataFingerprint': data, 'from': rows[0]['month'], 'through': last,
              'ideasTried': len(tried), 'bonferroniThreshold': round(threshold, 6), 'oneWayCostPct': ONE_WAY_COST_PCT,
              'publishedAt': f'{last}-28T10:30:00+00:00', 'candidates': out,
              'basketStats': {**rc.stats([r['basketPct'] for r in rows], [0.0] * len(rows)),
                              'afterTaxCagrPct': rc.after_tax_cagr([r['basketPct'] for r in rows])},
              'randomBaseline': {'rules': len(random_avg), 'keep': 3, 'medianExcessPct': round(statistics.median(random_avg), 3) if random_avg else None,
                                 'p90ExcessPct': round(random_avg[int(0.9 * (len(random_avg) - 1))], 3) if random_avg else None,
                                 'matchedByTurnover': {f'every{k}m': {'turnoverPctPerMonth': round(m['turnoverPct'], 1),
                                                                     'medianExcessPct': round(statistics.median(m['averages']), 3)}
                                                       for k, m in sorted(matched.items())}},
              'walkForward': wf, 'walkForwardExpanding': wfx,
              'note': 'Seen history, net of costs, against the equal-weight basket; a screen for ideas, not proof. Live paper fitness decides.'}
    if universe != 'desk':
        report.update({'universe': universe, 'shares': sorted(table), 'leftOut': excluded,
                       'warning': 'RESEARCH ONLY, never traded. Today\'s NIFTY 50 members over past years: survivorship bias flatters every rule.'})
    return report


def evidence_text(report, c):
    """The exact text the evaluator must be able to reproduce from its own run."""
    return (f"R&D scout {report['version']} (catalogue {report['fingerprint']}): candidate {c['name']}, {c['description']}. "
            f"Daily closes of the 8 NSE shares, months {report['from']}..{report['through']} (data {report['dataFingerprint']}), "
            f"net of {report['oneWayCostPct']}% per unit of turnover, against the equal-weight basket: {c['months']} months, "
            f"ahead {c['ahead']}, behind {c['behind']}, average excess {c['averageExcessPct']:+.3f}% a month. "
            f"Sign test p={c['pValue']:.6f}; {report['ideasTried']} ideas tried, Bonferroni threshold {report['bonferroniThreshold']:.6f}; "
            f"halves {c['halves'][0][0]}/{c['halves'][0][1]} and {c['halves'][1][0]}/{c['halves'][1][1]}. Seen history: a screen, not proof.")


def call(base, token, method, route, body=None, opener=None, prefix='rnd'):
    from urllib import request as urlrequest
    from urllib.error import HTTPError
    opener = opener or urlrequest.urlopen
    data = None if body is None else json.dumps(body, sort_keys=True)
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
    if method == 'POST':
        headers['Idempotency-Key'] = prefix + '-' + hashlib.sha256((route + (data or '')).encode()).hexdigest()[:60]
    req = urlrequest.Request(base + route, data=None if data is None else data.encode(), method=method, headers=headers)
    try:
        with opener(req, timeout=15) as response:
            return json.loads(response.read(2_000_000))
    except HTTPError as error:
        detail = error.read(2000).decode('utf-8', 'replace')
        error.close()
        raise RuntimeError(f'{route} refused (HTTP {error.code}): {detail[:200]}') from None


def propose(report, department, source, env=os.environ, opener=None, recompute=None):
    """Turns each passing, unserved candidate into verified evidence and a birth proposal. Returns what happened to each."""
    recompute = recompute or (lambda through: scout(through))
    base, researcher = principals(env, 'researcher')
    _, evaluator = principals(env, 'evaluator')
    bots = {b['id'] for b in call(base, researcher, 'GET', '/v1/bots', opener=opener)}
    proposed = {p['botId'] for p in call(base, researcher, 'GET', '/v1/bots/births', opener=opener)['proposals'] if p['status'] != 'rejected'}
    outcomes = []
    for c in report['candidates']:
        bot_id = 'rnd-' + c['name']
        if not c['passes']:
            continue
        if c['alreadyServedBy'] or bot_id in bots or bot_id in proposed:
            outcomes.append({'candidate': c['name'], 'outcome': 'already served', 'by': c['alreadyServedBy'] or bot_id})
            continue
        text = evidence_text(report, c)
        e = call(base, researcher, 'POST', '/v1/evidence', {'sourceId': source, 'kind': 'dataset', 'content': text,
                                                           'publishedAt': report['publishedAt']}, opener)
        if e.get('status') != 'verified':
            # the evaluator's own run: same catalogue, same months; anything different is not the evidence it verifies
            again = recompute(report['through'])
            mine = next((x for x in again['candidates'] if x['name'] == c['name']), None)
            ok = mine is not None and evidence_text(again, mine) == text
            call(base, evaluator, 'POST', '/v1/evidence/reviews', {'evidenceId': e['id'], 'status': 'verified' if ok else 'rejected',
                 'expected': {'content': text, 'sourceId': source, 'kind': 'dataset', 'publishedAt': report['publishedAt']}}, opener)
            if not ok:
                outcomes.append({'candidate': c['name'], 'outcome': 'evidence rejected: the evaluator could not reproduce it'})
                continue
        birth = call(base, researcher, 'POST', '/v1/bots/births/proposals', {
            'botId': bot_id, 'name': c['description'][:120], 'department': department, 'specialty': c['specialty'], 'method': c['method'],
            'contribution': f"Model-free {c['specialty']} member: {c['description']}.",
            'opportunity': (f"Ahead of the basket in {c['ahead']} of {c['ahead'] + c['behind']} differing months, net of costs "
                            f"(p={c['pValue']:.4f}, passing the Bonferroni level for {report['ideasTried']} ideas and in both halves)."),
            'successCriterion': 'Its live paper calls beat holding cash over at least 20 scored calls, and it stays ahead of the basket.',
            'evidenceIds': [e['id']]}, opener)
        outcomes.append({'candidate': c['name'], 'outcome': 'birth proposed', 'proposalId': birth['id'], 'botId': bot_id})
    return outcomes


def invent(how, through=None, cache=daily.DAILY, ledger_path=None, llm=None, now=None):
    """RND-03: R&D proposes new ideas into the ledger before the scout tests everything. 'model' asks the local model
    (schema-constrained to the idea grammar); 'explorer' proposes close variants of the three best ideas. Either way the
    ledger refuses duplicates and caps new ideas per month, and every idea raises the bar for all."""
    import rnd_ideas
    current = scout(through, cache, ledger_path)
    known = {rnd_ideas.spec_hash(s) for s in CATALOGUE_SPECS.values()}
    if how == 'explorer':
        specs, proposer = rnd_ideas.explore([c for c in current['candidates'] if c.get('spec')][:3]), 'explorer'
        reasons = {}
    else:
        if llm is None:
            sys.path.insert(0, str(daily.ROOT / 'integrations' / 'claims'))
            import claims
            llm, endpoint = claims.model_client(claims.local_settings(os.environ), 240)
            proposer = 'model:' + endpoint.model
        else:
            proposer = 'model:test'
        ideas = rnd_ideas.invent(llm, current['candidates'])
        specs, reasons = [i['spec'] for i in ideas], {json.dumps(i['spec'], sort_keys=True, default=str): i['why'] for i in ideas}
    outcomes = rnd_ideas.propose(specs, proposer, known, ledger_path or rnd_ideas.LEDGER, now)
    for o in outcomes:
        why = reasons.get(json.dumps(o['spec'], sort_keys=True, default=str))
        if why:
            o['why'] = why
    return outcomes


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--through', help='last month to use (YYYY-MM); default all cached months')
    parser.add_argument('--propose', action='store_true', help='turn passing candidates into evidence and birth proposals')
    parser.add_argument('--department', default=os.environ.get('RND_DEPARTMENT', 'desk'))
    parser.add_argument('--source', default=os.environ.get('RND_SOURCE', 'desk-research'))
    parser.add_argument('--invent', choices=['model', 'explorer'], help='first let R&D invent new ideas (RND-03): the local model, or close variants of the best')
    parser.add_argument('--universe', choices=['desk', 'nifty50'], default='desk', help='nifty50: research-only screen, never proposes')
    args = parser.parse_args(argv)
    if args.universe != 'desk':
        if args.propose or args.invent:
            raise SystemExit('The research universe only screens: no proposals or invented ideas from it')
        report = scout(args.through, daily.RESEARCH, universe=args.universe)
        OUT.mkdir(parents=True, exist_ok=True)
        batch.save(OUT / f"scout-{args.universe}-{report['through']}.json", report)
        print(json.dumps({'universe': args.universe, 'shares': len(report['shares']), 'leftOut': len(report['leftOut']), 'from': report['from'],
                          'through': report['through'], 'passing': [c['name'] for c in report['candidates'] if c['passes']],
                          'best': [{k: c[k] for k in ('name', 'ahead', 'behind', 'averageExcessPct', 'pValue', 'beatsRandomPct')} for c in report['candidates'][:5]],
                          'walkForward': {k: report['walkForward'][k] for k in ('outOfSampleMonths', 'ahead', 'behind', 'averageExcessPct', 'pValue')}}, indent=2))
        return
    invented = invent(args.invent, args.through) if args.invent else None
    report = scout(args.through)
    OUT.mkdir(parents=True, exist_ok=True)
    batch.save(OUT / f"scout-{report['through']}.json", report)
    passing = [c['name'] for c in report['candidates'] if c['passes']]
    summary = {'through': report['through'], 'ideasTried': report['ideasTried'], 'passing': passing,
               'best': [{k: c[k] for k in ('name', 'ahead', 'behind', 'pValue')} for c in report['candidates'][:3]]}
    if invented is not None:
        summary['invented'] = invented
    if args.propose and passing:
        summary['proposals'] = propose(report, args.department, args.source)
    summary['at'] = datetime.now(timezone.utc).isoformat()
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
