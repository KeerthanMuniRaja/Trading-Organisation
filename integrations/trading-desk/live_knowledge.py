"""Live knowledge (KNOW-05): what the organisation currently knows, refreshed every cycle, for the agents and the owner.

`refresh` gathers the newest evidence the desk produced, so method lessons never go stale:
  - research: the latest scout of the eight shares (ideas tried, passing, the best three with their statistics, the
    lowest-risk idea, the random baseline and the walk-forward verdict) and the NIFTY 50 research screen, if any;
  - regime: today's market regime and what its study says about later falls;
  - news links: how many driver links carry information; the scenario panel's shadow record.
It writes .local/trading-desk/knowledge/live.json. `briefing` is the short, bounded form given to model agents
(the debate desk, the scenario panel, R&D): today's regime and the lessons that bear on a trading decision.
Nothing here decides or trades; it only tells the agents what the evidence says.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\live_knowledge.py refresh
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import daily  # noqa: E402

DESK = daily.ROOT / '.local' / 'trading-desk'
OUT = DESK / 'knowledge' / 'live.json'
CARDS = Path(__file__).resolve().parent / 'knowledge' / 'methods.json'
DECISION_LESSONS = ('transaction-costs', 'tax-and-turnover', 'momentum', 'trend-filter', 'distribution-days', 'walk-forward', 'survivorship-bias')


def _read(path):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def _latest(pattern, root=DESK / 'rnd'):
    files = sorted(Path(root).glob(pattern)) if Path(root).exists() else []
    return _read(files[-1]) if files else None


def scout_summary(report):
    if not report:
        return None
    c = report['candidates']
    with_stats = [x for x in c if x.get('stats')]
    safest = min(with_stats, key=lambda x: -x['stats']['maxDrawdownPct'], default=None)
    pick = lambda x: {k: x.get(k) for k in ('name', 'ahead', 'behind', 'averageExcessPct', 'pValue', 'beatsRandomPct')} | (  # noqa: E731
        {'sharpe': x['stats']['sharpe'], 'maxDrawdownPct': x['stats']['maxDrawdownPct']} if x.get('stats') else {}) | (
        {'yearsToProve': x['proof']['yearsToProve'], 'afterTaxCagrPct': x['proof']['afterTaxCagrPct']} if x.get('proof') else {})
    taxed = [x for x in c if (x.get('proof') or {}).get('afterTaxCagrPct') is not None]
    best_after_tax = max(taxed, key=lambda x: x['proof']['afterTaxCagrPct'], default=None)
    wf = report.get('walkForward')
    return {'from': report['from'], 'through': report['through'], 'ideasTried': report['ideasTried'], 'bar': report['bonferroniThreshold'],
            'passing': [x['name'] for x in c if x['passes']], 'best': [pick(x) for x in c[:3]], 'lowestRisk': pick(safest) if safest else None,
            'basket': {k: (report.get('basketStats') or {}).get(k) for k in ('cagrPct', 'sharpe', 'maxDrawdownPct', 'afterTaxCagrPct')},
            'bestAfterTax': pick(best_after_tax) if best_after_tax else None,
            'randomMedianExcessPct': (report.get('randomBaseline') or {}).get('medianExcessPct'),
            'walkForward': {k: wf[k] for k in ('outOfSampleMonths', 'ahead', 'behind', 'averageExcessPct')} if wf else None,
            **({'warning': report['warning']} if report.get('warning') else {})}


def refresh(desk=DESK, now=None):
    regime, study = _read(desk / 'regime' / 'latest.json'), _read(desk / 'regime' / 'study.json')
    links = _read(desk / 'chains' / 'link-study.json')
    scenario = _read(desk / 'scenario' / 'record.json')
    desk_scout = _latest('scout-[0-9][0-9][0-9][0-9]-[0-9][0-9].json', desk / 'rnd')
    research = _latest('scout-nifty50-*.json', desk / 'rnd')
    live = {'generatedAt': (now or datetime.now(timezone.utc)).isoformat(),
            'research': scout_summary(desk_scout), 'researchNifty50': scout_summary(research),
            'regime': {**{k: regime.get(k) for k in ('date', 'risk', 'distributionDays', 'breadth200d', 'shares', 'aboveTrend200d', 'exposureCeilingPct', 'inputsComplete')},
                       'studyVerdict': (study or {}).get('verdict')} if regime else None,
            'newsLinks': {'drivers': len(links['drivers']), 'carrying': sorted(d for d, r in links['drivers'].items() if r['verdict'] == 'link-carries-information'),
                          'headlines': links['headlines']} if links else None,
            'scenarioPanel': {'calls': scenario['calls'], **{k: scenario['panel'][k] for k in ('right', 'wrong', 'verdict')}} if scenario else None,
            'note': 'Current evidence from the desk\'s own files; seen history describes, it does not prove.'}
    out = desk / 'knowledge' / 'live.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    batch.save(out, live)
    return live


STALE_DAYS = 5  # calendar days: a regime older than this (a long weekend plus a missed cycle) is not today's regime


def regime_state(r, today=None):
    """'fresh', 'stale' or 'incomplete' for a regime record: readers never present an old or partial regime as current."""
    from datetime import date
    if not r:
        return 'unknown'
    if r.get('inputsComplete') is False:
        return 'incomplete'
    age = ((today or date.today()) - date.fromisoformat(r['date'])).days
    return 'stale' if age > STALE_DAYS else 'fresh'


def briefing(desk=DESK, cards_path=CARDS, lessons=DECISION_LESSONS, today=None):
    """The bounded context for a model agent making or challenging a decision: today's regime and the decision lessons."""
    live = _read(desk / 'knowledge' / 'live.json') or {}
    cards = {c['id']: c for c in (_read(cards_path) or {}).get('cards', [])}
    r = live.get('regime')
    state = regime_state(r, today)
    if state == 'fresh':
        regime = (f"{r['risk']} on {r['date']}: {r['distributionDays']} distribution days, {r['breadth200d']}/{r['shares']} shares above "
                  f"their 200-day average; history says: {r['studyVerdict']}. Advice only.")
    elif state in ('stale', 'incomplete'):
        regime = f"unknown (the last regime, from {r['date']}, is {state}: do not rely on it)"
    else:
        regime = 'unknown'
    return {'marketRegime': regime, 'lessons': [cards[i]['lesson'] for i in lessons if i in cards]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=['refresh', 'briefing'])
    args = parser.parse_args(argv)
    if args.command == 'refresh':
        live = refresh()
        print(json.dumps({'state': 'done', 'research': bool(live['research']), 'regime': (live['regime'] or {}).get('risk')}))
    else:
        print(json.dumps(briefing(), indent=2))


if __name__ == '__main__':
    main()
