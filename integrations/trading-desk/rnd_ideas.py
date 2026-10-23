"""R&D ideas (RND-03): how the research department invents new strategy ideas by itself, safely. Research only; no orders.

An idea is a SPECIFICATION in a fixed grammar, never code: a family and its parameters, each within bounds. Whoever
proposes it (the local model, or the deterministic explorer below), nothing unreviewed ever executes: the grammar maps a
valid spec onto a small set of audited rule builders. Every idea ever proposed is appended to a ledger
(.local/trading-desk/rnd/ideas.jsonl) with who proposed it and when, and is never removed. The scout's significance bar is
0.05 divided by ALL ideas ever tried (the fixed catalogue plus the ledger), so inventing more ideas makes passing harder,
never easier: luck cannot be mined.

Families (all monthly, long-only, equal weight over the chosen shares, the desk's eight NSE shares):
  momentum     the `keep` strongest shares over `months` months; optional `filter: trend-200d` (cash when the universe
               is below its 200-day average)
  low-vol      the `keep` calmest shares by `window`-day volatility; optional trend filter
  reversal     the `keep` weakest shares over the last `days` days; optional trend filter
  trend-template  shares in a Minervini-style uptrend (close above the 50-day average, the 50-day above the 200-day, the
               200-day rising over a month) within `nearHighPct`% of their 52-week high, the `keep` strongest over 6 months
  pullback     shares above their 200-day average whose 14-day RSI is at most `rsiMax`, the `keep` most oversold
               (a dip in an uptrend; adapted from the dividend-growth pullback screener)
  Filters: `trend-200d` (cash when the universe is below its 200-day average), `distribution-days` (cash when the
  market regime's distribution-day risk is HIGH or SEVERE; market_regime.py) or `distribution-ftd` (the same, but back in
  once a follow-through day has confirmed a new uptrend; adapted from claude-trading-skills' FTD method, MIT).
  Every family may set `rebalance` to 3, 6 or 12 months (default monthly): the decision is taken at the start of each
  quarter, half-year or year and held, so it trades less, pays less cost and defers tax to the long-term rate.
  combo        the `keep` best shares on three equal ranks: `months` momentum, `window`-day calm (low volatility) and
               consistency (rising months in the last year): weak signals combined, as factor funds do
  The trend-template and pullback families and the distribution-day filter adapt methods from claude-trading-skills (MIT).
  A family that finds fewer qualifying shares than `keep` holds only those, the rest in cash.
Proposals are bounded: at most MAX_NEW_PER_MONTH new ideas a calendar month, and duplicates (same canonical spec as
anything in the catalogue or the ledger) are refused.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import daily  # noqa: E402
import portfolio_daily as pd  # noqa: E402

LEDGER = daily.ROOT / '.local' / 'trading-desk' / 'rnd' / 'ideas.jsonl'
MAX_NEW_PER_MONTH = 3
GRAMMAR = {
    'momentum': {'months': (1, 12), 'keep': (1, 5)},
    'low-vol': {'window': (20, 120), 'keep': (1, 5)},
    'reversal': {'days': (5, 63), 'keep': (1, 5)},
    'trend-template': {'nearHighPct': (5, 40), 'keep': (1, 5)},
    'pullback': {'rsiMax': (20, 50), 'keep': (1, 5)},
    'combo': {'months': (3, 12), 'window': (20, 120), 'keep': (1, 5)},
}
FILTERS = (None, 'trend-200d', 'distribution-days', 'distribution-ftd')
REBALANCE = (1, 3, 6, 12)   # months between rebalances; slower trading pays less cost and less short-term tax
REBALANCE_SUFFIX = {3: '-q', 6: '-h', 12: '-y'}
SPECIALTY = {'momentum': 'momentum-allocation', 'low-vol': 'risk-allocation', 'reversal': 'reversal-allocation',
             'trend-template': 'trend-allocation', 'pullback': 'pullback-allocation', 'combo': 'multi-factor-allocation'}
SUFFIX = {'trend-200d': '-trend', 'distribution-days': '-dd', 'distribution-ftd': '-ddftd'}


def canonical(spec):
    """The validated, normalised spec (sorted keys, only grammar fields), or ValueError naming what is wrong."""
    if not isinstance(spec, dict):
        raise ValueError('An idea is an object')
    family = spec.get('family')
    if family not in GRAMMAR:
        raise ValueError(f'family must be one of {sorted(GRAMMAR)}')
    allowed = set(GRAMMAR[family]) | {'family', 'filter', 'rebalance'}
    if set(spec) - allowed:
        raise ValueError(f'unknown fields for {family}: {sorted(set(spec) - allowed)}')
    out = {'family': family}
    for name, (low, high) in GRAMMAR[family].items():
        value = spec.get(name)
        if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
            raise ValueError(f'{name} must be a whole number from {low} to {high}')
        out[name] = value
    if spec.get('filter') not in FILTERS:
        raise ValueError(f'filter must be one of {FILTERS}')
    if spec.get('filter'):
        out['filter'] = spec['filter']
    every = spec.get('rebalance', 1)
    if every is None:
        every = 1
    if not isinstance(every, int) or isinstance(every, bool) or every not in REBALANCE:
        raise ValueError(f'rebalance must be one of {REBALANCE} months')
    if every != 1:  # monthly is the default and stays out of the spec, so every earlier idea keeps its hash
        out['rebalance'] = every
    return out


def name_of(spec):
    s = canonical(spec)
    body = {'momentum': f"momentum-{s.get('months')}m-top{s.get('keep')}", 'low-vol': f"lowvol-{s.get('window')}d-top{s.get('keep')}",
            'reversal': f"reversal-{s.get('days')}d-bottom{s.get('keep')}",
            'trend-template': f"trendtemplate-{s.get('nearHighPct')}pct-top{s.get('keep')}",
            'pullback': f"pullback-rsi{s.get('rsiMax')}-top{s.get('keep')}",
            'combo': f"combo-{s.get('months')}m-{s.get('window')}d-top{s.get('keep')}"}[s['family']]
    return 'idea-' + body + SUFFIX.get(s.get('filter'), '') + REBALANCE_SUFFIX.get(s.get('rebalance', 1), '')


def describe(spec):
    s = canonical(spec)
    text = {'momentum': f"The {s.get('keep')} strongest shares over {s.get('months')} months",
            'low-vol': f"The {s.get('keep')} calmest shares by {s.get('window')}-day volatility",
            'reversal': f"The {s.get('keep')} weakest shares over the last {s.get('days')} days",
            'trend-template': f"Up to {s.get('keep')} shares in a Minervini-style uptrend within {s.get('nearHighPct')}% of their 52-week high, strongest first",
            'pullback': f"Up to {s.get('keep')} shares above their 200-day average with a 14-day RSI of at most {s.get('rsiMax')}, most oversold first",
            'combo': (f"The {s.get('keep')} best shares on three equal ranks: {s.get('months')}-month momentum, {s.get('window')}-day calm "
                      f"(low volatility) and consistency (share of rising months in the last year)")}[s['family']]
    tail = {'trend-200d': ', in cash while the universe is below its 200-day average',
            'distribution-days': ', in cash while distribution-day risk is high',
            'distribution-ftd': ', in cash while distribution-day risk is high unless a follow-through day has confirmed a new uptrend'}.get(s.get('filter'), '')
    every = s.get('rebalance', 1)
    return text + ', equal weights, ' + ('monthly' if every == 1 else f'rebalanced every {every} months') + tail


def _every(rule, months):
    """Holds the weights chosen at the latest rebalance month (a calendar month number divisible by `months`, so quarters
    start in Jan/Apr/Jul/Oct and years in January) until the next one. Uses only days up to i."""
    def held(table, dates, i):
        j = i
        while j > 0:
            if dates[j][:7] != dates[j - 1][:7] and (int(dates[j][:4]) * 12 + int(dates[j][5:7]) - 1) % months == 0:
                break
            j -= 1
        return rule(table, dates, j) if j > 0 else {}
    held.holdsBetween = True  # the scout lets its positions drift instead of rebalancing them every month
    return held


def _sma(table, symbol, dates, i, window):
    c = pd.closes(table, symbol, dates, i, window)
    return sum(c) / window if len(c) == window else None


def _trend_template(table, dates, i, near_high_pct, keep):
    if i < 273:  # the 200-day average a month ago, and a 52-week high
        return {}
    chosen = []
    for s in table:
        close = table[s][dates[i]]['closePaise']
        m50, m200, m200_before = _sma(table, s, dates, i, 50), _sma(table, s, dates, i, 200), _sma(table, s, dates, i - 21, 200)
        high = max(table[s][d]['highPaise'] for d in dates[i - 251:i + 1])
        if close > m50 > m200 > m200_before and close >= high * (1 - near_high_pct / 100):
            chosen.append(s)
    chosen.sort(key=lambda s: (-table[s][dates[i]]['closePaise'] / table[s][dates[i - 126]]['closePaise'], s))
    return {s: 1 / keep for s in chosen[:keep]}


def rsi(table, symbol, dates, i, window=14):
    """RSI over the last `window` changes with simple averages (Cutler's form, not Wilder's smoothing), or None without
    enough history."""
    c = pd.closes(table, symbol, dates, i, window + 1)
    if len(c) <= window:
        return None
    gains = sum(max(0, c[k] - c[k - 1]) for k in range(1, len(c)))
    losses = sum(max(0, c[k - 1] - c[k]) for k in range(1, len(c)))
    return 100.0 if losses == 0 else 100 - 100 / (1 + gains / losses)


def _pullback(table, dates, i, rsi_max, keep):
    if i < 200:
        return {}
    scored = {}
    for s in table:
        r = rsi(table, s, dates, i)
        if r is not None and r <= rsi_max and table[s][dates[i]]['closePaise'] > _sma(table, s, dates, i, 200):
            scored[s] = r
    return {s: 1 / keep for s in sorted(scored, key=lambda s: (scored[s], s))[:keep]}


def _calmest(table, dates, i, window, keep):
    vols = {}
    for symbol in table:
        c = pd.closes(table, symbol, dates, i, window + 1)
        if len(c) <= window:
            return {}
        vols[symbol] = statistics.pstdev([math.log(c[k] / c[k - 1]) for k in range(1, len(c))])
    return {symbol: 1 / keep for symbol in sorted(vols, key=lambda x: (vols[x], x))[:keep]}


def _weakest(table, dates, i, days, keep):
    if i < days:
        return {}
    ranked = sorted(table, key=lambda x: (table[x][dates[i]]['closePaise'] / table[x][dates[i - days]]['closePaise'], x))
    return {symbol: 1 / keep for symbol in ranked[:keep]}


def _combo(table, dates, i, months, window, keep):
    """Average of three ranks (1 = best): momentum over `months`, calm over `window` days, and consistency (rising months
    out of the last 12). Combining weak signals is steadier than any one; ties break by symbol."""
    days = 21 * months
    if i < max(days, window, 252):
        return {}
    names = sorted(table)
    momentum = {s: table[s][dates[i]]['closePaise'] / table[s][dates[i - days]]['closePaise'] for s in names}
    calm = {}
    for s in names:
        c = pd.closes(table, s, dates, i, window + 1)
        calm[s] = statistics.pstdev([math.log(c[k] / c[k - 1]) for k in range(1, len(c))])
    steady = {s: sum(table[s][dates[i - 21 * m]]['closePaise'] > table[s][dates[i - 21 * (m + 1)]]['closePaise'] for m in range(12)) for s in names}

    def ranks(values, best_high):
        order = sorted(names, key=lambda s: (-values[s] if best_high else values[s], s))
        return {s: k for k, s in enumerate(order, 1)}
    r = [ranks(momentum, True), ranks(calm, False), ranks(steady, True)]
    score = {s: sum(x[s] for x in r) / 3 for s in names}
    return {s: 1 / keep for s in sorted(names, key=lambda s: (score[s], s))[:keep]}


def rule_of(spec):
    """The audited rule for a valid spec: weights(table, dates, i) from completed days only."""
    s = canonical(spec)
    if s['family'] == 'momentum':
        base = lambda t, d, i: pd.top_momentum(t, d, i, months=s['months'], keep=s['keep'])  # noqa: E731
    elif s['family'] == 'low-vol':
        base = lambda t, d, i: _calmest(t, d, i, s['window'], s['keep'])  # noqa: E731
    elif s['family'] == 'reversal':
        base = lambda t, d, i: _weakest(t, d, i, s['days'], s['keep'])  # noqa: E731
    elif s['family'] == 'trend-template':
        base = lambda t, d, i: _trend_template(t, d, i, s['nearHighPct'], s['keep'])  # noqa: E731
    elif s['family'] == 'combo':
        base = lambda t, d, i: _combo(t, d, i, s['months'], s['window'], s['keep'])  # noqa: E731
    else:
        base = lambda t, d, i: _pullback(t, d, i, s['rsiMax'], s['keep'])  # noqa: E731
    if not s.get('filter'):
        rule = base
    elif s['filter'] == 'distribution-days':
        import market_regime
        rule = lambda t, d, i: base(t, d, i) if market_regime.calm(t, d, i) else {}  # noqa: E731
    elif s['filter'] == 'distribution-ftd':
        import market_regime
        rule = lambda t, d, i: base(t, d, i) if market_regime.calm_or_followed_through(t, d, i) else {}  # noqa: E731
    else:
        rule = lambda t, d, i: base(t, d, i) if pd.trend_filtered(t, d, i) else {}  # noqa: E731
    # the whole decision, filter included, is taken only at a rebalance month and held until the next
    return _every(rule, s['rebalance']) if s.get('rebalance', 1) != 1 else rule


def spec_hash(spec):
    return hashlib.sha256(json.dumps(canonical(spec), sort_keys=True).encode()).hexdigest()[:16]


def ledger(path=LEDGER):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]


def propose(specs, proposer, known_hashes=(), path=LEDGER, now=None):
    """Appends new, valid, non-duplicate ideas to the ledger, at most MAX_NEW_PER_MONTH a month. Returns what happened
    to each proposal. Rejected proposals are reported, never stored as ideas (they were never tested)."""
    now = now or datetime.now(timezone.utc)
    entries = ledger(path)
    seen = {e['hash'] for e in entries} | set(known_hashes)
    month = now.strftime('%Y-%m')
    used = sum(e['at'][:7] == month for e in entries)
    out = []
    for raw in specs:
        try:
            spec = canonical(raw)
        except ValueError as error:
            out.append({'spec': raw, 'outcome': 'invalid', 'reason': str(error)})
            continue
        h = spec_hash(spec)
        if h in seen:
            out.append({'spec': spec, 'outcome': 'duplicate', 'name': name_of(spec)})
            continue
        if used >= MAX_NEW_PER_MONTH:
            out.append({'spec': spec, 'outcome': 'monthly-limit', 'reason': f'at most {MAX_NEW_PER_MONTH} new ideas a month'})
            continue
        entry = {'hash': h, 'name': name_of(spec), 'spec': spec, 'proposer': str(proposer)[:80], 'at': now.isoformat()}
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('a', encoding='utf-8') as handle:
            handle.write(json.dumps(entry, sort_keys=True) + '\n')
        seen.add(h)
        used += 1
        out.append({'spec': spec, 'outcome': 'added', 'name': entry['name']})
    return out


SYSTEM = ('You are the research department of a paper-trading organisation that holds 8 large NSE shares. You invent simple '
          'monthly allocation rules. You may only answer with rule specifications in the given JSON schema; you never write '
          'code. Every idea you propose is recorded forever and raises the statistical bar for all ideas, so propose only '
          f'ideas you think are genuinely different and promising, at most {MAX_NEW_PER_MONTH}. The results you see are on '
          'history that has already been used (seen data): do not simply copy the best result. Read the lessons: they are '
          'what the organisation already learned about these methods, including what failed.')
SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['ideas'], 'properties': {
    'ideas': {'type': 'array', 'maxItems': MAX_NEW_PER_MONTH, 'items': {'anyOf': [
        {'type': 'object', 'additionalProperties': False, 'required': ['family', *fields, 'filter', 'why'], 'properties': {
            'family': {'const': family}, **{f: {'type': 'integer', 'minimum': lo, 'maximum': hi} for f, (lo, hi) in fields.items()},
            'filter': {'enum': list(FILTERS)}, 'rebalance': {'enum': list(REBALANCE)}, 'why': {'type': 'string', 'maxLength': 300}}}
        for family, fields in GRAMMAR.items()]}}}}


KNOWLEDGE = Path(__file__).resolve().parent / 'knowledge' / 'methods.json'


def lessons(path=KNOWLEDGE):
    """What the organisation has learned about methods (knowledge/methods.json): one line per card, for the model."""
    if not Path(path).exists():
        return []
    return [{'method': c['id'], 'result': c['result'], 'lesson': c['lesson']} for c in json.loads(Path(path).read_text(encoding='utf-8'))['cards']]


def invent(llm, results):
    """Asks the model for new ideas, given the results so far and the organisation's method lessons. The schema confines
    the answer to the grammar, and every idea is checked again here; the reason is kept with the idea. Returns specs,
    each with its stated reason."""
    brief = [{'name': r['name'], 'spec': r.get('spec'), 'ahead': r['ahead'], 'behind': r['behind'], 'pValue': r['pValue'],
              **({'beatsRandomPct': r['beatsRandomPct']} if r.get('beatsRandomPct') is not None else {})} for r in results][:40]
    value, _ = llm(SYSTEM, json.dumps({'resultsSoFar': brief, 'lessons': lessons(),
                                       'grammar': {k: {f: list(b) for f, b in v.items()} for k, v in GRAMMAR.items()}}), SCHEMA)
    out = []
    for idea in (value or {}).get('ideas', [])[:MAX_NEW_PER_MONTH]:
        why = str(idea.get('why', ''))[:300] if isinstance(idea, dict) else ''
        spec = {k: v for k, v in idea.items() if k != 'why'} if isinstance(idea, dict) else idea
        if isinstance(spec, dict) and spec.get('filter') is None:
            spec.pop('filter', None)
        out.append({'spec': spec, 'why': why})
    return out


def explore(results, limit=MAX_NEW_PER_MONTH):
    """The deterministic explorer: close variants of the best ideas so far (one parameter step each way, and the trend
    filter switched), best first. It only proposes; the ledger and the Bonferroni bar decide what counts."""
    variants = []
    for r in results:
        spec = r.get('spec')
        if not spec:
            continue
        s = canonical(spec)
        for name, (low, high) in GRAMMAR[s['family']].items():
            step = 1 if name in ('months', 'keep') else max(1, (high - low) // 10)
            for value in (s[name] - step, s[name] + step):
                if low <= value <= high:
                    variants.append({**s, name: value})
        variants += [{**{k: v for k, v in s.items() if k != 'filter'}, **({'filter': f} if f else {})} for f in FILTERS if f != s.get('filter')]
        variants += [{**{k: v for k, v in s.items() if k != 'rebalance'}, **({'rebalance': m} if m != 1 else {})}
                     for m in REBALANCE if m != s.get('rebalance', 1)]
    unique, seen = [], set()
    for v in variants:
        if spec_hash(v) not in seen:
            seen.add(spec_hash(v))
            unique.append(v)
    return unique[:limit * 4]
