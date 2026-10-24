"""Outcome labels (MODEL-DATA-02): reality as the teacher. Each debate argument the organisation posted is labelled by
what actually happened to the call it argued about, once the backend has scored that call: an opposing argument was
right when the call turned out wrong, a supporting one when it turned out right (the backend's own challenger rule).
The labels (.local/trading-desk/outcome-labels.json, keyed by the fingerprint of what the model saw) let
build_dataset.py mark the model's own past answers as desirable or undesirable for a future fine-tune: the model learns
from its own decisions and their real results, never from another model's answers. Read-only (evaluator credential).
  .local\\replay-venv\\Scripts\\python.exe integrations\\trading-desk\\outcome_labels.py
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import batch  # noqa: E402
import daily  # noqa: E402
import debate  # noqa: E402
import review_scorecard  # noqa: E402
import signal_scorer as sc  # noqa: E402

OUT = daily.ROOT / '.local' / 'trading-desk' / 'outcome-labels.json'


def labels(log_rows, signals, now=None):
    """userHash -> {right, signalId, side, moveBps} for every logged argument whose call has an outcome."""
    outcome = {s['id']: s['outcome'] for s in signals if s.get('outcome')}
    out = {}
    for row in log_rows:
        o = outcome.get(row['signalId'])
        if not o:
            continue
        right = (not o['correct']) if row['stance'] == 'oppose' else bool(o['correct'])
        out[row['userHash']] = {'right': right, 'signalId': row['signalId'], 'side': row['side'], 'moveBps': o.get('moveBps'),
                                'labelledAt': (now or datetime.now(timezone.utc)).isoformat()}
    return out


def run(env=os.environ, opener=None, log_path=None, out=OUT):
    from urllib import request as urlrequest
    path = Path(log_path or debate.DEBATE_LOG)
    rows = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()] if path.exists() else []
    signals = review_scorecard.all_signals(*sc.principals(env, 'evaluator'), opener or urlrequest.urlopen) if rows else []
    result = labels(rows, signals)
    batch.save(Path(out), {'labels': result, 'arguments': len(rows), 'labelled': len(result),
                           'note': 'Right or wrong by the backend\'s own scoring of the call each argument was about.'})
    return {'arguments': len(rows), 'labelled': len(result), 'right': sum(v['right'] for v in result.values())}


if __name__ == '__main__':
    print(json.dumps(run()))
