"""R&D bots (RND-02): onboarding and the monthly runner for every bot born from the R&D scout. No model; paper only.

A bot whose birth the owner approved on the agenda is called rnd-<idea>, and runs the scout catalogue's rule for that idea.
  onboard  For each born rnd-* bot that has no release of its exact identity yet:
             - the RESEARCHER registers the release: model rules:<idea>, the rule's version and this code's fingerprint;
             - the EVALUATOR recomputes the scout and files the idea's screening record as a fitness report against the
               basket (seen data, net of costs);
             - the EVALUATOR evaluates the release on that report.
           The owner then activates the release, qualifies the bot and sets its budget, all on the agenda.
  run      For each rnd-* bot in paper with a trader credential bound to it, and only while POST /v1/releases/check
           allows its exact identity: once a month, the rule's target holdings from the steward-checked daily cache become
           evidence (reported by the researcher, verified on an exact match by the evaluator). The bot then proposes exits
           first, and entries once the exits have settled, like rule_bot.py. Proposals go through the same review, challenges,
           execution, scoring and fitness as any bot.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\rnd_bot.py all --source market-yahoo-daily
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily  # noqa: E402
import eod_trader  # noqa: E402
import portfolio_daily as pd  # noqa: E402
import rnd_scout  # noqa: E402
import rule_bot  # noqa: E402  (its helpers only; its own file is never changed by this)
import signal_scorer as sc  # noqa: E402

PREFIX = 'rnd-'
HORIZON_DAYS, EXPIRY_DAYS = 30, 7
STATE = daily.ROOT / '.local' / 'trading-desk' / 'rnd-bots'
HERE = Path(__file__).resolve().parent


def idea(bot_id):
    return bot_id[len(PREFIX):] if bot_id.startswith(PREFIX) else None


def identity(name):
    """The release identity of one R&D bot: its rule, the catalogue version, and the exact code that runs it."""
    code = b''.join((HERE / f).read_bytes().replace(b'\r\n', b'\n') for f in ('rnd_bot.py', 'rnd_scout.py', 'rnd_ideas.py', 'portfolio_daily.py'))
    return {'model': 'rules:' + name, 'promptVersion': hashlib.sha256(f'{name}|{rnd_scout.fingerprint()}'.encode()).hexdigest()[:16],
            'codeFingerprint': hashlib.sha256(code).hexdigest()}


def get(base, token, route, opener):
    return rnd_scout.call(base, token, 'GET', route, opener=opener)


def onboard(env=os.environ, opener=None, report=None, today=None):
    """Release, screening fitness and evaluation for every born R&D bot that lacks them. Idempotent."""
    base, researcher = sc.principals(env, 'researcher')
    _, evaluator = sc.principals(env, 'evaluator')
    entries = rnd_scout.entries()  # the fixed catalogue and every invented idea
    out = []
    for bot in get(base, researcher, '/v1/bots', opener):
        name = idea(bot['id'])
        if not name or bot['state'] == 'retired':
            continue
        if name not in entries:
            out.append({'botId': bot['id'], 'state': 'unknown-idea', 'note': 'not in the current catalogue; nothing registered'})
            continue
        ident = identity(name)
        release = rnd_scout.call(base, researcher, 'POST', '/v1/releases', {'botId': bot['id'], **ident,
                                 'notes': f"R&D rule {name}: {entries[name][0]} ({rnd_scout.VERSION})"}, opener, prefix='rndbot')
        view = rnd_scout.call(base, researcher, 'POST', '/v1/releases/view', {'botId': bot['id']}, opener, prefix='rndbot')
        mine = next((r for r in view['releases'] if r['id'] == release['id']), {})
        if mine.get('evaluations'):
            out.append({'botId': bot['id'], 'state': 'onboarded', 'releaseVersion': release['version'], 'stage': mine.get('stage')})
            continue
        report = report or rnd_scout.scout()
        c = next(x for x in report['candidates'] if x['name'] == name)
        last = date.fromisoformat(report['through'] + '-01').replace(day=28) + timedelta(days=4)
        fitness = rnd_scout.call(base, evaluator, 'POST', '/v1/bots/fitness', {
            'botId': bot['id'], 'role': 'allocator', 'baseline': 'equal-weight-basket', 'model': ident['model'],
            'testName': f"rnd-scout {report['version']} {report['from']}..{report['through']} net of costs (seen data)",
            'periodFrom': report['from'] + '-01', 'periodTo': (last - timedelta(days=last.day)).isoformat(),
            'judged': c['months'], 'wins': c['ahead'], 'losses': c['behind']}, opener, prefix='rndbot')
        evaluation = rnd_scout.call(base, evaluator, 'POST', '/v1/releases/evaluations', {'releaseId': release['id'], 'fitnessReportId': fitness['id']},
                                    opener, prefix='rndbot')
        out.append({'botId': bot['id'], 'state': 'evaluated', 'releaseVersion': release['version'], 'fitness': fitness['verdict'],
                    'activeEligible': evaluation['activeEligible'], 'next': 'owner: activate, qualify and budget it on the agenda'})
    return out


def targets(name, cache, now):
    """The rule's weights from settled daily closes, and the decision date. {} weights means hold cash."""
    datasets = {s: d for s in sorted(daily.datasets.UNIVERSE) if (d := eod_trader.dataset_for(cache, s.removesuffix('.NS')))}
    settled = {s: [b for b in d['bars'] if sc.close_time(b['date']) <= now - sc.SETTLE] for s, d in datasets.items()}
    dates, table = pd.aligned(settled)
    weights = rnd_scout.entries()[name][3](table, dates, len(dates) - 1) if dates else {}
    return {s.removesuffix('.NS'): round(w, 4) for s, w in weights.items() if w > 0}, (dates[-1] if dates else None)


