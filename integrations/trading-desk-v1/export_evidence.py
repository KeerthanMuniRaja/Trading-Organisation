"""Bring desk results into the organisation's governed knowledge: evidence first, lessons only after review.

prepare         Offline. Builds a bundle per finished batch window: factual evidence text plus each bot's own
                factual lessons. Nothing is sent.
submit-evidence Sends the bundle's evidence as UNVERIFIED evidence (researcher role). An independent evaluator
                must review it in the backend before it can support anything.
submit-lessons  After that review, proposes each mapped bot's lessons against the verified evidence. Every lesson
                is again unverified until independently reviewed. The backend itself refuses unverified support.

Retries reuse content-derived idempotency keys, so a lost response never creates duplicates.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import desk  # noqa: E402
import learning  # noqa: E402

EXPORTS = desk.ROOT / '.local' / 'trading-desk' / 'exports'
IDENTIFIER = re.compile(r'^[a-zA-Z0-9_-]{1,80}$')


def evidence_text(row):
    s = row['scorecards']
    m = s.get('portfolioManager', {})
    lines = [f"Trading-desk paper replay, NSE:RELIANCE 5-minute bars {row['from']} to {row['to']} ({row['bars']} bars).",
             f"Desk version {row['deskVersion']}, model {row['model']}, meeting every {row['every']} bars, {row['decisionPoints']} meetings.",
             f"Desk net after modelled costs: {row['deskNetPaise']} paise over {row['deskTrades']} fills.",
             f"Baselines on identical bars and costs: momentum {row['momentumNetPaise']} paise ({row['momentumTrades']} fills), "
             f"one-share buy-and-hold {row['buyAndHoldPaise']} paise, cash 0.",
             f"Manager decisions {m.get('decisions')}: matched the next-hour best action {m.get('correct')}; "
             f"always-hold would have matched {m.get('alwaysHoldCorrect')}; actions {json.dumps(m.get('actions', {}), sort_keys=True)}."]
    for role, card in s['analysts'].items():
        lines.append(f"{role}: {card['correct']} of {card['opinions']} stances matched the next-hour move beyond 30 bps.")
    lines.append('Limits: one symbol, one week, illustrative costs, simulated fills at next-bar open; not a qualification.')
    return '\n'.join(lines)


def bundle_for(row, decisions, source_id):
    if not IDENTIFIER.match(source_id):
        raise ValueError('Invalid source id')
    bars = json.loads(Path(row['path']).read_text(encoding='utf-8'))['bars']
    content = evidence_text(row)
    period = f"{row['from'][:10]} to {row['to'][:10]}"
    lessons = {role: '\n'.join(lines) for role, lines in
               learning.lessons(learning.experience([(bars, decisions)], row['every']), period).items()}
    # Published at the last bar: the evidence describes data that existed by then, never later.
    published = bars[-1]['time']
    if len(content) > 4000 or any(len(text) > 4000 for text in lessons.values()):
        raise ValueError('Bundle exceeds backend text limits')
    return {'schemaVersion': 1, 'datasetKey': row['datasetKey'], 'deskVersion': row['deskVersion'], 'model': row['model'],
            'evidence': {'sourceId': source_id, 'kind': 'dataset', 'content': content, 'publishedAt': published},
            'lessons': lessons, 'reviewRequired': True}


def prepare(batch_name, source_id, out=EXPORTS, batches=None):
    if not IDENTIFIER.match(batch_name):
        raise ValueError('Invalid batch name')
    directory = (batches or desk.ROOT / '.local' / 'trading-desk' / 'batches') / batch_name
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for path in sorted(directory.glob('*.json')):
        if path.name == 'summary.json' or path.name.endswith('.decisions.json') or path.name in ('lessons.json', 'comparison.json'):
            continue
        row = json.loads(path.read_text(encoding='utf-8'))
        decisions = json.loads((directory / f"{row['datasetKey']}.decisions.json").read_text(encoding='utf-8'))
        bundle = bundle_for(row, decisions, source_id)
        digest = hashlib.sha256(json.dumps(bundle, sort_keys=True).encode()).hexdigest()[:16]
        target = out / f'{batch_name}-{row["datasetKey"]}-{digest}.json'
        if not target.exists():
            batch.save(target, bundle)
        written.append(str(target))
    return written


def backend(env):
    """API origin and the single researcher credential, from the environment or the private .env."""
    values = {k: env.get(k) for k in ('API_URL', 'PRINCIPALS_JSON')}
    path = desk.ROOT / '.env'
    if not all(values.values()) and path.exists():
        for line in path.read_text(encoding='utf-8').splitlines():
            key, _, value = line.partition('=')
            if key in values and not values[key]:
                values[key] = value.strip()
    base = (values['API_URL'] or 'http://127.0.0.1:3000').rstrip('/')
    if not re.match(r'^(https://[^/@?#]+|http://(127\.0\.0\.1|localhost)(:\d+)?)$', base):
        raise ValueError('Invalid backend API origin')
    researchers = [p for p in json.loads(values['PRINCIPALS_JSON'] or '[]') if p.get('role') == 'researcher']
    if len(researchers) != 1 or not researchers[0].get('token'):
        raise ValueError('Configure exactly one researcher credential')
    return base, researchers[0]['token']


def post(base, token, route, body, opener=urlrequest.urlopen):
    key = 'desk-' + hashlib.sha256((route + json.dumps(body, sort_keys=True)).encode()).hexdigest()[:64]
    req = urlrequest.Request(base + route, data=json.dumps(body).encode(), method='POST',
                             headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': key})
    try:
        with opener(req, timeout=15) as response:
            result = json.loads(response.read(65537))
    except HTTPError as error:
        error.close()
        raise RuntimeError(f'{route} refused (HTTP {error.code}); review backend state, then rerun the same command') from None
    except (URLError, OSError, ValueError):
        raise RuntimeError(f'{route} was not acknowledged; rerun the same command to recover safely') from None
    if not isinstance(result.get('id'), str):
        raise RuntimeError(f'{route} returned an invalid acknowledgement')
    return result


def receipt_path(bundle_path):
    return Path(str(bundle_path).replace('.json', '.receipt.json'))


def submit_evidence(bundle_path, env=os.environ, opener=urlrequest.urlopen):
    bundle = json.loads(Path(bundle_path).read_text(encoding='utf-8'))
    base, token = backend(env)
    result = post(base, token, '/v1/evidence', bundle['evidence'], opener)
    receipt = {'evidenceId': result['id'], 'status': result.get('status'), 'lessons': {}}
    batch.save(receipt_path(bundle_path), receipt)
    return {**receipt, 'next': 'An independent evaluator must verify this evidence before lessons can be proposed.'}


def submit_lessons(bundle_path, mapping, env=os.environ, opener=urlrequest.urlopen):
    bundle = json.loads(Path(bundle_path).read_text(encoding='utf-8'))
    path = receipt_path(bundle_path)
    if not path.exists():
        raise ValueError('Submit and independently verify the evidence first')
    receipt = json.loads(path.read_text(encoding='utf-8'))
    if any(role not in bundle['lessons'] or not IDENTIFIER.match(bot) for role, bot in mapping.items()):
        raise ValueError('Map desk roles to existing organisation bot ids')
    base, token = backend(env)
    for role, bot in mapping.items():
        result = post(base, token, '/v1/lessons', {'botId': bot, 'content': bundle['lessons'][role], 'evidenceId': receipt['evidenceId']}, opener)
        receipt['lessons'][role] = {'botId': bot, 'lessonId': result['id'], 'status': result.get('status')}
        batch.save(path, receipt)
    return {**receipt, 'next': 'Each lesson is unverified until an independent evaluator reviews it.'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare'); p.add_argument('--batch', required=True); p.add_argument('--source-id', required=True)
    e = sub.add_parser('submit-evidence'); e.add_argument('bundle', type=Path)
    lsn = sub.add_parser('submit-lessons'); lsn.add_argument('bundle', type=Path)
    lsn.add_argument('--bot', action='append', required=True, help='role=organisationBotId, e.g. trend-analyst=desk-trend')
    args = parser.parse_args(argv)
    if args.command == 'prepare':
        print(json.dumps(prepare(args.batch, args.source_id), indent=2))
    elif args.command == 'submit-evidence':
        print(json.dumps(submit_evidence(args.bundle), indent=2))
    else:
        mapping = dict(item.split('=', 1) for item in args.bot if '=' in item)
        print(json.dumps(submit_lessons(args.bundle, mapping), indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
