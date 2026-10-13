"""Signal scorer: closes the decision loop automatically. Research only.

For every reviewed trade proposal whose horizon has passed and that has no outcome yet:
  1. the PRICE REPORTER (researcher credential) submits the closing price on the first session at or after the
     horizon as evidence, taken from the steward-checked daily cache (source: the owner-approved market-data source);
  2. the PRICE CHECKER (evaluator credential, a different identity) re-reads that bar from the cache itself, verifies the
     evidence only if the stored text matches exactly (content-bound review), and records the outcome.
The backend then scores the call, fills the bot's track record and its challengers' records, which feed fitness,
releases and alerts. Nothing here trades. A bar counts only once its session closed at least 30 minutes ago.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\signal_scorer.py --source market-yahoo-daily
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
import daily  # noqa: E402

CLOSE_UTC = (10, 0)  # NSE closes 15:30 IST = 10:00 UTC
SETTLE = timedelta(minutes=30)


def close_time(day):
    return datetime.fromisoformat(day).replace(hour=CLOSE_UTC[0], minute=CLOSE_UTC[1], tzinfo=timezone.utc)


def exit_bar(bars, created_at, horizon_days, now):
    """The first session whose close is at or after created + horizon, and that has settled."""
    due = datetime.fromisoformat(created_at.replace('Z', '+00:00')) + timedelta(days=horizon_days)
    for bar in bars:
        at = close_time(bar['date'])
        if at >= due:
            return bar if at <= now - SETTLE else None
    return None


def evidence_text(symbol, bar, fingerprint):
    return (f"Daily close of NSE:{symbol} on {bar['date']}: {bar['closePaise']} paise. Source: Yahoo Finance via yfinance, "
            f"adjusted daily bars checked by the data steward, dataset fingerprint {fingerprint}.")


def principals(env, role):
    values = {k: env.get(k) for k in ('API_URL', 'PRINCIPALS_JSON')}
    path = daily.ROOT / '.env'
    if not all(values.values()) and path.exists():
        for line in path.read_text(encoding='utf-8').splitlines():
            key, _, value = line.partition('=')
            if key in values and not values[key]:
                values[key] = value.strip().strip("'")
    base = (values['API_URL'] or 'http://127.0.0.1:3000').rstrip('/')
    if not re.match(r'^(https://[^/@?#]+|http://(127\.0\.0\.1|localhost)(:\d+)?)$', base):
        raise ValueError('Invalid backend API origin')
    found = [p for p in json.loads(values['PRINCIPALS_JSON'] or '[]') if p.get('role') == role and not p.get('botId')]
    if len(found) != 1 or not found[0].get('token'):
        raise ValueError(f'Configure exactly one {role} credential (not bound to a bot)')
    return base, found[0]['token']


def post(base, token, route, body, opener):
    from urllib import request as urlrequest
    from urllib.error import HTTPError
    data = json.dumps(body, sort_keys=True)
    req = urlrequest.Request(base + route, data=data.encode(), method='POST', headers={
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'Idempotency-Key': 'scorer-' + hashlib.sha256((route + data).encode()).hexdigest()[:64]})
    try:
        with opener(req, timeout=15) as response:
            return json.loads(response.read(1_000_000))
    except HTTPError as error:
        detail = error.read(2000).decode('utf-8', 'replace')
        error.close()
        raise RuntimeError(f'{route} refused (HTTP {error.code}): {detail[:200]}') from None


def score(source_id, env=os.environ, cache=daily.DAILY, opener=None, now=None):
    from urllib import request as urlrequest
    import data_steward
    opener = opener or urlrequest.urlopen
    now = now or datetime.now(timezone.utc)
    rbase, reporter = principals(env, 'researcher')
    ebase, checker = principals(env, 'evaluator')
    signals, before = [], None
    while True:  # every page of reviewed, unscored signals: nothing is left behind however many exist
        page = post(ebase, checker, '/v1/trading/signals/query', {'limit': 200, 'pending': 'unscored', **({'before': before} if before else {})}, opener)
        signals += page['signals']
        before = page.get('nextBefore')
        if not before:
            break
    results = []
    for s in signals:
        review = s.get('review') or {}
        if s.get('outcome') or not review.get('referencePricePaise'):
            continue
        path = cache / f"{s['symbol']}.NS-1d.json"
        if not path.exists():
            path = cache / f"{s['symbol']}-1d.json"
        if not path.exists():
            results.append({'signalId': s['id'], 'state': 'no-price-data'})
            continue
        dataset = json.loads(path.read_text(encoding='utf-8'))
        bar = exit_bar(dataset['bars'], s['createdAt'], s['horizonDays'], now)
        if not bar:
            results.append({'signalId': s['id'], 'state': 'not-due-or-not-settled'})
            continue
        content = evidence_text(s['symbol'], bar, data_steward.fingerprint(dataset))
        published = close_time(bar['date']).isoformat().replace('+00:00', 'Z')
        try:
            # 1. the price reporter submits the observation
            evidence = post(rbase, reporter, '/v1/evidence', {'sourceId': source_id, 'kind': 'dataset', 'content': content, 'publishedAt': published}, opener)
            # 2. the price checker re-reads the bar itself and verifies only an exact match
            reread = json.loads(path.read_text(encoding='utf-8'))
            check_bar = next(b for b in reread['bars'] if b['date'] == bar['date'])
            expected = evidence_text(s['symbol'], check_bar, data_steward.fingerprint(reread))
            if evidence.get('status') != 'verified':
                post(ebase, checker, '/v1/evidence/reviews', {'evidenceId': evidence['id'], 'status': 'verified',
                     'expected': {'content': expected, 'sourceId': source_id, 'kind': 'dataset', 'publishedAt': published}}, opener)
            outcome = post(ebase, checker, '/v1/trading/signals/outcomes', {'signalId': s['id'], 'exitPricePaise': str(check_bar['closePaise']),
                                                                              'observedAt': published, 'evidenceId': evidence['id']}, opener)
            results.append({'signalId': s['id'], 'state': 'scored', 'symbol': s['symbol'], 'exitDate': bar['date'],
                            'moveBps': outcome.get('moveBps'), 'correct': outcome.get('correct')})
        except (RuntimeError, OSError, ValueError, StopIteration) as error:
            results.append({'signalId': s['id'], 'state': 'failed', 'reason': str(error)[:200]})
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', required=True, help='Owner-approved market-data source id for price evidence')
    parser.add_argument('--cache', type=Path, default=daily.DAILY, help='Daily price cache (default: the steward-checked cache)')
    args = parser.parse_args(argv)
    results = score(args.source, cache=args.cache)
    for r in results:
        print(json.dumps(r))
    scored = sum(r['state'] == 'scored' for r in results)
    print(f'{scored} scored, {sum(r["state"] == "failed" for r in results)} failed, {len(results) - scored} waiting or skipped')
    if any(r['state'] == 'failed' for r in results):
        sys.exit(1)


if __name__ == '__main__':
    main()
