# Bounded recovery after failed school exams

> [Current implementation, validation and limits](current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

Version 0.1.12 preserves the three base attempts from [academy skills](academy-skills.md) and adds **one owner-approved extra attempt per managed student lifetime**. The backend keeps every failure, expiration, approval and revocation. Approval does not mark a bot as competent; the new random exam must still pass independent grading.

## Eligibility and approval

Version 0.1.13 can generate and independently review a corrective lesson from graded failure checks; inspect [skill diagnostics](skill-diagnostics.md) for the proposal and resulting lesson ID. This automates the narrow plan/review contract, not owner recovery approval or implementation repair.

A student must remain in school, have a currently verified curriculum, and have consumed exactly three attempts. Its latest attempt must be a graded failure under the currently enabled skill policy. No unresolved submitted or live outstanding exam may remain. Students whose latest result is expired, invalidated or passed are not eligible for this recovery workflow; operational-failure appeals need a separate design.

A corrective lesson must:

- Belong to this student and use verified evidence from an approved source.
- Have been created after the latest failed exam was graded.
- Be independently reviewed by someone other than its author and the owner approving recovery.
- Be new to this student's curriculum.

The owner records the failed attempt, lesson, current policy revision and reason. Approval appends the lesson to the curriculum and stores a fingerprint of its content, author, reviewer and evidence reference. The lesson's correctness remains a human/agent review judgment; the backend verifies provenance and authority, not the meaning of arbitrary prose.

Each approval expires after seven days and can be revoked by the owner. A revoked or expired approval cannot be replaced: there is one approval per student lifetime, with no counter resets. All four attempts still consume the organisation's daily and lifetime exam quotas. The existing policy must therefore have enough capacity before an approval is made. Changing the policy revision afterward invalidates the exception; it does not revive it.

## Use and withdrawal

The normal researcher department automatically claims the extra attempt when the owner has approved it and all current support remains valid. Claim and approval consumption happen in one locked transaction. Concurrent requests can reuse the current author's pending challenge; they cannot create fifth or parallel recovery attempts. The usual 120-second submission deadline applies, and an expired recovery exam remains consumed.

Submission, grading and college admission recheck the approval's expiry/revocation, current policy, lesson fingerprint, verified curriculum and student state. A changed lesson/reviewer or withdrawn evidence prevents unsupported progression. A submitted exam whose support is withdrawn receives `invalidated` when the evaluator next processes it. A historical passing grade remains preserved even when it can no longer authorise admission.

Revocation after the student has already entered college does not retroactively demote it or stop unrelated research. This exception governs school admission only. No recovery creates trading authority, wallet access, reputation, new credentials or increased financial limits.

The owner report distinguishes `SKILL_ATTEMPTS_EXHAUSTED` from a pending grade and includes `skillBudget` with used/base-remaining attempts and recovery availability. Recovery status is historical; current support is always rechecked before use.

## Owner commands

Inspect current exams, failed checks and any previous approval:

```cmd
npm run lifecycle:admin -- skills
npm run lifecycle:admin -- skill-recoveries
```

Use the existing lesson proposal/review endpoints to register the corrective lesson. After reviewing it, submit a JSON file with:

```json
{
  "botId": "student-id",
  "failedAttemptId": "latest-failed-attempt-uuid",
  "lessonId": "new-reviewed-lesson-uuid",
  "expectedPolicyRevision": 1,
  "reason": "Explain the correction and why one fresh assessment is justified."
}
```

```cmd
npm run lifecycle:admin -- skill-recovery recovery.json
```

The identifiers above are placeholders. Use actual current records and preserve the request file for retries. Revocation uses a file containing `recoveryId` and `reason`:

```cmd
npm run lifecycle:admin -- revoke-skill-recovery revoke-recovery.json
```

API routes: owner/evaluator `GET /v1/skills/recoveries`, owner-only `POST /v1/skills/recoveries`, and owner-only `POST /v1/skills/recoveries/revocations`. POSTs use the existing idempotency-key contract. A replay is a historical receipt, not renewed permission.

Migration **012** is additive. Rebuild/restart the backend before using these routes; no Python worker change is needed. This documentation does not activate policies or approve any real student's recovery.

## What this does not yet do

There is no automatic repair of worker code, model fine-tuning or proof that reading a corrective lesson changed behaviour. The existing Python solver is shared and deterministic. This increment adds a controlled reassessment path and preserved accountability. Automated diagnosis, versioned solver attribution, agent-written remediation plans and operational-failure appeals remain future work. Executed results are in [verification](verification.md).

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
