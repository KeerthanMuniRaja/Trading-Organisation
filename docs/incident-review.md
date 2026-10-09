# Organisation incident review

Implemented on 9 October 2026; database migration `024_incident_findings.sql`.

This is the first structured part of the organisation's incident court. An investigation records a proposed root cause, corrective action, prevention and verification plan, linked to currently verified evidence from an approved source. These are reviewed findings, not proof that corrective work has actually been executed.

## Workflow and permissions

1. Report an incident through the existing incident endpoint. Critical incidents halt new risk.
2. An owner, researcher or evaluator proposes a finding with verified supporting evidence.
3. An owner or evaluator accepts or rejects it. The reviewer must differ from both the finding author and the incident reporter.
4. A correction is a new finding. Previous findings and reviews remain available. Only one finding may await review at a time, with a maximum of ten per incident.
5. Once an incident has findings, owner resolution requires its latest finding to be accepted and the resolution evidence to match that finding. Evidence and source eligibility are checked again at resolution.
6. Resolution does not resume operations. The owner explicitly resumes, and unresolved critical incidents still prevent resumption.

Investigations remain available during a halt. Proposals and reviews create audit events and entries in the existing owner notification queue. They do not send external messages.

## API

All routes require authentication. Mutation routes require the existing `Idempotency-Key` header.

| Route | Body | Roles |
| --- | --- | --- |
| `POST /v1/incidents/findings` | `incidentId`, `evidenceId`, `rootCause`, `correctiveAction`, `prevention`, `verificationPlan` | owner, researcher, evaluator |
| `POST /v1/incidents/findings/reviews` | `findingId`, `decision` (`accepted` or `rejected`), `reason` | owner, evaluator |
| `POST /v1/incidents/findings/query` | `incidentId` | owner, researcher, evaluator |

Query is read-only and needs no idempotency key. It returns ordered findings, their review and `support_current`; a historical acceptance is not a guarantee that its source remains approved. Command retries replay historical receipts, not a new eligibility decision.

## Limits and remaining work

### Assigned learning and assessment history (migration 026)

An owner can assign a verified incident lesson to 1–20 distinct active recipient bots per request, up to 100 per lesson. Assignments are unique per lesson and recipient. The author bot is excluded because this workflow uses cross-bot knowledge transfer. Each assignment freezes a task of up to 500 characters and records an audit notification. A failed batch leaves no partial assignments.

| Route | Body | Role |
| --- | --- | --- |
| `POST /v1/incidents/learning/assignments` | `lessonId`, `botIds`, `task` | owner |
| `POST /v1/incidents/learning/links` | `assignmentId`, `requestId` | researcher |
| `POST /v1/incidents/learning/progress` | `lessonId` | owner, researcher, evaluator |

Mutations require idempotency keys. Progress is read-only. Assignments can be recorded while operations are halted; actual knowledge requests and assessments retain their existing halt, model-policy and budget checks.

The researcher creates a normal knowledge-transfer request **after** assignment, with the assigned bot, exact task and assigned lesson included, then links it. Only that request's author can link it. Up to ten distinct attempts are retained per assignment; repeated linking of the same request does not create a new attempt. Assignment and attempt records cannot be overwritten or deleted through normal SQL operations because history-protection triggers reject those changes.

The existing independent knowledge review and synthetic assessment workflow runs unchanged. Progress exposes every linked request's review, assessment and historical report. `support_current` describes the assigned lesson; `context_current` additionally checks every lesson used by the attempt, recipient retirement, current model-policy revision and global halt. A historical pass remains visible after withdrawal, alongside false current-eligibility indicators. There is no mutable completion checkbox or automatic fitness reward.

These assessments measure the existing research-basics/methods rubric. They do **not** establish incident-specific understanding, causal improvement, actual model execution, or trading skill. The response explicitly reports `incidentMasteryEstablished: false`. No model is launched by assignment, linking or progress queries. Automatic assignment selection, worker scheduling and incident-specific challenges remain future work.

The existing owner/evaluator knowledge-graph endpoint now includes incident, finding and assignment nodes. Its edges trace incident → finding → lesson → assignment → knowledge transfer → assessment, including assignments not yet attempted. Findings explicitly avoid claiming executed remediation. The graph is bounded to 100 lessons, assignments and transfers per bot; missing linked records outside those bounds are omitted, not invented, and `truncated` indicates that the graph may be incomplete. For the full bounded history of one lesson, use the incident-learning progress endpoint. Historical findings and scores are not current authority; check lesson usability and progress support indicators.

### Incident-to-lesson bridge (migration 025)

`POST /v1/incidents/findings/lessons` accepts `{findingId, botId, content}` from an owner or researcher with an idempotency key. The incident must be resolved, the finding must be its latest accepted finding, its evidence must still be verified and its source approved, and the destination bot must not be retired. The content is a proposed lesson summary, limited to 4,000 characters, not executable instructions.

The backend creates an **unverified** lesson and an immutable provenance link to the finding. There is one lesson per finding, even across different callers or idempotency keys. Other bots reuse this lesson through existing reviewed-knowledge and curriculum mechanisms rather than generating copies. The findings query includes `lesson_id` and `lesson_status`.

Use the existing `POST /v1/lessons/reviews` route for independent lesson review. The reviewer must differ from the lesson author, finding author and incident reporter. The original finding reviewer may review the lesson if those independence conditions hold. Source/evidence eligibility is checked again. Until verification, the lesson is excluded from shared reviewed knowledge and cannot be used for school completion.

After verification, existing knowledge discovery, curriculum and retirement-preservation mechanisms apply. Withdrawing evidence support excludes the lesson from the reviewed-knowledge view and blocks subsequent gated use; the historical finding and lesson remain stored. This does not reverse learning already performed or automatically remove historical curriculum entries. Proposing a lesson neither resumes operations nor changes a bot's stage, permissions, budget or model weights.

Incidents with no structured finding retain the previous owner-resolution path using verified evidence. Structured review is therefore optional until the first finding is submitted; it is not yet a mandatory court for every incident.

No remediation code runs from these text fields. Acceptance neither changes bot fitness or permissions nor retires bots or moves money. Automatic case assignment, independently verified remediation execution, and automatic selection of learning recipients remain future work. The lesson bridge preserves provenance in SQL and the knowledge graph; it does not run autonomous training.

Migrations 024–026 are applied by the normal database migration mechanism. Tests use an isolated in-memory database; they do not activate this workflow in a running deployment.
