"""R&D forward tests (RND-04): the way an idea can pass after the seen history stopped being able to tell.

The scout judges every idea on the same seen history, and every idea tried raises its bar (Bonferroni over all ideas,
p < 0.002 after 25). On eight shares nothing realistically clears that, and more searching only makes it stricter. A
forward test asks the honest question instead: registered today, does the idea beat the basket on months nobody has
seen yet?

  register  once a month, the best unserved idea of the latest scout report (ahead of the basket on average, not yet
            registered) is frozen with its rule's code fingerprint. Only months that start after registration count.
            At most one a month and at most MAX_LIVE running at once, so the family of forward tests stays small.
  judge     each run scores every registration on its judged months (the scout's own monthly timing and costs). The
            verdict comes only at HORIZON months: one-sided t of the monthly excess over the basket at least FORWARD_T
            (1% each, so MAX_LIVE tests together keep a 5% false-pass rate) and ahead on average.
  end       when the rule's code changes after registration (the test would no longer test what was registered). The idea
            may be registered again, on later months only. A verdict is written into the registration and is final.

A pass makes the idea eligible for a birth proposal on the owner's agenda; it never trades by itself, and live paper
fitness after birth is still the real test. No model, no network.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\rnd_forward.py
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
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
import rnd_scout  # noqa: E402

ROOT = rnd_scout.OUT / 'forward'
HORIZON = 24        # judged months before the verdict, fixed at registration
FORWARD_T = 2.5     # one-sided t at about 1% with 23 degrees of freedom
MAX_LIVE = 5        # forward tests running at once: 5 x 1% keeps the family's false-pass rate at 5%


def _next_month(month):
    y, m = int(month[:4]), int(month[5:])
    return f'{y + (m == 12)}-{m % 12 + 1:02d}'


def rule_fingerprint(name, entry):
    """What the registered idea does: the scout's shared code (timing, costs, every rule builder) and this idea's own
    spec or catalogue entry. Changing any of it ends the test."""
    spec = entry[5]
    own = json.dumps(spec, sort_keys=True, default=str) if spec else name
    return hashlib.sha256('\n'.join([rnd_scout.code_fingerprint(), name, own]).encode()).hexdigest()[:16]


def latest_scout(out=rnd_scout.OUT):
    """The newest desk scout report (the research-universe screens are never traded, so never registered)."""
    reports = sorted(p for p in Path(out).glob('scout-2*.json'))
    return json.loads(reports[-1].read_text(encoding='utf-8')) if reports else None


def registrations(root=ROOT):
    return [json.loads(p.read_text(encoding='utf-8')) for p in sorted(Path(root).glob('*.json'))]


def register_monthly(report, root=ROOT, now=None, ledger_path=None, finished=()):
    """At most one new registration a month, while fewer than MAX_LIVE run (`finished`: tests with a verdict or ended,
    whose slots are free). Returns what happened."""
    now = now or datetime.now(timezone.utc)
    month = now.strftime('%Y-%m')
    known = registrations(root)
    running = [r for r in known if r['name'] not in set(finished)]
    if any(r['registeredAt'][:7] == month for r in known):
        return {'outcome': 'already-this-month'}
    if len(running) >= MAX_LIVE:
        return {'outcome': 'full', 'reason': f'{MAX_LIVE} forward tests already running'}
    if report is None:
        return {'outcome': 'no-scout-report'}
    tried = rnd_scout.entries(ledger_path)
    # an idea is taken once it has a verdict, or while its test still tests today's code; a test a code change ended
    # leaves its idea free for a new registration, judged only on months after it
    taken = {r['idea'] for r in known if r.get('verdict') or (r['idea'] in tried and rule_fingerprint(r['idea'], tried[r['idea']]) == r['rules'])}
    pick = next((c for c in report['candidates'] if c['name'] in tried and c['name'] not in taken and not c.get('alreadyServedBy')
                 and c['averageExcessPct'] > 0), None)
    if pick is None:
        return {'outcome': 'no-candidate', 'reason': 'no unserved idea ahead of the basket on the seen history is left to register'}
    record = {'name': f"{month}-{pick['name']}", 'idea': pick['name'], 'description': pick['description'], 'registeredAt': now.isoformat(),
              'firstMonth': _next_month(month), 'rules': rule_fingerprint(pick['name'], tried[pick['name']]),
              'seen': {k: pick[k] for k in ('months', 'ahead', 'behind', 'averageExcessPct', 'pValue')} | {'through': report['through']},
              'criterion': {'months': HORIZON, 'tStatAtLeast': FORWARD_T, 'averageExcessPctAbove': 0},
              'note': (f'Pre-registered: from firstMonth, the idea against the equal-weight basket of the 8 shares, net of costs, with '
                       f'the scout\'s timing. After {HORIZON} judged months it passes only if the one-sided t of its monthly excess is '
                       f'at least {FORWARD_T} and it is ahead on average.')}
    Path(root).mkdir(parents=True, exist_ok=True)
    batch.save(Path(root) / f"{record['name']}.json", record)
    return {'outcome': 'registered', 'name': record['name'], 'firstMonth': record['firstMonth']}


def t_stat(xs):
    if len(xs) < 2:
        return None
    sd = statistics.stdev(xs)
    return None if sd == 0 else statistics.fmean(xs) / (sd / math.sqrt(len(xs)))


def judge(record, rows_for, ledger_path=None):
    """One registration's state: waiting, running, passed, failed or ended. `rows_for(name, rule)` gives the scout's
    monthly rows for one rule."""
    tried = rnd_scout.entries(ledger_path)
    base = {k: record[k] for k in ('name', 'idea', 'firstMonth')} | {'monthsNeeded': record['criterion']['months']}
    entry = tried.get(record['idea'])
    if entry is None or rule_fingerprint(record['idea'], entry) != record['rules']:
        return {**base, 'status': 'ended', 'reason': 'the rule changed after registration (or left the ledger): its slot is free'}
    rows = [r for r in rows_for(record['idea'], entry[3]) if r['month'] >= record['firstMonth']][:record['criterion']['months']]
    months = [{'month': r['month'], 'excessPct': round(r['rules'][record['idea']] - r['basketPct'], 3)} for r in rows]
    out = {**base, 'monthsJudged': len(months), 'months': months}
    if not months:
        return {**out, 'status': 'waiting', 'note': f"No month from {record['firstMonth']} has closed yet."}
    excess = [m['excessPct'] for m in months]
    t = t_stat(excess)
    out.update({'averageExcessPct': round(statistics.fmean(excess), 3), 'ahead': sum(e > 0 for e in excess),
                'behind': sum(e < 0 for e in excess), 'tStat': None if t is None else round(t, 2)})
    if len(months) < record['criterion']['months']:
        return {**out, 'status': 'running', 'note': 'Descriptive until the pre-registered horizon; a few months prove nothing.'}
    passes = t is not None and t >= record['criterion']['tStatAtLeast'] and out['averageExcessPct'] > 0
    return {**out, 'status': 'passed' if passes else 'failed',
            'note': 'The pre-registered verdict. A pass makes the idea eligible for a birth proposal to the owner, never a trade by itself.'}


def evidence_text(record, verdict):
    """The exact text the evaluator must reproduce from its own judgement of the same registration."""
    return (f"R&D forward test {record['name']} (rules {record['rules']}): idea {record['idea']}, {record['description']}. Registered "
            f"{record['registeredAt'][:10]} and judged only on the months from {record['firstMonth']}, net of costs, against the equal-weight "
            f"basket of the 8 shares: {verdict['monthsJudged']} months, ahead {verdict['ahead']}, behind {verdict['behind']}, average excess "
            f"{verdict['averageExcessPct']:+.3f}% a month, one-sided t {verdict['tStat']}. Pre-registered bar: t at least "
            f"{record['criterion']['tStatAtLeast']} and a positive average after {record['criterion']['months']} months. Passed.")


def propose(department, source, env=None, opener=None, root=ROOT, rows_for=None, ledger_path=None):
    """RND-05: a forward test that PASSED becomes a birth proposal on the owner's agenda, as rnd_scout.propose does for a
    seen-history pass: the researcher reports the verdict as evidence, the evaluator (another identity) judges the same
    registration itself and verifies the evidence only on an exact match, then the researcher proposes the birth."""
    env = env if env is not None else os.environ
    rows_for = rows_for or desk_rows()
    base, researcher = rnd_scout.principals(env, 'researcher')
    _, evaluator = rnd_scout.principals(env, 'evaluator')
    call = lambda token, method, route, body=None: rnd_scout.call(base, token, method, route, body, opener, prefix='rnd-forward')  # noqa: E731
    bots = {b['id'] for b in call(researcher, 'GET', '/v1/bots')}
    proposed = {p['botId'] for p in call(researcher, 'GET', '/v1/bots/births')['proposals'] if p['status'] != 'rejected'}
    tried = rnd_scout.entries(ledger_path)
    outcomes = []
    for record in registrations(root):
        verdict = judge(record, rows_for, ledger_path)
        if verdict['status'] != 'passed':
            continue
        bot_id = 'rnd-' + record['idea']
        if bot_id in bots or bot_id in proposed:
            outcomes.append({'idea': record['idea'], 'outcome': 'already served', 'by': bot_id})
            continue
        text = evidence_text(record, verdict)
        published = f"{verdict['months'][-1]['month']}-28T10:30:00+00:00"
        e = call(researcher, 'POST', '/v1/evidence', {'sourceId': source, 'kind': 'dataset', 'content': text, 'publishedAt': published})
        if e.get('status') != 'verified':
            again = judge(record, rows_for, ledger_path)  # the evaluator's own judgement of the same registration
            ok = again['status'] == 'passed' and evidence_text(record, again) == text
            call(evaluator, 'POST', '/v1/evidence/reviews', {'evidenceId': e['id'], 'status': 'verified' if ok else 'rejected',
                 'expected': {'content': text, 'sourceId': source, 'kind': 'dataset', 'publishedAt': published}})
            if not ok:
                outcomes.append({'idea': record['idea'], 'outcome': 'evidence rejected: the evaluator could not reproduce it'})
                continue
        description, specialty, method = tried[record['idea']][:3]
        birth = call(researcher, 'POST', '/v1/bots/births/proposals', {
            'botId': bot_id, 'name': description[:120], 'department': department, 'specialty': specialty, 'method': method,
            'contribution': f'Model-free {specialty} member: {description}.',
            'opportunity': (f"Passed its pre-registered forward test: {verdict['ahead']} of {verdict['monthsJudged']} later months ahead of the basket, "
                            f"{verdict['averageExcessPct']:+.3f}% a month, t {verdict['tStat']}.")[:600],
            'successCriterion': 'Its live paper calls beat holding cash over at least 20 scored calls, and it stays ahead of the basket.',
            'evidenceIds': [e['id']]})
        outcomes.append({'idea': record['idea'], 'outcome': 'birth proposed', 'proposalId': birth['id'], 'botId': bot_id})
    return outcomes


def desk_rows(cache=daily.DAILY):
    dates, table = pd.aligned(daily.load(sorted(daily.datasets.UNIVERSE), cache))
    return lambda name, rule: rnd_scout.monthly(table, dates, {name: rule})


def run(root=ROOT, cache=daily.DAILY, now=None, ledger_path=None, report=None, rows_for=None):
    """The daily step: judge every registration, then register this month's idea if a slot is free."""
    rows_for = rows_for or desk_rows(cache)
    records = registrations(root)
    judged = [judge(r, rows_for, ledger_path) for r in records]
    for record, j in zip(records, judged):
        if j['status'] in ('passed', 'failed') and not record.get('verdict'):  # final: no later code change undoes it
            batch.save(Path(root) / f"{record['name']}.json", record | {'verdict': {k: j.get(k) for k in (
                'status', 'monthsJudged', 'ahead', 'behind', 'averageExcessPct', 'tStat')} | {'at': (now or datetime.now(timezone.utc)).isoformat()}})
    finished = {j['name'] for j in judged if j['status'] in ('ended', 'passed', 'failed')}
    registered = register_monthly(report if report is not None else latest_scout(), root, now, ledger_path, finished)
    if registered['outcome'] == 'registered':
        record = json.loads((Path(root) / f"{registered['name']}.json").read_text(encoding='utf-8'))
        judged.append(judge(record, rows_for, ledger_path))
    summary = {'at': (now or datetime.now(timezone.utc)).isoformat(), 'registration': registered, 'tests': judged,
               'running': sum(j['status'] in ('waiting', 'running') for j in judged), 'maxLive': MAX_LIVE,
               'passed': [j['idea'] for j in judged if j['status'] == 'passed'],
               'note': 'Forward tests judge only months after registration; a pass is eligibility for the owner\'s agenda, not a trade.'}
    Path(root, 'reports').mkdir(parents=True, exist_ok=True)
    batch.save(Path(root) / 'reports' / 'latest.json', summary)
    return summary


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--propose', action='store_true', help='turn a passed forward test into verified evidence and a birth proposal (RND-05)')
    parser.add_argument('--department', default=os.environ.get('RND_DEPARTMENT', 'desk'))
    parser.add_argument('--source', default=os.environ.get('RND_SOURCE', 'desk-research'))
    args = parser.parse_args(argv)
    s = run()
    proposals = propose(args.department, args.source) if args.propose and s['passed'] else []
    print(json.dumps({'registration': s['registration'], 'running': s['running'], 'passed': s['passed'], 'proposals': proposals,
                      'tests': [{k: t.get(k) for k in ('name', 'status', 'monthsJudged', 'monthsNeeded', 'averageExcessPct', 'tStat')} for t in s['tests']]},
                     indent=2))


if __name__ == '__main__':
    main()
