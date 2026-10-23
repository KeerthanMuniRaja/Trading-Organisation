"""TradingAgents decisions (TA-01): runs the open-source TradingAgents firm (Tauric Research, Apache-2.0) for our shares and
writes its ratings to a decisions file. Data only: this process has no credential and never talks to our backend; the
governed side (ta_bot.py) turns the file into proposals, under release control, review, scoring and fitness.

Inside TradingAgents: market, news and fundamentals analysts; bull and bear researchers in debate; a trader; a risk team;
and a portfolio manager who issues a five-tier rating (Buy, Overweight, Hold, Underweight, Sell). Its own data comes from
Yahoo Finance and SEC EDGAR (no API key), and our local model serves every role through its OpenAI-compatible endpoint.

Runs in its own environment, so our pinned research environment is never touched:
  .local\\tradingagents-venv\\Scripts\\python.exe integrations\\tradingagents\\ta_decide.py --day 2026-10-23
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.local' / 'tradingagents' / 'decisions'
SYMBOLS = ['AXISBANK', 'HDFCBANK', 'ICICIBANK', 'INFY', 'ITC', 'NTPC', 'RELIANCE', 'SBIN']
RATINGS = ('BUY', 'OVERWEIGHT', 'HOLD', 'UNDERWEIGHT', 'SELL')
ANALYSTS = ['market', 'news', 'fundamentals']
SETTINGS = {'max_debate_rounds': 1, 'max_risk_discuss_rounds': 1, 'max_tool_rounds': 8, 'holding_period_days': 5, 'output_language': 'English'}


def config_version():
    """The settings that define how this member decides (its prompt version): our overrides and analyst choice."""
    return hashlib.sha256(json.dumps({'settings': SETTINGS, 'analysts': ANALYSTS}, sort_keys=True).encode()).hexdigest()[:16]


def rating_of(decision):
    """The five-tier rating from TradingAgents' decision (whatever its shape), or None when it states none clearly."""
    text = json.dumps(decision, default=str) if not isinstance(decision, str) else decision
    found = {r for r in RATINGS if re.search(rf'(?<![A-Z]){r}(?![A-Z])', text.upper())}
    # 'OVERWEIGHT' and 'UNDERWEIGHT' are not 'BUY'/'SELL'; exactly one rating must remain
    return found.pop() if len(found) == 1 else None


def rationale_of(state):
    for key in ('final_trade_decision', 'investment_plan', 'trader_investment_plan'):
        value = (state or {}).get(key) if isinstance(state, dict) else None
        if value:
            return str(value)[:1500]
    return ''


HOLDINGS = ROOT / '.local' / 'tradingagents' / 'holdings.json'


class Book:
    """The member's own paper book, in the shape TradingAgents' propagate(portfolio=...) uses: fingerprint() and
    render(company). Written by the governed side (ta_bot.py) from the bot's own record; this process never reads the backend."""

    def __init__(self, holdings):
        self.holdings = holdings

    def fingerprint(self):
        return hashlib.sha256(json.dumps(self.holdings, sort_keys=True).encode()).hexdigest()[:16]

    def render(self, company):
        h, symbol = self.holdings, str(company).removesuffix('.NS')
        held = h.get('positions', {})
        lines = [f"This member's paper book (as of {h.get('asOf', 'unknown')}): budget Rs {int(h.get('budgetPaise', 0)) / 100:,.2f}, "
                 f"in use Rs {int(h.get('budgetUsedPaise', 0)) / 100:,.2f}."]
        lines += [f"Holds {p['quantity']} share(s) of {s} at a cost of Rs {int(p['costPaise']) / 100:,.2f}." for s, p in sorted(held.items())] or ['Holds no shares.']
        lines.append(f"It {'holds' if symbol in held else 'does not hold'} {symbol}. Rate whether to add, keep or exit it.")
        return ' '.join(lines)


def book(path=HOLDINGS):
    return Book(json.loads(path.read_text(encoding='utf-8'))) if path.exists() else None


