# Trading Organisation — Brainstorming Knowledge Base

## Implementation update — v0.1.32

This folder retains the organisation vision and working templates. Use [current implementation](../current-status.md), [model strategy and learning graph](../model-strategy.md) and [reference decisions](../reference-map.md) for current capabilities and model evidence. Shared model weights can serve distinct bots; knowledge reuse is implemented in bounded workflows, while autonomous model training and unrestricted growth are not.

> [Current implementation, validation and limits](../current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

For development continuity across accounts or chats, read the current [project KT](../../KT.md) and [resume prompt](../../RESUME-PROMPT.md). This folder preserves the original design, while those files identify the latest implementation and continuation point.

> **Historical design snapshot.** This folder preserves brainstorming knowledge base v0.3. For implemented behaviour, current dependency pins and validation results, start with the [backend README](../../README.md), [reference mapping](../reference-map.md) and [roadmap](../roadmap.md). Later implementation documents take precedence where the snapshot differs.

Version: 0.3  
Updated: 3 October 2026  
Stage: brainstorming and architecture exploration  
Owner: the user; GitHub username supplied as keerthanmuniraja

## Purpose

Design a private, owner-controlled organisation of specialist bots and plugins that studies markets and the wider world, forms testable trading hypotheses, develops new capabilities, and learns from verified experience.

The organisation should create new specialists when a distinct opportunity justifies them, educate and qualify them, and let them work alongside existing teams. Exceptional research may support a new department. Growth should follow demonstrated value and sustainable resources. Bots that no longer justify an active role should transfer useful knowledge before retirement.

The organisation should also detect operational problems, recover within authorised boundaries, verify the result, and notify the owner. It cannot promise zero failures or solve every incident autonomously.

The two-wallet policy is now agreed: owner deposits go entirely to Wallet 1, eligible realised net profit is split 60% retained in Wallet 1 and 40% protected in Wallet 2, and bots cannot control Wallet 2 or withdraw to SBI. Independent financial controls, loss recovery, shared reservations, and owner transaction approval are part of the design. Custody, distribution timing, detailed costs, tax treatment, and numerical limits remain open. Nothing in this package enables live trading, account access, automatic spending, actual bot creation, or scheduled hackathons.

## Status vocabulary

- **Owner requirement:** explicitly expressed in the conversation.
- **Agreed design:** a requirement or management principle accepted by the owner; it is not permission to execute financial actions.
- **Design proposal:** a suggested implementation, still open to revision.
- **Reference capability:** functionality described in an upstream project; not necessarily independently tested.
- **Open question:** a choice still requiring a decision.
- **Validated:** reserved for a specific claim supported by recorded tests. The integrated organisation is not validated yet.

## Read the knowledge base

| Document | Purpose |
|---|---|
| [Vision and principles](01-vision-and-principles.md) | Requirements, objectives, uniqueness, and boundaries. |
| [Organisation and plugins](02-organisation-and-plugins.md) | Departments, responsibilities, communication, and interfaces. |
| [Knowledge graph](03-knowledge-graph.md) | Architecture, evidence, capability lineage, growth, and retirement. |
| [Research and decisions](04-research-and-decisions.md) | Daily information gathering, explanations, scenarios, and decisions. |
| [Learning and evaluation](05-learning-and-evaluation.md) | Education, fitness, rewards, qualification, and improvement. |
| [Governance and capital](06-governance-and-capital.md) | Owner authority, incident court, and financial boundaries. |
| [Repository map](07-repository-map.md) | Roles and limitations of all ten reviewed repositories. |
| [Roadmap and open questions](08-roadmap-and-open-questions.md) | Proposed stages and unresolved design choices. |
| [Runtime and operational independence](09-runtime-and-independence.md) | Hermes, Ruflo, retained deployments, and external services. |
| [Autonomous recovery and notifications](10-autonomous-recovery-and-notifications.md) | Detection, containment, repair, verification, and escalation. |
| [R&D, bot growth, and retirement](11-research-development-and-bot-lifecycle.md) | New specialists, graduation, hackathons, departments, and knowledge transfer. |
| [Wallet and treasury policy](12-wallet-and-treasury.md) | Agreed deposit, 60/40 allocation, access, loss recovery, and management rules. |
| [Financial scenarios](13-financial-scenarios.md) | Worked examples and proposed acceptance criteria. |
| [Change log](CHANGELOG.md) | What changed across versions. |

## Working templates

- [Decision record](templates/decision-record.md)
- [Experiment record](templates/experiment-record.md)
- [Incident review](templates/incident-review.md)
- [Owner report](templates/owner-report.md)
- [Bot and department proposal](templates/bot-and-department-proposal.md)
- [Graduation review](templates/graduation-review.md)
- [Hackathon record](templates/hackathon-record.md)
- [Knowledge transfer and retirement](templates/knowledge-transfer-and-retirement.md)
- [Financial reconciliation](templates/financial-reconciliation.md)

## Confirmed clarifications since version 0.1

1. Open-source reuse is acceptable. Independence means our retained deployment should not stop solely because an upstream repository disappears or becomes inaccessible.
2. Hermes and Ruflo join the reference set. Using them is acceptable in principle; their exact integration and versions remain to be validated.
3. Routine learning and recovery should proceed autonomously within approved limits, with owner notification.
4. New bots should contribute distinct capabilities. Replication is justified only by opportunity or capacity need and differentiated assignments.
5. Periodic R&D hackathons should generate ideas, train candidates, and propose improvements to existing bots.
6. Fitness includes role-specific quality and team contribution. Knowledge should be transferred before active retirement.
7. Team and capability growth should be tied to demonstrated value, affordable operating costs, and approved Wallet 1 budgets; retained profit is not automatic spending authority.
8. Day-to-day news, magazines, articles, business affairs, and other relevant sources are central research inputs.
9. Wallet 2 starts at zero. Contributions are never automatically split; only newly eligible verified realised net profit follows the fixed 60/40 allocation.
10. Owner transfers and withdrawals require strong transaction authorisation and ledger records. Bots cannot change financial permissions, ratios, or spending limits.

## How to use and maintain this package

Start with the vision, graph, and bot lifecycle. For the latest agreed financial design, read the wallet policy and worked scenarios. Use the templates when ideas become decisions or experiments. Preserve failed trials, superseded conclusions, and inherited-capability lineage.

All links between Markdown documents are relative. Mermaid diagrams include text explanations for readers without Mermaid support. No graph database, final model, hosting provider, or execution engine has been selected.

This version supersedes version 0.2 as the current design record. Both earlier ZIPs are retained. The package contains 24 Markdown documents and five Mermaid diagrams. No GitHub repository has been created or updated.

<!-- documentation-navigation -->
[Documentation index](../documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
