# Owner organisation report

> [Current implementation, validation and limits](current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

## Additional execution view

The organisation summary remains unchanged. Use `npm run lifecycle:admin -- execution-reports` for the separate owner/evaluator view of paired-artifact events and independent backend submission/review facts. Local inspection and finite recovery are documented in [artifact recovery](artifact-recovery.md); neither makes worker liveness known.

Version 0.1.6 adds `GET /v1/organisation/report`, available only to the owner. It answers “what is happening, what is waiting, and why?” for the managed research community. The endpoint and its regression cases are written but have not been built or run.

Version 0.1.7 also adds learning and R&D policy/counter snapshots to this report. See [learning and development](learning-and-development.md) for those workflows and new migrations 007/008. These additions are also unexecuted.

Version 0.1.8 adds `development.experiments` counters for registered, pending, historically supported, not-supported and cancelled plans. They describe historical records. Current source/memory validity is exposed separately by experiment status; see [registered experiments](development-experiments.md). Migration 009 and this increment remain unexecuted.

The owner subsequently confirmed an empty v0.1.8 report response; full workflow validation remains pending. Version 0.1.10 adds `workers` with per-role supervisor telemetry and computes `workerLiveness` from its current session leases. See [department monitoring](department-monitoring.md); this newest increment is unexecuted.

After rebuilding and restarting the backend in your own terminal, inspect it with:

```cmd
npm run lifecycle:admin -- report
```

The command uses the existing local owner credential and prints a JSON snapshot. It does not start a worker, enable policies, acknowledge notifications, reconcile expired leases or transfer money. The backend remains paper-only. No new dependencies or database migrations are added in this increment; the prior migrations 005/006 still apply on startup if they have not already been applied.

## Reading the report

| Field | Meaning |
| --- | --- |
| `generatedAt` | Database snapshot time. |
| `summary` | Managed student, ready-for-assignment, pending evaluation and retired counts. These are not all bots in the original manual workflow. |
| `control`, `blockers` | Global halt reason and lifecycle/dispatch policy pauses. |
| `lifecycle` | Policy revision, population, blueprint state counts, birth capacity, last cycle and cooldown. Capacity does not certify that a blueprint can be admitted. |
| `dispatch` | Policy revision, approved dataset count, rolling-day/lifetime usage and remaining capacity. Failed/cancelled assignments still consume capacity. |
| `students` | Each student's stage, method, reputation, curriculum validity, available windows, pending work, reason codes and suggested next action. |
| `recentAssignmentFailures` | Latest twenty failed assignment records, with attempts and reason. These are operational failures, not negative skill scores. |
| `notifications` | Total unread count and latest twenty unread summaries. Reading does not acknowledge them. |
| `workerLiveness`, `workers` | Since v0.1.10: aggregate and individual supervisor freshness, phase and cycle counters. Without sessions the aggregate remains `not-observed`. Reports are not proof of useful research work. |

`canAssignNow` means that, at this snapshot, a managed college student meets dispatch conditions and the shared allocation budget has capacity. It is not a reservation. Ten students can be ready while only one assignment remains available; the next dispatcher cycle enforces the shared limit and fairness order. `availableWindowCount` counts individually eligible datasets; those datasets can overlap each other until one is consumed. The dispatcher and report use the same query to exclude overlap with the student's historical work.

`readyToArchive` means the retirement request is pending, lifecycle is enabled, the system is not halted, and no work currently blocks archival. A lifecycle cycle must still run after its cooldown and re-evaluate current evidence and fitness. Retirement, reputation and example scores are not proof of profitable trading or permission to trade.

## Common reasons

| Code | Interpretation |
| --- | --- |
| `SYSTEM_HALTED` | Owner/incident halt blocks new research work. |
| `LIFECYCLE_DISABLED`, `DISPATCH_DISABLED` | The corresponding owner-controlled policy is disabled. |
| `CURRICULUM_MISSING`, `CURRICULUM_INVALID` | The student lacks current independently reviewed learning references. |
| `SCHOOL_PENDING` | The lifecycle still needs to admit the student to college. |
| `RESEARCH_QUEUED` | An existing assignment needs a researcher claim. |
| `RESEARCH_RUNNING` | A current lease exists; the worker may or may not actually be running. |
| `LEASE_EXPIRED` | The lease has expired and needs the normal reconciliation path. The report does not mutate it. |
| `ASSIGNMENT_INELIGIBLE` | Curriculum or dataset evidence no longer supports pending work. |
| `EVALUATION_PENDING` | A submitted portfolio needs independent review or owner cancellation. |
| `DATASET_POOL_EMPTY`, `NO_FRESH_WINDOWS` | No approved pool, or no currently supported unused windows for this student. |
| `DAILY_ASSIGNMENT_CAP`, `LIFETIME_ASSIGNMENT_CAP` | New allocation is blocked by owner-set capacity. Existing assignments are not cancelled by these counters. |
| `RETIREMENT_PENDING` | The next lifecycle action must drain/cancel work and preserve history before archival. |

The report may show multiple reasons. For example, a student can have revoked curriculum, an expired lease and a system halt simultaneously. It exposes assignment IDs and expiry times, never lease tokens, fitted weights or holdout observations. Detailed financial reporting remains in `/treasury` and its owner ledger endpoint.

This is an on-demand backend report, not an email/push service, scheduled summary, UI dashboard or autonomous repair agent. Existing audit events still feed the durable owner inbox.

## Implementation and review status

`backend/src/organisation-report.ts` builds a read-only snapshot under the existing database command lock. `research-eligibility.ts` shares dataset eligibility with dispatch. Portfolio submission now uses a shared curriculum check that rejects both revoked references and an empty curriculum; previously the submission check only searched for invalid references.

Three added regression cases in `backend/test/dispatch.test.ts` cover owner-only access/read-only behaviour, ready→queued→running→evaluation→capacity states, overlapping-window exclusion, lease-token omission, and expired/revoked/halted work visibility. No build or test was executed, respecting the owner's instruction to handle terminal execution. Source review is not runtime validation.

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
