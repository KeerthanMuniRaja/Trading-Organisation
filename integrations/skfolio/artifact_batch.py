"""One bounded recovery pass over explicitly selected journals; no execution."""
import re

from artifact_inspection import inspect_journal
from artifact_recovery import recover


def recover_batch(client, journals, state):
    if (not isinstance(journals, list) or not 1 <= len(journals) <= 10
            or any(not isinstance(j, str) or not re.fullmatch(r'[a-f0-9]{64}', j) for j in journals)
            or len(set(journals)) != len(journals)):
        raise ValueError('Select one to ten unique journal identifiers')
    results = []
    for journal in journals:
        try:
            snapshot = inspect_journal(client, journal, state)
            # Incomplete work can only flush observations. Never rerun a solver.
            result = recover(client, journal, state, report_only=snapshot['localStatus'] not in (
                'submission-saved-unconfirmed', 'acknowledgement-saved'))
            results.append({**result, 'outcome': 'pending-reports' if result['executionReporting']['pending'] else 'completed'})
        except Exception:
            # Individual failures cannot expose arbitrary database/transport contents.
            results.append({'journal': journal, 'outcome': 'needs-attention'})
    return {'results': results, 'needsAttention': sum(r['outcome'] != 'completed' for r in results),
            'executedArtifacts': 0, 'recurring': False}
