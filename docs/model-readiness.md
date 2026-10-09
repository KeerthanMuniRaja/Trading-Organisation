# Model endpoint readiness and benchmark — v0.1.35

## Current development update — v0.1.35, 7 October 2026

The checkout now includes v0.1.34's explicit direct-structured-v1 production engine and migration 023, which adds the optional research-methods-v1 assessment rubric. Existing research-basics-v1 records/defaults remain unchanged. The direct worker requests task schemas and binds tickets to the owner-selected engine; it is separate from Hermes, not a fallback or an upgrade of the pinned Hermes path.

This increment rejects direct responses unless the provider reports a normal stop with no tool calls or refusal, even when their JSON is valid. Reported tokens survive validation/completion failures in the durable failed outcome. No automatic regeneration or engine switch is added. Learning/R&D launchers now propagate HERMES_ENGINE to inference workers, while reviewer/discovery commands retain credential separation. Explicit Hermes benchmarks cannot be relabelled direct runs by ambient settings.

Validation: all 59 Python tests passed; the launcher regression passed six command/role scenarios using intercepted child launches and fixture credentials. No model, backend policy, persistent service, Docker runtime or financial connection was activated. No backend code/migration changed in this increment. Full backend tests were not rerun for these Python/launcher changes.

This is preparation for AI-01 in the [remaining-work assessment](remaining-work-assessment.md): connecting a real existing model. It adds:

- **Versioned task contracts.** Every prompt has a version hash.
- **An endpoint doctor.**
- **A bounded benchmark.** It runs the organisation's own task contracts against a candidate model and compares assessment results with and without transferred lessons.

Local 2B/4B artifacts now exist, and a saved direct 2B benchmark exposes contract and assessment failures. Qwen3.5-4B Q4_K_M is the preferred experimental profile; newer constrained direct results are recorded in [selection evidence](model-selection.md), but the production Hermes path is not qualified. See [model strategy](model-strategy.md); older version-specific verification remains historical.

## Versioned task contracts

The five model tasks (`candidate`, `capability`, `knowledge`, `knowledge-assessment`, `source-lesson`) now take their system prompts and token limits from `integrations/hermes/contracts.py`. The prompt text is unchanged from v0.1.28; this was checked by capturing the previous runner's prompts. The Hermes child loads the file by exact path, without changing `sys.path`, so upstream imports cannot resolve to organisation modules.

Each prompt's version is the first 16 hex digits of its SHA-256. Doctor and benchmark reports include these, so any result can be tied to the exact instructions the model received. Editing a prompt changes its version, so earlier benchmark results then describe the old prompt only.

| Task | Prompt version | Max tokens |
| --- | --- | ---: |
| candidate | `b8f6db72e781ea25` | 512 |
| capability | `788c3a60a187ca80` | 1024 |
| knowledge | `aa71e3a6bda06caf` | 1024 |
| knowledge-assessment | `36548d679ac444e2` | 2048 |
| source-lesson | `937eae52aa513e7f` | 1024 |

## Doctor

```cmd
npm.cmd run model:doctor
npm.cmd run model:doctor -- --probe
npm.cmd run model:doctor -- --probe --check-hermes
```

The doctor reads `HERMES_MODEL`, `HERMES_MODEL_BASE_URL` and `HERMES_MODEL_API_KEY` and checks:

1. **Settings:** HTTPS is required, except plain HTTP on loopback. Credentials, queries and fragments in the URL are refused.
2. **Model served:** `GET /models` must list the configured model.
3. **Probe (`--probe` only):** one 16-token completion. It records latency, whether the reply was strict JSON, whether usage counts were reported, and the model name the server reported. A non-loopback endpoint also needs `--allow-remote-cost`, because hosted providers may bill even a probe.
4. **Hermes (`--check-hermes`):** the pinned, clean Hermes checkout exists and uses the same model and endpoint.

The launcher passes only model settings; no organisation API token reaches these tools. The client ignores `HTTP(S)_PROXY`, refuses redirects, caps responses at 256 KiB, and reports fixed codes such as `ENDPOINT_UNAUTHORISED`, `MODEL_NOT_SERVED` and `ENDPOINT_TIMEOUT`. It never echoes provider text or the key. The doctor reports current endpoint reachability; saved files and benchmark reports do not prove a model is currently running.

