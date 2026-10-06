# Research-basics examinations

> [Current implementation, validation and limits](current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

Version 0.1.11 adds an optional practical assessment between school and college for managed research students. Earlier school admission verified curriculum references only. With the skill policy enabled, both automated lifecycle admission and the owner's school-completion endpoint require an independently graded pass under the current policy and curriculum.

This is a test of the configured research worker's basic calculations and control handling. It does not demonstrate general intelligence, prove an individual model learned those skills, update model weights, select a profitable strategy or grant trading authority. All students currently share a deterministic Python examination adapter; each attempt receives a freshly generated scenario.

## Rubric

`research-basics-v1` requires all four checks to pass:

| Skill | Backend check |
| --- | --- |
| Costs | Gross realised profit minus the stated fees and slippage, using synthetic integer paise. |
| Drawdown | Largest percentage decline from a preceding equity peak, expressed in basis points; tolerance 0.0001 bps. |
| Information timing | Select only records whose event time **and availability time** are at or before the cutoff. |
| Abstention | Choose `research` only when the synthetic scenario is not halted, its evidence is verified and its budget covers the required work; otherwise choose `wait`. |

These are hypothetical questions, never executable trading instructions. Correct answers do not award reputation, funds, permissions or a mentor designation.

## Authority and history

The owner controls an initially disabled, revisioned policy. Defaults are 12 attempts per rolling 24 hours and 100 lifetime attempts, with hard ceilings of 100/day and 1,000 lifetime. Each managed bot has **three base lifetime attempts across all policy revisions**. Version 0.1.12 adds at most [one owner-approved recovery attempt](skill-recovery.md) after a new independently reviewed corrective lesson; it never resets earlier counts. Failed, expired and invalidated attempts remain counted. Repeated claims reuse the same outstanding challenge for its author without extending its 120-second submission deadline.

Only a researcher can claim and submit an attempt. An evaluator with a different identity requests grading; the backend calculates the checks from the stored challenge rather than accepting a submitted score or verdict. Answer replacement is refused. Attempts, submissions and reviews are append-only, audited and preserved after retirement.

Submission and grading honour the global halt and enabled policy. Current policy revision, supported rubric, school state and unchanged verified curriculum are rechecked. Revoked evidence or changed support prevents a historical pass from satisfying school admission. Previously submitted unsupported attempts receive `invalidated`, preserving the distinction from a wrong answer. Policy changes invalidate earlier passes for students still in school; changing limits is therefore not a harmless way to retry.

The gate applies to **managed students still in school**. Enabling it does not retroactively demote college students or assess older owner-created bots. Disabling it restores the earlier curriculum-only admission rule. A student exhausting its attempts stays in school; no automatic deletion, punitive fitness update or unlimited retry follows. The owner can now authorise one bounded recovery under the separate workflow. Automated remediation and versioned solver upgrades remain future work.

## Worker and owner use

Researchers attempt at most one exam per department cycle, then proceed with normal learning and research work. Evaluators grade pending exams before lifecycle admission. The owner report includes `SKILL_ASSESSMENT_REQUIRED` when applicable. Inspect with:

```cmd
npm run lifecycle:admin -- skills
```

After reviewing the current revision and desired limits, the owner can submit a JSON file via `npm run lifecycle:admin -- skills-policy <file>`. Example for a fresh policy:

```json
{"expectedRevision":0,"enabled":true,"maxPerDay":12,"maxLifetime":100}
```

This document is not an instruction to activate the persistent policy. Starter preparation/import does not enable the new gate automatically. Updated department workers require a rebuilt backend with migration **011** before use; an old server will reject the new routes.

| Route | Role | Purpose |
| --- | --- | --- |
| GET `/v1/skills` | Owner/evaluator | Policy and historical outcomes; no answer key. |
| POST `/v1/skills/policy` | Owner | Revision-checked policy update. |
| POST `/v1/skills/claims` | Researcher | Empty body; next eligible school student's challenge. |
| POST `/v1/skills/submissions` | Researcher | Attempt ID and four answers, bound to the original author. |
| POST `/v1/skills/cycles` | Evaluator | Empty body; independently grade at most ten submissions. |

POST routes require idempotency keys. Replaying an old command returns its historical receipt; it does not renew an attempt, undo a revocation or establish a current pass. Use current status and the owner report to inspect eligibility.

## Validation

Six backend cases cover known grading vectors, owner/role boundaries, both admission routes, answer immutability, independent evaluation, bounded attempts, expiration, policy changes, revocation and halt. Three Python cases check the independent solver and unsupported-rubric refusal. The organisation integration additionally enables this gate only in its fresh test database and requires three passed exams before reporting success. Current executed results are recorded in [verification](verification.md).

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