def decision_text(name, weights, day, fingerprint):
    held = ', '.join(f'NSE:{s} {w * 100:.1f}%' for s, w in sorted(weights.items())) or 'cash only'
    return (f"R&D rule {name} ({rnd_scout.VERSION}, catalogue {rnd_scout.fingerprint()}) as of {day}: target weights {held}. "
            f"Source: Yahoo Finance via yfinance, adjusted daily closes checked by the data steward, combined dataset fingerprint {fingerprint}.")


def proposals(name, weights, holdings, bot_id, evidence_id, now):
    """Exits for holdings the rule no longer wants, then entries for targets not held."""
    ident = identity(name)
    base = {'botId': bot_id, 'horizonDays': HORIZON_DAYS, 'conviction': 'high', 'evidenceIds': [evidence_id], 'model': ident['model'],
            'promptVersion': ident['promptVersion'], 'expiresAt': (now + timedelta(days=EXPIRY_DAYS)).isoformat().replace('+00:00', 'Z')}
    out = [{**base, 'symbol': s, 'action': 'exit', 'thesis': f'No longer a target of rule {name} this month.',
            'invalidation': f'A target of rule {name} again at the next monthly decision.'} for s in sorted(holdings) if s not in weights]
    out += [{**base, 'symbol': s, 'action': 'enter-long', 'targetWeightPct': max(1, min(100, round(w * 100))),
             'thesis': f'Rule {name} targets {w * 100:.1f}% this month.', 'invalidation': f'Not a target of rule {name} at the next monthly decision.'}
            for s, w in sorted(weights.items()) if s not in holdings]
    return out


