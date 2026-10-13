"""End-of-day trader: paper trading without a live price feed. Research only, paper only.

Each run, from the steward-checked daily cache:
  MARK     every share's latest settled close is reported and verified the same way and recorded as its valuation mark,
           so open paper positions show real profit and loss without a live feed.
  REVIEW  every proposal awaiting review, not expired: the price reporter (researcher) submits the latest settled
           daily close as evidence, the price checker (evaluator) re-reads it and verifies an exact match, then the
           evaluator reviews the proposal priced at that close (used only when no live quote is fresh).
  EXECUTE  every accepted, not yet executed, not expired proposal: the first session OPEN strictly after the review is
           reported and verified the same way, then the proposing bot executes at that price with its own credential
           (a trader credential bound to that bot). The backend refuses any price observed before the review, and the
           paper engine re-checks the evidence, slippage, fees and every limit.
A proposal waits (and is reported as waiting) while its next open does not exist yet, its bot has no credential here,
or the close is older than 7 days. Nothing is guessed and nothing is filled at a price chosen after the fact.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\eod_trader.py --source market-yahoo-daily
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily  # noqa: E402
import signal_scorer as sc  # noqa: E402

OPEN_UTC = (3, 45)  # NSE opens 09:15 IST
MAX_PRICE_AGE = timedelta(days=7)


def open_time(day):
    return datetime.fromisoformat(day).replace(hour=OPEN_UTC[0], minute=OPEN_UTC[1], tzinfo=timezone.utc)


def open_text(symbol, bar, fingerprint):
    return (f"Opening price of NSE:{symbol} on {bar['date']}: {bar['openPaise']} paise. Source: Yahoo Finance via yfinance, "
            f"adjusted daily bars checked by the data steward, dataset fingerprint {fingerprint}.")


def latest_close(bars, now):
    settled = [b for b in bars if sc.close_time(b['date']) <= now - sc.SETTLE]
    return settled[-1] if settled else None


def first_open_after(bars, moment, now):
    return next((b for b in bars if moment < open_time(b['date']) <= now), None)


def bot_credential(env, bot_id):
    values = {k: env.get(k) for k in ('API_URL', 'PRINCIPALS_JSON')}
    base = (values['API_URL'] or 'http://127.0.0.1:3000').rstrip('/')
    found = [p for p in json.loads(values['PRINCIPALS_JSON'] or '[]') if p.get('role') == 'trader' and p.get('botId') == bot_id]
    return (base, found[0]['token']) if len(found) == 1 and found[0].get('token') else None


def pages(base, token, pending, opener):
    out, before = [], None
    while True:
        page = sc.post(base, token, '/v1/trading/signals/query', {'limit': 200, 'pending': pending, **({'before': before} if before else {})}, opener)
        out += page['signals']
        before = page.get('nextBefore')
        if not before:
            return out


def evidence_for(text, published, source_id, reporter, checker, opener):
    """Reported by one identity, verified only on an exact match by another; returns the evidence id."""
    (rbase, rtoken), (ebase, etoken) = reporter, checker
    evidence = sc.post(rbase, rtoken, '/v1/evidence', {'sourceId': source_id, 'kind': 'dataset', 'content': text, 'publishedAt': published}, opener)
    if evidence.get('status') != 'verified':
        sc.post(ebase, etoken, '/v1/evidence/reviews', {'evidenceId': evidence['id'], 'status': 'verified',
                'expected': {'content': text, 'sourceId': source_id, 'kind': 'dataset', 'publishedAt': published}}, opener)
    return evidence['id']


def dataset_for(cache, symbol):
    for name in (f'{symbol}.NS-1d.json', f'{symbol}-1d.json'):
        if (cache / name).exists():
            return json.loads((cache / name).read_text(encoding='utf-8'))
    return None


def run(source_id, env=os.environ, cache=daily.DAILY, opener=None, now=None):
    from urllib import request as urlrequest
    import data_steward
    opener = opener or urlrequest.urlopen
    now = now or datetime.now(timezone.utc)
    reporter, checker = sc.principals(env, 'researcher'), sc.principals(env, 'evaluator')
    results = []
    for name in sorted(daily.datasets.UNIVERSE):  # MARK: value open positions at the verified latest close (PAPER-02)
        symbol = name.removesuffix('.NS')
        dataset = dataset_for(cache, symbol)
        bar = latest_close(dataset['bars'], now) if dataset else None
        if not bar or now - sc.close_time(bar['date']) > MAX_PRICE_AGE:
            continue
        published = sc.close_time(bar['date']).isoformat().replace('+00:00', 'Z')
        try:
            evidence_id = evidence_for(sc.evidence_text(symbol, bar, data_steward.fingerprint(dataset)), published, source_id, reporter, checker, opener)
            mark = sc.post(*checker, '/v1/paper/marks', {'symbol': symbol, 'priceEvidence': {'evidenceId': evidence_id,
                           'pricePaise': str(bar['closePaise']), 'observedAt': published}}, opener)
            results.append({'step': 'mark', 'symbol': symbol, 'state': 'unchanged' if mark.get('duplicate') else 'marked', 'pricePaise': mark['pricePaise']})
        except RuntimeError as error:
            results.append({'step': 'mark', 'symbol': symbol, 'state': 'failed', 'reason': str(error)[:200]})
    for s in pages(*checker, 'unreviewed', opener):
        dataset = dataset_for(cache, s['symbol'])
        bar = latest_close(dataset['bars'], now) if dataset else None
        if not bar or now - sc.close_time(bar['date']) > MAX_PRICE_AGE:
            results.append({'step': 'review', 'signalId': s['id'], 'state': 'waiting', 'reason': 'no recent settled close'})
            continue
        published = sc.close_time(bar['date']).isoformat().replace('+00:00', 'Z')
        try:
            evidence_id = evidence_for(sc.evidence_text(s['symbol'], bar, data_steward.fingerprint(dataset)), published, source_id, reporter, checker, opener)
            review = sc.post(*checker, '/v1/trading/signals/reviews', {'signalId': s['id'], 'priceEvidence': {'evidenceId': evidence_id,
                             'pricePaise': str(bar['closePaise']), 'observedAt': published}}, opener)
            results.append({'step': 'review', 'signalId': s['id'], 'state': review['outcome'], 'quantity': review.get('quantity'), 'reasons': review['reasons']})
        except RuntimeError as error:
            results.append({'step': 'review', 'signalId': s['id'], 'state': 'failed', 'reason': str(error)[:200]})
    for s in pages(*checker, 'unexecuted', opener):
        trader = bot_credential(env, s['botId'])
        dataset = dataset_for(cache, s['symbol'])
        reviewed = datetime.fromisoformat(s['review']['reviewedAt'].replace('Z', '+00:00'))
        bar = first_open_after(dataset['bars'], reviewed, now) if dataset else None
        if not trader:
            results.append({'step': 'execute', 'signalId': s['id'], 'state': 'waiting', 'reason': f"no trader credential for {s['botId']}"})
            continue
        if not bar:
            results.append({'step': 'execute', 'signalId': s['id'], 'state': 'waiting', 'reason': 'next open not in the data yet'})
            continue
        published = open_time(bar['date']).isoformat().replace('+00:00', 'Z')
        if now - open_time(bar['date']) > MAX_PRICE_AGE:
            results.append({'step': 'execute', 'signalId': s['id'], 'state': 'waiting', 'reason': 'next open is older than 7 days; re-propose'})
            continue
        try:
            evidence_id = evidence_for(open_text(s['symbol'], bar, data_steward.fingerprint(dataset)), published, source_id, reporter, checker, opener)
            done = sc.post(*trader, '/v1/trading/signals/executions', {'signalId': s['id'], 'priceEvidence': {'evidenceId': evidence_id,
                           'pricePaise': str(bar['openPaise']), 'observedAt': published}}, opener)
            results.append({'step': 'execute', 'signalId': s['id'], 'state': 'executed', 'side': done['side'], 'quantity': done['quantity'],
                            'pricePaise': done['pricePaise']})
        except RuntimeError as error:
            results.append({'step': 'execute', 'signalId': s['id'], 'state': 'failed', 'reason': str(error)[:200]})
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', required=True, help='Owner-approved market-data source id for price evidence')
    parser.add_argument('--cache', type=Path, default=daily.DAILY)
    args = parser.parse_args(argv)
    results = run(args.source, cache=args.cache)
    for r in results:
        print(json.dumps(r))
    counts = {k: sum(r['state'] == k for r in results) for k in ('accepted', 'rejected', 'executed', 'waiting', 'failed', 'marked')}
    print(f"marked {counts['marked']}, reviewed {counts['accepted'] + counts['rejected']} ({counts['accepted']} accepted), executed {counts['executed']}, "
          f"waiting {counts['waiting']}, failed {counts['failed']}")
    if counts['failed']:
        sys.exit(1)


if __name__ == '__main__':
    main()
