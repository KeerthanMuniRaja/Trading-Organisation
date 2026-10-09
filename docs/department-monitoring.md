# Department supervisor sessions

> [Current implementation, validation and limits](current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

## Separate artifact observation stream

Department sessions/heartbeats remain distinct from paired-artifact observations. The latter report attempt and submission states through migration 015 and are available via `lifecycle:admin -- execution-reports`. Delayed outbox reports are not heartbeats and never establish liveness. [Artifact recovery](artifact-recovery.md) is explicitly invoked and not added to recurring department cycles.

Current v0.1.13 departments also submit producer manifests and call remediation routes. Rebuild/restart through migration 013 before using these updated workers; see [skill diagnostics](skill-diagnostics.md).

Current deployment requirement: updated v0.1.11 Python departments also call the [academy skills](academy-skills.md) endpoints. Rebuild/restart the backend through migration 011 before starting these workers; their new routes are needed even while the exam policy is disabled.

Version 0.1.10 adds authenticated supervisor sessions, heartbeat reporting and owner visibility for `worker:department` and `worker:organisation`. Backend/client tests, actual child cancellation and heartbeat-loss shutdown tests, and an isolated monitored Python team run have passed. See [organisation verification](organisation-verification.md) for repeatable checks and remaining limits.

## What is observed

The Node parent registers a session before spawning its Python department process. The backend allows one current session per department role (`researcher` or `evaluator`), even when different principals share that role. These two roles can operate simultaneously. A lease lasts 90 seconds and the parent sends a heartbeat every 20 seconds, including during fitting and retry waits. The API supplies its own timestamps.

Each heartbeat contains only a session UUID, increasing sequence number, phase, completed-cycle count and failed-cycle count. Counts describe Python process exits: zero is a completed supervisor cycle, which can include idle or disabled work. A reported completion is not proof of a fitted model, accepted trial or profitable research. Inspect assignment/trial records for actual outcomes. No host paths, process IDs, credentials, training observations or raw exceptions are included in the heartbeat.

The owner report and `GET /v1/workers` return both expected roles:

| Status | Meaning |
| --- | --- |
| `not-observed` | This role has no recorded department session. Other uninstrumented workers could still exist. |
| `responding` | A supervisor has a current lease and no unresolved reported cycle failure. This is not process-health attestation. |
| `degraded` | A current supervisor reported a failed cycle and has not subsequently reported a successful one. Entering the running phase alone does not clear this state. |
| `stale` | The session did not report stop and its lease has expired. The process may have stopped, stalled or lost contact; the API cannot determine which. |
| `stopped` | The supervisor reported a terminal stop. Last counts remain visible until a new session starts. |

`workerLiveness` in the organisation report summarises both roles: `not-observed`, `responding`, `attention-required`, or `partial-or-stopped`. The accompanying `workers` object gives the individual role, actor, session, phase, last heartbeat, expiry, last reported cycle completion and counters. This replaces the earlier always-unknown field without treating a lease as evidence of useful work.

## Recovery and notifications

Session registration retries use the same UUID. Heartbeat retries use the exact same sequence and body. Repeated messages do not extend a lease or refresh last-seen time. Rewriting a sequence, skipping a sequence, decreasing counters or reporting more than one completed/failed cycle per heartbeat is rejected. An expired/stopped session cannot renew or restart; its UUID remains in immutable session history. Starting again needs a fresh session UUID, and an old session cannot overwrite its replacement.

The transport makes at most two attempts per message with five-second request timeouts. Permission/conflict/client errors are not retried. If a heartbeat cannot be confirmed, the parent stops its direct Python child and performs no more cycles. It does not automatically acquire a replacement session. The paired team supervisor stops the other role when a role exits with an error. The existing 110-second child deadline, finite session duration and three-consecutive-failure limit remain.

This is a **cooperative supervisor guard**, not a transaction fence across every API operation or an OS process lock. It covers the updated launchers. Direct Python runs, old launchers, momentum workers, Hermes, Ruflo and malicious clients are not fenced by this lease. An already accepted API transaction can complete after a child is stopped. Existing assignment leases and permissions remain the authority for submissions. There is no force-release button that could conceal a still-running supervisor; stop it normally or let its 90-second lease expire before restarting.

Start, stop, first cycle failure and recovery create audit/owner-inbox entries. Routine heartbeats and repeated failed cycles do not produce repeated alerts. A successful cycle clears the failure state. Replacing an expired session records its expiry and last counters in the audit log. Session UUID/actor history is retained; the current-role row is replaced for the new session.

Staleness is calculated at read time. Reading status does not mutate audit records. **There is no background stale-session notification service or external push/email delivery in this increment.** If both workers disappear, their stale status becomes visible on the next owner report; an expiry event is recorded when a replacement session starts. Global halt does not hide worker telemetry or prevent graceful stop; normal lifecycle/dispatch checks still control research activity.

## Owner commands

Rebuild and restart the backend before using updated launchers; otherwise their new session routes are absent. From the project folder, after stopping the old server:

```cmd
npm run build && npm start
```

Startup applies migration 010. It creates empty session tables and starts no workers. Inspect from a second terminal:

```cmd
npm run lifecycle:admin -- workers
npm run lifecycle:admin -- report
```

After configuring the starter department or another approved example workflow, the existing command starts a finite monitored session:

```cmd
npm run worker:organisation -- --minutes 30
```

Ctrl+C stops the direct child processes and attempts to report terminal session state. If the backend is unavailable, a final stop may not be acknowledged; wait for expiry rather than assuming an immediate release. A second simultaneous supervisor for an occupied role fails before launching its Python child. Policies are not enabled by any of these monitoring commands.

## API

| Route | Role | Contract |
| --- | --- | --- |
| GET `/v1/workers` | Owner | Read-only summary and both department roles. |
| POST `/v1/workers/sessions` | Researcher/evaluator | `{sessionId}`; role/actor derive from authentication. |
| POST `/v1/workers/heartbeats` | Researcher/evaluator | `{sessionId,sequence,state,completedCycles,failedCycles}`. |

These POSTs use session/sequence replay rules instead of the general `Idempotency-Key` command cache. Their responses always describe the current lease; they cannot replay a historical authorisation receipt as a fresh one. No new trading, model, wallet, permission-management or owner-control access is granted.

## Validation still needed

Four backend cases passed for role exclusivity, read-only reports, monotonic counters, retry freshness, expiration/replacement fencing and notification deduplication. Six Node cases passed, including actual child exit on cancellation and heartbeat denial. `npm run test:supervisor` selects these cases. The isolated Python team integration also passed duplicate-launch rejection, multi-cycle heartbeat freshness and acknowledged shutdown. Natural expiry after an OS-level crash and persistent deployment remain unverified. See [verification](verification.md).

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 7 October 2026; historical records retain their original scope.
