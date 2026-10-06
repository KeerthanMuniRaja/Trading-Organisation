# Implementation roadmap

## Current priority: the learning bot organisation

v0.1.23 implements cross-bot reasoning, a SQL-backed knowledge graph and reusable accepted application plans. Next: evaluate real inference, measure transfer benefit on fresh tasks and ingest approved external sources with timestamps and review. These take priority over further infrastructure expansion. Reviewed plans alone do not demonstrate skill. See [bot knowledge](bot-knowledge.md).


## v0.1.22 research approval records

Owner approval/revocation records for independently evaluated candidates are implemented with exact identity checks, expiry and current policy/halt status. No worker consumes this record as execution authority. Actual release selection, deployment, rollback and stronger runtime provenance remain future work. See [research approvals](research-approvals.md).

> Documentation refreshed for v0.1.21 (5 October 2026). [Current implementation, validation and limits](current-status.md). Dated milestones and design proposals retain their original scope.

## Current priorities — v0.1.21

See [current status](current-status.md). Docker adapter and owned-container recovery are implemented but live Docker testing remains deferred. Owner-visible execution reports, a durable outbox, independent local inspection and finite selected-journal recovery are implemented and tested. Next: validate deferred host isolation, add independently trusted provenance and separate owner release/rollback governance, then expand real-input evaluations. No automatic release, model selection, real-market feed or live capital is enabled.

## Historical milestones

Older “next” statements below describe priorities at that version, not the current backlog.

Version 0.1.15 adds [trusted local artifact execution](artifact-execution.md): exact normalized source snapshots, separate bounded processes without inherited API credentials, per-arm retry history and durable paired-submission replay. It requires explicit trusted-code acknowledgement and is not an OS sandbox or remote attestation mechanism. Next: OS isolation and trusted provenance before generated-code automation, then separate owner-governed release/rollback and broader real-input evaluations. No recurring execution or financial authority changed.

Version 0.1.14 adds [pre-registered paired academy experiments](skill-experiments.md): identical synthetic cases, fixed thresholds, complete submissions, independent backend grading and retained incomplete/failure history. A Python helper and actual HTTP fixture exercise the protocol. These remain diagnostic declarations, not attested execution or release approval. Next: verified artifact execution with isolation, bounded resources and durable retries, separate release/rollback governance, wider specialist evaluations and real-input ingestion.

Version 0.1.13 adds [exam-worker declarations and diagnostics](skill-diagnostics.md), recurring failure reports, independently reviewed deterministic corrective lessons and complete descriptive version comparisons. Attribution is currently academy-only and self-reported by authenticated workers. Pre-registered paired comparisons, executable artifact verification, release approval and attribution across portfolio/model workers remain next steps. Current results are in [verification](verification.md).

Version 0.1.12 adds [owner-governed school recovery](skill-recovery.md): one additional attempt with an independently reviewed corrective lesson, immutable approval/consumption, expiry and revocation. Existing Python workers use authorised recovery through their normal exam path. Individual model learning, automatic code repair, worker-version attribution and operational-failure appeals remain future work. Current backend results are in [verification](verification.md).

Version 0.1.11 adds [research-basics examinations](academy-skills.md): bounded synthetic practical questions, immutable attempts, separate evaluation and an optional gate for managed school-to-college admission. The exam-enabled monitored workflow passed in an isolated backend. This measures the shared deterministic adapter; individual model learning, remediation, re-examination policy, worker-version attribution and broader specialist competence remain future work. See the latest [verification entry](verification.md) for current build/test results.

Historical v0.1.10 validation (5 October 2026): build, 61 backend tests, ten Node contract/process tests and 30 Python tests passed. Actual portfolio integration passed for all three methods. Starter import/replay and a monitored Python research/memory team also passed in an isolated backend, including three college students, three evaluated trials, one verified memory and clean shutdown. This supersedes the earlier increment-level “unverified” labels below for those checks. Persistent deployment, model inference and production isolation remain unverified. See [the validation record](verification.md) and [repeatable organisation check](organisation-verification.md) for exact scope.

The owner's accepted stack is NestJS + TypeScript for the core and Python for research workers. The owner wants existing models and frameworks adapted to the organisation; a specific serving model/endpoint is still unset. This roadmap tracks the gap between source implementation and the wider organisation imagined in the knowledge base; it is not a claim that those later stages already work.

