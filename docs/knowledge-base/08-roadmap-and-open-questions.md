# Roadmap and Open Questions

> [Current implementation, validation and limits](../current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

[Home](README.md) · [Vision](01-vision-and-principles.md) · [Bot lifecycle](11-research-development-and-bot-lifecycle.md)

## Current state and scope

We are in brainstorming. No integrated application, trained model, operational department, scheduled hackathon, autonomous repair service, or live trading connection has been created.

Open-source reuse is accepted. Operational independence means retaining our own deployable copies and managing external dependencies. Hermes and Ruflo are included in the evaluation set; their final configuration and interfaces remain open.

The owner has agreed the two-wallet policy and management principles in [wallet and treasury](12-wallet-and-treasury.md). Custody, distribution timing, configured costs, tax treatment, financial thresholds, and implementation remain unresolved. No financial actions are authorised by that agreement.

The stages below are proposals, not schedules or automatic authorisation.

## Proposed stages

| Stage | Main work | Evidence required to move forward |
|---|---|---|
| 0. Define organisation boundaries | Agree roles, information flow, education, recovery authority, notifications, and the first research use case. | Owner-reviewed blueprint with open questions visible. |
| 1. Establish evidence | Collect a useful data stream, original-source provenance, availability timestamps, and quality checks. | Reproducible records and correct handling of missing, stale, or revised data. |
| 2. Compare agent foundations | Evaluate a small Hermes-based team, with and without selected Ruflo capabilities. | Evidence of useful coordination, reliable state, controlled costs, and enforceable permissions. |
| 3. Establish a research baseline | One testable hypothesis, one experiment contract, appropriate simulation, and independent evaluation. | Reproducible results with realistic assumptions and recorded failed trials. |
| 4. Exercise the academy | Admit one distinct candidate, teach it, examine it, and assign bounded work. | Demonstrated competence and incremental contribution beyond existing bots. |
| 5. Exercise recovery and retirement | Test faults, verified repairs, notifications, knowledge transfer, and decommissioning in a sandbox. | No unapproved authority changes, lost evidence, or duplicated side effects. |
| 6. Trial a bounded hackathon | Compare new ideas and challenger versions under fixed evaluation rules. | Useful outputs and negative results retained; winners still pass qualification. |
| 7. Validate financial controls | Resolve custody, timing, costs, taxes, reserves, and limits; exercise the agreed wallet policy and adverse financial scenarios. | Reconciled accounting, enforceable separation, safe retries, and explicit decisions before any financial connection. |
| 8. Consider paper and bounded live operation | Evaluate current-data operation and later any separately authorised live pilot. | Qualified strategies, reliable reconciliation, recovery, reporting, and explicit live authorisation. |
| 9. Expand selectively | Add bots, differentiated replicas, or departments only where value and resources justify them. | Sustained useful contribution and an authorised expansion policy. |

## Open decisions

| ID | Decision | Why it matters |
|---|---|---|
| O-01 | First market and jurisdiction. | Determines data, venues, rules, costs, calendars, and execution. |
| O-02 | First research problem, strategy family, and horizon. | Defines an achievable initial examination and baseline. |
| O-03 | Capital amount, loss response, exposure, department, and operating-cost limits. | These are distinct controls; no numerical limits are yet approved. |
| O-04 | Distribution cadence, reserves, cost recognition, tax treatment, and expansion budgets. | The 60/40 split and owner transfer rights are agreed; detailed accounting and spending parameters remain open. |
| O-05 | Leverage, shorting, derivatives, or borrowing. | None is assumed authorised. |
| O-06 | Broker/exchange availability, custody, payout routes, and credential separation. | Must support the agreed wallet protection and transfer permissions before any connection. |
| O-07 | Source selection, access terms, retention, and data budget. | Determines evidence quality and lawful/reliable reuse. |
| O-08 | Models, hosting, privacy, retained artifacts, and compute. | Determines operating dependencies and sustainable cost. |
| O-09 | Qualification metrics, baselines, windows, and thresholds. | Defines role-specific fitness and avoids arbitrary selection. |
| O-10 | Authority for spawning, promotion, department creation, and retirement. | Allows autonomy within a controlled mandate. |
| O-11 | Notification channels, cadence, severity, and delivery-failure handling. | Keeps the owner informed without concealing important incidents. |
| O-12 | Product name and destination Git repository. | Needed later; this ZIP is independent of that choice. |
| O-13 | Hackathon interval, challenge selection, and resource limits. | No recurring event is scheduled yet. |
| O-14 | Novelty, workload-partition, and independent-replication criteria. | Distinguishes useful new work from redundant bots. |
| O-15 | Retirement threshold, observation period, reserve status, and retention. | Protects useful specialists and preserves accountable knowledge. |
| O-16 | Approved automatic remedies and retry/escalation limits. | Prevents unbounded repair loops and authority expansion. |
| O-17 | Ownership of shared state across Hermes, Ruflo, and our services. | Avoids conflicting schedulers, memories, and permission decisions. |
| O-18 | Restore objectives and external-service alternatives. | Makes independence and recovery measurable. |
| O-19 | Curriculum, mentor review, and proof of knowledge transfer. | Makes school, college, and graduation operationally meaningful. |
| O-20 | Cost basis, eligible income, reporting currency, and rounding policy. | Required for exact and reproducible profit allocation. |
| O-21 | Owner authentication, recovery of access, and transaction approval mechanism. | Must bind approval to amount, source, and destination without granting bots bank access. |

## Design decisions and status

| ID | Position | Status |
|---|---|---|
| D-01 | Separate observation, hypotheses, decisions, and execution. | Design proposal. |
| D-02 | Share evidence while preserving independent judgment. | Design proposal supporting the owner's validation requirement. |
| D-03 | Compare execution alternatives against the selected use case. | Design proposal; no final engine selected. |
| D-04 | Keep independent financial control and shared Wallet 1 reservations. | Accepted management principle; implementation unvalidated. |
| D-05 | Separate learning candidates from qualification and deployment. | Design proposal. |
| D-06 | Preserve failed experiments and append corrections to history. | Design proposal. |
| D-07 | Recognise no-trade decisions and useful dissent. | Design proposal. |
| D-08 | Require a useful differentiated contribution from new bots. | Owner requirement; measurement method open. |
| D-09 | Reuse open source with our own retained deployments. | Owner clarification. |
| D-10 | Recover automatically where authorised, verify the result, and notify. | Owner requirement; action policies open. |
| D-11 | Run periodic R&D hackathons and support new specialists. | Owner requirement; cadence and resources open. |
| D-12 | Transfer useful experience before active retirement. | Owner requirement; retention/decommissioning mechanism open. |
| D-13 | Grow teams and departments with demonstrated opportunity and approved, affordable Wallet 1 budgets. | Owner requirement and accepted refinement; thresholds open. |
| D-14 | Treat Hermes as a runtime candidate and Ruflo as a selective coordination candidate. | Recommended evaluation approach, not a final integration decision. |
| D-15 | Put all owner deposits in Wallet 1, with Wallet 2 initially zero. | Owner requirement. |
| D-16 | Allocate eligible realised net profit 60% to retained Wallet 1 capital and 40% to protected Wallet 2. | Owner requirement. |
| D-17 | Recover prior realised losses and configured costs; prevent repeated profit allocation. | Owner requirement and accepted management principle. |
| D-18 | Permit authenticated owner transfers and SBI withdrawals while denying these powers to bots. | Owner requirement; mechanism and custody feasibility unvalidated. |
| D-19 | Maintain a traceable double-entry ledger, departmental budgets, and predetermined loss responses. | Accepted management principle; detailed policies open. |

## Next useful design exercise

Describe one opportunity discovered from current information, one candidate bot educated to address it, one independent examination, and one possible failure and retirement. Trace all of these through the knowledge graph and owner report.

This example can expose missing responsibilities and interfaces before committing to a large implementation.

A second design exercise should trace deposits, profit, losses, recovery, owner transfers, and interrupted distributions through the [financial scenarios](13-financial-scenarios.md). These are proposed acceptance cases, not completed application tests.

<!-- documentation-navigation -->
[Documentation index](../documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
