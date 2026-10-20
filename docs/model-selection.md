# Model selection evidence — 6 October 2026

**Preferred experimental profile: Qwen3.5-4B Q4_K_M with schema-constrained JSON on the direct llama.cpp endpoint. Production Hermes qualification remains open.** The 2B run failed important contracts and is not approved as a fallback. See [strategy](model-strategy.md), [runtime](local-model.md) and [benchmark usage](model-readiness.md).

## Saved evidence

These are existing local reports inspected for this documentation refresh, not new inference runs. They use seed 20261006 and two repeats.

| Measure | 2B free-form | 4B free-form | 4B constrained |
| --- | ---: | ---: | ---: |
| Candidate/capability/knowledge valid outputs | 6/6 | 6/6 | Not retested |
| Source-lesson valid outputs | 0/2 | 2/2 | 2/2 |
| Assessment valid outputs | 3/4 | 1/4 | 4/4 |
| Assessment latency p50 | 72.6 s | 146.1 s | 50.7 s |
| Assessment latency maximum | 85.8 s | 163.7 s | 65.9 s |
| With-lessons checks passed across all attempted sets | 2/32 | 0/32 | 17/32 |
| Without-lessons checks passed across all attempted sets | 6/32 | 4/32 | 10/32 |

The report directories under .local/model-benchmarks are 20261006T170703Z, 20261006T171731Z and 20261006T173456Z respectively. The two free-form reports predate reportVersion 2; their old transferComparison paired counts are not reliable. The 2B saved outputs were regraded offline in the preceding review: only one complete valid pair. The free-form 4B run has no complete valid pair because both with-lessons outputs failed validation.

The constrained report uses reportVersion 2 and records **2/2 complete valid pairs**, with 53.12% versus 31.25% checks passed. This small descriptive difference does not establish causal learning or market skill. It tests only source-lesson and assessment contracts; other tasks were measured free-form, not constrained. Correctness is separate from output validity.

## Remaining failures and boundaries

- Drawdown remains 0/16 across both assessment arms. Do not qualify numerical accuracy from format compliance. A future method-reasoning evaluation can call deterministic calculators, but must use a new rubric and retain these original failures.
- Schema-constrained output is currently a **direct benchmark option only**. It is not wired into the production Hermes inference path. No production improvement follows until that path is implemented and tested.
- Schema requests do not guarantee correctness or even a usable response: unsupported endpoints, truncation, timeouts and semantic errors remain possible. Strict validators still decide acceptance.
- Independent source review, lesson review and held-out evaluation remain required. The task schema cannot establish that a quoted claim is true.
- Do not conclude constrained decoding generally halves latency from six calls on fixed fixtures. These reports show a lower observed assessment latency in this run only.

## Configuration and next step

Existing artifact pins and sizes are in [local-model.lock.json](../config/local-model.lock.json). The server configuration is loopback port 8080, key-protected, 16k context and one slot. File sizes do not equal running RAM; measure memory before launching. The disabled example policy uses the 4B alias. No private configuration, policy or service was changed during this refresh. Files and past reports do not prove current server liveness.

Next: evaluate all five contracts in constrained mode on fresh cases, then implement and verify the same behaviour through the pinned Hermes adapter. Keep task caps, permissions, evidence review and independent numerical grading. No automatic recruitment, fitness award, live trading or owner-policy activation follows from model selection.

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 7 October 2026; historical records retain their original scope.

## Production path — v0.1.33

The constrained output that made 4B reliable now reaches the organisation's real workers. The owner selects it explicitly.

- **Owner policy:** the development policy's model profile accepts `"engine": "direct-structured-v1"`. The default stays `"hermes-rd-v1"`, so existing policies are unchanged. Tickets carry the selected engine, and a direct ticket records `sourceRevision: null`, `tools: []` and `decoding: "json-schema"`. Unknown engines and extra runtime fields such as tools are rejected.
- **Workers:**
  - Set `HERMES_ENGINE=direct` together with `HERMES_ENABLED=true` and the three model settings. No Hermes checkout is needed: the engine is a plain chat completion carrying the task's JSON Schema, with no agent loop, tools or upstream code.
  - The same strict validators decide acceptance, and the same 4 KiB output bound applies.
  - Workers refuse any ticket whose engine, model or endpoint differs from their local configuration, before preflight or inference.
- **Usage:** direct-engine inference reports real prompt and completion token counts and the server-reported model name to the backend (migration 022). The token ceiling then charges actual usage instead of a reservation.

### First real end-to-end run

`npm run verify:real-model` drives the production worker CLI (`knowledge_worker.py workflow-run`) against a fresh in-memory backend and the local 4B server. It passed on 6 October 2026 in 4 min 45 s:

| Stage | Real model work | Time | Tokens (prompt + completion) |
| --- | --- | ---: | ---: |
| Source lesson | Lesson with an exact article quotation and a stated limitation | 34 s | 414 + 102 |
| Cross-bot transfer | Comparison plan citing the lesson, with 5 checks and 5 risks | 65 s | 535 + 294 |
| Fresh assessment | Answers to 4 new cases, graded by the backend | 181 s | 3,126 + 341 |

The assessment outcome was `failed`, with **6/16** checks passed: abstention 4/4, information timing 2/4, costs 0/4, drawdown 0/4. The model's lesson, plan and answers are saved verbatim in `.local/real-model-verification.json` for owner review.

The two review decisions in this run were automated fixture acceptances, made only to exercise the chain. Real use requires independent review judgement.

This is the M1 milestone from the [remaining-work assessment](remaining-work-assessment.md), reached with actual inference, lineage and usage records: one approved source, a model-drafted lesson, review, transfer to another bot, a fresh assessment and durable feedback. It demonstrates a working chain. It does not show that the bot learned anything; there is no control arm in this run, and the numerical checks show the model cannot yet do the arithmetic.

### Recommended next step

Separate the method from the arithmetic in assessments. The model should name the computation and eligibility rules; the backend computes the numbers deterministically. That tests whether a bot applied a lesson rather than whether a 4B model can do floating-point maths, and it keeps metrics in deterministic code, as the organisation already requires for money.
