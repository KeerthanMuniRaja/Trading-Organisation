"""Model allocator member: the language-model allocator's monthly decision becomes trade proposals. No model call here.

The model decides in its pre-registered forward test (ai_allocator.py forward, run by the cycle only with --with-model).
This step then, once per decided month and only while the decision is current (at most 7 days old):
  1. the price reporter (researcher) submits, as evidence, the exact facts the model saw, with the shares named;
  2. the price checker (evaluator) recomputes those facts from the steward-checked daily data itself and verifies the
     evidence only if they match exactly: the model's inputs are proven true, not just its output recorded;
  3. signals_bridge.from_allocator turns material weight changes into proposals (enter-long with targetWeightPct,
     exit when cut to zero), sent with the credential bound to the allocator's bot. The model and prompt version come
     from the run, so release control applies unchanged.
Nothing is proposed for a failed month, a stale month, or a month already proposed.
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\model_allocator.py --bot ai-allocator --run ai-taught-forward-v1 --source market-yahoo-daily
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ai_allocator as ai  # noqa: E402
import daily  # noqa: E402
import eod_trader  # noqa: E402
import portfolio_daily as pd  # noqa: E402
import signal_scorer as sc  # noqa: E402
import signals_bridge as bridge  # noqa: E402

CURRENT_DAYS = 7


def facts_text(day, facts, letters, fingerprint):
    """The brief the model saw on `day`, with each letter replaced by its share."""
    def show(v):
        return 'n/a' if v is None else v
    lines = [f"NSE:{bridge.ticker(letters[k])} return 1m {show(f['return1mPct'])}%, 3m {show(f['return3mPct'])}%, "
             f"6m {show(f['return6mPct'])}%, 12m {show(f['return12mPct'])}%; volatility 60d {show(f['volatility60dPct'])}%; "
             f"from 52-week high {show(f['drawdownFrom52wHighPct'])}%; above 200-day average {show(f['above200dAverage'])}"
             for k, f in sorted(facts.items())]
    return (f'Monthly allocator brief for the decision on {day} (facts from completed days only): ' + '; '.join(lines)
            + f'. Source: Yahoo Finance via yfinance, adjusted daily bars checked by the data steward, combined fingerprint {fingerprint}.')


def recompute(day, letters, cache):
    """The checker's own computation of the brief for `day`, from the cache."""
    import data_steward
    all_bars = daily.load(sorted(daily.datasets.UNIVERSE), cache)
    dates, table = pd.aligned(all_bars)
    if day not in dates:
        raise ValueError(f'{day} is not a common trading day in the data')
    fingerprint = hashlib.sha256('|'.join(f"{s}:{data_steward.fingerprint({'bars': all_bars[s]})}" for s in sorted(all_bars)).encode()).hexdigest()[:16]
    return ai.brief(table, dates, dates.index(day), letters), fingerprint


def run(bot_id, run_name, source_id, env=os.environ, cache=daily.DAILY, root=ai.RUNS, opener=None, now=None, dry_run=False):
    from urllib import request as urlrequest
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,60}', run_name):
        raise ValueError('Run: letters, digits, _ or -')
    opener = opener or urlrequest.urlopen
    now = now or datetime.now(timezone.utc)
    path = root / run_name / 'decisions.json'
    if not path.exists():
        return {'state': 'waiting', 'reason': 'the forward test has decided no month yet'}
    state = json.loads(path.read_text(encoding='utf-8'))
    day = max(state['months'])
    entry = state['months'][day]
    if entry['outcome'] != 'valid':
        return {'state': 'no-valid-decision', 'month': day, 'reason': entry.get('failure', 'invalid reply')}
    if (now.date() - date.fromisoformat(day)).days > CURRENT_DAYS:
        return {'state': 'waiting', 'month': day, 'reason': 'no current decision (the next month has not been decided)'}
    trader = eod_trader.bot_credential(env, bot_id) or bridge.credential(env, bot_id)
    mine = sc.post(*trader, '/v1/trading/signals/query', {'limit': 200}, opener)['signals']
    if any(s['createdAt'][:10] >= day and s.get('model') == state['model'][:120] for s in mine):
        return {'state': 'already-proposed', 'month': day}
    letters = ai.mapping(run_name, daily.datasets.UNIVERSE)
    facts, fingerprint = recompute(day, letters, cache)
    if facts != entry['facts']:
        raise ValueError(f'The facts the model saw on {day} no longer match the checked data; not proposing on them')
    planned = bridge.from_allocator(state, day, letters, bot_id, ['EVIDENCE'], now)
    if dry_run or not planned:
        return {'state': 'dry-run' if dry_run else 'no-material-change', 'month': day,
                'proposals': [[p['action'], p['symbol'], p.get('targetWeightPct')] for p in planned]}
    reporter, checker = sc.principals(env, 'researcher'), sc.principals(env, 'evaluator')
    published = sc.close_time(day).isoformat().replace('+00:00', 'Z')
    evidence_id = eod_trader.evidence_for(facts_text(day, facts, letters, fingerprint), published, source_id, reporter, checker, opener)
    sent = bridge.submit(bridge.from_allocator(state, day, letters, bot_id, [evidence_id], now), env, opener)
    return {'state': 'proposed', 'month': day, 'model': state['model'], 'proposals': [[r['action'], r['symbol'], r['id']] for r in sent]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--bot', required=True)
    parser.add_argument('--run', required=True, help='The allocator forward-test run (ai_allocator.py register/forward)')
    parser.add_argument('--source', required=True, help='Owner-approved market-data source id for the facts evidence')
    parser.add_argument('--cache', type=Path, default=daily.DAILY)
    parser.add_argument('--runs', type=Path, default=ai.RUNS, help='Folder of allocator runs')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    print(json.dumps(run(args.bot, args.run, args.source, cache=args.cache, root=args.runs, dry_run=args.dry_run), indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
