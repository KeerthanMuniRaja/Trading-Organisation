"""Automatic knowledge: news snapshots become verified bot lessons with no human in the loop. Research only.

Two independent bots share only data files; each step runs as its own child process holding only its own credential.
  Claim analyst  (researcher credential + local model)  drafts claims, then proposes lessons for recipient bots.
  Fact-checker   (evaluator credential, no model)       decides by fixed rules, never by model judgement:
     - re-checks every claim's quote against its own copy of the snapshot, and recomputes corroboration itself;
     - verifies evidence only when a re-checked claim is corroborated by independent origins reporting the same fact
       (metric and period, the backend's fact-key rule), or comes from an owner-designated primary source, and nothing
       contradicts it (a disagreeing figure for the same fact); holds it while it waits for corroboration;
       rejects it when it has no checkable claim or stays uncorroborated past the hold period;
     - verifies a lesson only when its text equals the template the rules produce from re-checked claims, then
       reads the stored lesson back and revokes the evidence if anything differs;
     - revokes previously verified evidence when later reports contradict it.
The backend independently enforces that no author reviews its own evidence or lesson, that lessons need verified
evidence, and that sources are approved. "Verified" here means quote-checked and corroborated, not proven true.
Sessions are owner-started and finite (--cycles). Nothing here touches money, trading authority or policies.
Run with any project Python environment, e.g.:
  .local\\replay-venv\\Scripts\\python.exe integrations\\claims\\autolearn.py run --config .local\\claims\\autolearn.json --cycles 1
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parent))
import claims  # noqa: E402
import headline_receipt

STATE = claims.ROOT / '.local' / 'claims' / 'auto'
STEPS = {'factcheck-queue': 'evaluator', 'analyst-extract': 'researcher', 'factcheck-evidence': 'evaluator',
         'analyst-lessons': 'researcher', 'factcheck-lessons': 'evaluator'}
BOT_ID = re.compile(r'^[a-zA-Z0-9_-]{1,80}$')


# ---------- owner configuration ----------
def load_config(path):
    value = json.loads(Path(path).read_text(encoding='utf-8'))
    allowed = {'recipientBotIds', 'primarySourceIds', 'holdDays', 'maxModelCallsPerCycle', 'looseCorroborationVerifies', 'analystBotId'}
    if not isinstance(value, dict) or set(value) - allowed or 'recipientBotIds' not in value:
        raise ValueError(f'Config keys: {sorted(allowed)}; recipientBotIds is required')
    config = {'recipientBotIds': value['recipientBotIds'], 'primarySourceIds': value.get('primarySourceIds', []),
              'holdDays': value.get('holdDays', 7), 'maxModelCallsPerCycle': value.get('maxModelCallsPerCycle', 20)}
    # optional: the bot that stands for the claim analyst, so its model calls count against its department's budget
    if 'analystBotId' in value:
        if not (isinstance(value['analystBotId'], str) and BOT_ID.match(value['analystBotId'])):
            raise ValueError('analystBotId: an organisation bot id')
        config['analystBotId'] = value['analystBotId']
    # Retired with the loose rule it governed; still accepted so an existing configuration keeps loading.
    if not isinstance(value.get('looseCorroborationVerifies', False), bool):
        raise ValueError('looseCorroborationVerifies: no longer used; remove it or set true or false')
    if not (isinstance(config['recipientBotIds'], list) and 1 <= len(config['recipientBotIds']) <= 5
            and all(isinstance(b, str) and BOT_ID.match(b) for b in config['recipientBotIds'])):
        raise ValueError('recipientBotIds: 1-5 organisation bot ids')
    if not (isinstance(config['primarySourceIds'], list) and all(isinstance(s, str) and BOT_ID.match(s) for s in config['primarySourceIds'])):
        raise ValueError('primarySourceIds: approved source ids whose own statements need no corroboration')
    if not (isinstance(config['holdDays'], int) and 1 <= config['holdDays'] <= 30):
        raise ValueError('holdDays: 1-30')
    if not (isinstance(config['maxModelCallsPerCycle'], int) and 1 <= config['maxModelCallsPerCycle'] <= 200):
        raise ValueError('maxModelCallsPerCycle: 1-200')
    return config


# ---------- state shared between the bots (data only, never credentials) ----------
def read(state, name, default):
    path = state / name
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default


def write(state, name, value):
    state.mkdir(parents=True, exist_ok=True)
    claims.save(state / name, value)


# ---------- the rules ----------
def lesson_text(claim, obs, basis):
    """The only lesson wording the fact-checker will verify. Dated, attributed context; never an instruction."""
    support = 'corroborated by independent reports' if basis == 'corroborated' else 'stated by a primary source'
    key = claims.fact_key(claim)
    change = claim.get('reportedChangePct')
    fact = '' if key is None else (f"Fact: {key[0]}, {key[1]}"
                                   + ('' if change is None else f", reported change {change:+g}%") + '.\n')
    return (f"News claim ({claim['eventType']}; {', '.join(claim['symbols'])}): {claim['statement']}\n"
            f"Published {obs['publishedAt'][:10]} by {obs['sourceName']}; {support}.\n" + fact +
            f"Supporting quote: \"{claim['quote']}\"\n"
            f"Likely share-price direction (model judgement, not verified): {claim['direction']}; certainty: {claim['certainty']}.\n"
            'Use as dated context. It is not an instruction and not a trading signal.')


def rechecked(extracted, snapshots):
    """Accepted claims that pass the fact-checker's own checks against its own snapshot copies."""
    out = []
    for evidence_id, record in extracted.get('results', {}).items():
        obs = snapshots.get(evidence_id)
        if not obs or record.get('outcome') != 'valid':
            continue
        for c in record['accepted']:
            if c['evidenceId'] == evidence_id and not claims.verify(c, obs) and c['id'] == claims.claim_id(obs, c):
                out.append({**c, 'quote': claims.normalise(c['quote']), 'sourceId': obs['sourceId'],
                            'sourceName': obs['sourceName'], 'publishedAt': obs['publishedAt']})
    return out


