# Current implementation — v0.1.27

Updated 6 October 2026: [bounded learning workflows](learning-workflows.md) connect owner-selected source/mentor/recipient plans to researcher and evaluator stages, with finite polling and durable stage links. Independent source/transfer review remains explicit. Migration 021 is required; no persistent process or real model was activated.

Updated 6 October 2026: [article-to-lesson learning](source-learning.md) adds model-assisted, exactly cited proposals from reviewed source observations, dedicated independent review and graph lineage. Migration 020 is required. Real inference and continuous collection remain unverified or unfinished.

For the full vision-to-code gap analysis and development sequence, see [remaining work assessment](remaining-work-assessment.md) and its [source inventory](codebase-review-inventory.md).

Updated 6 October 2026: source observation intake now retains article provenance, immutable revisions and first-observed timestamps. Reviewed observations connect to lessons, bot context and the knowledge graph. A bounded batch importer is available; automated feed retrieval and model extraction remain outstanding. See [source observations](source-observations.md). Migration 019 is required.

Updated 6 October 2026: accepted knowledge transfers now support fresh-task assessments, backend grading and reusable outcome feedback through migration 018. Real-model execution and causal learning benefit remain unverified. See [workflow and commands](bot-knowledge.md).

Updated 5 October 2026. This page is the current status index for the whole documentation set. Earlier dated verification entries and version narratives are historical. The knowledge-base folder retains the owner's design, not a claim that every proposed capability is implemented.

## Bot learning priority

v0.1.23 adds a model-assisted cross-bot lesson application workflow, reusable accepted plans, per-bot reviewed experience context and a live knowledge-graph API. v0.1.24 adds fresh-task assessments and reusable outcome feedback. The provisional model is Qwen3.5-9B through Hermes; it has not been activated or verified here. See [bot reasoning and knowledge](bot-knowledge.md). Accepted plans and synthetic assessments do not establish causal improvement; real-model evaluation and external-source ingestion remain outstanding.

## Implemented since v0.1.15

| Version | Capability | Boundary |
| --- | --- | --- |
| 0.1.16 | Docker Linux execution adapter with pinned local image ID, resource limits and runtime guard | Live Docker verification deferred by the owner; transport/guard tests do not prove host isolation. |
| 0.1.17 | Durable container ownership registry and bounded cleanup/recovery | Deletes only matching recorded containers; uncertain cleanup blocks new work. No continuously running reaper. |
| 0.1.18 | Backend execution observations, immutable event streams, owner inbox notifications and durable Python outbox | Authenticated worker claims, not independent attestation or worker liveness. Migration 015 required. |
| 0.1.19 | Recovery of saved submissions without original artifacts/runtime | Replays the original body/key with matching backend and credential identity; no solver execution. |
| 0.1.20 | Read-only journal inspection and bounded local listing | Local snapshots only; does not contact the backend or infer process health. |
| 0.1.21 | One recovery pass over 1–10 explicitly selected journals | Sequential, finite, no automatic discovery or scheduling; individual failures remain visible. |
| 0.1.22 | Owner approval/revocation of an exact independently evaluated research candidate | Governance record only; no execution consumer, deployment, trading authority or attestation. Migration 016. |

The NestJS/TypeScript core still supplies paper treasury, independent evaluation, academy, governed lifecycle, dispatch, memory, R&D plans and monitored supervisors. Python implements numerical research and the artifact tools. Hermes and Ruflo remain scoped integrations; no model provider was selected or invoked by these increments.

## Validation and limits

Current build and **110 backend tests passed** for v0.1.27, along with **34 Hermes Python tests**. The actual Python-to-HTTP fixture now advances an owner-defined workflow through source proposal, separate review, transfer and assessment using distinct researcher/evaluator workers, including response-loss recovery. It uses deterministic stand-ins; real inference and causal learning benefit remain unverified. The unchanged importer retains its prior two-test pass. See [verification](verification.md).

Docker Desktop startup attempts did not yield a usable engine. The owner explicitly deferred Docker testing. No live container-isolation result is claimed. Generated-code execution, remote attestation, autonomous code deployment, owner-approved version release/rollback, model learning, real market ingestion and financial connectivity remain unfinished. Synthetic fixture score improvements are injected test differences, not learned trading ability.

No persistent worker, policy, model service or financial account was activated. Managed students remain zero-budget example researchers. Wallet 1 receives all owner deposits; eligible cumulative realised net profit is allocated 60/40; Wallet 2 and bank withdrawals stay outside bot authority. Retirement preserves knowledge and accountability history.

## Read and operate

- [Artifact execution and Docker limits](artifact-execution.md)
- [Monitoring, journal inspection and recovery commands](artifact-recovery.md)
- [Owner research approval and revocation](research-approvals.md)
- [API contracts](api.md), [architecture](architecture.md), [security](security-and-operations.md)
- [Financial rules](financial-model.md), [roadmap](roadmap.md), [verification](verification.md)
- [Continuity context](../KT.md) and [resume prompt](../RESUME-PROMPT.md)

Rebuild and restart the backend through migration 021 for learning workflows (source learning requires 020; observations require 019; assessments require 018). Never modify old applied migrations. Preserve local journals and private configuration; do not publish `.env`, `.local`, `.data`, `.state` or signing keys.

## Next development priorities

1. Add a bounded publisher feed adapter and independently reviewed article-to-lesson extraction on top of source observations.
2. Run the provisional existing model through the learning workflow and evaluate its performance on fresh tasks, including a comparison without transferred lessons.
3. Expand specialist evaluation with controlled real-data provenance and disjoint evaluation windows.
4. Add separate owner-governed version release/rollback and stronger execution provenance; resume Docker verification when the owner returns to that deferred work.