## Benchmark

```cmd
npm.cmd run model:benchmark
npm.cmd run model:benchmark -- --repeats 3 --model-revision <weights-commit>
npm.cmd run model:benchmark -- --structured --tasks source-lesson,knowledge-assessment --repeats 2 --timeout-seconds 300
npm.cmd run model:benchmark -- --engine hermes
```

**What it runs**
- Fixed synthetic fixtures for every task, built from the same validators production uses.
- **Assessments:** each set of four fresh cases is generated like the backend's issuer (mirroring `makeChallenge` and its fixed halt/unverified/no-budget pattern). It is graded by a Python port of the backend's `gradeSkill`, for 16 checks per set.
- **Transfer comparison:** each assessment set runs twice on **identical cases**, once with four reviewed lessons and a plan, and once with no lessons. Version 2 compares only matching pairs with valid outputs in both arms. Calls carry pairId; assessmentCoverage reports plannedPairs and completePairs. Every attempted assessment arm counts toward sets/checksTotal, including transport failures. An incomplete pair cannot inflate pairedSets; no complete pair yields a null comparison. Coverage and failure rates must accompany any score to expose selection bias.
- **Engines:** `direct` sends the production prompt and JSON payload to `/chat/completions` at temperature 0, without Hermes agent scaffolding. `hermes` uses the pinned adapter, which is the real production path, but it reports no token counts. Confirm a model with `--engine hermes` before activating it.

**Constrained output:** `--structured` applies only to the direct engine. It sends the per-task `contracts.output_schema` through the compatible endpoint's JSON-schema response format; strict validators still run. The Hermes engine rejects this option. Do not transfer direct constrained results to production claims.

**What it records**
- Per task: the valid-output rate and failure categories. The categories are endpoint codes, `NOT_STRICT_JSON`, `FENCED_JSON`, `CONTRACT_INVALID` and `TRUNCATED_OUTPUT`. Production parsing stays strict, so fenced JSON is a failure, recorded separately to guide prompt work.
- Latency p50/p95/max, and prompt/completion tokens when the server reports them.
- Prompt versions, the declared weight revision (`--model-revision` is a label the owner records; it is not attestation), the endpoint origin, and the model name the server reported.
- Each call's outcome and its output (bounded to 8 KiB) in `calls.jsonl`.

Reports are written to `.local/model-benchmarks/<UTC time>/`. They contain no key; keep them private.

**Budgets**
- `--max-calls` defaults to 30, hard cap 60.
- `--max-total-tokens` defaults to 100,000, hard cap 400,000. The benchmark reserves each call's maximum completion plus an estimate of its prompt before sending it. Unreported usage is charged at that estimate.
- `--max-minutes` defaults to 30, hard cap 120; the budget is checked between calls, not a hard deadline interrupting an in-flight request.
- Direct `--timeout-seconds` accepts 5–300 seconds (default 120). Hermes accepts explicit 70–300 seconds; otherwise it inherits HERMES_TIMEOUT_SECONDS (70–540, default 70). Production per-task caps still apply. Reports contain configured timeoutSeconds and effectiveTimeoutSecondsByTask.
- A plan exceeding `--max-calls` is refused before any request. A non-loopback endpoint needs `--allow-remote-cost`.

**Every report states `qualification: none` and `promotionAllowed: false`.**
- The fixtures are a small, fixed synthetic sample. A positive with/without difference is descriptive only: there is no significance test and no causal claim.
- Older reports without reportVersion 2 retain their original comparison semantics and must not be used as corrected pair evidence.
- Fixtures can leak into a model's training data over time. Treat stable high scores on them as a smoke check, not evidence of general competence.
- A benchmark changes no backend policy, profile, budget or bot state.

## Qualifying the next model