| Stage | Status | Completion evidence / next acceptance condition |
| --- | --- | --- |
| 1. Backend foundation | Implemented | Durable ledger, permissions, 60/40 allocation, reviewed evidence, academy, separate evaluation, paper orders, incident controls and executable demo. |
| 2. Optional agent runtimes | Partial | Ruflo's selected research-task integration passed the actual backend/MCP lifecycle, restart, notifications and permission checks on the normal Windows host. Hermes adapter contract tested; selected-model run remains deferred. |
| 3. Real research inputs | Planned | Select a market and permitted data providers; ingest news, filings and adjusted price data with timestamps, corrections, provenance and access rights. Source quality must be measurable. |
| 4. Unattended paper department | Planned | Deterministic scheduler from approved signal to order; realistic execution simulation, walk-forward evaluation, risk monitoring and controlled recovery. Compare against simple baselines over unseen periods. |
| 5. Governed development organisation | Partial, isolated checks passed | v0.1.4 adds bounded example-research admissions, curriculum inheritance, reputation, mentoring and retirement. v0.1.5 connects managed students to approved research assignments, scoped fitting/evaluation workers and bounded recovery. Autonomous skill discovery, broader role fitness, hackathons, department creation and the incident court remain planned. |
| 6. Additional plugins | Partial | skfolio's offline example academy was verified in v0.1.2. The three-method isolated portfolio workflow passed; persistent activation remains separate. Permitted market data, Kronos and venue execution engines remain future work. |
| 7. Production infrastructure | Planned | OS isolation, externally protected owner signing, durable queues/outbox delivery, secret rotation, backups, disaster recovery, PostgreSQL integration tests, observability, performance and penetration testing. |
| 8. Live capital readiness | Not enabled | Owner-approved venue/custody/settlement design, external reconciliation, applicable requirements verified for the selected market, independent risk review and explicit staged activation. |

## Learning and fitness policy to develop

Version 0.1.9 adds an unverified [starter-department workflow](organisation-starter.md) after the owner confirmed an empty disabled community through the v0.1.8 report. It prepares an offline example bundle, imports reviewed fixed curriculum and three specialist blueprints on an explicit owner command, and generates separate activation proposals. No model training, new research technique or policy activation is implied by preparation.

Version 0.1.7 adds an unverified [factual memory loop and Hermes R&D proposer](learning-and-development.md), plus a finite supervisor for researcher/evaluator processes. Version 0.1.8 adds [registered diagnostic experiments](development-experiments.md): fixed windows/thresholds, independent assessment of all results, preserved failures and revocation-aware status. Both remain unverified. These experiments use the existing fixed portfolio methods and do not certify an arbitrary prose hypothesis. Next: executable specifications for genuinely new techniques, evaluation isolation and statistical/novelty assessment, then an explicit recruitment proposal pathway and model comparison. Real-world sources, autonomous hackathons, the incident court and governed code/model upgrades remain future work.

The [owner report](organisation-report.md) consolidates managed student blockers and research capacity without changing policy or executing work; an empty v0.1.8 response is owner-confirmed. Version 0.1.10 adds unverified [supervisor leases and heartbeats](department-monitoring.md), cooperative duplicate-launch prevention and owner-visible status. Background stale alerts, scheduled owner digests and external notification delivery remain planned.

Fitness must evaluate each department's purpose. Researchers contribute robust out-of-sample improvements; execution bots contribute reliable fills and cost control; monitors contribute detection and prevention; source validators contribute accuracy and correction speed. Revenue alone would unfairly remove defensive specialists and encourage excessive risk.

A new bot should propose a distinct contribution and run within an allocated research budget. Graduation should require independent tests; increased responsibility should require measured incremental value and available resources. Extra profit alone must never bypass risk limits or allow a bot to alter its permissions. The new managed lifecycle can create zero-budget research identities from owner-approved capabilities and update reputation from example assessments; it cannot independently invent skills, launch model instances, allocate trading capital, fine-tune itself, expand departments or erase history. Its school-to-college step verifies curriculum references, not genuine skill mastery.

Before retirement, preserve reviewed lessons, failed hypotheses, assumptions, costs and provenance. Retain failure evidence without automatically promoting it into accepted knowledge. Archive a bot's identity rather than erasing accountable history. Broader semantic deduplication and automated transfer checks remain to be built.

## Decisions for later stages

The next data layer needs an initial market, asset class, time horizon and provider. Indian listed equities and on-chain DEX assets use different market access and settlement models. The paper core is venue-neutral; it does not assume that every reference project supports the chosen market.

The institution metaphor guides responsibilities and learning. Runtime behaviour still needs explicit contracts, measurable tests and budgets. There is no established guarantee of autonomous profitability, fault-free operation, faster-than-market execution or unlimited self-improvement.
