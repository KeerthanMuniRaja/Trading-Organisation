# Reference repositories → our implementation

> Documentation refreshed for v0.1.21 (5 October 2026). [Current implementation, validation and limits](current-status.md). Dated milestones and design proposals retain their original scope.

The [original review](knowledge-base/07-repository-map.md) records the research and source links from brainstorming. The table below maps all ten references to version 0.1. It distinguishes architectural inspiration, an implemented adapter and a future candidate; it does not claim that every repository has been installed or every source file audited.

| Repository | Idea applied or reserved | Our current location and status |
| --- | --- | --- |
| [Qanat](https://github.com/fidetolabs/qanat) | Staged experiments, replay, explicit trial records. | `research.ts` and Python momentum trials implement our own bounded experiment workflow. Qanat is not a runtime dependency. |
| [Awesome Systematic Trading](https://github.com/wangzhe3224/awesome-systematic-trading) | Discovery catalogue for data, methods and infrastructure. | Reference register in the knowledge base; evaluate each candidate separately. A catalogue is not an execution engine. |
| [Kronos](https://github.com/shiyu-coder/Kronos) | Numerical market forecasting candidate. | Future Python forecasting adapter. No weights, inference or fine-tuning installed. |
| [Freqtrade](https://github.com/freqtrade/freqtrade) | Strategy testing, dry-run lifecycle and cost-aware position management. | Our paper lifecycle and test separation take architectural guidance; no Freqtrade runtime or broker connector is used. |
| [NautilusTrader](https://github.com/nautechsystems/nautilus_trader) | Separate data, risk, execution and portfolio responsibilities. | Separate market/trader/treasury roles, shared reservations and audit-linked fills. A future high-performance execution adapter needs benchmarking. |
| [skfolio](https://github.com/skfolio/skfolio) | Portfolio optimisation under constraints. | The local example-data academy was verified in v0.1.2. The v0.1.3 [backend connection](portfolio-backend.md) compiled and started on the owner's host; full evaluation remains unverified. Neither workflow grants capital or graduation. |
| [Hummingbot](https://github.com/hummingbot/hummingbot) | Connector and order-lifecycle patterns for market making/arbitrage. | Reserve/fill/cancel state separation in the paper engine. No DEX scanning, atomic arbitrage, flash loans or exchange connector implemented. |
| [Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) | Research roles, reusable skills, experiments and reports. | Our evidence, lessons, academy and separated research/evaluation workflow. No Vibe-Trading application runtime is bundled. |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Actual bounded agent inference runtime. | `integrations/hermes` uses the pinned `AIAgent` interface to select an allowed candidate; no agent tools enabled. Provider test deferred while model choice remains open. |
| [Ruflo](https://github.com/ruvnet/ruflo) | Actual task coordination through MCP. | `integrations/ruflo` installs exact packages and mirrors application research records using three tools. Contract tests and the actual backend-to-Ruflo create/complete/restart flow pass on the normal Windows host. |

## Relationships

Version 0.1.7 extends actual Hermes reuse with a source-only, unverified R&D proposer. It consumes the organisation's independently reviewed example memories and proposes controlled research capabilities. The fixed skfolio allocators remain unchanged, and Ruflo remains the previously bounded task mirror. See [learning and development](learning-and-development.md); no claim of installing or integrating every referenced runtime is made.

The research path combines trial accounting, independent evaluation and reviewed reusable knowledge. Later, a forecast plugin may supply a tested prediction to a constrained allocator, which produces an order proposal for the same core risk and capital authority. Neither predictions nor portfolio weights can bypass the ledger or permissions.

Execution engines overlap. Choose a venue-compatible engine through measured tests; do not run several engines against shared funds without a single reservation/reconciliation authority. The current ledger deliberately supplies that authority before any live connector exists.

Hermes and Ruflo are optional bounded adapters, not the owners of the organisation. Retaining their reviewed packages prevents an upstream repository removal from deleting our local copies. It does not eliminate third-party API/model/data dependencies, licensing obligations or maintenance work.

The wider institution—role-specific fitness, governed reproduction, hackathons, incident court, automatic department growth and advanced learning—is our planned design. Those capabilities require additional implementation and evidence beyond combining existing repositories.