def run_bot(bot_id, source_id, env, cache, opener, now, state_dir):
    name = idea(bot_id)
    trader = eod_trader.bot_credential(env, bot_id)
    if not trader:
        return {'botId': bot_id, 'state': 'no-credential', 'next': f'owner: npm run bot-credential -- --bot {bot_id} --yes, then restart the backend'}
    ident = identity(name)
    gate = rnd_scout.call(*sc.principals(env, 'evaluator'), 'POST', '/v1/releases/check', {'botId': bot_id, **ident}, opener, prefix='rndbot')
    if not gate.get('allowed'):
        return {'botId': bot_id, 'state': 'not-authorised', 'reason': gate.get('reason')}
    month = now.strftime('%Y-%m')
    path = state_dir / f'{bot_id}-{month}.json'
    mine = [s for s in sc.post(*trader, '/v1/trading/signals/query', {'limit': 200}, opener)['signals']
            if s['createdAt'][:7] == month and s.get('model') == ident['model'] and s['botId'] == bot_id]
    holdings = rule_bot.held(trader, bot_id, opener)
    decision = json.loads(path.read_text(encoding='utf-8')) if path.exists() else None
    if decision is None:
        weights, day = targets(name, cache, now)
        if day is None:
            return {'botId': bot_id, 'state': 'waiting', 'reason': 'no settled history'}
        evidence_id = None
        if proposals(name, weights, holdings, bot_id, None, now):
            import data_steward
            datasets = {s: eod_trader.dataset_for(cache, s.removesuffix('.NS')) for s in sorted(daily.datasets.UNIVERSE)}
            fingerprint = hashlib.sha256('|'.join(f'{s}:{data_steward.fingerprint(d)}' for s, d in datasets.items() if d).encode()).hexdigest()[:16]
            published = sc.close_time(day).isoformat().replace('+00:00', 'Z')
            evidence_id = eod_trader.evidence_for(decision_text(name, weights, day, fingerprint), published, source_id,
                                                  sc.principals(env, 'researcher'), sc.principals(env, 'evaluator'), opener)
        decision = {'month': month, 'decidedAt': now.isoformat(), 'asOf': day, 'weights': weights, 'evidenceId': evidence_id}
        state_dir.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(decision, indent=2), encoding='utf-8')
    sent = {(s['action'], s['symbol']) for s in mine}
    plan = [p for p in proposals(name, decision['weights'], holdings, bot_id, decision['evidenceId'], now) if (p['action'], p['symbol']) not in sent]
    exits = [p for p in plan if p['action'] == 'exit']
    if not plan:
        return {'botId': bot_id, 'state': 'month-complete' if mine else 'nothing-to-change', 'month': month}
    if not exits and any(s['action'] == 'exit' and not rule_bot.settled(s) for s in mine):
        return {'botId': bot_id, 'state': 'waiting-for-exits', 'month': month}
    made = []
    for p in exits or plan:
        try:
            result = sc.post(*trader, '/v1/trading/signals', p, opener)
        except RuntimeError as error:
            if 'suspended' in str(error):
                return {'botId': bot_id, 'state': 'suspended', 'proposals': made}
            raise
        made.append({'action': p['action'], 'symbol': p['symbol'], 'signalId': result['id']})
    return {'botId': bot_id, 'state': 'proposed', 'month': month, 'proposals': made}


def run(source_id, env=os.environ, cache=daily.DAILY, opener=None, now=None, state_dir=STATE):
    """Runs every R&D bot in paper. One bot's failure is reported without stopping the others."""
    from urllib import request as urlrequest
    opener = opener or urlrequest.urlopen
    now = now or datetime.now(timezone.utc)
    base, researcher = sc.principals(env, 'researcher')
    out = []
    for bot in get(base, researcher, '/v1/bots', opener):
        if idea(bot['id']) and bot['state'] == 'paper':
            try:
                out.append(run_bot(bot['id'], source_id, env, cache, opener, now, state_dir))
            except (RuntimeError, ValueError) as error:
                out.append({'botId': bot['id'], 'state': 'failed', 'reason': str(error)[:300]})
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=['onboard', 'run', 'all'])
    parser.add_argument('--source', default=os.environ.get('PRICE_EVIDENCE_SOURCE', 'market-yahoo-daily'))
    args = parser.parse_args(argv)
    result = {}
    if args.command in ('onboard', 'all'):
        result['onboard'] = onboard()
    if args.command in ('run', 'all'):
        result['run'] = run(args.source)
    print(json.dumps(result, indent=2))
    if any(r.get('state') == 'failed' for r in result.get('run', [])):
        sys.exit(1)


if __name__ == '__main__':
    main()
