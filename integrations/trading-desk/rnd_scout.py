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
    return out


def fingerprint():
    parts = [VERSION, str(ONE_WAY_COST_PCT), str(ALPHA), str(MIN_MONTHS), str(START), inspect.getsource(catalogue)]
    parts += [inspect.getsource(f) for f in (pd.top_momentum, pd.inverse_volatility, pd.trend_filtered, low_volatility, reversal)]
    return hashlib.sha256('\n'.join(parts).encode()).hexdigest()[:16]


def sign_p(ahead, behind):
    """One-sided exact sign test: P(X >= ahead) for X ~ Binomial(ahead + behind, 1/2)."""
    n = ahead + behind
    if n == 0 or ahead <= behind:
        return 1.0
    return min(1.0, sum(math.comb(n, k) for k in range(ahead, n + 1)) / 2 ** n)


def monthly(table, dates, rules, through=None):
    """Per month: the basket's gross return and each rule's return net of turnover cost (percent)."""
    starts = [i for i in range(START, len(dates)) if dates[i][:7] != dates[i - 1][:7]]
    rows, held = [], {name: {} for name in rules}
    for a, b in zip(starts, starts[1:]):
        ret = {s: table[s][dates[b]]['closePaise'] / table[s][dates[a]]['closePaise'] - 1 for s in table}
        row = {'month': dates[a][:7], 'basketPct': 100 * sum(ret.values()) / len(ret), 'rules': {}}
        for name, rule in rules.items():
            weights = rule(table, dates, a)
            turnover = sum(abs(weights.get(s, 0) - held[name].get(s, 0)) for s in table)
            held[name] = weights
            row['rules'][name] = 100 * sum(w * ret[s] for s, w in weights.items()) - ONE_WAY_COST_PCT * turnover
        rows.append(row)
    return [r for r in rows if through is None or r['month'] <= through]


def scout(through=None, cache=daily.DAILY):
    """The catalogue's results, best first. `through` (YYYY-MM) limits the months, so a result can be recomputed later."""
    dates, table = pd.aligned(daily.load(sorted(daily.datasets.UNIVERSE), cache))
    entries = catalogue()
    rows = monthly(table, dates, {name: e[3] for name, e in entries.items()}, through)
    if not rows:
        raise ValueError('Not enough daily history for the catalogue')
    data = hashlib.sha256(json.dumps([[r['month'], round(r['basketPct'], 6)] for r in rows]).encode()).hexdigest()[:16]
    threshold = ALPHA / len(entries)
    half = len(rows) // 2
    out = []
    for name, (description, specialty, method, _, served) in entries.items():
        excess = [r['rules'][name] - r['basketPct'] for r in rows]
        ahead, behind = sum(e > 0 for e in excess), sum(e < 0 for e in excess)
        halves = [[sum(e > 0 for e in part), sum(e < 0 for e in part)] for part in (excess[:half], excess[half:])]
        p = sign_p(ahead, behind)
        reasons = ([f'only {ahead + behind} months differ from the basket'] if ahead + behind < MIN_MONTHS else []) \
            + ([f'p={p:.4f} is not below {threshold:.4f}'] if p >= threshold else []) \
            + ([f'not ahead in both halves ({halves[0][0]}/{halves[0][1]}, {halves[1][0]}/{halves[1][1]})'] if any(a <= b for a, b in halves) else [])
        out.append({'name': name, 'description': description, 'specialty': specialty, 'method': method, 'alreadyServedBy': served,
                    'months': len(rows), 'ahead': ahead, 'behind': behind, 'averageExcessPct': round(sum(excess) / len(excess), 3),
                    'pValue': round(p, 6), 'halves': halves, 'passes': not reasons, 'reasons': reasons})
    out.sort(key=lambda c: (c['pValue'], c['name']))
    last = rows[-1]['month']
    return {'version': VERSION, 'fingerprint': fingerprint(), 'dataFingerprint': data, 'from': rows[0]['month'], 'through': last,
            'ideasTried': len(entries), 'bonferroniThreshold': round(threshold, 6), 'oneWayCostPct': ONE_WAY_COST_PCT,
            'publishedAt': f'{last}-28T10:30:00+00:00', 'candidates': out,
            'note': 'Seen history, net of costs, against the equal-weight basket; a screen for ideas, not proof. Live paper fitness decides.'}


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


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--through', help='last month to use (YYYY-MM); default all cached months')
    parser.add_argument('--propose', action='store_true', help='turn passing candidates into evidence and birth proposals')
    parser.add_argument('--department', default=os.environ.get('RND_DEPARTMENT', 'desk'))
    parser.add_argument('--source', default=os.environ.get('RND_SOURCE', 'desk-research'))
    args = parser.parse_args(argv)
    report = scout(args.through)
    OUT.mkdir(parents=True, exist_ok=True)
    batch.save(OUT / f"scout-{report['through']}.json", report)
    passing = [c['name'] for c in report['candidates'] if c['passes']]
    summary = {'through': report['through'], 'ideasTried': report['ideasTried'], 'passing': passing,
               'best': [{k: c[k] for k in ('name', 'ahead', 'behind', 'pValue')} for c in report['candidates'][:3]]}
    if args.propose and passing:
        summary['proposals'] = propose(report, args.department, args.source)
    summary['at'] = datetime.now(timezone.utc).isoformat()
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
