# Vibe-Trading research practice adaptation

Reviewed on 8 October 2026 IST. The user's “vibe-coding repo” is interpreted as the previously supplied HKUDS/Vibe-Trading repository.

## What is being transferred

The inspected [README](https://github.com/HKUDS/Vibe-Trading/blob/main/README.md) configures an external model/provider. Its [investment committee](https://github.com/HKUDS/Vibe-Trading/blob/main/agent/src/swarm/presets/investment_committee.yaml) separates favourable and adverse arguments, risk examination and synthesis. Its [quant desk](https://github.com/HKUDS/Vibe-Trading/blob/main/agent/src/swarm/presets/quant_strategy_desk.yaml) separates exploration, backtesting and risk examination. These are workflow references, not a transferable foundation-model checkpoint. This was a targeted inspection, not a full repository or model-asset audit.

Nexus now applies an original short adaptation, `research-review-practice-v1`, to its existing knowledge-application and capability-proposal prompts:

- Consider an explanation and a serious counterargument.
- State missing information and a falsifying condition.
- Propose independent cost/timing checks and untouched-data evaluation.
- Keep unknowns explicit and conclusions within the supplied evidence.

These perspectives run inside one existing model request. They do not create independent reviewers or simulate completed committee approval. The knowledge prompt continues to require exact supplied lesson citations; output limits, request budgets and tool restrictions remain unchanged. The capability prompt retains its existing schema; proposed checks fit its hypothesis/risks rather than new fields. Examination and candidate-selection prompts are unchanged.

## Implementation and provenance

The static guidance is in `integrations/hermes/contracts.py`. Both current direct inference and the isolated Hermes runner consume the resulting `PROMPTS`. The guidance changes the recorded prompt hash for the two research tasks; older benchmark reports remain historical and do not validate this new prompt. No environment flag, dependency install or additional inference call is required to include it in future authorised requests. A long-running Python worker must restart to load changed source; this update does not restart it automatically.

The referenced upstream files were inspected on mutable `main`; no exact upstream revision was resolved. The local prompt is versioned and original wording. No upstream runtime, model weights, full prompts or source code were copied. Upstream is MIT-licensed, with copyright attributed to Vibe-Trading Contributors; copying substantial source in a later change requires preserving the applicable licence and component notices. See the [licence](https://github.com/HKUDS/Vibe-Trading/blob/main/LICENSE) and [NOTICE](https://github.com/HKUDS/Vibe-Trading/blob/main/NOTICE).

## What this does not establish

This is prompt-level procedure reuse, not fine-tuning or knowledge distilled into model weights. It does not automatically supply market data, teach all trading skills, establish improved accuracy, or qualify a bot. Our school, knowledge review, source revocation, permissions and wallet rules remain authoritative. Free text can still be wrong despite valid JSON; independent evaluation is required.

The next model experiment should compare the old and new prompts on the same unseen tasks, including missing evidence and conflicting claims, with fixed model settings and an independently defined rubric. That paired model evaluation has not been run. Software tests verify prompt delivery, task isolation and unchanged contract/compute boundaries only.

The [paired practice benchmark](practice-benchmark.md) now prepares the comparison offline and supports an explicitly requested bounded local-model run. Preparation does not establish improved performance.
