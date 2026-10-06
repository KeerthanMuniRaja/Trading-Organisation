# Vision and Principles

> Documentation refreshed for v0.1.21 (5 October 2026). [Current implementation, validation and limits](../current-status.md). Dated milestones and design proposals retain their original scope.

[Home](README.md) · [Organisation](02-organisation-and-plugins.md) · [Governance](06-governance-and-capital.md)

## The idea

Create a self-developing trading organisation with specialist departments, a shared body of knowledge, qualification standards, and accountable decisions. Bots cooperate toward the owner's objectives while preserving independent judgment.

The owner should be able to observe the organisation through understandable reports, inspect evidence, change authorised boundaries, and stop activity. Routine work should eventually proceed within those boundaries without requiring the owner to supervise every action.

## Owner requirements

| ID | Requirement |
|---|---|
| R-01 | Work only with explicitly allocated capital. The original ₹100 figure was an example. |
| R-02 | Analyse markets, trusted internet sources, news, and surrounding conditions. |
| R-03 | Investigate observable large-trader activity and possible explanations without blindly copying it. |
| R-04 | Consider historical experience, current evidence, and plausible future scenarios. |
| R-05 | Use specialist bots and plugins for monitoring, analysis, decisions, and execution. |
| R-06 | Share information and verified lessons across the organisation. |
| R-07 | Provide school-like learning, specialist education, examinations, and role-specific rewards. |
| R-08 | Investigate serious mistakes through evidence, root-cause analysis, correction, and requalification. |
| R-09 | Give the owner ultimate administrative authority and clear status reports. |
| R-10 | Learn from existing projects while developing an original solution. |
| R-11 | Explore both conventional trading and decentralised-exchange arbitrage; the first market remains undecided. |
| R-12 | Stay in brainstorming until a later building phase is explicitly chosen. |
| R-13 | Reuse open-source components while keeping our own deployable copies and avoiding dependence on upstream repository availability during normal operation. |
| R-14 | Detect and repair operational problems autonomously within authorised boundaries, verify recovery, and notify the owner. |
| R-15 | Use the agreed two-wallet policy; custody, detailed costs, timing, and numerical financial limits remain open. This supersedes the earlier blanket deferral. |
| R-16 | Educate new bots through school, specialisation, and graduation before they work alongside existing teams. |
| R-17 | Require each new bot to justify a distinct contribution; permit replication only for demonstrated opportunities or capacity needs with differentiated work. |
| R-18 | Let outstanding R&D support proposals for new departments and teams. |
| R-19 | Expand capabilities and teams as demonstrated revenue/value and sustainable resources grow. |
| R-20 | Conduct periodic research hackathons to discover ideas, train new bots, and propose improvements to existing bots. |
| R-21 | Transfer useful knowledge and experience before removing an unfit bot from active service. |
| R-22 | Continuously study relevant news, magazines, articles, internet sources, sales developments, and organisational affairs to form testable market hypotheses. |
| R-23 | Credit 100% of owner deposits from the original SBI account to Wallet 1; Wallet 2 begins at zero. |
| R-24 | Retain 60% of newly eligible verified realised net profit in Wallet 1 and protect 40% in Wallet 2. |
| R-25 | Restrict bots to authorised Wallet 1 operations; deny Wallet 2 access, SBI withdrawals, and changes to ratios, permissions, or spending limits. |
| R-26 | Permit authenticated owner transfers between wallets and withdrawals to the original SBI account, with full ledger records and available-funds checks. |
| R-27 | Recover cumulative realised losses and configured costs before allocating new profit; exclude unrealised gains and prevent duplicate allocations. |
| R-28 | Preserve contribution principal separately from earnings, use independent financial control, and enforce shared reservations and department budgets. |

## Design principles

1. Separate observations, explanations, predictions, and actions.
2. Record uncertainty and contrary evidence alongside supporting evidence.
3. Give proposal creation and proposal approval different responsibilities.
4. Treat waiting, holding cash, or rejecting a trade as valid decisions.
5. Evaluate results after relevant trading and operating costs.
6. Reward reproducibility, useful dissent, honest error reporting, and appropriate restraint.
7. Promote verified improvements through controlled stages; retain rollback options.
8. Preserve the history of unsuccessful experiments as well as successes.
9. Keep fast execution independent of slow research discussions.
10. Make permissions enforceable outside the instructions given to an AI model.

## What makes the system unique

Existing foundation models may be shared with other users. Our distinctive organisation would combine its own constitution, workflows, knowledge graph, experiment history, qualified specialists, and operating methods.

Custom model versions may later be trained or fine-tuned. Memory updates, workflow changes, strategy selection, and parameter training are different improvement mechanisms; one does not imply another.

Uniqueness does not establish trading skill. Each component must demonstrate useful performance for its assigned role.

## Meaning of success

The organisation should make traceable decisions, respect capital boundaries, recover from operational problems, and demonstrate useful performance under realistic evaluation.

The design does not assume that every trade wins, every motive can be discovered, all future scenarios can be enumerated, or more bots automatically produce better decisions.

## Clarification: reuse and independence

The owner accepts open-source reuse. The requirement is operational control over our retained deployment, not a ban on open-source libraries or an instruction to rewrite everything. Repository disappearance alone should not interrupt an already provisioned deployment; external model, data, broker, or exchange services remain distinct dependencies.

## Clarification: growth and fitness

A graduate should bring a distinct role, method, market perspective, or validated capacity contribution. Experienced bots may teach reusable methods and pass on evidence. This does not justify redundant agents producing the same work with different names.

Fitness is evaluated against role-specific standards and contribution to the organisation. Revenue matters to trading and expansion, while enabling roles can justify themselves through research quality, avoided failures, reliability, or other validated benefits. A bot's age alone is not a retirement criterion.

See [the lifecycle](11-research-development-and-bot-lifecycle.md) and [operational independence](09-runtime-and-independence.md).

The [wallet policy](12-wallet-and-treasury.md) records the accepted financial management principles. Financial operations remain inactive until a separately authorised and validated implementation exists.
