# Bot reasoning, knowledge graph and transfer — v0.1.24

## Fresh-task assessment after transfer

Migration 018 connects an accepted transfer to one immutable assessment containing four fresh synthetic research scenarios. An independent evaluator issues it, consuming one additional slot from the existing shared development/model request budget. The original researcher receives the plan, lessons and questions; another bot's credential cannot take over. The request expires after one hour. All four cases must be answered exactly once, and submitted answers cannot be revised. An expired or failed attempt cannot be replaced for the same transfer.

The tool-disabled Hermes worker answers costs, peak-relative drawdown, event/availability cutoffs and abstention conditions. The backend owns the numerical checks and the assigned independent evaluator triggers grading. There are 16 checks. Results are `passed`, `failed` or `invalidated`; support withdrawal before grading invalidates the result instead of awarding a pass. Timely submissions can be graded after their submission deadline. Historical reports remain immutable.

The graph links transfers to assessment nodes; accepted prior plans include their assessment report in future reasoning context, including failed results. This is feedback about submitted answers on fresh synthetic tasks. It is **not proof that the model ran, that transfer caused improvement, or that the bot generalises to markets**. The model receives task definitions, and there is no pre-transfer/control comparison. No fitness, money, school qualification or deployment permission changes.

```cmd
REM JSON file: {"requestId":"an accepted transfer UUID"}
npm run worker:knowledge -- assessment-create .local/assessment-request.json
REM Use the assessmentId returned above; requires the configured Hermes model endpoint.
npm run worker:knowledge -- assess --assessment-id ASSESSMENT_UUID
REM JSON file: {"assessmentId":"the issued assessment UUID"}
npm run worker:knowledge -- assessment-grade .local/assessment-grade.json
```

Creation/grading select the evaluator credential; answering selects the researcher credential. The worker persists inference start and validated answers before submission, replays lost acknowledgements with the same key, and refuses automatic regeneration after uncertain inference. These are explicitly started operations. Saved direct model benchmarks do not prove a recurring worker is active or that the production Hermes path qualifies.

Assessment POST routes under `/v1/learning/knowledge/` are `assessments` (evaluator, `{requestId}`), `assessments/work` (researcher, `{assessmentId}`, read-only), `assessments/answers` (researcher, `{assessmentId,answers:[{caseId,answers}]}`), and `assessments/grades` (assigned evaluator, `{assessmentId}`). Mutations require idempotency keys. Scores are never accepted from clients. The four answer fields are `netProfitPaise`, `maxDrawdownBps`, `eligibleRecordIds`, and `action` (`research` or `wait`).

`verify:knowledge` now covers the complete HTTP transfer → fresh assessment → answers → independent grade → graph flow, including response loss at both proposal and answer submission. Its numerical solver is a deterministic stand-in, not real model inference. The original transfer contract follows below.

This begins the AI organisation's learning workflow. A recipient bot has its own stored role, specialty, method and contribution. Its reasoning context combines a new task, 1–5 reviewed lessons from other bots, up to five of its own currently supported factual trial memories and up to five accepted prior application plans. The existing Hermes adapter drafts a cited application plan with checks and risks. A different evaluator accepts or rejects it. An accepted plan becomes available to future reasoning requests, but is not a completed experiment, mastery certificate or fitness reward.

## Model selection

Preferred experimental local model: **Qwen3.5-4B Q4_K_M** through the compatible loopback endpoint and pinned Hermes adapter. The saved 2B direct benchmark failed important contracts and numerical checks. The constrained direct 4B run improved output validity on its tested tasks; drawdown still failed and production Hermes qualification remains open. See [selection evidence](model-selection.md). The [model strategy](model-strategy.md) replaces the earlier provisional 9B recommendation. The example policy stays disabled; no private settings were changed.

We reuse one existing foundation model with different bot contexts. This is not a separately trained neural network per bot. Distinct responsibilities, evidence, memory and evaluation make the agents different. Model identity and endpoint are owner-configured and replaceable; generated content cannot change them.

