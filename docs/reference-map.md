# Reference repositories → our organisation

## Current reuse review — 6 October 2026

Updated for v0.1.32. Ten distinct repositories were supplied in the visible conversation; four further repositories were not identified. All ten entry points/READMEs were revisited for this capability review, alongside the relevant local adapters. This is not a complete source or security audit. Upstream feature descriptions are not proof of local compatibility or trading results.

| Reference | Useful role | Our decision and integration boundary |
| --- | --- | --- |
| [Qanat](https://github.com/fidetolabs/qanat) | Declared data dependencies, staged research, replay and trial accounting | Use these patterns for traceable experiments and leakage controls. No Qanat runtime installed by this work. |
| [Awesome Systematic Trading](https://github.com/wangzhe3224/awesome-systematic-trading) | Catalogue of research, data and trading tools | Discovery source; each linked package needs its own assessment. It is not a model or execution runtime. |
| [Kronos](https://github.com/shiyu-coder/Kronos) | Pretrained candlestick forecasting; mini/small variants | Future separate forecasting experiment against simple chronological baselines. No forecasting integration or weights added here. |
| [Freqtrade](https://github.com/freqtrade/freqtrade) and [FreqAI](https://www.freqtrade.io/en/stable/freqai/) | Backtesting, dry-run, adaptive prediction and retraining workflows | Inform numerical-model lifecycle and leakage checks. Not the organisation authority; no exchange engine installed here. |
| [NautilusTrader](https://github.com/nautechsystems/nautilus_trader) | Event-driven simulation/execution with a compiled engine and Python control | Candidate for a later market execution adapter; keep LLM reasoning out of the fast order path. |
| [skfolio](https://github.com/skfolio/skfolio) | Portfolio optimisation, constraints and chronological/purged validation | Existing bounded portfolio worker remains. Library features do not imply all are enabled in our adapter. |
| [Hummingbot](https://github.com/hummingbot/hummingbot) | Controllers, executors and venue connectors; Gateway for AMM DEX connections | Reference for later crypto/DEX work. No wallet keys or venue connections introduced. |
| [Vibe-Trading](https://github.com/HKUDS/Vibe-Trading/blob/main/README.md) | Research tools, report grounding and agent workflows | Existing bounded news collector and replayable evidence intake. Upstream runtime validation and broader role/tool reuse remain pending. |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Model-agnostic reasoning, reusable procedural knowledge and recall | Existing pinned, tool-disabled task adapter. We supply reviewed context and retain authority in NestJS; unrestricted upstream skill execution is not enabled. |
| [Ruflo](https://github.com/ruvnet/ruflo) | Coordination, shared memory and model-provider integration | Existing scoped MCP task mirror. Retrieval/routing patterns are references; advertised swarm learning is not evidence our bots have learned. |

## What this means for model choice

Hermes and Ruflo are agent frameworks, not compact trading-model weights. Vibe-Trading combines tools with model inference. Kronos predicts numerical market sequences; it does not read news as an organisation manager. The remaining tools mostly supply research, optimisation, execution or discovery. Combining all of them does not automatically increase intelligence.

Use one shared quantised language model for bounded text tasks, specialist numerical methods for forecasts/portfolios and deterministic authority for money. [Model strategy](model-strategy.md) records the hardware, failed 2B benchmark and next 4B candidate; [local runtime](local-model.md) records the existing pins. The Qwen model cards and llama.cpp are additional technical sources, not four invented user-supplied repositories.

## Reuse and independence rules

Pin adopted versions, retain source/artifacts and compatible dependencies, preserve applicable notices and verify adapters before upgrades. Compare current upstream documentation with our pinned revision; do not silently upgrade to match a README. Locally retained code and weights survive repository deletion, but remote data/model services remain external dependencies. All integrations remain behind our evidence, budget, review and permission boundaries.

The [original brainstorming repository map](knowledge-base/07-repository-map.md) remains historical. This update adds original fixes and documentation; it does not vendor code from these repositories or add new dependencies.

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
