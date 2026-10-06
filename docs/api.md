# API contract and roles

## Learning workflow API — migration 021

POST `/v1/learning/workflows` (owner) freezes a programme. `/progress` is read-only for owner/assigned participants; `/links` binds exact stage records for the assigned worker; `/cancellations` records owner cancellation of progression. Mutation routes require idempotency keys. See [workflow contracts and cancellation limits](learning-workflows.md).

## Source learning API — migration 020

`GET /v1/learning/sources` lists frozen article-learning requests and proposals for owner/evaluator review. POST `/v1/learning/sources/requests`, `/preflight`, `/proposals` and `/reviews` implement a bounded cited-lesson workflow. Researcher creates/checks/submits; independent evaluator accepts/rejects. Mutation routes require idempotency keys. See [source learning contracts](source-learning.md).

## Knowledge assessment API - migration 018

POST `/v1/learning/knowledge/assessments`, `/assessments/work`, `/assessments/answers` and `/assessments/grades` issue, retrieve, answer and independently grade fresh tasks. See [contracts and limitations](bot-knowledge.md). Only work retrieval is read-only; mutation routes require idempotency keys.

## Bot knowledge API - migration 017

The `/v1/learning/knowledge/` request, preflight, proposal, review and graph routes connect bot identities, reviewed lessons and experience. See [the contracts and commands](bot-knowledge.md). Graph/preflight are read-only POSTs; other routes require idempotency keys.


## Owner research approvals — migration 016

GET `/v1/skills/experiments/research-approvals` is owner/evaluator read-only. Owner POSTs to that route and its `/revocations` subroute require idempotency keys. They bind a passing independent paired review to exact hashes, expiry and immutable withdrawal. See [contract](research-approvals.md). No execution, deployment or financial authority is created.

> Documentation refreshed for v0.1.21 (5 October 2026). [Current implementation, validation and limits](current-status.md). Dated milestones and design proposals retain their original scope.

## Execution observations — migration 015

GET `/v1/skills/experiments/execution-reports` permits owner/evaluator status reads. POST permits only the assigned researcher, requires an idempotency key and fixed experiment/plan/producer hashes, execution mode and optional Docker image identity. A strict batch of 1–16 ordered enum-coded observations describes baseline/candidate attempts or submission acknowledgements. Duplicate events are ignored; rewrites, gaps, invalid transitions and identity changes are rejected. Backend submission/review facts remain independent. Reporting after halt/cancellation/expiry is historical evidence, never work authority. See [reporting contract and commands](artifact-recovery.md).

Base URL: `http://127.0.0.1:3000/v1` for local development. All responses and requests use JSON. Except `/health`, every route requires `Authorization: Bearer <role token>`. Money is an integer-paise string; timestamps are ISO 8601 with an offset. Unknown fields are rejected by command schemas.

State-changing routes require an `Idempotency-Key` containing 8–100 letters, digits, `_` or `-`, except challenge creation, job claims and coordination status. Preserve the same key and payload after an uncertain response. A key is scoped by actor and command; changed payloads are rejected. A claim retry returns the worker's active lease rather than issuing a second job. Coordination status is idempotent by actor and state: retries refresh the heartbeat but do not duplicate notifications.

## Routes

