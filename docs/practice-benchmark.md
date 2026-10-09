# Paired evaluation of research guidance

The Vibe-Trading-inspired practice prompt must be evaluated before claiming improved reasoning. This finite experiment compares the current knowledge prompt against the exact same prompt with only the practice suffix removed. It does not benchmark capability proposals, execute Hermes orchestration, train model weights, or qualify a bot.

## Prepare without inference

From the Nexus directory in Command Prompt:

```bat
npm run model:practice
```

Preparation writes `study.json` and `state.json` under `.local/practice-benchmarks/<run>/`. It does not initialize a model endpoint. The study fixes four synthetic cases: missing costs, conflicting evidence, hostile embedded instructions and selection bias. Each case receives both prompt variants in alternating order, for eight planned requests. These are new fixtures for this experiment, not guaranteed unseen by the base model and not an independent market holdout.

## Run against an already configured local model

```bat
npm run model:practice -- --run
```

The existing local `HERMES_MODEL`, `HERMES_MODEL_BASE_URL` and `HERMES_MODEL_API_KEY` settings must be configured. Only loopback endpoints are accepted; the command does not start a model server, install weights or contact a hosted provider. The launcher passes model settings but excludes organisation and broker credentials. The endpoint's model name is a declaration, not cryptographic weight attestation.

Both variants use temperature zero, the same structured-output schema, the same context and at most 1,024 completion tokens per call. Maximum eight calls, a 30-second per-call request timeout, a 300-second scheduling budget and a 360-second launcher kill limit. The HTTP timeout is a socket timeout; the launcher supplies the outer process limit. There are no automatic retries. Token limits are requested from the provider, not independently enforceable if a provider disregards them. Usage counts are recorded when supplied.

## Failure and interruption records

Before each request, `state.json` records the active case, variant and fingerprints. Completed/failed calls are appended and synced to `calls.jsonl` before the checkpoint advances. An interrupted run may leave `inference-started` with uncertain completion; do not interpret it as a scored failure or a completed experiment. No report means no completed summary. This is diagnostic crash evidence, not a guarantee against every filesystem/power failure. Existing run directories are not resumed or overwritten; a new invocation creates a separate experiment.

`report.json` counts all attempted calls, valid outputs per variant and complete valid pairs. Truncation, refusal, tool requests, malformed JSON and wrong lesson citations fail structural validation. A pair is complete only if both variants pass those checks. Failed calls remain in the denominator.

## Reasoning quality review

Valid JSON is not a correct argument. An independent reviewer must read the answers and apply the study's fixed rubric: grounding, counterargument/falsification, missing information, test quality and authority boundaries. Responses remain untrusted model text. This version does not automatically grade semantics, compute a winner or hide variant labels from reviewers. `improvementDemonstrated` remains false and `semanticReview` remains pending until a separate review workflow is implemented.

The software tests use synthetic responses and validate pairing, failure counting, citation rejection, budgets and interruption checkpoints. They are not evidence that the real local model improved. No real inference was started during preparation of this increment.
