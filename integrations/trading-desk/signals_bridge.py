"""Signals bridge: research bots' decisions become structured trade proposals in the backend (/v1/trading/signals).

Every decision then goes through the same deterministic risk review, sizing and outcome scoring, whichever model
made it, so a future model plugs in here unchanged.
  allocator  A monthly allocation becomes one proposal per share whose weight changed materially:
             raised by 3+ points -> enter-long with the new weight as targetWeightPct (the risk review never sizes
             beyond it) and conviction from that weight; cut to zero -> exit. Unchanged weights propose nothing.
             Horizon 30 days.
  meeting    A desk meeting becomes one proposal: buy -> enter-long, sell -> exit, hold -> an explicit no-action call.
             Conviction and invalidation come from the strongest analyst agreeing with the action. Horizon 1 day.
The allocator states no invalidation of its own, so the bridge writes a fixed, rule-derived one and says so.
Proposals must cite verified evidence (the backend refuses anything else) and expire within days, so only current
decisions (forward tests, the live paper desk) can be submitted; replays of past months are dry-run only.
Each proposal is sent with the credential bound to that bot (role trader or researcher, matching botId).
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\signals_bridge.py allocator --run ai-taught-forward-v1 --bot ORG_BOT_ID --evidence UUID --dry-run
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_allocator as ai  # noqa: E402
import daily  # noqa: E402
import desk  # noqa: E402

MIN_CHANGE = 3  # percentage points
RULE_INVALIDATION = ('Rule-derived (the allocator states none): the next monthly review cuts this weight, '
                     'or the price closes below its 200-day average.')


def iso(moment):
    return moment.astimezone(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def ticker(symbol):
    return symbol.removesuffix('.NS')


def allocator_conviction(weight):
    return 'high' if weight >= 18 else 'medium' if weight >= 12 else 'low'


def from_allocator(state, day, letters, bot_id, evidence_ids, now):
    """Proposals for one decided month, comparing it with the last valid month before it."""
    entry = state['months'][day]
    if entry['outcome'] != 'valid':
        return []
    earlier = [d for d in sorted(state['months']) if d < day and state['months'][d]['outcome'] == 'valid']
    old = state['months'][earlier[-1]]['weights'] if earlier else {k: 0 for k in ai.LETTERS}
    base = {'botId': bot_id, 'evidenceIds': list(evidence_ids), 'model': state['model'][:120], 'promptVersion': state['promptVersion'][:64]}
    out = []
    for letter in ai.LETTERS:
        new, before = entry['weights'][letter], old.get(letter, 0)
        symbol = ticker(letters[letter])
        if new - before >= MIN_CHANGE:
            out.append({**base, 'symbol': symbol, 'action': 'enter-long', 'horizonDays': 30, 'conviction': allocator_conviction(new),
                        'targetWeightPct': new,
                        'thesis': f'Monthly allocation raises {symbol} from {before}% to {new}%. {entry["rationale"]}'[:600],
                        'invalidation': RULE_INVALIDATION[:300], 'expiresAt': iso(now + timedelta(days=3))})
        elif new == 0 and before > 0:
            out.append({**base, 'symbol': symbol, 'action': 'exit', 'horizonDays': 30, 'conviction': 'medium',
                        'thesis': f'Monthly allocation cuts {symbol} from {before}% to 0%. {entry["rationale"]}'[:600],
                        'invalidation': f'Rule-derived: {symbol} recovers above its 200-day average with a positive 6-month return.'[:300],
                        'expiresAt': iso(now + timedelta(days=3))})
    return out


def from_meeting(record, symbol, bot_id, evidence_ids, now, model=None):
    """One desk meeting's decision as a proposal."""
    action = record.get('action', 'hold')
    manager = record['bots'].get('portfolio-manager', {})
    rationale = (manager.get('decision') or {}).get('rationale') or 'Desk decision'
    wanted = {'buy': 'bullish', 'sell': 'bearish'}.get(action)
    rank = {'low': 0, 'medium': 1, 'high': 2}
    agreeing = sorted((log['opinion'] for role, log in record['bots'].items()
                       if role in desk.ANALYSTS and log.get('outcome') == 'valid' and log['opinion']['stance'] == wanted),
                      key=lambda o: -rank[o['conviction']])
    proposal = {'botId': bot_id, 'symbol': ticker(symbol), 'horizonDays': 1, 'thesis': rationale[:600],
                'expiresAt': iso(now + timedelta(hours=6)), **({'model': model[:120]} if model else {})}
    if action == 'hold':
        return {**proposal, 'action': 'no-action', 'conviction': 'medium', 'evidenceIds': list(evidence_ids)}
    best = agreeing[0] if agreeing else None
    return {**proposal, 'action': 'enter-long' if action == 'buy' else 'exit', 'evidenceIds': list(evidence_ids),
            'conviction': best['conviction'] if best else 'low',
            'invalidation': (best['invalidation'] if best and best['invalidation'] != 'n/a' else 'The desk risk stop is hit.')[:300]}