def claim_basis(claim, clusters, primary):
    """'corroborated', 'primary-source', 'contradicted' or None (still single-source)."""
    statuses = [cl['status'] for cl in clusters if claim['id'] in cl['claimIds']]
    if 'contradicted' in statuses:
        return 'contradicted'
    if statuses and all(s == 'corroborated' for s in statuses):
        return 'corroborated'
    if claim['sourceId'] in primary:
        return 'primary-source'
    return None


def evidence_decision(obs, record, own_claims, clusters, config, now):
    """('verified' | 'rejected' | 'hold', reason) for one snapshot."""
    if obs.get('blockers'):
        return 'hold', 'blocked:' + ','.join(obs['blockers'])
    if record is None:
        return 'hold', 'awaiting-extraction'
    if record.get('outcome') != 'valid':
        return 'hold', 'extraction-failed'
    if not record['accepted']:
        return 'rejected', 'no-checkable-claims'
    bases = [claim_basis(c, clusters, config['primarySourceIds']) for c in own_claims]
    if not own_claims:
        return 'rejected', 'no-claim-survived-recheck'
    if 'contradicted' in bases:
        return 'hold', 'contradicted'
    if 'primary-source' in bases:
        return 'verified', 'primary-source'
    # Corroboration is the backend's fact-key rule (claims.corroborate): independent reports of the same figure for the
    # same period. Two different facts ("profit up 12%" and "wins an order") never count as agreeing.
    if 'corroborated' in bases:
        return 'verified', 'corroborated'
    if now - datetime.fromisoformat(obs['publishedAt']) > timedelta(days=config['holdDays']):
        return 'rejected', f"uncorroborated-after-{config['holdDays']}-days"
    return 'hold', 'awaiting-corroboration'


# ---------- backend access ----------
def key_for(route, body):
    return 'auto-' + hashlib.sha256((route + json.dumps(body, sort_keys=True)).encode()).hexdigest()[:64]