| Method and path | Allowed roles | Purpose |
| --- | --- | --- |
| GET `/health` | Public | Paper mode and liveness. |
| POST `/owner/challenges` | Owner | Create a two-minute action-bound signing challenge. |
| POST `/owner/transactions` | Owner | Signed simulated contribution, transfer or operating expense. |
| GET `/treasury` | Owner, treasury | Balances, P, A, Q and pending protection. |
| GET `/treasury/ledger` | Owner | Latest 500 ledger entry rows. |
| POST `/treasury/allocations` | Treasury | Reserve the next eligible protected-profit amount. |
| POST `/treasury/confirmations` | Treasury | Confirm the internal paper allocation transfer once. |
| POST `/sources` | Owner | Register an approved/unapproved source. |
| POST `/evidence` | Owner, researcher, market | Submit untrusted evidence with provenance. |
| POST `/evidence/reviews` | Owner, evaluator | Independently verify or reject evidence. |
| POST `/evidence/revocations` | Owner, evaluator | Revoke evidence; only owner may revoke a source. |
| GET `/knowledge` | Owner, researcher, evaluator | Usable reviewed evidence and lessons. |
| GET `/bots` | Owner, researcher, evaluator | Bot records and academy states. |
| GET `/lifecycle` | Owner, evaluator | Research policy, approved capabilities, students and recorded reviews. |
| GET `/lifecycle/community` | Owner, researcher, evaluator | Research identities, speciality, mentor links and aggregate reputation. |
| GET `/lifecycle/archives` | Owner, evaluator | Preserved retirement records with lessons and experiment links. |
| POST `/lifecycle/policy` | Owner | Update bounded research rules using the current policy revision. |
| POST `/lifecycle/blueprints` | Owner | Approve an evidence-backed research capability and reviewed curriculum. |
| POST `/lifecycle/withdrawals` | Owner | Withdraw an unused capability approval. |
| POST `/lifecycle/cycles` | Owner, evaluator | Run one policy-controlled research lifecycle cycle; body `{}`. |
| POST `/bots` | Owner | Admit a bot with a distinct declared capability and budget. |
| POST `/bots/school-completions` | Owner | Move a student to college using verified lessons. |
| POST `/bots/retirements` | Owner | Retire a bot after knowledge transfer and work closure. |
| POST `/lessons` | Owner, researcher | Propose a reusable evidence-backed lesson. |
| POST `/lessons/reviews` | Owner, evaluator | Independently verify a lesson. |
| POST `/datasets` | Owner | Register chronological training and holdout bars. |
| POST `/portfolio/datasets` | Owner | Register immutable, example-only multi-asset training/holdout returns. |
| POST `/portfolio/training` | Researcher | Read training data and fixed policy; no holdout or idempotency key. |
| POST `/portfolio/trials` | Researcher | Submit constrained allocation weights for a college bot. |
| POST `/portfolio/reviews` | Evaluator | Trigger backend calculation of stored holdout results; accepts a trial ID only. |
| GET `/portfolio/trials` | Owner, evaluator | Portfolio proposals, historical reports and current evidence validity. |
| POST `/portfolio/cancellations` | Owner | Close a pending portfolio trial without erasing history. |
| POST `/experiments` | Researcher | Start a college bot's experiment on a fresh dataset. |
| GET `/experiments` | Owner, evaluator | Latest 100 experiments, including evaluation reports. |
| GET `/coordination/tasks` | Coordinator | Latest 100 task IDs, bot IDs, hypotheses, states and times only. |
| POST `/coordination/status` | Coordinator | Report structured health for its own Ruflo mirror; state changes notify the owner. |
| POST `/jobs/claims` | Researcher, evaluator | Claim only the appropriate kind of job. |
| POST `/jobs/completions` | Researcher, evaluator | Submit a schema-checked result against a current lease. |
| POST `/market/quotes` | Market | Publish an approved-source bid/ask quote. |
| GET `/paper/positions` | Owner, trader | Owner sees all; trader sees its own bot. |
| POST `/paper/orders` | Trader | Reserve a risk-checked paper buy or sell. |
| POST `/paper/fills` | Trader | Recheck current conditions and fill a reserved paper order. |
| POST `/paper/cancellations` | Owner, trader | Cancel and release a reservation. |
| POST `/incidents` | Owner, researcher, evaluator, trader, treasury, market | Record an incident; critical severity halts new risk. |
| POST `/incidents/resolutions` | Owner | Link verified resolution evidence. |
| POST `/operations/control` | Owner | Halt/resume; unresolved critical incidents block resume. |
| GET `/operations` | Owner | Control state, incidents and notification inbox. |
| POST `/notifications/acknowledgments` | Owner | Acknowledge an inbox entry. |
| GET `/audit` | Owner | Audit event history. |
| GET `/audit/integrity` | Owner | Check the recorded audit hash chain. |

The core deliberately gives the coordinator no job-claim, wallet, evaluation or execution permission. The treasury principal is a restricted accounting service, not a trading bot.

