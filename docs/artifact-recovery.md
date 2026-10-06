# Artifact monitoring and recovery

> Documentation refreshed for v0.1.21 (5 October 2026). [Current implementation, validation and limits](current-status.md). Dated milestones and design proposals retain their original scope.

Current through v0.1.21. These commands operate on research artifacts, never financial transfers or trading orders. Run from the project root with the configured scoped researcher identity. The default journal directory is `integrations/skfolio/.state/paired-artifacts`; use `--state PATH` consistently if it differs.

## Inspect before recovery

```powershell
npm run worker:recover-artifacts -- --list
npm run worker:recover-artifacts -- --inspect --journal JOURNAL_ID
npm run lifecycle:admin -- execution-reports
```

Replace `JOURNAL_ID` with the exact 64-character identifier returned by the runner/listing. Local inspection opens SQLite read-only and does not call the backend. Listing returns at most 100 identifiers and indicates truncation; a known exact ID can still be inspected directly. Invalid, unreadable and differently scoped files produce fixed unavailable summaries. Raw tokens, errors, solver answers and arbitrary filenames are excluded.

`submission-saved-unconfirmed` means a payload exists locally, not that the backend has or has not accepted it. `acknowledgement-saved` is historical local evidence. `running` is only the last recorded attempt state; liveness remains unknown. Queue counts exclude events not yet enqueued and are null if the outbox has not been initialized. Recovery validates payloads again.

The owner backend view separates worker observations from backend submission/review facts. Migration 015 makes each experiment's stream and ordered observations append-only. Only its assigned researcher can report matching plan/producer hashes; mode and image identity cannot change. At most 16 enum-coded events are accepted. Starts, terminal outcomes, two-attempt limits and submission acknowledgements have checked transitions. Duplicate observations do not create duplicate owner notifications. Raw exception text is not accepted.

Reporting remains allowed after cancellation, halt or expiry so historical operational failures remain visible. This does not authorize new work. Reports do not grade, promote, change permissions or establish attestation/liveness. They use the existing owner inbox; no external push channel is configured.

## Recover one journal

```powershell
npm run worker:recover-artifacts -- --journal JOURNAL_ID
npm run worker:recover-artifacts -- --report-only --journal JOURNAL_ID
```

Recovery checks the original origin, credential hash, experiment, saved work and payload identity, then uses the original submission idempotency key. It needs neither source descriptors nor matching old execution binaries because it never executes an artifact. Original files/runtime are still needed for ordinary execution retries. A saved backend acknowledgement prevents another submission; pending reports can still flush. Missing complete payloads require report-only mode, not invented answers or a reset attempt budget.

The journal lock serializes operations against the normal executor. Lost responses retain the same saved payload. API outages retain durable outbox events. A later invocation retries them; no background scheduler is installed. Moving/deleting journals or rotating credentials is not a supported way to reset history. Journals are trusted local state, not tamper-proof evidence.

## Run one bounded recovery pass

Create a JSON file containing 1–10 distinct journal IDs chosen from inspection:

```json
["REPLACE_WITH_A_REAL_64_CHARACTER_JOURNAL_ID"]
```

```powershell
npm run worker:recover-artifacts -- --batch .local/recovery-selection.json
```

The placeholder above is deliberately not a runnable identifier. The command validates the entire selection before work, processes it once sequentially and never scans for work to execute. Complete saved submissions are replayed; incomplete runs only flush reports. An individual failure does not stop other selected journals. Results distinguish `completed`, `pending-reports` and `needs-attention`; any unresolved item gives exit code 1. `completed` describes this recovery operation, not a passing experiment or recovered Docker container. Existing HTTP retries remain bounded. No recurring run, new artifact attempt, model call, release or financial permission is created.

Container cleanup is separate: `artifact_executor.py sandbox-recover` checks the recorded ownership registry before deletion. Submission replay does not imply that an earlier container was cleaned up. See [execution](artifact-execution.md) and [security](security-and-operations.md).

## Code and validation

`artifact_recovery.py`, `artifact_inspection.py`, `artifact_batch.py` and `execution_reporting.py` implement this workflow; the Node launcher supplies the researcher credential. Tests cover read-only inspection, bounded selection, mixed failures, stale runtime recovery, response loss, reporting outages, identity mismatch and no re-execution. The actual HTTP fixture verifies inspection before/after batch recovery, exactly two original solver runs, independent grading and no financial writes. See [verification](verification.md).
