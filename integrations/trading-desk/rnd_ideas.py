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
}
FILTERS = (None, 'trend-200d')
SPECIALTY = {'momentum': 'momentum-allocation', 'low-vol': 'risk-allocation', 'reversal': 'reversal-allocation'}


def canonical(spec):
    """The validated, normalised spec (sorted keys, only grammar fields), or ValueError naming what is wrong."""
    if not isinstance(spec, dict):
        raise ValueError('An idea is an object')
    family = spec.get('family')
    if family not in GRAMMAR:
        raise ValueError(f'family must be one of {sorted(GRAMMAR)}')
    allowed = set(GRAMMAR[family]) | {'family', 'filter'}
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
    return out


def name_of(spec):
    s = canonical(spec)
    body = {'momentum': f"momentum-{s.get('months')}m-top{s.get('keep')}", 'low-vol': f"lowvol-{s.get('window')}d-top{s.get('keep')}",
            'reversal': f"reversal-{s.get('days')}d-bottom{s.get('keep')}"}[s['family']]
    return 'idea-' + body + ('-trend' if s.get('filter') else '')


def describe(spec):
    s = canonical(spec)
    text = {'momentum': f"The {s.get('keep')} strongest shares over {s.get('months')} months",
            'low-vol': f"The {s.get('keep')} calmest shares by {s.get('window')}-day volatility",
            'reversal': f"The {s.get('keep')} weakest shares over the last {s.get('days')} days"}[s['family']]
    return text + ', equal weights, monthly' + (', in cash while the universe is below its 200-day average' if s.get('filter') else '')


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


def rule_of(spec):
    """The audited rule for a valid spec: weights(table, dates, i) from completed days only."""
    s = canonical(spec)
    if s['family'] == 'momentum':
        base = lambda t, d, i: pd.top_momentum(t, d, i, months=s['months'], keep=s['keep'])  # noqa: E731
    elif s['family'] == 'low-vol':
        base = lambda t, d, i: _calmest(t, d, i, s['window'], s['keep'])  # noqa: E731
    else:
        base = lambda t, d, i: _weakest(t, d, i, s['days'], s['keep'])  # noqa: E731
    if not s.get('filter'):
        return base
    return lambda t, d, i: base(t, d, i) if pd.trend_filtered(t, d, i) else {}


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
          'history that has already been used (seen data): do not simply copy the best result.')
SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['ideas'], 'properties': {
    'ideas': {'type': 'array', 'maxItems': MAX_NEW_PER_MONTH, 'items': {'anyOf': [
        {'type': 'object', 'additionalProperties': False, 'required': ['family', *fields, 'filter', 'why'], 'properties': {
            'family': {'const': family}, **{f: {'type': 'integer', 'minimum': lo, 'maximum': hi} for f, (lo, hi) in fields.items()},
            'filter': {'enum': [None, 'trend-200d']}, 'why': {'type': 'string', 'maxLength': 300}}}
        for family, fields in GRAMMAR.items()]}}}}


def invent(llm, results):
    """Asks the model for new ideas, given the results so far. The schema confines the answer to the grammar, and every
    idea is checked again here; the reason is kept with the idea. Returns specs, each with its stated reason."""
    brief = [{'name': r['name'], 'spec': r.get('spec'), 'ahead': r['ahead'], 'behind': r['behind'], 'pValue': r['pValue']} for r in results][:40]
    value, _ = llm(SYSTEM, json.dumps({'resultsSoFar': brief, 'grammar': {k: {f: list(b) for f, b in v.items()} for k, v in GRAMMAR.items()}}), SCHEMA)
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
        variants.append({k: v for k, v in s.items() if k != 'filter'} if s.get('filter') else {**s, 'filter': 'trend-200d'})
    unique, seen = [], set()
    for v in variants:
        if spec_hash(v) not in seen:
            seen.add(spec_hash(v))
            unique.append(v)
    return unique[:limit * 4]
