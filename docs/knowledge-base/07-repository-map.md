# Repository Map

> Documentation refreshed for v0.1.21 (5 October 2026). [Current implementation, validation and limits](../current-status.md). Dated milestones and design proposals retain their original scope.

[Home](README.md) · [Knowledge graph](03-knowledge-graph.md) · [Roadmap](08-roadmap-and-open-questions.md)

## Scope of the review

These ten repositories were supplied as references during brainstorming. The conversation reviewed documentation, architecture, and selected source paths. It did not execute the projects, benchmark their performance, audit every line, or establish production suitability.

Links below refer to moving branches or documentation. No immutable commit set has been selected. Before implementation, pin candidate versions and verify interfaces, venue support, dependencies, licences, model/data terms, and operating costs.

## Capability map

| Reference | Documented role | Proposed use and boundary |
|---|---|---|
| [Kronos](https://github.com/shiyu-coder/Kronos) | Tokenises candlestick data and generates numerical market forecasts; supplies inference and fine-tuning workflows. | Forecasting candidate. It is not the news department or a complete trading engine. Predictions require strategy-level validation. |
| [Freqtrade](https://github.com/freqtrade/freqtrade) | Crypto strategy execution, historical testing, dry-run operation, optimisation, position management, and reports. | Candidate for a crypto strategy department. It overlaps with other execution engines; venue suitability must be checked. |
| [NautilusTrader](https://github.com/nautechsystems/nautilus_trader) | Event-driven trading architecture with data, execution, risk, portfolio, and messaging components. | Candidate infrastructure for simulation and execution. Shared components do not remove live-market differences. |
| [skfolio](https://github.com/skfolio/skfolio) | Portfolio optimisation using returns, risk estimates, allocation constraints, costs, and validation tools. | Allocation candidate. Its weights need translation into valid orders and separate capital enforcement. |
| [Hummingbot](https://github.com/hummingbot/hummingbot) | Exchange connectors, strategy controllers, and order-lifecycle executors including market making and arbitrage. | Candidate for crypto execution and arbitrage research. It does not establish universal atomic settlement or guaranteed profits. |
| [Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) | Research agents and teams, market-data tools, experiments, persistent memory, reusable skills, and reporting. | Reference for research collaboration and workflows. Capability and broker permissions vary by component. |
| [Qanat](https://github.com/fidetolabs/qanat) | Staged data-to-portfolio pipelines, historical replay, trial records, and evaluation controls. | Reference for the laboratory and experiment ledger. It explicitly does not place live orders. |
| [Awesome Systematic Trading](https://github.com/wangzhe3224/awesome-systematic-trading) | Catalogue of libraries, data, education, and infrastructure. | Discovery resource; inclusion does not certify a project or make the collection an integrated system. |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Agent runtime with tools, skills, memory, delegation, scheduling, messaging, and application integration interfaces. | Primary runtime candidate from the discussion. Persistent departments and independently enforced permissions still require our design. |
| [Ruflo](https://github.com/ruvnet/ruflo) | Coordination, workflow tools, memory, task routing, and feedback mechanisms. | Coordination candidate. Select capabilities through comparison tests and avoid competing task owners. |

## Relationships and integration questions

### Forecasting to portfolio construction

Kronos consumes historical market data and outputs forecasts. Its predictor averages sampled paths. That alone does not establish calibrated probabilities or joint cross-asset covariance. A bridge to skfolio would need aligned return horizons, units, uncertainty, and dependence estimates.

Sources: [Kronos predictor](https://github.com/shiyu-coder/Kronos/blob/master/model/kronos.py), [skfolio MeanRisk interface](https://github.com/skfolio/skfolio/blob/main/src/skfolio/optimization/convex/_mean_risk.py).

### Research teams to controlled experiments

Vibe-Trading offers patterns for hypothesis-driven research, memory, and reusable workflows. Qanat offers patterns for staged experiments and recording attempted ideas. A proposed connection would require a common experiment contract and an evaluator that the candidate cannot control.

Qanat's documentation acknowledges that its research window is not sealed against an agent inspecting later data. Timestamped replay is useful but does not alone prevent researcher leakage.

Sources: [Vibe-Trading](https://github.com/HKUDS/Vibe-Trading), [Qanat](https://github.com/fidetolabs/qanat).

### Memory and training

Vibe-Trading's skill-writing tools can save or patch reusable workflows. FreqAI supports automated predictive-model retraining. These mechanisms affect different parts of a system and need different evaluation.

Sources: [Skill writer](https://github.com/HKUDS/Vibe-Trading/blob/main/agent/src/tools/skill_writer_tool.py), [FreqAI](https://www.freqtrade.io/en/stable/freqai/).

### Execution alternatives

Freqtrade, NautilusTrader, and Hummingbot should initially be compared against the chosen market and strategy. Using more than one later requires clear account/instrument scope, compatible accounting, and shared capital reservations.

NautilusTrader's architecture separates data, risk, execution, and portfolio state. Freqtrade's main loop analyses data and manages positions and orders. Hummingbot distinguishes strategy controllers from execution lifecycles.

Sources: [NautilusTrader architecture](https://nautilustrader.io/docs/latest/concepts/architecture/), [Freqtrade main loop](https://github.com/freqtrade/freqtrade/blob/develop/freqtrade/freqtradebot.py), [Hummingbot](https://github.com/hummingbot/hummingbot).

### Arbitrage semantics

The inspected Hummingbot arbitrage executor evaluates estimated profitability and costs, then places separate buy and sell orders. An integration must account for inventory, one-sided fills, retries, and venue-specific settlement. Atomic on-chain arbitrage would be a separate design question.

Source: [Arbitrage executor](https://github.com/hummingbot/hummingbot/blob/master/hummingbot/strategy_v2/executors/arbitrage_executor/arbitrage_executor.py).

## What remains our design work

The integrated constitution, source-verification policy, shared evidence schema, independent academy, role-specific rewards, incident court, cross-bot capital authority, and qualification-to-deployment process remain proposals.

Some references supply parts of these ideas. None of this review establishes that a complete organisation meeting our requirements already exists or that the proposed combination will outperform simpler alternatives.

## Selection rule

Prefer the smallest set of compatible components that demonstrates useful capability under our tests. Reuse implementations where justified, adapt proven patterns where necessary, and build missing mechanisms only when their role is clear.

A component earns selection through evidence about correctness, reliability, cost, latency, maintainability, market coverage, and contribution to the overall organisation.

## Hermes and Ruflo review

Hermes supplies plugin interfaces for tools, hooks, and commands, plus programmatic interfaces for external applications. Its reusable skill and memory mechanisms are relevant to the academy, but workflow changes do not establish profitable strategies or automatically train foundation-model weights.

Sources: [architecture](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture), [plugins](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins), [programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration).

The inspected Hermes delegation path gives children isolated contexts and disables ordinary memory loading. Persistent departments therefore need explicit identity, evidence access, and lifecycle design. Its security documentation distinguishes certain tool safeguards from operating-system isolation.

Sources: [delegation implementation](https://github.com/NousResearch/hermes-agent/blob/main/tools/delegate_tool.py), [security boundaries](https://hermes-agent.nousresearch.com/docs/user-guide/security).

Ruflo's inspected router updates and persists task-assignment values using feedback. This is relevant to specialist selection, not evidence of market-prediction skill. An adaptive coordination interface accepts consensus alignment as input; our independent reviewers need evidence-based scoring that does not penalise justified dissent.

Sources: [routing implementation](https://github.com/ruvnet/ruflo/blob/main/v3/%40claude-flow/cli/src/ruvector/q-learning-router.ts), [coordination implementation](https://github.com/ruvnet/ruflo/blob/main/v3/%40claude-flow/cli/src/mcp-tools/swarm-tools.ts).

Ruflo's May 2026 audit documented real learning behaviour alongside defects and unsupported performance claims. Its remediation section records several fixes in v3.10.7, including negative-reward parsing. This is historical evidence, not a claim that those defects remain in a later selected version. Pin and test the actual version before relying on it.

Source: [audit and remediation](https://github.com/ruvnet/ruflo/blob/main/docs/reviews/intelligence-system-audit-2026-05-29.md).

Hermes can consume MCP tools and Ruflo exposes an MCP server, giving a plausible integration route. Compatibility of the complete deployment remains untested. Source references were reviewed during the conversation; no install, benchmark, or production audit was performed.

## Reuse permission and repository disappearance

The owner clarified that using open-source software is acceptable. Keep our own deployable artifacts and dependency copies so normal operation does not rely on access to an upstream GitHub repository.

Hermes and Ruflo currently have MIT licence files permitting reuse and modification under their notice conditions. Retain required notices and check component-specific dependencies, model terms, and data terms.

Sources: [Hermes licence](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE), [Ruflo licence](https://github.com/ruvnet/ruflo/blob/main/LICENSE).

See [runtime and independence](09-runtime-and-independence.md).
