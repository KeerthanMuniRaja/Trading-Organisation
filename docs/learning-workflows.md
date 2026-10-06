# Bounded learning workflows — v0.1.27

An owner can register a finite learning programme for one reviewed source observation, one mentor bot, one receiving bot and separate researcher/evaluator service identities. The backend reports the next stage and retains immutable links to its source proposal, transfer and assessment. Workers can advance ready stages without manually supplying the next request ID each time.

This is partial organisation orchestration. It does not discover sources or recipients, fetch news, automatically judge an article/transfer, train model weights, promote bots or grant financial authority. Real inference remains unverified; the current end-to-end fixture uses deterministic stand-ins.

## State sequence

`source → awaiting-source-review → transfer → awaiting-transfer-review → assessment-create → assessment-answer → assessment-grade → completed`

The researcher proposes the source lesson and transfer, then answers the assessment. The evaluator must separately review the source lesson and transfer using the existing review commands. After those decisions, its workflow worker can issue fresh tasks and request backend numerical grading automatically; this is not autonomous judgement of source truth.

A rejected review stops progression. Halt, policy revision change, source withdrawal or retirement of either selected bot blocks progression. An unanswered expired assessment is reported as `assessment-expired`. A completed assessment can be passed, failed or invalidated: `completed` describes workflow completion, not demonstrated learning or fitness. Historical assessment results remain visible if current support later changes.

## Register a programme

Rebuild and restart through migration **021**. Use an already reviewed observation from [source intake](source-observations.md), active bots, and an enabled owner development-model profile. Create `workflow.json` with the actual existing bot/evidence IDs and configured service-principal IDs:

```json
{
  "mentorId": "mentor",
  "recipientId": "student",
  "evidenceId": "REPLACE-WITH-REVIEWED-OBSERVATION-UUID",
  "researcherId": "researcher",
  "evaluatorId": "evaluator",
  "task": "Apply the source's transaction-cost lesson to a fresh research comparison."
}
```

```cmd
npm run learning:workflow -- create workflow.json
```

The owner launcher reads the existing local `.env` and uses only the owner credential for this API call. Repeating the same command/body returns the original programme. Registration does not start a worker or reserve inference capacity. The workflow service verifies distinct participant IDs; an operator must choose identities that actually have the configured researcher/evaluator roles, or no corresponding worker can progress.

There can be at most 10 new workflows per rolling day and 100 lifetime. A successful workflow consumes three shared development request slots: source proposal, transfer proposal and assessment. All other model-request users share the same existing budget. A stage can therefore fail for insufficient capacity even after programme registration.

## Run the assigned workers

Use the returned workflow UUID. In separate normal terminals, run the researcher and evaluator as needed:

```cmd
npm run worker:knowledge -- workflow-run --workflow-id WORKFLOW-UUID --role researcher --cycles 20 --interval-seconds 15
npm run worker:knowledge -- workflow-run --workflow-id WORKFLOW-UUID --role evaluator --cycles 20 --interval-seconds 15
```

Run those commands separately if both should be active at the same time. The launcher selects one scoped credential for each role; it does not pass researcher/model credentials to the evaluator process. Omit `--cycles` for a single check/step. Limits are 1–20 checks, separated by 5–60 seconds; default interval is 15 seconds. Inference and API time add to the polling duration. The worker stops on errors or terminal/blocked states and is not a persistent service. It does not automatically restart after machine shutdown.

The backend authenticates the service identity, not the command-line role string. A different principal cannot operate the programme. Within a process, every iteration advances at most one stage. Separate review decisions remain required while workers wait. Use [source review](source-learning.md) and [transfer review](bot-knowledge.md) commands, with the request IDs reported by workflow progress.

The assigned evaluator handles workflow progression and assessment issuance/grading. Existing source/transfer review endpoints retain their own independent-review permissions; the workflow does not narrow those endpoints to a single reviewer identity.

## Inspect or cancel

Create `workflow-ref.json` containing `{ "workflowId": "WORKFLOW-UUID" }`:

```cmd
npm run learning:workflow -- progress workflow-ref.json
```

Owner progress is read-only and never returns an executable action. Assigned worker progress returns an action only when the next stage belongs to that role. Responses include stage links, a required role where relevant and the historical assessment report when available. State is derived from the underlying records rather than a worker's claim of success.

For cancellation, provide `{ "workflowId": "WORKFLOW-UUID", "reason": "Owner's reason" }` in a separate file:

```cmd
npm run learning:workflow -- cancel cancellation.json
```

**Cancellation stops this workflow's progression; it does not revoke already-issued source/transfer/assessment requests, terminate an in-flight model subprocess, or remove history.** Those requests retain their ordinary policy, expiry and evidence checks and can still be operated through their separate APIs if authorised. Use existing model policy/halt controls when wider containment is needed. There is no automatic rollback or distributed cancellation in this increment.

## Recovery and concurrency boundaries

- Stable workflow/stage keys reuse earlier requests and assessment issuance. Linking checks bot identities, source evidence, frozen task, exact transferred lesson, policy revision and evaluator assignment.
- Source/transfer/answer workers retain existing durable inference journals. Lost submission acknowledgements do not require repeating inference. Uncertain inference stops for reconciliation rather than silently sampling again.
- A successful source/transfer proposal can exist before its workflow link is acknowledged. Restart retries the same request and link. If cancellation/policy withdrawal intervenes, the original records remain separately discoverable; no attempt is made to delete them.
- A local workflow lock prevents concurrent execution for the same backend/credential/workflow on a shared state directory. Run a single host with preserved journals for now. This is not a distributed inference lease across machines.
- Expired requests or corrupt/missing journals require operator reconciliation; the runner does not obtain a fresh budget automatically. The progress API does not diagnose every inference-journal failure.
- Workflow polling is separate from the existing portfolio department supervisor. It is not yet included in that supervisor's heartbeat/report or a global scheduled queue.

## API contracts

| Route | Role | Purpose |
| --- | --- | --- |
| `POST /v1/learning/workflows` | owner | Freeze a programme; idempotency key required. |
| `POST /v1/learning/workflows/progress` | owner or assigned researcher/evaluator | Read `{workflowId}` and obtain stage/progress. |
| `POST /v1/learning/workflows/links` | assigned stage worker | Attach `{workflowId,step,referenceId}`; idempotency key required. |
| `POST /v1/learning/workflows/cancellations` | owner | Record `{workflowId,reason}`; idempotency key required. |

Existing source/knowledge/assessment routes remain the only creators and reviewers of their underlying records. Workflow registration, links and cancellation records are append-only. They do not change wallet balances, reward scores, curricula or deployment permission.

## Verification and remaining work

Backend tests exercise the complete source-to-assessment sequence, separate reviews, identity binding, substitution rejection, immutable links, halt, revocation, policy change and cancellation. Python tests check no-model waiting, stable recovery keys, stage dispatch and bounded polling. The actual HTTP fixture runs researcher/evaluator Python stages and injects lost acknowledgements, including an assessment-link response.

Finite publisher/Vibe collection and reviewed keyword lesson discovery now exist separately. Remaining orchestration work includes connecting these tools to workflow queues, qualified reviewer reasoning, recipient relevance selection, durable distributed inference leases, richer owner reports and operational deployment. See AUTO-01 in the [remaining-work assessment](remaining-work-assessment.md).

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
