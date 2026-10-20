"""Models compared: every saved test result, grouped by the model that produced it. Read-only.

When a stronger model replaces the local one, the same tests are rerun under the new model's name. Every result
is already keyed by model (batch rows, allocator runs), so this report puts old and new side by side:
  desk replays   net results against momentum, buy-and-hold and cash, and each bot's fitness verdict
  AI allocator   net, growth and worst drawdown against holding the basket
Only results from the same test (same batch data and desk version, or same allocator start and prompt) are
comparable; each row carries those identifiers so mismatches are visible rather than hidden.
Run: .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\model_compare.py
"""
from __future__ import annotations

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import fitness  # noqa: E402

LOCAL = Path(__file__).resolve().parents[2] / '.local' / 'trading-desk'


def read(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def desk_rows(batches):
    rows = []
    for summary_path in sorted(batches.glob('*/summary.json')) if batches.exists() else []:
        s = read(summary_path)
        if not s or not s.get('windows'):
            continue
        name = summary_path.parent.name
        try:
            verdicts = {role: card['verdict'] for role, card in fitness.evaluate(fitness.load([name], batches=batches)).items()
                        if card['verdict'] != 'not-consulted'}
        except (OSError, ValueError, KeyError):
            verdicts = {}
        manager = s.get('portfolioManager', {})
        rows.append({'test': f"desk replay · {name}", 'model': s.get('model'), 'deskVersion': s.get('deskVersion'), 'every': s.get('every'),
                     'weeks': s['windows'], 'deskNetPaise': s['desk']['netPaise'], 'deskTrades': s['desk']['trades'],
                     'momentumNetPaise': s['momentum']['netPaise'], 'buyAndHoldPaise': s['buyAndHoldPaise'],
                     'managerAccuracy': manager.get('accuracy'), 'neverTradingAccuracy': manager.get('alwaysHoldAccuracy'),
                     'fitness': verdicts})
    return rows


def allocator_rows(root):
    rows = []
    for path in sorted(root.glob('*/report.json')) if root.exists() else []:
        r = read(path)
        if not r:
            continue
        results = r.get('results', {})
        pick = lambda k: {f: results.get(k, {}).get(f) for f in ('netPaise', 'cagr', 'maxDrawdown', 'costsPaise')}  # noqa: E731
        rows.append({'test': f"AI allocator · from {r.get('from')}", 'run': r.get('name'), 'model': r.get('model'),
                     'promptVersion': r.get('promptVersion'), 'through': r.get('through'), 'months': r.get('months'),
                     'failedMonths': r.get('failedMonths'), 'averageCashPct': r.get('averageCashPct'),
                     'ai': pick('ai-allocator'), 'basket': pick('buy-and-hold-equal'), 'monthly': pick('equal-weight-monthly'),
                     'beatBasket': (results.get('ai-allocator', {}).get('netPaise', 0) > results.get('buy-and-hold-equal', {}).get('netPaise', 0))
                     if results else None})
    return rows


def compare(local=LOCAL):
    report = {'desk': desk_rows(local / 'batches'), 'allocator': allocator_rows(local / 'ai-allocator')}
    report['models'] = sorted({r['model'] for rows in report.values() for r in rows if r.get('model')})
    report['note'] = ('Compare rows of the same test only: identical batch data and desk version, or identical allocator start '
                      'and prompt. A model earns its cost only if it beats both the simple baselines and the cheaper model.')
    return report


def main():
    report = compare()
    batch.save(LOCAL / 'model-comparison.json', report)
    print(f"models: {', '.join(report['models']) or 'none yet'}")
    for r in report['desk']:
        print(f"  {r['test']} [{r['model']}]: desk {r['deskNetPaise'] / 100:,.2f} vs momentum {r['momentumNetPaise'] / 100:,.2f}, "
              f"buy-and-hold {r['buyAndHoldPaise'] / 100:,.2f}; fitness {r['fitness']}")
    for r in report['allocator']:
        ai, basket = r['ai'], r['basket']
        print(f"  {r['test']} [{r['model']}]: AI {(ai['netPaise'] or 0) / 100:,.0f} (CAGR {ai['cagr']}, worst {ai['maxDrawdown']}) "
              f"vs basket {(basket['netPaise'] or 0) / 100:,.0f} (CAGR {basket['cagr']}, worst {basket['maxDrawdown']})")


if __name__ == '__main__':
    main()
