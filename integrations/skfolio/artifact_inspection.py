"""Scoped, read-only local observations; never establish worker liveness."""
import hashlib
import heapq
import json
from pathlib import Path
import re
import sqlite3
import uuid

from artifact_executor import digest


def inspect_journal(client, journal, state):
    if not isinstance(journal, str) or not re.fullmatch(r'[a-f0-9]{64}', journal):
        raise ValueError('Exact journal identifier required')
    directory = Path(state).resolve(strict=True)
    path = (directory / (journal + '.sqlite')).resolve(strict=True)
    if path.parent != directory or not path.is_file():
        raise ValueError('Journal outside state directory')
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=1)
    try:
        db.execute('PRAGMA query_only=ON')
        db.execute('PRAGMA trusted_schema=OFF')
        db.execute('BEGIN')
        row = db.execute('SELECT binding, work IS NOT NULL, payload IS NOT NULL, response IS NOT NULL FROM job WHERE id=1').fetchone()
        if not row or not isinstance(row[0], str) or len(row[0]) > 16384:
            raise ValueError('Invalid journal binding')
        binding = json.loads(row[0])
        if not isinstance(binding, dict) or not isinstance(binding.get('experimentId'), str):
            raise ValueError('Invalid journal identity')
        experiment = str(uuid.UUID(binding['experimentId']))
        scope = {'origin': client.base, 'credentialHash': hashlib.sha256(client.token.encode()).hexdigest(), 'experimentId': experiment}
        if any(binding.get(k) != v for k, v in scope.items()) or digest(scope) != journal:
            raise ValueError('Journal identity mismatch')
        attempts = db.execute('SELECT arm,state FROM attempts ORDER BY id LIMIT 5').fetchall()
        if len(attempts) > 4 or any(arm not in ('baseline', 'candidate') or status not in ('running', 'completed', 'failed', 'interrupted') for arm, status in attempts):
            raise ValueError('Invalid attempt history')
        arms = {}
        for arm in ('baseline', 'candidate'):
            history = [status for name, status in attempts if name == arm]
            if len(history) > 2:
                raise ValueError('Invalid retry history')
            arms[arm] = {'attempts': len(history), 'lastRecordedState': history[-1] if history else 'not-started'}
        outbox = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_outbox'").fetchone()
        pending = None
        if outbox:
            counts = db.execute('SELECT count(*),coalesce(sum(CASE WHEN delivered=0 THEN 1 ELSE 0 END),0) FROM execution_outbox').fetchone()
            if counts[0] > 16:
                raise ValueError('Invalid reporting history')
            pending = counts[1]
        status = 'acknowledgement-saved' if row[3] else 'submission-saved-unconfirmed' if row[2] else 'work-incomplete' if row[1] else 'awaiting-work'
        return {'journal': journal, 'experimentId': experiment, 'localStatus': status, 'arms': arms,
                'queuedReports': pending, 'reportQueueInitialized': bool(outbox),
                'nextAction': 'inspect-reports' if row[3] else 'recover-saved-submission' if row[2] else 'review-original-run',
                'liveness': 'not-established', 'backendStatus': 'not-queried', 'verifiedExecution': False,
                'limitation': 'Local snapshot only. Saved payloads require recovery validation; queued counts exclude observations not yet enqueued.'}
    finally:
        db.close()


def list_journals(client, state):
    directory = Path(state)
    if not directory.exists():
        return {'journals': [], 'truncated': False}
    # Only generated identifiers are exposed, never arbitrary filenames or paths.
    names = heapq.nsmallest(101, (p.stem for p in directory.iterdir()
                                if re.fullmatch(r'[a-f0-9]{64}\.sqlite', p.name) and not p.is_symlink()))
    results = []
    for name in names[:100]:
        try:
            results.append(inspect_journal(client, name, directory))
        except (ValueError, KeyError, TypeError, sqlite3.Error, OSError):
            results.append({'journal': name, 'localStatus': 'unavailable',
                            'reason': 'Unreadable, invalid or outside the current credential scope'})
    return {'journals': results, 'truncated': len(names) > 100}
