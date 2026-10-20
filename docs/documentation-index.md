# Documentation index — v0.1.35

Research prompt evaluation: [paired practice benchmark](practice-benchmark.md), including offline preparation, bounded local inference and interruption records.

Model workflow reuse: [Vibe-Trading research practice](vibe-research-practice.md) describes the versioned prompt adaptation, provenance and untested model-performance limits.

New market-data experiments: [historical NSE replay](historical-replay.md) uses public data for personal research without broker credentials; [NSE live-data paper trial](nse-paper-trial.md) uses authenticated Kite quotes. Both are isolated diagnostics, not qualified organisation trading.

Latest runtime changes: see [current status](current-status.md) for the v0.1.35 direct-engine completion/usage/launcher fixes and migration 023 from v0.1.34. The earlier full documentation reconciliation below retains its original scope.

Updated 7 October 2026. Start with [current status](current-status.md) for implementation boundaries and [model selection](model-selection.md) for measured evidence. This index covers all 67 existing first-party Markdown documents; it is the additional navigation page.

The latest full backend test record is historical v0.1.30 (116 tests). The preceding review-fix validation records a successful build, 52 Python tests and 21 feed tests. This documentation-only refresh reruns neither models nor application tests. All 782 local link targets/section references passed validation across the 68-document set; git diff --check passed. Finite workers are not a continuously operating autonomous organisation.

The preferred experimental model is constrained Qwen3.5-4B Q4_K_M on the direct endpoint. Production Hermes remains unqualified, numerical assessment failures remain visible, and the disabled example does not authorise activation. Financial rules and paper-only operation are unchanged.

## Start and operate

- [Current implementation — v0.1.32](current-status.md)
- [Remaining work to build the self-growing trading organisation](remaining-work-assessment.md)
- [Implementation roadmap](roadmap.md)
- [Knowledge transfer: continue the trading organisation](../KT.md)
- [Trading Organisation — backend foundation](../README.md)
- [Resume this organisation project](../RESUME-PROMPT.md)

## Runtime and integration guides

- [Research-basics examinations](academy-skills.md)
- [API contract and roles](api.md)
- [Architecture and runtime knowledge graph](architecture.md)
- [Artifact execution, isolation and recovery](artifact-execution.md)
- [Artifact monitoring and recovery](artifact-recovery.md)
- [Bot reasoning, knowledge graph and transfer — v0.1.24](bot-knowledge.md)
- [Department supervisor sessions](department-monitoring.md)
- [Registered R&D experiments](development-experiments.md)
- [Financial model](financial-model.md)
- [Hermes research integration](hermes-integration.md)
- [Discovering reusable bot knowledge](knowledge-discovery.md)
- [Learning, existing models and organisation automation](learning-and-development.md)
- [Bounded learning workflows — v0.1.27](learning-workflows.md)
- [Local model runtime — v0.1.32](local-model.md)
- [Model endpoint readiness and benchmark — v0.1.32](model-readiness.md)
- [Model selection evidence — 6 October 2026](model-selection.md)
- [Model strategy for the bot organisation](model-strategy.md)
- [Owner organisation report](organisation-report.md)
- [Prepare the first research department](organisation-starter.md)
- [Verify the research organisation together](organisation-verification.md)
- [Portfolio academy: repository-backed research](portfolio-academy.md)
- [Portfolio research backend connection](portfolio-backend.md)
- [Publisher feed intake — v0.1.32](publisher-feeds.md)
- [Reference repositories → our organisation](reference-map.md)
- [Owner research approvals — v0.1.22](research-approvals.md)
- [Bounded research department](research-dispatch.md)
- [Our organisation: research bot birth, development and retirement](research-lifecycle.md)
- [Ruflo coordination integration](ruflo-integration.md)
- [Security boundaries and operations](security-and-operations.md)
- [Worker attribution, diagnosis and corrective proposals](skill-diagnostics.md)
- [Paired academy version experiments](skill-experiments.md)
- [Bounded recovery after failed school exams](skill-recovery.md)
- [Article-to-lesson learning — v0.1.26](source-learning.md)
- [External source observations — v0.1.25](source-observations.md)
- [Vibe-Trading research integration](../integrations/vibe-trading/README.md)

## Original organisation design

- [Vision and Principles](knowledge-base/01-vision-and-principles.md)
- [Organisation and Plugins](knowledge-base/02-organisation-and-plugins.md)
- [Knowledge Graph](knowledge-base/03-knowledge-graph.md)
- [Research and Decisions](knowledge-base/04-research-and-decisions.md)
- [Learning and Evaluation](knowledge-base/05-learning-and-evaluation.md)
- [Governance and Capital](knowledge-base/06-governance-and-capital.md)
- [Repository Map](knowledge-base/07-repository-map.md)
- [Roadmap and Open Questions](knowledge-base/08-roadmap-and-open-questions.md)
- [Runtime and Operational Independence](knowledge-base/09-runtime-and-independence.md)
- [Autonomous Recovery and Notifications](knowledge-base/10-autonomous-recovery-and-notifications.md)
- [R&D, Bot Growth, and Retirement](knowledge-base/11-research-development-and-bot-lifecycle.md)
- [Wallet and Treasury Policy](knowledge-base/12-wallet-and-treasury.md)
- [Financial Scenarios and Acceptance Criteria](knowledge-base/13-financial-scenarios.md)
- [Change Log](knowledge-base/CHANGELOG.md)
- [Trading Organisation — Brainstorming Knowledge Base](knowledge-base/README.md)

## Working templates

- [Bot and Department Proposal](knowledge-base/templates/bot-and-department-proposal.md)
- [Decision Record Template](knowledge-base/templates/decision-record.md)
- [Experiment Record Template](knowledge-base/templates/experiment-record.md)
- [Financial Reconciliation and Distribution Record](knowledge-base/templates/financial-reconciliation.md)
- [Graduation Review](knowledge-base/templates/graduation-review.md)
- [R&D Hackathon Record](knowledge-base/templates/hackathon-record.md)
- [Incident Review Template](knowledge-base/templates/incident-review.md)
- [Knowledge Transfer and Retirement](knowledge-base/templates/knowledge-transfer-and-retirement.md)
- [Owner Report Template](knowledge-base/templates/owner-report.md)

## Dated verification and assessment

- [Codebase review inventory](codebase-review-inventory.md)
- [Validation record — updated 2026-10-06](verification.md)

## Reading historical material

Versioned verification entries and the original codebase inventory describe their recorded snapshot, not current readiness. Brainstorming describes intended capabilities; templates are blank proposals, not approvals or executed actions. More recent model evidence supersedes older no-model/no-4B statements. Shared context and reviewed knowledge do not imply neural-weight training, profitable trading or independent corroboration.
