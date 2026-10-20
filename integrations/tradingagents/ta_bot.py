"""TradingAgents member (TA-01): the governed side. Turns TradingAgents' decisions (ta_decide.py) into proposals of the bot
TA_BOT_ID, under exactly the rules every member lives by. Paper only; no model in this process.

  propose  For the newest decisions file (a settled session at most 4 days old), once per decided day:
             BUY -> enter-long, high conviction, target 25% of budget; OVERWEIGHT -> enter-long, medium, 15%;
             UNDERWEIGHT or SELL -> exit (a directional call, scored like any); HOLD -> nothing.
           The proposal cites verified price evidence of that session's closes (reported by the researcher, verified on an
           exact match by the evaluator); TradingAgents' own reasoning goes in the thesis as the model's opinion, not as evidence.
           Once the bot has a release, it proposes only while POST /v1/releases/check allows its exact identity.
  onboard  It EARNS its place: while it has no release it proposes in shadow (in school, with no budget the review rejects
           the trade but prices it, and the scorer scores it). After 20 scored shadow calls the researcher registers its
           release and the evaluator evaluates it on that live shadow record. Then the owner's standing approvals (or the
           agenda) activate, qualify and fund it, as for any bot.
  .local\\replay-venv\\Scripts\\python.exe integrations\\tradingagents\\ta_bot.py all --source market-yahoo-daily
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[0] / 'trading-desk'))
import daily  # noqa: E402
import eod_trader  # noqa: E402
import signal_scorer as sc  # noqa: E402

DECISIONS = daily.ROOT / '.local' / 'tradingagents' / 'decisions'
STATE = daily.ROOT / '.local' / 'tradingagents' / 'proposed.json'
SHADOW_CALLS_NEEDED = 20
HORIZON_DAYS, EXPIRY_DAYS, MAX_AGE_DAYS = 7, 3, 4
PLAN = {'BUY': ('enter-long', 'high', 25), 'OVERWEIGHT': ('enter-long', 'medium', 15), 'UNDERWEIGHT': ('exit', 'medium', None), 'SELL': ('exit', 'high', None)}


def identity(record):
    """The member's release identity: the engine and model (model), its settings (prompt version), and this code."""
    code = b''.join((HERE / f).read_bytes().replace(b'\r\n', b'\n') for f in ('ta_decide.py', 'ta_bot.py'))
    return {'model': f"tradingagents:{record.get('engineVersion', 'unknown')}:{record.get('model', 'unknown')}"[:120],
            'promptVersion': record['configVersion'], 'codeFingerprint': hashlib.sha256(code + record.get('engineVersion', '').encode()).hexdigest()}


def latest(decisions=DECISIONS, now=None):
    now = now or datetime.now(timezone.utc)
    files = sorted(decisions.glob('????-??-??.json')) if decisions.exists() else []
    if not files:
        return None
    record = json.loads(files[-1].read_text(encoding='utf-8'))
    return record if (now.date() - datetime.fromisoformat(record['day']).date()).days <= MAX_AGE_DAYS else None


def facts_text(record, cache):
    rows = []
    for symbol in sorted(record['decisions']):
        dataset = eod_trader.dataset_for(cache, symbol)
        bar = next((b for b in (dataset or {}).get('bars', []) if b['date'] == record['day']), None)
        if bar:
            rows.append(f"NSE:{symbol} {bar['closePaise']} paise")
    return (f"Daily closes of the tracked shares on {record['day']}, the session TradingAgents ({record.get('engine')} "
            f"{record.get('engineVersion')}) decided on: {'; '.join(rows)}. Source: Yahoo Finance via yfinance, adjusted daily closes "
            f"checked by the data steward.") if rows else None


def proposals(record, bot_id, evidence_id, now):
    ident, out = identity(record), []
    for symbol, d in sorted(record['decisions'].items()):
        if d.get('rating') not in PLAN:
            continue
        action, conviction, weight = PLAN[d['rating']]
        rationale = ' '.join((d.get('rationale') or '').split())[:420]
        p = {'botId': bot_id, 'symbol': symbol, 'action': action, 'horizonDays': HORIZON_DAYS, 'conviction': conviction,
             'thesis': f"TradingAgents rated NSE:{symbol} {d['rating']} for {record['day']} (model opinion, not evidence): {rationale}"[:600],
             'invalidation': f'A different TradingAgents rating for NSE:{symbol} next week, or the price moving against the call by the horizon.',
             'expiresAt': (now + timedelta(days=EXPIRY_DAYS)).isoformat().replace('+00:00', 'Z'), 'evidenceIds': [evidence_id],
             'model': ident['model'], 'promptVersion': ident['promptVersion']}
        if weight:
            p['targetWeightPct'] = weight
        out.append(p)
    return out


def call(base, token, method, route, body=None, opener=None):
    if method == 'POST':
        return sc.post(base, token, route, body, opener)
    from urllib import request as urlrequest
    req = urlrequest.Request(base + route, method='GET', headers={'Authorization': 'Bearer ' + token})
    with opener(req, timeout=15) as response:
        return json.loads(response.read(2_000_000))


