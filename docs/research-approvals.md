# Owner research approvals — v0.1.22

Migration 016 adds immutable owner approval and revocation records for a candidate from an independently reviewed passing paired experiment. This is a governance record for further research. No worker consumes it as execution authority. It does not deploy code, change curriculum, grant financial permissions or establish runtime attestation. Paired reports still return `promotionAllowed: false`.

| Route | Role | Purpose |
| --- | --- | --- |
| GET `/v1/skills/experiments/research-approvals` | Owner/evaluator | Read up to 100 approvals with their current state. |
| POST `/v1/skills/experiments/research-approvals` | Owner | Approve an exact evaluated candidate for further research. |
| POST `/v1/skills/experiments/research-approvals/revocations` | Owner | Permanently withdraw approval, including during halt. |

Both POST routes require an idempotency key. Approval input is `{experimentId, planHash, candidateHash, validHours, reason}`. `validHours` is an integer from 1 to 168. Hashes must match the registered experiment. A passing independent review, enabled current policy revision, supported rubric, absence of cancellation and unhalted system are required. Worker observations cannot substitute for review. There is one approval per experiment; a revoked/expired approval cannot be renewed against the same experiment.

Revocation input is `{approvalId, reason}`. Repeated identical revocation does not create another notification; its reason cannot be rewritten. Both records are append-only, audited and create owner inbox entries. Responses explicitly prohibit deployment and trading and deny verified-execution claims.

States are `approved-for-research`, `halted`, `unsupported`, `expired` and `revoked`. Revocation takes precedence. A halt temporarily blocks applicability; a changed policy revision makes the original approval unsupported. Expiry is evaluated at read time. Command replay returns its historical receipt; always read current status rather than treating an old receipt as renewed approval.

```cmd
npm run lifecycle:admin -- research-approvals
npm run lifecycle:admin -- approve-research .local/research-approval.json
npm run lifecycle:admin -- revoke-research .local/research-revocation.json
```

Supply reviewed values in those files and rebuild/restart through migration 016. These commands are not run automatically. Withdrawal does not stop external processes or roll back deployed code; deployment/rollback management and independently trusted provenance remain future work. See [current status](current-status.md) and [verification](verification.md).

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 7 October 2026; historical records retain their original scope.