See [local runtime](local-model.md) for existing pinned artifacts and commands, and [model strategy](model-strategy.md) for the measured 2B failures and 4B evaluation plan. Run the doctor, direct benchmark and then the pinned Hermes path under measured memory/deadline limits. A good direct score does not approve a production profile. Keep owner policy disabled until the required tasks qualify.

## Validation

The original v0.1.29 `test_model_tools.py` introduced five tests. They run against a real loopback HTTP server that serves a deterministic stand-in model, which answers assessments correctly only when it receives lessons. The historical total was 46 tests. In v0.1.32 the full Hermes suite passes **52/52**, including mismatched failed pairs, partial-pair time budget and effective Hermes timeout reporting.

The tests cover:
- Endpoint policy, ignored proxy variables, refused redirects (the redirect target is never requested), unauthorised keys without provider text, oversized responses and timeouts.
- Doctor readiness, `MODEL_NOT_SERVED`, and the remote-cost gate (no request is sent).
- All five task contracts valid, a positive with/without-lessons difference, prompt versions, the reported model, and no key in any report file.
- Fenced-JSON categorisation, call/token/time budgets, endpoint failures, and fixture fidelity to the backend's grading.

A full `npm run model:benchmark` through the Node launcher, against the loopback stand-in, wrote a report without the key; that fixture report was deleted afterwards.

## Per-request usage and token ceiling — v0.1.30

Migration **022** records one immutable outcome for every model ticket and lets the owner cap daily tokens. Rebuild and restart through 022 before using updated workers.

**Recording**
- Every ticket kind shares `development_requests`: portfolio R&D, knowledge transfer, assessment and source lesson. Each one's assigned researcher may record one outcome through `POST /v1/development/inference-reports` (idempotency key required).
- An outcome is `completed`, `failed` (with a fixed failure code) or `uncertain` (`INFERENCE_INTERRUPTED`). It also carries the engine, prompt version, latency and, where available, token counts and the reported model.
- Repeating the same report is accepted. A conflicting second report is rejected, and rows cannot be updated or deleted.
- Reports stay possible after expiry or a halt, because they record history and authorise nothing.
- Failed and uncertain outcomes are audited and reach the owner inbox. Completions are stored without an inbox entry.

**Workers**
- The R&D, knowledge, source-lesson and assessment workers time each real inference and save the outcome in their local journal before submitting.
- They report it with a stable key, so a lost acknowledgement is resent rather than duplicated.
- A crash mid-inference is reported once as `uncertain`. Regeneration is still refused.
- Reporting failures never block proposal submission. An older backend without the route leaves the report pending locally; it is never guessed.
- The pinned Hermes adapter does not expose token counts, so production reports carry latency and outcome only. The direct benchmark engine does record tokens.

**Token ceiling**
- The development policy accepts an optional `maxTokensPerDay` (1,000–10,000,000).
- Before any new ticket, the backend charges each request in the rolling 24 hours its reported prompt+completion tokens. When usage is unreported, it charges a conservative reservation instead: the task's maximum completion + 512 + context bytes / 3.
- The new request's own reservation is added, and the ticket is refused once the ceiling would be exceeded.
- Omitting `maxTokensPerDay` in a later policy keeps the existing ceiling; `null` removes it. Request-count limits still apply.
- Tokens are not money. Converting usage into a monetary budget needs the provider's price, which is still an owner decision.

**Inspection:** `npm run lifecycle:admin -- inference-usage` (owner) shows:
- the ceiling and the rolling window's charged, reported and remaining tokens;
- per-kind and per-model counts, outcomes, token totals and latency p50/p95;
- the latest 50 reports.

The organisation report's `development.inference` lists ticket counts by kind, which separates R&D, transfer, assessment and source tickets.

All of these are authenticated worker claims, not provider bills or execution attestation.

## Remaining for AI-01

- Qualify the next candidate after the failed direct 2B run; choose the enabled task profile from evidence.
- Hermes-path confirmation.
- Token counts on the production Hermes path.
- Monetary spend ceilings: per-request recording and token ceilings are done in v0.1.30.
- Endpoint health in the owner report.
- Cancellation of an in-flight provider call.

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 7 October 2026; historical records retain their original scope.