def propose(source_id, env=os.environ, cache=daily.DAILY, opener=None, now=None, decisions=DECISIONS, state_path=STATE):
    from urllib import request as urlrequest
    opener = opener or urlrequest.urlopen
    now = now or datetime.now(timezone.utc)
    bot_id = env.get('TA_BOT_ID')
    if not bot_id:
        return {'state': 'not-configured', 'reason': 'no TradingAgents member configured (TA_BOT_ID)'}
    trader = eod_trader.bot_credential(env, bot_id)
    if not trader:
        return {'state': 'no-credential', 'next': f'owner: npm run bot-credential -- --bot {bot_id} --yes, then restart the backend'}
    record = latest(decisions, now)
    if record is None:
        return {'state': 'waiting', 'reason': 'no fresh TradingAgents decisions (run ta_decide.py with the model)'}
    state = json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else {}
    if record['day'] in state:
        return {'state': 'already-proposed', 'day': record['day']}
    ident = identity(record)
    evaluator = sc.principals(env, 'evaluator')
    view = call(*evaluator, 'POST', '/v1/releases/view', {'botId': bot_id}, opener)
    if view.get('releases'):  # under release control: only the exact authorised code and settings propose
        gate = call(*evaluator, 'POST', '/v1/releases/check', {'botId': bot_id, **ident}, opener)
        if not gate.get('allowed'):
            return {'state': 'not-authorised', 'reason': gate.get('reason')}
    planned = proposals(record, bot_id, 'pending', now)
    made = []
    if planned:
        text = facts_text(record, cache)
        if text is None:
            return {'state': 'waiting', 'reason': f"no closes for {record['day']} in the daily data yet"}
        published = sc.close_time(record['day']).isoformat().replace('+00:00', 'Z')
        evidence_id = eod_trader.evidence_for(text, published, source_id, sc.principals(env, 'researcher'), evaluator, opener)
        for p in proposals(record, bot_id, evidence_id, now):
            result = sc.post(*trader, '/v1/trading/signals', p, opener)
            made.append({'symbol': p['symbol'], 'action': p['action'], 'signalId': result['id']})
    state[record['day']] = {'at': now.isoformat(), 'proposals': made}
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state, indent=2), encoding='utf-8')
    return {'state': 'proposed', 'day': record['day'], 'shadow': not view.get('releases'), 'proposals': made}


def onboard(env=os.environ, opener=None, decisions=DECISIONS, now=None):
    """After enough scored shadow calls, register and evaluate the member's first release on its own live record."""
    from urllib import request as urlrequest
    opener = opener or urlrequest.urlopen
    bot_id = env.get('TA_BOT_ID')
    files = sorted(decisions.glob('????-??-??.json')) if decisions.exists() else []
    record = json.loads(files[-1].read_text(encoding='utf-8')) if files else None  # the identity it decided under most recently
    if not bot_id or not record:
        return {'state': 'nothing-to-onboard'}
    researcher, evaluator = sc.principals(env, 'researcher'), sc.principals(env, 'evaluator')
    if call(*evaluator, 'POST', '/v1/releases/view', {'botId': bot_id}, opener).get('releases'):
        return {'state': 'has-release'}
    ident = identity(record)
    signals = call(*evaluator, 'POST', '/v1/trading/signals/query', {'botId': bot_id, 'limit': 200}, opener)['signals']
    scored = [s for s in signals if s.get('outcome') and s.get('model') == ident['model'] and s['action'] in ('enter-long', 'exit')]
    if len(scored) < SHADOW_CALLS_NEEDED:
        return {'state': 'earning', 'scoredShadowCalls': len(scored), 'needed': SHADOW_CALLS_NEEDED}
    fitness = call(*evaluator, 'POST', '/v1/bots/fitness/live', {'botId': bot_id, 'model': ident['model']}, opener)
    release = call(*researcher, 'POST', '/v1/releases', {'botId': bot_id, **ident, 'settings': {},
                   'notes': 'TradingAgents (Tauric Research, Apache-2.0) as a governed member; evaluated on its own shadow calls'}, opener)
    evaluation = call(*evaluator, 'POST', '/v1/releases/evaluations', {'releaseId': release['id'], 'fitnessReportId': fitness['id']}, opener)
    return {'state': 'evaluated', 'scoredShadowCalls': len(scored), 'fitness': fitness.get('verdict'), 'activeEligible': evaluation.get('activeEligible'),
            'next': 'standing approvals or the owner agenda: activate, qualify and fund it'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('command', choices=['propose', 'onboard', 'all'])
    parser.add_argument('--source', default=os.environ.get('PRICE_EVIDENCE_SOURCE', 'market-yahoo-daily'))
    args = parser.parse_args(argv)
    out = {}
    if args.command in ('onboard', 'all'):
        out['onboard'] = onboard()
    if args.command in ('propose', 'all'):
        out['propose'] = propose(args.source)
    print(json.dumps(out, indent=2))


if __name__ == '__main__':
    main()
