"""The organisation's own lessons (MENTOR-02): what its research has found, written as lessons its agents read, rebuilt
from fresh results every cycle, so the curriculum keeps growing without the mentor.

The mentor's lessons (mentor.py) are experience brought in from outside and checked on our data. These are the other half:
facts the organisation measured itself, from its latest research reports, each stated with its numbers and its limits:
  factor lab      for every factor of the broad universe: a lead (IC t-statistic of 2 or more), a reversed signal (-2 or
                  less), or no detectable signal; a factor that passes the lab's bar says so, and the survivorship caveat
                  stays on every one until point-in-time membership exists
  R&D scout       whether any idea on our 8 shares beats holding them after costs and tax, and by how much the best trails
Every lesson is regenerated from the newest report, so a lead that fades on new data fades from the lessons too. Like the
mentor's, they are background for reasoning, never evidence to cite, and never training targets.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\organisation_lessons.py
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import daily  # noqa: E402

RND = daily.ROOT / '.local' / 'trading-desk' / 'rnd'
OUT = daily.ROOT / '.local' / 'trading-desk' / 'knowledge' / 'organisation-lessons.json'
LEAD_T = 2.0
METHOD_OF = {'momentum': 'momentum', 'reversal': 'reversal', 'low-vol': 'low-vol', 'near-52w-high': 'trend', 'trend': 'trend'}


def _latest(pattern, root=RND):
    files = sorted(Path(root).glob(pattern))
    return json.loads(files[-1].read_text(encoding='utf-8')) if files else None


def _method(name):
    return next((m for prefix, m in METHOD_OF.items() if name.startswith(prefix)), None)


def from_factor_lab(report):
    if not report:
        return []
    caveat = 'today\'s NIFTY 500 members over past years (survivorship bias flatters momentum and trend)'
    span = f"{report['sharesWithData']} shares, {report['months']} months to {report['through']}"
    out, quiet = [], []
    for f in report['factors']:
        ic = f.get('ic') or {}
        t, top = ic.get('tStat'), f.get('topQuintile') or {}
        if t is None:
            continue
        numbers = (f"mean IC {ic['mean']} (t {t}), top fifth {top.get('averageExcessPct'):+}% a month against the universe, "
                   f"ahead {top.get('ahead')}/{top.get('behind')} months")
        method = _method(f['name'])
        applies = {'methods': [method]} if method else {'always': True}
        if f['passes']:
            out.append({'id': f'org-factor-{f["name"]}', 'title': f'Our factor lab found a pattern that passed: {f["name"]}',
                        'lesson': f"Across {span}, {f['description']} predicted next month's returns: {numbers}, past the lab's bar. "
                                  f"It is a candidate for a live test, not yet proof: {caveat}.", 'appliesTo': applies, 'measured': ic})
        elif t >= LEAD_T:
            out.append({'id': f'org-factor-{f["name"]}', 'title': f'A lead, not an edge: {f["name"]}',
                        'lesson': f"Across {span}, {f['description']} leaned the right way: {numbers}. It did not clear the lab's bar "
                                  f"for {report['factorsTried']} factors, and the data is {caveat}. Treat it as a weak tilt at most.",
                        'appliesTo': applies, 'measured': ic})
        elif t <= -LEAD_T:
            out.append({'id': f'org-factor-{f["name"]}', 'title': f'The opposite held: {f["name"]}',
                        'lesson': f"Across {span}, {f['description']} pointed the WRONG way: {numbers}. "
                                  f"Do not lean on it here; on Indian shares in this period the reverse did better.",
                        'appliesTo': applies, 'measured': ic})
        else:
            quiet.append(f['name'])
    if quiet:
        out.append({'id': 'org-factor-no-signal', 'title': 'Signals that showed nothing across 500 shares',
                    'lesson': f"Across {span}, these factors showed no detectable link with next month's returns (IC t between -2 and 2): "
                              f"{', '.join(quiet)}. An argument resting on them alone is resting on noise.",
                    'appliesTo': {'always': True}, 'measured': {'factors': quiet}})
    return out


def from_scout(report):
    if not report or not report.get('candidates'):
        return []
    basket = (report.get('basketStats') or {}).get('afterTaxCagrPct')
    taxed = [c for c in report['candidates'] if (c.get('proof') or {}).get('afterTaxCagrPct') is not None]
    best = max(taxed, key=lambda c: c['proof']['afterTaxCagrPct']) if taxed else None
    passing = [c['name'] for c in report['candidates'] if c.get('passes')]
    if passing:
        text = f"On our 8 shares, {len(passing)} of {report['ideasTried']} ideas passed the scout's bar: {', '.join(passing)}."
    else:
        text = (f"On our 8 shares, none of the {report['ideasTried']} ideas tried beats simply holding them, after the bar for luck."
                + (f" After costs and an approximate tax, the best ({best['name']}) keeps {best['proof']['afterTaxCagrPct']}% a year "
                   f"against the basket's {basket}%." if best and basket is not None else ''))
    return [{'id': 'org-scout-summary', 'title': 'What our R&D found on our own shares', 'lesson': text + ' Holding the basket is the default to beat.',
             'appliesTo': {'always': True}, 'measured': {'ideasTried': report['ideasTried'], 'passing': passing, 'basketAfterTaxCagrPct': basket}}]


def build(rnd=RND, out=OUT, now=None):
    lab = _latest('factor-lab-*.json', rnd)
    scout = _latest('scout-2*.json', rnd)  # the desk scout (scout-<month>), not the NIFTY 50 one (scout-nifty50-<month>)
    # the numbers are in the lesson itself; the evidence names the report they come from (the model reads every word)
    lessons = [{**l, 'status': 'checked', 'author': 'organisation', 'evidence': f"our factor lab, through {lab['through']}"} for l in from_factor_lab(lab)] \
        + [{**l, 'status': 'checked', 'author': 'organisation', 'evidence': f"our R&D scout, through {scout['through']}"} for l in from_scout(scout)]
    report = {'version': 1, 'generatedAt': (now or datetime.now(timezone.utc)).isoformat(),
              'sources': {'factorLab': lab and {'through': lab['through'], 'fingerprint': lab['fingerprint']},
                          'scout': scout and {'through': scout['through'], 'fingerprint': scout['fingerprint']}},
              'lessons': lessons,
              'note': 'Lessons the organisation measured itself, rebuilt from its newest research every cycle. Background, never evidence to cite, never training targets.'}
    batch.save(Path(out), report)
    return report


def main(argv=None):
    r = build()
    print(json.dumps({'state': 'done', 'lessons': len(r['lessons']), 'ids': [l['id'] for l in r['lessons']], 'sources': r['sources']}))


if __name__ == '__main__':
    main()