class NoRedirect(urlrequest.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_api(base, token, opener=None):
    """api(method, route, body) -> dict. Content-derived idempotency keys make every retry safe."""
    opener = opener or urlrequest.build_opener(NoRedirect()).open
    def api(method, route, body=None):
        headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
        if method == 'POST' and body is not None and not route.endswith(('/review-queue', '/query', '/status')):
            headers['Idempotency-Key'] = key_for(route, body)
        req = urlrequest.Request(base + route, data=None if body is None else json.dumps(body).encode(), method=method, headers=headers)
        try:
            with opener(req, timeout=15) as response:
                data = response.read(2_000_001)
                if len(data) > 2_000_000:
                    raise ValueError('Backend response too large')
                return json.loads(data)
        except HTTPError as error:
            error.close()
            raise RuntimeError(f'{route} refused (HTTP {error.code})') from None
        except (URLError, OSError, ValueError):
            raise RuntimeError(f'{route} was not acknowledged; rerun to recover safely') from None
    return api


def child_backend(env, role):
    """Inside a step: exactly one credential, of this step's role, from the environment only (never .env)."""
    base = (env.get('API_URL') or 'http://127.0.0.1:3000').rstrip('/')
    if not re.match(r'^(https://[^/@?#]+|http://(127\.0\.0\.1|localhost)(:\d+)?)$', base):
        raise ValueError('Invalid backend API origin')
    principals = json.loads(env.get('PRINCIPALS_JSON') or '[]')
    if len(principals) != 1 or principals[0].get('role') != role or not principals[0].get('token'):
        raise ValueError(f'This step must receive exactly one {role} credential')
    return http_api(base, principals[0]['token'])


# ---------- the steps ----------
def factcheck_queue(api, state, max_pages=10):
    """Evaluator: fetch every pending snapshot and keep its own copy of each (the fact-checker's ground truth)."""
    snapshots, queue, after, invalid = read(state, 'snapshots.json', {}), [], None, 0
    for _ in range(max_pages):
        page = api('POST', '/v1/sources/observations/review-queue', {'limit': 50, **({'after': after} if after else {})})
        for raw in page['observations']:
            try:
                obs = {**claims.observation_fields(raw), 'blockers': list(raw.get('blockers', []))}
            except ValueError:
                invalid += 1  # left in the backend queue untouched; never guessed or repaired
                continue
            snapshots.setdefault(obs['evidenceId'], {k: v for k, v in obs.items() if k != 'blockers'})
            queue.append(obs)
        after = page.get('nextCursor')
        if not after:
            break
    write(state, 'snapshots.json', snapshots)
    write(state, 'queue.json', queue)
    return {'pending': len(queue), 'invalidRows': invalid}


def analyst_extract(llm, model, state, config, api=None, now=None):
    """Researcher with the model: draft claims for snapshots that have none yet. With analystBotId configured, the model
    calls count against that bot's department budget: the allowance is asked first, and the tokens used are reported."""
    bot = config.get('analystBotId')
    if bot and api:
        allowance = api('POST', '/v1/compute/allowance', {'botId': bot})
        if not allowance.get('allowed'):
            return {'skipped': f"compute budget: department {allowance.get('departmentId')} used {allowance.get('usedTodayTokens')} "
                               f"of its {allowance.get('budgetTokensPerDay')} tokens today", 'callsThisRun': 0}
    started = time.monotonic()
    result = _extract(llm, model, state, config)
    if bot and api and result['callsThisRun']:
        day = (now or datetime.now(timezone.utc)).date().isoformat()
        api('POST', '/v1/compute/usage/reports', {'botId': bot, 'model': model, 'runLabel': f"autolearn {(now or datetime.now(timezone.utc)).isoformat()}"[:160],
            'periodFrom': day, 'periodTo': day, 'calls': result['callsThisRun'], 'promptTokens': result['tokensThisRun'][0],
            'completionTokens': result['tokensThisRun'][1], 'latencyMs': int((time.monotonic() - started) * 1000)})
        result['computeReported'] = True
    return result


def _extract(llm, model, state, config):
    queue = [{k: v for k, v in o.items() if k != 'blockers'} for o in read(state, 'queue.json', []) if not o.get('blockers')]
    # newest first: with a bounded number of model calls a day, today's news matters most to the desk, and an item
    # older than holdDays can no longer be corroborated in time anyway
    queue.sort(key=lambda o: o.get('publishedAt') or '', reverse=True)
    current = read(state, 'extracted.json', None)
    if current and (current.get('model') != model or current.get('contractVersion') != claims.CONTRACT_VERSION):
        # A new model or claim contract starts a fresh extraction file. The old one is kept and still read, so claims
        # behind evidence already decided stay checkable (they simply carry no fact key if the old contract had none).
        claims.replace(state / 'extracted.json', state / f'extracted-archive-{len(archives(state)) + 1}.json')
    return claims.run_extract(queue, llm, state, model, config['maxModelCallsPerCycle'])


def archives(state):
    return sorted(state.glob('extracted-archive-*.json'), key=lambda p: int(p.stem.rsplit('-', 1)[1]))


def all_extracted(state):
    """Every extraction result, oldest file first; the current file wins for an evidence item extracted twice."""
    results = {}
    for path in archives(state):
        results.update(json.loads(path.read_text(encoding='utf-8')).get('results', {}))
    results.update(read(state, 'extracted.json', {}).get('results', {}))
    return {'results': results}


def factcheck_evidence(api, state, config, now):
    """Evaluator, no model: decide each pending snapshot by the rules and record why."""
    snapshots, extracted = read(state, 'snapshots.json', {}), all_extracted(state)
    decisions = read(state, 'decisions.json', {})
    own = rechecked(extracted, snapshots)
    clusters = claims.corroborate(own) if own else []
    counts = {}
    for obs in read(state, 'queue.json', []):
        if decisions.get(obs['evidenceId'], {}).get('sent'):
            continue
        record = extracted.get('results', {}).get(obs['evidenceId'])
        decision, reason = evidence_decision(obs, record, [c for c in own if c['evidenceId'] == obs['evidenceId']], clusters, config, now)
        entry = {'decision': decision, 'reason': reason, 'at': now.isoformat(), 'sent': False}
        if decision != 'hold':
            api('POST', '/v1/evidence/reviews', {'evidenceId': obs['evidenceId'], 'status': decision,
                'expected': {'content': obs['content'], 'sourceId': obs['sourceId'], 'kind': obs['kind'],
                             'publishedAt': obs['publishedAt'], 'observation': {'url': obs['url'], 'title': obs['title']}}})
            entry['sent'] = True
        decisions[obs['evidenceId']] = entry
        write(state, 'decisions.json', decisions)
        counts[reason] = counts.get(reason, 0) + 1
    write(state, 'clusters.json', clusters)
    return counts


def eligible_lessons(state, config):
    """(claim, snapshot, basis) for every re-checked claim on evidence the fact-checker verified."""
    snapshots, decisions = read(state, 'snapshots.json', {}), read(state, 'decisions.json', {})
    own = rechecked(all_extracted(state), snapshots)
    clusters = claims.corroborate(own) if own else []
    out = []
    for c in own:
        if decisions.get(c['evidenceId'], {}).get('decision') != 'verified' or not decisions[c['evidenceId']].get('sent'):
            continue
        basis = claim_basis(c, clusters, config['primarySourceIds'])
        if basis in ('corroborated', 'primary-source'):
            out.append((c, snapshots[c['evidenceId']], basis))
    return out


def backend_claim(c, obs):
    """The claim as the backend's claim record takes it (POST /v1/evidence/claims), or None when the backend could not
    accept it: its quote must be in the article body (a quote from the headline stays local)."""
    if c['quote'] not in claims.normalise(obs['content']):
        return None
    body = {'evidenceId': c['evidenceId'], 'statement': c['statement'], 'quote': c['quote'],
            'symbols': sorted({s.removesuffix('.NS') for s in c['symbols']}), 'eventType': c['eventType'], 'direction': c['direction'],
            'eventDate': c['eventDate'], 'certainty': c['certainty']}
    key = claims.fact_key(c)
    if key:  # one name per fact (CLAIMS-03), so the registry groups what the fact-checker grouped
        body.update(metric=key[0], period=key[1])
        if c.get('reportedChangePct') is not None:
            body['reportedChangePct'] = c['reportedChangePct']
    return body


def analyst_lessons(api, state, config):
    """Researcher: record each eligible claim in the backend's claim registry, and propose it to each recipient bot, once."""
    proposals, posted = read(state, 'proposals.json', {}), read(state, 'backend-claims.json', {})
    made = recorded = refused = 0
    for c, obs, _ in eligible_lessons(state, config):
        if c['id'] in posted:
            continue
        body = backend_claim(c, obs)
        if body is None:
            posted[c['id']] = {'skipped': 'quote-not-in-article-body'}
        else:
            try:
                result = api('POST', '/v1/evidence/claims', body)
                posted[c['id']] = {'backendId': result['id'], 'evidenceId': c['evidenceId']}
                recorded += 1
            except RuntimeError as error:  # recorded and counted, never retried blindly or hidden
                posted[c['id']] = {'refused': str(error)[:200]}
                refused += 1
        write(state, 'backend-claims.json', posted)
    for c, obs, basis in eligible_lessons(state, config):
        for bot in config['recipientBotIds']:
            key = f"{c['id']}:{bot}"
            if key in proposals:
                continue
            content = lesson_text(c, obs, basis)
            result = api('POST', '/v1/lessons', {'botId': bot, 'content': content, 'evidenceId': c['evidenceId']})
            proposals[key] = {'lessonId': result['id'], 'botId': bot, 'claimId': c['id'], 'evidenceId': c['evidenceId'],
                              'content': content, 'basis': basis}
            write(state, 'proposals.json', proposals)
            made += 1
    return {'proposed': made, 'claimsRecorded': recorded, 'claimsRefused': refused}


def factcheck_lessons(api, state, config, now):
    """Evaluator, no model: verify lessons whose text equals the rules' template; revoke on mismatch or contradiction."""
    headline_receipt.receipt_path(state / 'verified-headlines.json').unlink(missing_ok=True)
    write(state, 'verified-headlines.json', [])
    reviews, revocations = read(state, 'lesson-reviews.json', {}), read(state, 'revocations.json', {})
    expected = {f"{c['id']}:{bot}": (lesson_text(c, obs, basis), c['evidenceId'])
                for c, obs, basis in eligible_lessons(state, config) for bot in config['recipientBotIds']}
    counts = {'verified': 0, 'skipped': 0, 'revoked': 0, 'claimsAccepted': 0}
    # the backend's claim registry: each recorded claim the rules still find eligible is accepted, once, by this
    # independent reviewer; revoking its evidence later withdraws it there automatically
    eligible = {c['id'] for c, _, _ in eligible_lessons(state, config)}
    claim_reviews = read(state, 'backend-claim-reviews.json', {})
    for claim_id, posted in read(state, 'backend-claims.json', {}).items():
        if 'backendId' not in posted or claim_id in claim_reviews or claim_id not in eligible:
            continue
        api('POST', '/v1/evidence/claims/reviews', {'claimId': posted['backendId'], 'decision': 'accepted',
            'reason': 'Automatic fact-check: quote re-checked against its own copy of the article; corroborated or from a primary source'})
        claim_reviews[claim_id] = {'decision': 'accepted', 'at': now.isoformat()}
        write(state, 'backend-claim-reviews.json', claim_reviews)
        counts['claimsAccepted'] += 1

    def revoke(evidence_id, reason):
        if evidence_id in revocations:
            return
        api('POST', '/v1/evidence/revocations', {'kind': 'evidence', 'targetId': evidence_id, 'reason': reason})
        revocations[evidence_id] = {'reason': reason, 'at': now.isoformat()}
        write(state, 'revocations.json', revocations)
        counts['revoked'] += 1
    for key, p in read(state, 'proposals.json', {}).items():
        if p['lessonId'] in reviews:
            continue
        want = expected.get(key)
        if want is None or want[0] != p['content'] or want[1] != p['evidenceId']:
            reviews[p['lessonId']] = {'status': 'not-verified', 'reason': 'not-eligible-or-text-differs', 'at': now.isoformat()}
            counts['skipped'] += 1
        else:
            api('POST', '/v1/lessons/reviews', {'lessonId': p['lessonId'],
                'expected': {'content': want[0], 'evidenceId': want[1], 'botId': key.rsplit(':', 1)[1]}})
            reviews[p['lessonId']] = {'status': 'verified', 'at': now.isoformat(), 'evidenceId': p['evidenceId'], 'content': want[0]}
            counts['verified'] += 1
        write(state, 'lesson-reviews.json', reviews)
    # Read back what the backend actually stored; any difference means the proposal was not what was reviewed.
    stored = {row['id']: row for row in api('GET', '/v1/knowledge').get('lessons', [])}
    for lesson_id, review in reviews.items():
        row = stored.get(lesson_id)
        if review['status'] == 'verified' and row is not None and row['content'] != review['content']:
            revoke(review['evidenceId'], 'Automatic fact-check: stored lesson text differs from the reviewed text')
    # Later reports can contradict what was verified earlier.
    own = rechecked(all_extracted(state), read(state, 'snapshots.json', {}))
    clusters = claims.corroborate(own) if own else []
    decisions = read(state, 'decisions.json', {})
    for c in own:
        if decisions.get(c['evidenceId'], {}).get('decision') == 'verified' and claim_basis(c, clusters, config['primarySourceIds']) == 'contradicted':
            revoke(c['evidenceId'], 'Automatic fact-check: later independent reports contradict this claim')
    counts['headlines'] = len(export_headlines(api, state, config))
    return counts


def export_headlines(api, state, config):
    """Reconcile exact evidence IDs before publishing. Failure leaves an empty export, not stale news."""
    checked_at = datetime.now(timezone.utc)
    output = state / 'verified-headlines.json'
    headline_receipt.receipt_path(output).unlink(missing_ok=True)
    write(state, 'verified-headlines.json', [])
    revoked = read(state, 'revocations.json', {})
    candidates = [(c, obs, basis) for c, obs, basis in eligible_lessons(state, config) if c['evidenceId'] not in revoked]
    ids = sorted({c['evidenceId'] for c, _, _ in candidates})
    if len(ids) > 500:
        raise ValueError('Headline reconciliation capacity exceeded (500 evidence records)')
    stored = {}
    for offset in range(0, len(ids), 50):
        batch = ids[offset:offset + 50]
        response = api('POST', '/v1/evidence/status', {'evidenceIds': batch})
        rows = response.get('evidence')
        if not isinstance(rows, list):
            raise ValueError('Invalid evidence status response')
        for row in rows:
            if not isinstance(row, dict) or row.get('id') not in batch or row['id'] in stored:
                raise ValueError('Invalid evidence status identity')
            stored[row['id']] = row

    def current(c, obs):
        row = stored.get(c['evidenceId'], {})
        return (row.get('usable') is True and row.get('status') == 'verified' and row.get('source_approved') is True
                and row.get('source_id') == obs['sourceId'] and row.get('content') == obs['content']
                and row.get('title') == obs['title'] and row.get('url') == obs['url']
                and row.get('kind') == obs.get('kind')
                and datetime.fromisoformat(row['published_at'].replace('Z', '+00:00')) == datetime.fromisoformat(obs['publishedAt']))

    current_candidates = [(c, obs, basis) for c, obs, basis in candidates if current(c, obs)]
    current_clusters = claims.corroborate([c for c, _, _ in current_candidates]) if current_candidates else []
    items = [{'publishedAt': obs['publishedAt'], 'source': obs['sourceName'][:80], 'title': c['statement'][:240], 'symbols': c['symbols']}
             for c, obs, _ in current_candidates
             if claim_basis(c, current_clusters, config['primarySourceIds']) in ('corroborated', 'primary-source')]
    items.sort(key=lambda h: (h['publishedAt'], h['title']))
    write(state, 'verified-headlines.json', items)
    claims.save(headline_receipt.receipt_path(output), headline_receipt.receipt(output.read_bytes(), checked_at))
    return items


# ---------- orchestration: one child process per step, each with only its own credential ----------
def env_file(path=None):
    values, path = {}, Path(path or claims.ROOT / '.env')
    if path.exists():
        for line in path.read_text(encoding='utf-8').splitlines():
            key, _, value = line.partition('=')
            if key.strip() and not key.startswith('#'):
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in '\'"`':
                    value = value[1:-1]  # quoted, as node --env-file reads it (the cycle's own .env loader)
                values[key.strip()] = value
    return values


def child_env(step, parent_env, private, steps=None, model_steps=('analyst-extract',)):
    """The environment for one step: its single credential; model settings only for model-using steps."""
    role = (steps or STEPS)[step]
    principals = json.loads(parent_env.get('PRINCIPALS_JSON') or private.get('PRINCIPALS_JSON') or '[]')
    mine = [p for p in principals if p.get('role') == role]
    if len(mine) != 1:
        raise ValueError(f'Configure exactly one {role} credential')
    runtime_keys = {'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
                    'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA',
                    'LANG', 'LC_ALL', 'TZ'}
    env = {k: v for k, v in parent_env.items() if k.upper() in runtime_keys}
    env['PYTHONUTF8'] = '1'
    env['PRINCIPALS_JSON'] = json.dumps(mine)
    env['API_URL'] = parent_env.get('API_URL') or private.get('API_URL') or 'http://127.0.0.1:3000'
    env['AUTOLEARN_STEP'] = step
    if step in model_steps:
        for k in ('HERMES_MODEL', 'HERMES_MODEL_BASE_URL', 'HERMES_MODEL_API_KEY'):
            if parent_env.get(k) or private.get(k):
                env[k] = parent_env.get(k) or private.get(k)
    return env


def run_step(step, args, env, script=None):
    command = [sys.executable, str(Path(script or __file__).resolve()), 'step', step, '--config', str(args.config), '--state', str(args.state),
               '--timeout-seconds', str(args.timeout_seconds)] + (['--allow-remote-cost'] if args.allow_remote_cost else [])
    done = subprocess.run(command, env=env, capture_output=True, text=True, timeout=3600)
    if done.returncode != 0:
        raise RuntimeError(f'{step} stopped: {done.stderr.strip()[-300:]}')
    return json.loads(done.stdout)


def run(args, parent_env=os.environ, runner=run_step, sleep=time.sleep, private=None, steps=None, validate=load_config,
        model_steps=('analyst-extract',)):
    """Finite cycles of the steps in order; any failed step stops the session and is logged."""
    steps = steps or STEPS
    validate(args.config)  # fail early on a bad config
    private = env_file() if private is None else private
    log = []
    for cycle in range(args.cycles):
        entry = {'cycle': cycle + 1, 'at': datetime.now(timezone.utc).isoformat(), 'steps': {}}
        try:
            for step in steps:
                entry['steps'][step] = runner(step, args, child_env(step, dict(parent_env), private, steps, model_steps))
        except (RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
            entry['stopped'] = str(error)[:300]
        with (args.state / 'cycles.jsonl').open('a', encoding='utf-8') as handle:
            handle.write(json.dumps(entry) + '\n')
        log.append(entry)
        if 'stopped' in entry:
            break
        if cycle + 1 < args.cycles:
            sleep(args.interval_minutes * 60)
    return log


def step_main(args):
    env = os.environ
    if env.get('AUTOLEARN_STEP') != args.step:
        raise ValueError('Steps run only as children of `run`, which gives each one its own credential')
    config, now = load_config(args.config), datetime.now(timezone.utc)
    if args.step == 'analyst-extract':
        llm, endpoint = claims.model_client({k: env.get(k) for k in ('HERMES_MODEL', 'HERMES_MODEL_BASE_URL', 'HERMES_MODEL_API_KEY')},
                                            args.timeout_seconds, args.allow_remote_cost)
        return analyst_extract(llm, endpoint.model, args.state, config, api=child_backend(env, 'researcher') if config.get('analystBotId') else None)
    api = child_backend(env, STEPS[args.step])
    if args.step == 'factcheck-queue':
        return factcheck_queue(api, args.state)
    if args.step == 'factcheck-evidence':
        return factcheck_evidence(api, args.state, config, now)
    if args.step == 'analyst-lessons':
        return analyst_lessons(api, args.state, config)
    return factcheck_lessons(api, args.state, config, now)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('run', 'step'):
        p = sub.add_parser(name)
        if name == 'step':
            p.add_argument('step', choices=list(STEPS))
        p.add_argument('--config', type=Path, required=True)
        p.add_argument('--state', type=Path, default=STATE)
        p.add_argument('--timeout-seconds', type=int, default=240, choices=range(10, 601))
        p.add_argument('--allow-remote-cost', action='store_true')
        if name == 'run':
            p.add_argument('--cycles', type=int, default=1, choices=range(1, 49))
            p.add_argument('--interval-minutes', type=int, default=30, choices=range(5, 241))
    args = parser.parse_args(argv)
    args.state.mkdir(parents=True, exist_ok=True)
    if args.command == 'step':
        print(json.dumps(step_main(args)))
    else:
        print(json.dumps(run(args), indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