def credential(env, bot_id):
    """API origin and the one credential bound to this bot (trader or researcher), from the environment or .env."""
    values = {k: env.get(k) for k in ('API_URL', 'PRINCIPALS_JSON')}
    path = daily.ROOT / '.env'
    if not all(values.values()) and path.exists():
        for line in path.read_text(encoding='utf-8').splitlines():
            key, _, value = line.partition('=')
            if key in values and not values[key]:
                values[key] = value.strip()
    base = (values['API_URL'] or 'http://127.0.0.1:3000').rstrip('/')
    if not re.match(r'^(https://[^/@?#]+|http://(127\.0\.0\.1|localhost)(:\d+)?)$', base):
        raise ValueError('Invalid backend API origin')
    bound = [p for p in json.loads(values['PRINCIPALS_JSON'] or '[]') if p.get('botId') == bot_id and p.get('role') in ('trader', 'researcher')]
    if len(bound) != 1 or not bound[0].get('token'):
        raise ValueError(f'Configure exactly one trader or researcher credential bound to bot {bot_id}')
    return base, bound[0]['token']


def submit(proposals, env, opener=None):
    """POST each proposal with the bot's own credential; content-derived idempotency keys make retries safe."""
    from urllib import request as urlrequest
    from urllib.error import HTTPError, URLError
    opener = opener or urlrequest.urlopen
    results = []
    for body in proposals:
        base, token = credential(env, body['botId'])
        data = json.dumps(body, sort_keys=True)
        req = urlrequest.Request(base + '/v1/trading/signals', data=data.encode(), method='POST', headers={
            'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
            'Idempotency-Key': 'signal-' + hashlib.sha256(data.encode()).hexdigest()[:64]})
        try:
            with opener(req, timeout=15) as response:
                results.append({**json.loads(response.read(65537)), 'symbol': body['symbol'], 'action': body['action']})
        except HTTPError as error:
            error.close()
            raise RuntimeError(f"Proposal for {body['symbol']} refused (HTTP {error.code})") from None
        except (URLError, OSError, ValueError):
            raise RuntimeError(f"Proposal for {body['symbol']} was not acknowledged; rerun to recover safely") from None
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    a = sub.add_parser('allocator')
    a.add_argument('--run', required=True)
    a.add_argument('--month', help='Decision day YYYY-MM-DD (default: the latest decided month)')
    a.add_argument('--bot', required=True, help='Organisation bot id the allocator runs as')
    a.add_argument('--evidence', action='append', required=True, help='Verified evidence id (repeatable)')
    a.add_argument('--dry-run', action='store_true', help='Print the proposals without sending them')
    args = parser.parse_args(argv)
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,60}', args.run):
        raise ValueError('Run: letters, digits, _ or -')
    state = json.loads((ai.RUNS / args.run / 'decisions.json').read_text(encoding='utf-8'))
    day = args.month or max(state['months'])
    if day not in state['months']:
        raise ValueError(f'No decision for {day} in {args.run}')
    proposals = from_allocator(state, day, ai.mapping(args.run, daily.datasets.UNIVERSE), args.bot, args.evidence, datetime.now(timezone.utc))
    if args.dry_run or not proposals:
        print(json.dumps(proposals, indent=2) if proposals else f'No material weight changes on {day}: nothing to propose')
        return
    for result in submit(proposals, os.environ):
        print(f"{result['action']:10s} {result['symbol']:10s} signal {result['id']}{' (already sent)' if result.get('duplicate') else ''}")


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