def default_graph(env):
    from tradingagents.default_config import DEFAULT_CONFIG
    from tradingagents.graph.trading_graph import TradingAgentsGraph
    import tradingagents
    config = DEFAULT_CONFIG.copy()
    model = env.get('HERMES_MODEL') or 'local-model'
    config.update(SETTINGS, llm_provider='openai_compatible', backend_url=env.get('HERMES_MODEL_BASE_URL') or 'http://127.0.0.1:8080/v1',
                  quick_think_llm=model, deep_think_llm=model,
                  results_dir=str(ROOT / '.local' / 'tradingagents' / 'logs'), data_cache_dir=str(ROOT / '.local' / 'tradingagents' / 'cache'),
                  memory_log_path=str(ROOT / '.local' / 'tradingagents' / 'memory.md'))
    try:
        graph = TradingAgentsGraph(selected_analysts=ANALYSTS, debug=False, config=config)
    except TypeError:  # older signatures take the analysts only through the CLI
        graph = TradingAgentsGraph(debug=False, config=config)
    return graph, {'engine': 'tradingagents', 'engineVersion': getattr(tradingagents, '__version__', 'unknown'), 'model': model}


def decide(day, symbols=SYMBOLS, graph=None, meta=None, env=os.environ, out=OUT, now=None, portfolio=None):
    """One decision per share for `day` (the last settled session), against the member's own book when there is one.
    Resumable: a share already decided is not rerun."""
    if graph is None:
        graph, meta = default_graph(env)
        portfolio = portfolio or book()
    out.mkdir(parents=True, exist_ok=True)
    path = out / f'{day}.json'
    record = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {
        'day': day, **meta, 'configVersion': config_version(), 'settings': SETTINGS, 'analysts': ANALYSTS, 'decisions': {}}
    for symbol in symbols:
        if symbol in record['decisions'] and record['decisions'][symbol].get('rating'):
            continue
        started = (now or datetime.now(timezone.utc)).isoformat()
        try:
            state, decision = graph.propagate(f'{symbol}.NS', day, portfolio=portfolio) if portfolio is not None else graph.propagate(f'{symbol}.NS', day)
            rating = rating_of(decision)
            record['decisions'][symbol] = {'rating': rating, 'rationale': rationale_of(state), 'startedAt': started,
                                           'finishedAt': datetime.now(timezone.utc).isoformat(),
                                           # gap 22: TradingAgents does not force its answer schema; on a small model the judge
                                           # may name no rating or several, so an unreadable answer is kept and counted
                                           **({} if rating else {'unreadable': True,
                                                                 'excerpt': (decision if isinstance(decision, str) else json.dumps(decision, default=str))[:300]})}
        except Exception as error:  # noqa: BLE001 - recorded, never guessed; a rerun retries the share
            record['decisions'][symbol] = {'rating': None, 'error': f'{type(error).__name__}: {str(error)[:200]}', 'startedAt': started}
        record['readability'] = readability([record])
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps(record, indent=2), encoding='utf-8')
        os.replace(tmp, path)
    return record


def readability(records):
    """How often the member's answers could be read: decisions made, rated, unreadable (no single clear rating) and
    failed (an error), with the share rated. A member whose answers are often unreadable is not ready to rely on."""
    decisions = [d for r in records for d in r.get('decisions', {}).values()]
    rated = sum(1 for d in decisions if d.get('rating'))
    unreadable = sum(1 for d in decisions if d.get('unreadable'))
    errors = sum(1 for d in decisions if d.get('error'))
    return {'decisions': len(decisions), 'rated': rated, 'unreadable': unreadable, 'errors': errors,
            'ratedPct': round(100 * rated / len(decisions), 1) if decisions else None}


def report(out=OUT):
    """Readability over every decision day so far."""
    records = [json.loads(p.read_text(encoding='utf-8')) for p in sorted(out.glob('????-??-??.json'))] if out.exists() else []
    return {'days': len(records), **readability(records)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--day', help='the last settled session (YYYY-MM-DD)')
    parser.add_argument('--symbols', default=','.join(SYMBOLS))
    parser.add_argument('--report', action='store_true', help='readability over every decision day, and stop')
    args = parser.parse_args(argv)
    if args.report:
        print(json.dumps(report(), indent=2))
        return
    if not args.day:
        parser.error('--day is required (or --report)')
    record = decide(args.day, [s for s in args.symbols.split(',') if s in SYMBOLS])
    print(json.dumps({'day': record['day'], 'ratings': {s: d.get('rating') for s, d in record['decisions'].items()},
                      'errors': sum(1 for d in record['decisions'].values() if d.get('error'))}, indent=2))


if __name__ == '__main__':
    main()