Version 0.1.7 adds `/learning` and `/development` routes for model profiles, bounded factual reflections, independent reviews, filtered memory and optional Hermes R&D requests. See the [learning/R&D endpoint table](learning-and-development.md#api-additions). The read-only POST routes `/learning/memory` and `/development/preflight` do not require idempotency keys. No new endpoint grants execution, recruitment or financial authority to a model.

Version 0.1.8 adds GET/POST `/development/experiments`, POST `/development/experiments/cycles` and POST `/development/experiments/cancellations`. The owner registers/cancels plans; evaluators assess them; owner/evaluators inspect status. All mutations require idempotency keys. See [registered experiments](development-experiments.md#api).

Version 0.1.10 adds owner-only GET `/workers` and researcher/evaluator POST `/workers/sessions` and `/workers/heartbeats`. These two POSTs use authenticated session UUID and ordered-sequence replay rules instead of the general idempotency-key cache. See [department monitoring](department-monitoring.md#api).

Version 0.1.6 adds owner-only `GET /organisation/report`: a read-only overview of managed student readiness, blockers, queue capacity, admission limits, failures and unread notification summaries. See the [report contract](organisation-report.md). It never reconciles leases or acknowledges notifications and does not expose lease tokens.

Version 0.1.5 adds the [dispatch API](research-dispatch.md#api): owner policy/cancellation, evaluator dispatch cycles and pending reviews, researcher lease claims. Every managed student's portfolio submission now requires `assignment:{id,leaseToken}`. Direct submissions remain available only for ordinary owner-created bots. The read-only POST `/dispatch/reviews` does not require an idempotency key; claims do.

The [portfolio contract](portfolio-backend.md) documents the example-only path. `/portfolio/training` is an additional read-only POST exempt from the mutation idempotency-key requirement. Portfolio evaluation never promotes a bot to paper trading. The [lifecycle contract](research-lifecycle.md) describes v0.1.4's disabled-by-default, example-research admissions and retirement rules; its mutations use the standard idempotency key and never change financial permissions.

Coordination status accepts `{state, code, taskCount}` only. `healthy` requires code `SYNCED`; degraded codes are `OS_PROFILE_UNAVAILABLE`, `DEPENDENCIES_UNAVAILABLE`, `BACKEND_UNAVAILABLE`, `MCP_UNAVAILABLE`, `RECONCILIATION_REQUIRED` and `CAPACITY_REACHED`. Counts are integers from 0 to 100. This is self-reported service health, not trading qualification. The owner sees the reporter, last-seen time and state under `/operations.integrations`; no automatic missing-heartbeat watchdog is installed yet.

## Owner signature flow

Submit an action to `/owner/challenges`:

```json
{
  "action": "deposit",
  "payload": {"amountPaise": "1000000", "bankReference": "paper-deposit-001"}
}
```

The response contains `challengeId`, `expiresAt`, `message` and the request. Check the requested action before signing the **exact UTF-8 message bytes** with the owner's Ed25519 private key. Send the original request with the proof to `/owner/transactions`:

```json
{
  "request": {
    "action": "deposit",
    "payload": {"amountPaise": "1000000", "bankReference": "paper-deposit-001"}
  },
  "proof": {"challengeId": "<returned UUID>", "signature": "<base64url signature>"}
}
```

Transfer payloads use `from: W1|W2`, `to: W1|W2|SBI`, and `amountPaise`; source and destination must differ. Expense payloads use `amountPaise`, a unique `reference`, and `category: compute|data|infrastructure|research`. No API command debits SBI.

The demo signs locally to exercise the contract. Production strong authentication must place signing authority outside the agent host, with a user-visible transaction confirmation and independently protected key.

## Paper and worker examples

An order request is `{botId, symbol, side, quantity, evidenceId}` with `side: buy|sell` and integer quantity. `/paper/fills` and `/paper/cancellations` take `{orderId}`. Quotes take `{symbol, bidPaise, askPaise, observedAt, sourceId}`. A quoted price is never fetched by the API from an arbitrary URL.

A worker claim returns `{job:null}` or a job with `id`, `experimentId`, `kind`, `leaseToken`, and its role-specific `payload`. Research receives training bars; evaluation receives the chosen candidate, holdout, preceding warmup bars, fixed cost assumptions and dataset digest. Completion takes `{jobId, leaseToken, result}`. Use the supplied Python workers for the precise numerical result schemas.

The running demonstration in `scripts/demo.mjs` is a complete executable client example. Request schemas live beside their services; this version does not yet publish OpenAPI or client SDKs.

## Error handling

Unauthenticated requests return 401; disallowed roles or invalid leases return 403; invalid command input returns 400; conflicting state or idempotency reuse returns 409; throttling returns 429. Error bodies include a request ID and omit database internals. Retry only temporary failures with bounded backoff. A 401/403 must not become an endless retry loop.

Endpoints have bounded lists rather than pagination. External reporting, long-history exports and a structured event subscription are future work; the SQL records remain available to an authorised operator.

## Source observation intake (v0.1.25)

- `POST /v1/sources/observations`: researcher/market; idempotency key required. Immutable collector-submitted snapshot, unverified evidence, approved HTTPS origin, first backend observation time.
- `POST /v1/sources/observations/query`: owner/researcher/evaluator; source ID and optional evidence status; newest 50 with truncation flag.

Existing evidence review/revocation and lesson review routes govern downstream use. No external URL is fetched by these routes. See [contracts and batch commands](source-observations.md). Migration 019 required.
