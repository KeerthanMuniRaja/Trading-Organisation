# Paired academy version experiments

> Documentation refreshed for v0.1.21 (5 October 2026). [Current implementation, validation and limits](current-status.md). Dated milestones and design proposals retain their original scope.

## Execution and operational evidence

Current paired plans can use the [artifact runner](artifact-execution.md). Reports through migration 015 and the [recovery tools](artifact-recovery.md) add operational visibility without changing grades, quotas or promotion rules. Docker live verification is deferred. Saved-submission replay always uses the original key; no new attempt is created by recovery.

Version 0.1.15 adds a separate [trusted local artifact runner](artifact-execution.md) with source verification and durable retries. The original caller-supplied-function helper below remains available with its original limitations. Neither path provides an OS sandbox, remote attestation or release approval.

Version 0.1.14 compares two declared solver versions on identical synthetic research-basics cases. It produces diagnostic evidence for a future release decision, without approving or deploying a version, establishing profitability, or demonstrating model learning.

## Workflow

1. The owner registers two producer manifests, an assigned researcher ID, purpose, case count and numerical criteria. New manifests can be registered without consuming a student exam; the shared producer registry remains limited to 100 profiles.
2. The backend generates cases after receiving the fixed plan. An immutable SHA-256 digest binds cases, versions, researcher, rubric, policy revision, purpose and criteria. Registration returns hashes and identity, not questions.
3. Only the assigned researcher can fetch questions, supplying matching version hashes. Each four-case block includes allowed research, halt, unverified evidence and insufficient budget. Both versions receive identical arithmetic, drawdown, timing and control inputs.
4. Both answer sets must be submitted atomically, with every planned case exactly once and matching plan/version hashes. Client scores, missing cases, duplicates and replacement answers are rejected.
5. An evaluator distinct from both the registering owner and researcher requests backend grading. Immutable reports count all checks, with improvements and regressions separately overall and per skill. Reviews and audit notifications are replay-safe.

The Python `integrations/skfolio/paired.py` helper accepts trusted caller-supplied solver functions. Separate deep copies prevent ordinary input mutation from changing the other solver's cases. A solver exception prevents partial submission. The helper does not load arbitrary artifacts, select models, attest code, provide process isolation, impose execution timeouts, or persist retry payloads. It is not scheduled by departments. Bounded isolated execution and durable result journaling remain future work.

## Criteria and outcomes

Each case has four boolean checks: costs, drawdown, information timing and abstention.

| Fixed criterion | Meaning |
| --- | --- |
| `minCandidatePassBps` | Minimum proportion of individual checks passed, in basis points; 10000 requires every check. |
| `maxRegressions` | Maximum checks where baseline passes and candidate fails; improvements cannot cancel these. |
| `minImprovements` | Minimum checks where baseline fails and candidate passes. |

Results are `meets-criteria` or `below-criteria`, always with `promotionAllowed: false`. A tie fails a plan requiring improvement. Withdrawn policy/rubric support produces `invalidated` without a success score. Previously reviewed outcomes remain visible with `currentSupport: false` when the current policy no longer supports them.

The same authenticated researcher supplies both arms. Manifests remain declarations, not proof that specific artifacts ran. These paired synthetic diagnostics provide neither statistical significance nor unseen financial validation. Artifact verification, isolated execution and separate release governance are still needed before changing deployed workers.

## Controls and retained history

- Requires enabled skills. Global halt blocks registration, work, submission and new grading; owner cancellation remains available.
- 8–32 cases in multiples of four; at most three active plans, ten registrations per rolling day and 100 lifetime registrations. These quotas are separate from student exams. Cancellation, expiration and policy changes never refund registration history.
- Submission deadline is 24 hours after registration. Timely complete submissions may be reviewed afterward. Expired unsubmitted plans cannot resume.
- Owner cancellation closes pending/submitted work without deleting it. Reviewed plans cannot be cancelled. Unsupported plans retain an active slot until cancelled or expired.
- Status includes all plans within the lifetime cap: awaiting submission/review, unsupported, expired, cancelled and reviewed outcomes. It never filters to winners.
- No students, lessons, school passes, recovery grants, reputation, money or trading permissions follow from an experiment.

## Operations

Rebuild/restart through migration **014** before using the routes. Existing department schedules remain unchanged.

| Route | Role | Purpose |
| --- | --- | --- |
| GET `/v1/skills/experiments` | Owner/evaluator | Summaries and completed reports; no pending questions or answers. |
| POST `/v1/skills/experiments` | Owner | Register a plan. |
| POST `/v1/skills/experiments/work` | Researcher | Read its matching open plan and cases. |
| POST `/v1/skills/experiments/submissions` | Researcher | Submit both arms. |
| POST `/v1/skills/experiments/reviews` | Evaluator | Request grading by `experimentId`. |
| POST `/v1/skills/experiments/cancellations` | Owner | Cancel by `experimentId` with a reason. |

All writes require idempotency keys; `/work` is read-only. A repeated write returns its historical receipt, not fresh permission to operate. Read status for current support.

```powershell
npm run lifecycle:admin -- skill-experiments
npm run lifecycle:admin -- skill-experiment your-reviewed-plan.json
npm run lifecycle:admin -- cancel-skill-experiment your-cancellation.json
```

Plan shape: `{baseline, candidate, researcherId, caseCount, criteria, purpose}`. Each producer uses the [existing manifest contract](skill-diagnostics.md). Supply actual declarations and an existing scoped researcher principal ID. No provider/model is selected by registration.

`npm run verify:paired-skills` builds and tests a temporary in-memory backend with ephemeral credentials and actual Python-to-HTTP transport. A deliberately broken cost fixture is compared with the existing solver over eight cases: baseline 24/32, candidate 32/32, eight improvements, zero regressions. This demonstrates detection of injected errors, not learned improvement. It also verifies zero student/exam/lesson/financial writes and audit integrity. The fixture closes afterward and saves `.local/paired-skills-verification.json`; no `.env`, persistent database, model API, exchange or bank is used. See [verification](verification.md) for results.