## Knowledge and experience

The graph is a bounded SQL-backed projection, not a separate graph database. It links bots → authored lessons → supporting evidence → source, lesson → transfer request → recipient, transfer → independent reviewer, and bot → reviewed experience → evaluated trial. Historical lessons and transfer plans remain inspectable after retirement or source withdrawal. Lesson usability is recomputed; historical acceptance must not be treated as current permission. Reviewed numerical experiences use the existing provenance/evidence/model filters. Rejected plans never enter reasoning context. Prior plans whose lesson support has been withdrawn are excluded.

Graph output is current organisational knowledge, not a temporally filtered historical backtest dataset. Lesson review is not a guarantee that external claims are true. Publisher RSS/Atom and bounded Vibe collection adapters now feed the approved-source observation/review workflow. They are finite, explicitly started tools; real publisher validation, corroboration and demonstrated transfer benefit on fresh held-out tasks remain open.

## Workflow and authority

1. Owner-created or managed bots supply identities. A reviewed mentor lesson references verified evidence.
2. Researcher requests a transfer for another active bot and a concrete task. Retired mentors' supported lessons remain reusable.
3. The ticket freezes model/context/hash, expires after ten minutes, and consumes the **existing shared development-policy budget**. No new unmetered model quota exists.
4. The Python worker checks identity and current preflight, records inference start durably, then invokes tool-disabled Hermes. Context is treated as untrusted data. Requests are bounded and model output has a strict schema with exact lesson citations.
5. A lost submit response replays the saved plan/key without another model call. An uncertain inference cannot regenerate automatically.
6. A separate evaluator reviews the proposal. Acceptance rechecks policy, halt, recipient and current lesson support. Rejection can retain a failure reason after withdrawal. No curriculum, budget, retirement, release or fitness state changes.

No recurring worker, paid endpoint or persistent organisation was activated by development tests. Stronger measured learning, automatic hypothesis execution and validated adaptation remain to be built.

## API and commands

All routes start `/v1/learning/knowledge/`:

| POST route | Role | Input |
| --- | --- | --- |
| `requests` | Researcher | `{botId,task,lessonIds}`; idempotency key required |
| `preflight` | Researcher | `{requestId}`; read-only current authorization |
| `proposals` | Researcher | `{requestId,contextHash,proposal}`; idempotency key required |
| `reviews` | Evaluator | `{requestId,decision,reason}`; accepted/rejected; idempotency key required |
| `graph` | Owner/evaluator | `{botId}`; read-only bounded graph |

`proposal` contains `summary`, `application`, `lessonIds`, `checks`, `risks`. It must cite every supplied lesson exactly once. Reviews, requests and proposals are immutable. Migration 017 requires backend rebuild/restart.

After an owner has configured and enabled an actual model endpoint and approved inputs:

```cmd
npm run worker:knowledge -- --bot-id STUDENT_ID --lesson-id LESSON_UUID --task "Design a fresh cost-aware comparison" --request-key stable-learning-key
npm run worker:knowledge -- review .local/knowledge-review.json
npm run lifecycle:admin -- knowledge-graph .local/knowledge-bot.json
```

The review file contains `{requestId,decision,reason}`; the bot file contains `{botId}`. The Node launcher selects evaluator credentials only for `review`; inference gets only the researcher credential, and the Hermes child gets no backend credentials. Reuse the request key after an uncertain submission. Actual inference needs the existing `HERMES_ENABLED`, source/runtime, model, endpoint and provider credential settings documented in the Hermes guide. Do not paste secrets into chat.

`npm run verify:knowledge` uses a fresh backend, two fixture bots, actual Python HTTP, independent review and a deterministic model stand-in. It verifies protocol behaviour and graph links, not real model reasoning. The report is `.local/knowledge-verification.json`.

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 7 October 2026; historical records retain their original scope.
