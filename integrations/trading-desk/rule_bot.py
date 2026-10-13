"""Rule bot: monthly top-3 momentum as a real organisation member, with no language model. Research only, paper only.

Once per calendar month, from the steward-checked daily cache:
  1. rank the eight shares by 6-month return (126 settled sessions);
  2. the price reporter (researcher) submits the ranking, with its closes and dataset fingerprints, as evidence; the
     price checker (evaluator) verifies it only on an exact match of the stored text (content-bound review);
  3. the bot, with its own bot-bound trader credential, proposes: enter-long (target weight 33%) for top-3 shares it
     does not hold, and exit for holdings that dropped out of the top 3. Holdings still in the top 3 need nothing.
Proposals then flow through the same review, challenges, end-of-day execution, scoring and fitness as any bot. The
model field names the rule ('rules:top3-momentum-6m') and the prompt version is the rule's fingerprint, so release
control applies unchanged. After costs it beat holding the basket in 2021-24 (22.1% vs 21.2% a year) and 2024-25 (+0.7%
vs -2.0%) but not in the latest year 2025-26 (-11.5% vs -11.0%, with a deeper 22.6% fall); gross of costs it was ahead in
32 of 50 months (p ~ 0.03, all seen data) and behind on average in broad downtrends. Not proven; its paper record on
new months is the real test.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\rule_bot.py --bot momentum-rules --source market-yahoo-daily [--dry-run]
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily  # noqa: E402
import eod_trader  # noqa: E402
import signal_scorer as sc  # noqa: E402

MODEL = 'rules:top3-momentum-6m'
LOOKBACK, KEEP, TARGET_PCT, HORIZON_DAYS, EXPIRY_DAYS = 126, 3, 33, 30, 7
RULE_VERSION = hashlib.sha256(f'top{KEEP}|return-{LOOKBACK}-sessions|target-{TARGET_PCT}|horizon-{HORIZON_DAYS}'.encode()).hexdigest()[:16]


def ranking(datasets, now):
    """[(symbol, returnPct, startPaise, endPaise, date)] best first, from settled bars only; shares lacking history are left out."""
    rows = []
    for name, dataset in datasets.items():
        bars = [b for b in dataset['bars'] if sc.close_time(b['date']) <= now - sc.SETTLE]
        if len(bars) > LOOKBACK:
            start, end = bars[-1 - LOOKBACK], bars[-1]
            rows.append((name.removesuffix('.NS'), round((end['closePaise'] / start['closePaise'] - 1) * 100, 2),
                         start['closePaise'], end['closePaise'], end['date']))
    return sorted(rows, key=lambda r: (-r[1], r[0]))


def ranking_text(rows, fingerprint):
    body = '; '.join(f'{i + 1}. NSE:{s} {ret:+.2f}% ({a} -> {b} paise)' for i, (s, ret, a, b, _) in enumerate(rows))
    return (f'{LOOKBACK}-session returns of the tracked shares as of {max(r[4] for r in rows)}: {body}. Source: Yahoo Finance via '
            f'yfinance, adjusted daily closes checked by the data steward, combined dataset fingerprint {fingerprint}.')


def proposals(rows, holdings, bot_id, evidence_id, now):
    """Exits for holdings outside the top KEEP, then entries for top-KEEP shares not held."""
    top = [r[0] for r in rows[:KEEP]]
    rank = {r[0]: (i + 1, r[1]) for i, r in enumerate(rows)}
    # 'high' takes the full target weight, as the backtest did (three equal thirds); the target weight is the real cap, and an
    # evidenced objection from another bot still sizes it as medium. 'medium' would halve the headroom and starve the third slot.
    base = {'botId': bot_id, 'horizonDays': HORIZON_DAYS, 'conviction': 'high', 'evidenceIds': [evidence_id], 'model': MODEL,
            'promptVersion': RULE_VERSION, 'expiresAt': (now + timedelta(days=EXPIRY_DAYS)).isoformat().replace('+00:00', 'Z')}
    out = []
    for symbol in sorted(holdings):
        if symbol in rank and symbol not in top:
            k, ret = rank[symbol]
            out.append({**base, 'symbol': symbol, 'action': 'exit',
                        'thesis': f'Dropped out of the top {KEEP}: rank {k} of {len(rows)}, {LOOKBACK}-session return {ret:+.2f}%.',
                        'invalidation': f'Back in the top {KEEP} at the next monthly ranking.'})
    for symbol in top:
        if symbol not in holdings:
            k, ret = rank[symbol]
            out.append({**base, 'symbol': symbol, 'action': 'enter-long', 'targetWeightPct': TARGET_PCT,
                        'thesis': f'Rank {k} of {len(rows)} by {LOOKBACK}-session return ({ret:+.2f}%).',
                        'invalidation': f'Out of the top {KEEP} at the next monthly ranking.'})
    return out


def held(trader, bot_id, opener):
    """Symbols the bot holds now, from its own paper performance record."""
    from urllib import request as urlrequest
    from urllib.error import HTTPError
    base, token = trader
    req = urlrequest.Request(base + '/v1/paper/performance', method='GET', headers={'Authorization': 'Bearer ' + token})
    try:
        with opener(req, timeout=15) as response:
            report = json.loads(response.read(1_000_000))
    except HTTPError as error:
        error.close()
        raise RuntimeError(f'/v1/paper/performance refused (HTTP {error.code})') from None
    return {p['symbol'] for b in report['bots'] if b['botId'] == bot_id for p in b['openPositions'] if int(p['quantity']) > 0}


def load(cache):
    import data_steward
    datasets = {s: eod_trader.dataset_for(cache, s.removesuffix('.NS')) for s in sorted(daily.datasets.UNIVERSE)}
    datasets = {s: d for s, d in datasets.items() if d}
    combined = hashlib.sha256('|'.join(f'{s}:{data_steward.fingerprint(d)}' for s, d in datasets.items()).encode()).hexdigest()[:16]
    return datasets, combined


def run(bot_id, source_id, env=os.environ, cache=daily.DAILY, opener=None, now=None, dry_run=False):
    from urllib import request as urlrequest
    opener = opener or urlrequest.urlopen
    now = now or datetime.now(timezone.utc)
    trader = eod_trader.bot_credential(env, bot_id)
    if not trader:
        raise ValueError(f'Configure exactly one trader credential bound to {bot_id}')
    datasets, fingerprint = load(cache)
    rows = ranking(datasets, now)
    if len(rows) < KEEP:
        return {'state': 'waiting', 'reason': 'not enough settled history'}
    month = now.strftime('%Y-%m')
    mine = sc.post(*trader, '/v1/trading/signals/query', {'limit': 200}, opener)['signals']
    if any(s['createdAt'][:7] == month and s.get('model') == MODEL and s['botId'] == bot_id for s in mine):
        return {'state': 'already-decided', 'month': month}
    holdings = held(trader, bot_id, opener)
    if dry_run:
        return {'state': 'dry-run', 'month': month, 'ranking': [list(r[:2]) for r in rows], 'holdings': sorted(holdings),
                'proposals': [[p['action'], p['symbol']] for p in proposals(rows, holdings, bot_id, None, now)]}
    plan = proposals(rows, holdings, bot_id, None, now)
    if not plan:
        return {'state': 'nothing-to-change', 'month': month, 'top': [r[0] for r in rows[:KEEP]], 'holdings': sorted(holdings)}
    reporter, checker = sc.principals(env, 'researcher'), sc.principals(env, 'evaluator')
    published = sc.close_time(max(r[4] for r in rows)).isoformat().replace('+00:00', 'Z')
    evidence_id = eod_trader.evidence_for(ranking_text(rows, fingerprint), published, source_id, reporter, checker, opener)
    made = []
    for p in proposals(rows, holdings, bot_id, evidence_id, now):
        result = sc.post(*trader, '/v1/trading/signals', p, opener)
        made.append({'action': p['action'], 'symbol': p['symbol'], 'signalId': result['id']})
    return {'state': 'proposed', 'month': month, 'top': [r[0] for r in rows[:KEEP]], 'proposals': made}


def describe():
    """The identity a release registers: the rule (model), its parameters (prompt version) and this exact code."""
    code = Path(__file__).read_bytes().replace(b'\r\n', b'\n')
    return {'model': MODEL, 'promptVersion': RULE_VERSION, 'codeFingerprint': hashlib.sha256(code).hexdigest(),
            'rule': f'Hold the {KEEP} shares with the strongest {LOOKBACK}-session return, {TARGET_PCT}% of budget each, rebalanced monthly; '
                    f'horizon {HORIZON_DAYS} days.'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--describe', action='store_true', help='Print the release identity (model, prompt version, code fingerprint) and stop')
    parser.add_argument('--bot')
    parser.add_argument('--source', help='Owner-approved market-data source id for the ranking evidence')
    parser.add_argument('--cache', type=Path, default=daily.DAILY)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    if args.describe:
        print(json.dumps(describe()))
        return
    if not args.bot or not args.source:
        parser.error('--bot and --source are required')
    print(json.dumps(run(args.bot, args.source, cache=args.cache, dry_run=args.dry_run), indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
