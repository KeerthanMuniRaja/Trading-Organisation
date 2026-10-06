# Organisation and Plugins

> [Current implementation, validation and limits](../current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

[Home](README.md) · [Knowledge graph](03-knowledge-graph.md) · [Learning](05-learning-and-evaluation.md)

## Bots and plugins

A bot has an accountable role, model or decision logic, qualifications, and permissions. A plugin provides a capability with a defined interface. A plugin can be ordinary software; it does not need an AI model.

Examples: a price-feed plugin collects observations; a research bot uses price, filing, and news plugins to investigate a hypothesis.

## Proposed departments

| Department | Responsibility | Principal output | Boundary |
|---|---|---|---|
| Data and source verification | Collect, normalise, timestamp, and check evidence. | Versioned observations and provenance. | Cannot turn external content into operating instructions. |
| Market monitoring | Track prices, volume, spreads, liquidity, volatility, and feed health. | Time-limited observations and alerts. | Does not infer a participant's identity from price movements. |
| Participant activity | Study public holdings, disclosed transactions, and on-chain events. | Observations with attribution confidence and alternative explanations. | Does not claim access to private positions or motives. |
| Fundamentals and environment | Assess business developments, economic conditions, and sector events. | Evidence-backed claims and hypotheses. | Does not convert speculation into established fact. |
| Narrative analysis | Investigate publicity, source repetition, conflicting claims, and possible hype. | Source-dependence maps and narrative assessments. | Popularity is not proof of truth or manipulation. |
| Forecasting | Produce numerical predictions with a defined horizon. | Versioned forecasts and evaluated uncertainty. | Forecasts do not bypass strategy evaluation. |
| Research laboratory | Form hypotheses, implement candidates, and run experiments. | Reproducible experiment records. | Cannot change its own examination standard. |
| Independent evaluation | Challenge assumptions and assess unseen performance. | Qualification decisions with scope and expiry conditions. | Does not approve candidates solely by agent vote. |
| Portfolio | Propose allocations consistent with objectives and constraints. | Target holdings and rebalance proposals. | Cannot create extra spending authority. |
| Treasury and risk | Reconcile accounts, reserve Wallet 1 funds, and enforce exposure and permission limits. | Ledger, approval, rejection, and restriction records. | Operates independently of candidate agents; cannot grant itself authority. |
| Profit distribution | Apply the fixed 60/40 policy to newly eligible realised net profit. | Allocation, reserved obligation, transfer, and confirmation records. | Rule-based service; cannot spend from Wallet 2, withdraw to SBI, or change the ratio. |
| Execution | Manage authorised orders and reconcile venue outcomes. | Orders, fills, rejections, and position state. | Cannot independently enlarge budgets or change strategy scope. |
| Academy and incident review | Convert verified experience into lessons, tests, and requalification. | Versioned curricula and corrective changes. | Does not deploy its own remedies without validation. |
| Owner reporting | Explain activity, uncertainty, performance, and incidents. | Reports linked to underlying evidence. | Must distinguish simulated, paper, and live results. |
| R&D and incubation | Detect capability gaps, conduct hackathons, educate candidates, and propose new teams. | Bot charters, experiment records, graduation and department proposals. | Cannot bypass qualification or allocate unlimited resources. |
| Operations and recovery | Detect service failures, contain impact, execute approved remedies, and verify recovery. | Health evidence, recovery attempts, and owner notifications. | Cannot enlarge permissions or treat a restarted process as proof of correct operation. |

These are logical responsibilities. The number of live bots should follow measured workload and distinct contributions rather than one bot per row.

## Plugin contract

Every plugin should declare:

- Identity, version, purpose, and responsible department.
- Input and output schemas, instrument identifiers, units, and timestamps.
- Data freshness requirements and supported markets.
- Read/write permissions and permitted external destinations.
- Latency expectations, resource budget, timeouts, and retry behaviour.
- Error categories, unavailable-data behaviour, and health signals.
- Whether actions have side effects and how duplicate requests are handled.
- Required evidence references and audit events.

Execution plugins additionally need order identifiers, reservation references, explicit venue state, and reconciliation behaviour when an acknowledgement is missing.

## Collaboration model

Use a shared event channel for notifications and an evidence store for durable records. A communication channel alone is not a reliable historical record.

Each specialist can form an initial assessment independently, then examine the others' evidence. Contradictory assessments remain visible until resolved or explicitly accepted as uncertainty.

Several bots repeating one source or one model's conclusion do not constitute independent confirmation. Relevant lessons should be shared with affected roles, rather than adding every message to every bot's context.

## Identity and access

A bot identity binds its role, model version, configuration, knowledge permissions, qualification record, and allowed tools. A material change may require requalification.

Owner-only administration is compatible with limited service permissions for bots. Bots should receive only the operational access their role needs; no learning reward grants bank access or unrestricted administrative control.

## New specialist admission

A bot charter must name the unmet opportunity, responsible department, existing capabilities it inherits, differentiated assignment, evidence required for graduation, and resource limits. R&D maintains the candidate register and prevents several bots from unknowingly performing the same assignment.

Graduates join existing teams first where that structure fits. A new department needs a continuing distinct mandate, interfaces with existing teams, and evidence that coordination costs are justified. Outstanding individual performance supports a proposal; it does not automatically grant departmental authority.

## Replication and shared experience

Several bots may share a model or proven workflow while covering different sectors, horizons, evidence sources, or methods. Capacity replicas may process different work partitions when measured load justifies them. Temporary independent replication for validation must be labelled and bounded.

Keep task ownership, inheritance, data dependence, and output similarity visible. Replicas are not independent evidence merely because they have separate identities.

## Runtime responsibilities

Hermes is a candidate agent runtime; selected Ruflo capabilities may coordinate teams. Our application supplies the owner experience and organisation-specific services. Assign one authoritative owner for task state, scheduling, permissions, and evidence so overlapping frameworks do not race to control the same work.

See [runtime choices](09-runtime-and-independence.md), [R&D](11-research-development-and-bot-lifecycle.md), and [recovery](10-autonomous-recovery-and-notifications.md).

## Financial services are outside bot self-improvement

Financial authority is enforced by controlled services, account configuration, and credentials. A research, trading, or recovery bot cannot edit these controls. Wallet 1 capacity is shared across all bots, departments, open orders, operating commitments, and pending distributions.

The distribution service may send the prescribed amount to the configured Wallet 2 destination, but it has no authority to spend from Wallet 2. Owner transfer approval is a separate flow.

See the [wallet policy](12-wallet-and-treasury.md).

<!-- documentation-navigation -->
[Documentation index](../documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
