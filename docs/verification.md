# Validation record — updated 2026-10-06

## Current development update — v0.1.35, 7 October 2026

The checkout now includes v0.1.34's explicit direct-structured-v1 production engine and migration 023, which adds the optional research-methods-v1 assessment rubric. Existing research-basics-v1 records/defaults remain unchanged. The direct worker requests task schemas and binds tickets to the owner-selected engine; it is separate from Hermes, not a fallback or an upgrade of the pinned Hermes path.

This increment rejects direct responses unless the provider reports a normal stop with no tool calls or refusal, even when their JSON is valid. Reported tokens survive validation/completion failures in the durable failed outcome. No automatic regeneration or engine switch is added. Learning/R&D launchers now propagate HERMES_ENGINE to inference workers, while reviewer/discovery commands retain credential separation. Explicit Hermes benchmarks cannot be relabelled direct runs by ambient settings.

Validation: all 59 Python tests passed; the launcher regression passed six command/role scenarios using intercepted child launches and fixture credentials. No model, backend policy, persistent service, Docker runtime or financial connection was activated. No backend code/migration changed in this increment. Full backend tests were not rerun for these Python/launcher changes.

## Version 0.1.34 — method-based assessment rubric

- **Full backend regression:** build plus **120/120 tests passed with zero failures (195.342 seconds)** against migration 023 (log `.local/backend-tests-v034.log`).
  - New `assessment-methods.test.ts` (2 cases): derivation to 16/16 for correct methods; each wrong method fails only its own concept; answer forms cannot be mixed between rubrics; the basics default and its context shape are unchanged.
  - One new workflow case: a methods workflow issues method assessments and refuses to link a basics assessment.
- **Hermes Python suite:** **57/57**. Covers the method validator, a Python derivation matching the backend vectors (net 950, drawdown 2,500 and the 4,000 distractor), the methods schema, rubric-based task selection and a benchmark that reports paired method results.
- **Benchmark, real inference (local Qwen3.5-4B, schema-constrained, 3 pairs):**
  - With lessons: 46/48. Without lessons: 37/48. Higher in every pair; all 6 outputs valid.
  - The lessons used directly state the tested concepts.
- **Real chain (`verify:real-model -- --methods`):** completed in about 4.9 minutes and graded **8/16, failed**. The student had only one model-extracted article lesson.

Scope:
- Synthetic cases; automated fixture reviews.
- Not evidence of learning from real sources or of market competence.
- No persistent policy, worker or service was activated; the model server was stopped.

## Version 0.1.33 — owner-selectable direct structured engine and first real end-to-end run

- **Full backend regression:** build plus **117/117 tests** passed with zero failures (290.214 seconds; log `.local/backend-tests-v033.log`). This includes a new engine-selection case: Hermes stays the default; `direct-structured-v1` tickets carry `sourceRevision: null`, `tools: []` and `decoding: json-schema`; unknown engines and smuggled runtime fields are rejected.
- **Hermes Python suite:** 55 tests; 21 of 22 runs passed (13 sequential, 8 under 4× parallel load). One run, immediately after the backend suite, reported 1 failure that could not be reproduced; its output was not captured, so the failing test is unidentified. Treat this as an open flakiness investigation. The suite includes 3 new direct-engine tests against a real loopback stand-in:
  - No Hermes checkout is needed for the direct engine.
  - Engine/profile binding works in both directions.
  - The schema is sent with the exact supplied IDs.
  - Fenced or unauthorised replies are refused.
  - The worker reports real token counts and refuses an engine-mismatched ticket before preflight.
- **Other suites, on the combined code after the parallel v0.1.32 review session:**
  - skfolio 64, research 10, feeds 21, Vibe/importers 34, starter/supervisor 10, Ruflo 18. All passed.
- **`npm run verify:real-model`:** passed at 2026-10-06T17:57:42Z with **real inference** on local Qwen3.5-4B Q4_K_M (llama.cpp b11435, CPU), through the production worker CLI and an in-memory backend:
  - Source lesson: 34 s, exact quotation, 414+102 tokens.
  - Transfer plan: 65 s, 535+294 tokens.
  - Fresh assessment answers: 181 s, 3,126+341 tokens.
  - Backend grade: **6/16, outcome failed** (abstention 4/4, timing 2/4, costs 0/4, drawdown 0/4).
  - Three completed inference reports with real usage; graph of 10 nodes and 9 edges; zero wallet balance; valid audit chain.
  - Report with the model's verbatim outputs: `.local/real-model-verification.json`.

Scope:
- Both review decisions were automated fixture acceptances.
- One article and four synthetic cases; no control arm.
- This demonstrates the chain end to end, not learning, market competence or Hermes-path behaviour.
- No persistent policy, worker or service was activated; the model server was stopped afterwards.

## Documentation reconciliation — v0.1.32, 7 October 2026

Inspected all first-party Markdown documents and current code/report metadata. The newer saved 4B reports supersede the earlier statement that no 4B report existed. The free-form report (20261006T171731Z) has 1/4 valid assessments and no complete valid pair. The version-2 constrained report (20261006T173456Z) has 2/2 valid source lessons, 4/4 valid assessments and 2/2 complete pairs: 17/32 versus 10/32 checks, with 0/16 drawdown across both arms. It uses the direct engine only; production Hermes schema support remains pending. See [model selection](model-selection.md).

This refresh changes documentation only. Saved reports were inspected, not rerun. No build/test result below is claimed as a new run, and no model/service/policy/financial state was changed. Current command examples use Command Prompt; historical transcripts retain their original context. The documentation index distinguishes runtime guides, original design, templates and dated records. Validation on 7 October: 68 Markdown documents, 782 local link targets/section references checked with no missing targets or anchors; git diff --check passed.

## Version 0.1.32 — review fixes and model decision

- **52/52 Hermes Python tests passed**, including regression cases for failed arms falsely forming a pair, a time budget ending mid-pair, configured/environment Hermes timeouts and effective task caps.
- **21/21 publisher-feed tests passed**, including a crash between saving a 429 outcome and its checkpoint, and recovery of a saved 304 after previous failures. The six-hour Retry-After remains intact and failure counts apply once.
- During the preceding review, TypeScript compilation and all three inference-usage tests passed; no backend source/migration changed in these fixes. The final TypeScript build also passed for v0.1.32.
- Local file targets in 66 Markdown documents resolved; git diff --check passed.
- Benchmark reports now use reportVersion 2; prompts and task contracts remain unchanged. Earlier raw reports are retained, not silently rewritten.
- Inspected the existing Qwen3.5-2B direct report with twelve calls. It has 0/2 valid source lessons and 3/4 valid assessments. Offline replay of saved outputs through corrected scoring gives one complete valid pair of two planned, with 12.5% versus 18.75% checks passed. No new inference occurred; no causal learning improvement is established.
- Read the ten supplied upstream repository entry points/READMEs plus official Qwen cards and relevant FreqAI/llama.cpp documentation. This is a capability/model-fit review, not a full source audit. The 4B candidate has no saved benchmark report in the inspected directory and remains unqualified.

No new model download, service launch, persistent automation, private configuration, financial connection or Docker test was performed. Documentation now distinguishes saved direct-model evidence, production qualification and future organisation capabilities.

## Version 0.1.30 — per-request inference usage and token ceiling

- **Full backend regression:** build plus **116/116 tests** passed with zero failures (257.405 seconds; log `.local/backend-tests-v030.log`), against migration 022.
- **Three new inference-usage tests:**
  - Author-only, immutable, replay-safe reports; conflicting outcomes rejected; schema bounds.
  - Failures audited, while completions create no inbox entry; reports accepted during a halt.
  - The ceiling charges reservations until usage is reported; omitted policy fields keep the ceiling and `null` removes it.
  - Per-kind/model statistics with latency percentiles; HTTP roles and idempotency.
- **Hermes Python suite:** **47/47 tests** passed. Scripted-client tests now assert completed reports carry the correct prompt version, a failed inference reports `INFERENCE_FAILED` once, and the assessment worker reports against its own ticket ID without resending after a lost answer acknowledgement.
- **`npm run verify:knowledge`:** passed over real Python-to-HTTP with injected response loss. All three model stages (source lesson, transfer, assessment) recorded exactly one `completed` report with a Hermes engine label and unreported tokens.

Scope:
- No model endpoint was configured or called; the stand-in inference has no token counts.
- Reports are authenticated worker claims, not provider bills or attestation.
- Tokens are not converted to money.

## Version 0.1.29 — model endpoint readiness

- **Prompt extraction:** before the runner refactor, the previous runner's system prompts and token limits for all five tasks were captured. All matched `contracts.py` exactly.
- **Hermes Python suite:** **46/46 tests passed**. This includes the 41 existing tests run after the refactor, and 5 new `test_model_tools.py` tests against a real loopback OpenAI-compatible stand-in.
- **Transport and doctor:** proxy variables ignored, redirect target never requested, unauthorised/oversized/timeout codes, the doctor's served-model and remote-cost gates, and no key in any output.
- **Benchmark:** all task contracts, the paired with/without-lessons comparison (positive by construction of the stand-in), budgets, fenced-JSON categorisation, and grading fidelity to the backend's grader.
- **Launcher smoke:** `npm.cmd run model:benchmark` through the Node launcher wrote a key-free report from the stand-in; that report was deleted.
- **Doctor against the real `.env`:** `ENDPOINT_NOT_CONFIGURED`.

Scope:
- No model was installed, downloaded or called.
- The machine had no model server or Hermes checkout, and no CUDA GPU.
- No backend source or migration changed, so the 113-test backend result from v0.1.28 still applies.
- Stand-in scores demonstrate the tooling, not any model's quality.

## Version 0.1.28 — approved-publisher feed intake

`npm.cmd run test:feeds` passed **19/19 tests**:
- Parser (6): RSS/Atom extraction, DTD/entity/XXE refusal, malformed XML, fixed rejection reasons without publisher echo, backend length bounds, strict explicit-zone dates.
- Client (4): configuration bounds, conditional requests, redirect/HTTP/type/size codes, Retry-After, and real loopback HTTP showing redirects are not followed and slow responses time out.
- Cycle (9): poll interval, ETag, lost-acknowledgement resume from the saved snapshot, corrections, newest-N capacity, exponential backoff, parse failure retention, crash recovery, abandonment, configuration/credential binding, locking and a finite session.

`node scripts/verify-feeds.mjs` passed at 2026-10-06T12:53:29Z against an actual in-memory backend and a loopback synthetic publisher. It covered:
- Response loss after acceptance, recovered without a refetch or duplicate evidence.
- The not-due and `304` paths.
- A corrected entry stored as a separate unverified revision.
- Evidence becoming usable only after independent review.
- Source withdrawal blocking ingestion, followed by explicit abandonment.
- No credentials reaching the publisher, zero wallet balance and a valid audit chain.

Report: `.local/feed-verification.json`.

The full backend regression passed **113/113 tests** with zero failures (395.530 seconds; log `.local/backend-tests-v028.log`). The suite includes the earlier discovery/review-inbox additions; no backend source or migration changed in this increment.

Shared intake helpers moved into `scripts/cycle-state.mjs` and `parseSourceMappings`. Afterwards the Vibe, importer and review-inbox suites passed **34/34**.

Scope: no real publisher was selected or contacted, and no persistent schedule, model, Docker engine or financial service was activated. Synthetic feeds do not establish real-feed compatibility, access permission or claim accuracy.

## Version 0.1.27 — bounded learning workflow orchestration

### Discovered-learning worker — 6 October 2026

**20/20 Python tests passed** across `test_discovered_learning`, `test_knowledge_discovery`, `test_knowledge`, `test_source_learning` and `test_learning_workflow`. Six new tests cover empty search without model setup, persisted selection and input binding, real nested proposal-journal recovery after a lost acknowledgement, invalid selections, support-withdrawal failures without rediscovery and unknown acknowledgements without success receipts. Command Prompt was used. No backend code changed in this increment; no model, live data provider or financial service was activated.

### Cross-bot lesson discovery — 6 October 2026

TypeScript compilation and **8/8 bot-knowledge backend tests** passed. Discovery checks cover bounded relevance ranking, retired-author retention, exclusion of unreviewed/own lessons, revoked support, strict HTTP roles and revalidation by the transfer path. **14 Python tests** passed across `test_knowledge`, `test_source_learning`, `test_learning_workflow` and `test_knowledge_discovery`; the latter verifies the discovery CLI never loads model settings or invokes inference. Checks used Command Prompt. No upstream runtime was activated and the full backend suite was not rerun for this increment.

### Organisation evidence-review inbox — 6 October 2026

TypeScript compilation passed. The focused source-observation, source-learning and learning-workflow suites passed **15/15 tests**, including authenticated HTTP permissions, oldest-first cursor pagination after review, self-review blocking and withdrawn-source diagnostics. The new terminal-reader suite passed **3/3 tests**, checking credential separation, endpoint validation and bounded responses. Commands ran through Command Prompt. The full backend suite was not rerun for this increment; no live model or upstream provider was contacted.

### Additional Vibe-Trading news integration validation — 6 October 2026

The subsequent resumable-cycle increment passes **31/31 focused tests**, extending the 23 checks below with saved-result recovery, immutable input/backend binding, empty/rejected outcomes, incomplete-collection handling, snapshot hash checks and concurrent-worker exclusion. Tests were run with `node --test` through Command Prompt. These remain fixture/contract checks, not actual upstream or live-backend verification.

`npm.cmd run test:vibe` passed **23/23 tests** through Command Prompt. Coverage includes news conversion, importer retries, rejected-row handling, bounded files, real loopback HTTP JSON/SSE handshakes, one-tool restriction, scope binding, redirects, mismatched response IDs, oversized responses, timeout/session cleanup and collection artifact preservation. HTTP peers are local fixtures, not Vibe-Trading itself. Submission uses an injected transport. No live upstream, model, financial service or recurring worker was activated. The preceding adapter increment also passed `npm.cmd run build`; this collector increment changes JavaScript integration code, tests, configuration and documentation only.

### Learning workflow validation

The build and full **110-test backend regression suite passed** with zero failures (374.910 seconds). Log: `.local/backend-tests-v027.log`.

After that run, an explicit conflict guard was added for cross-workflow stage reuse. The final rebuild and all four focused workflow tests passed again (21.646 seconds), including an unlinked record with mismatched participants. Local links in six updated documents resolved.

Compilation and all **4 focused workflow backend tests passed**, covering the complete reviewed source/transfer/assessment path, role and identity binding, stage substitution, immutable links and blocking states. All **34 Hermes Python tests passed** (0.582 seconds), including bounded polling, no-model waiting and replay-safe stage attachment.

The actual Python-to-HTTP fixture completed an owner-defined workflow at 2026-10-06T06:51:59.695Z. Separate researcher/evaluator workers advanced source proposal, transfer, assessment creation, answers and backend grading around two explicit independent review decisions. Injected response loss did not repeat the three model-stand-in calls; the assessment-link response loss also recovered. Final assessment was 16/16; wallets were not funded and audit verification passed.

This is orchestration evidence with deterministic stand-ins, not a real-model learning result. No persistent worker or provider was activated; Docker remains deferred. Cancellation stops workflow progression only, not issued request authority or an in-flight process. Migration 021 is required. Changed Node entry points passed syntax checks.

## Version 0.1.26 — reviewed article-to-lesson proposals

The final build and full **106-test backend suite passed** with zero failures (326.222 seconds). Log: `.local/backend-tests-v026.log`. The two changed Node launch/fixture scripts passed syntax checks; local links in seven updated documents resolved.

Compilation and all **12 focused source-learning/knowledge backend tests passed** (58.822 seconds). They cover dedicated independent review before transfer, exact quotation checks, context/identity binding, rejection finality, immutability, shared quotas, halt/source withdrawal, retirement, policy changes, graph lineage and HTTP roles.

All **29 Hermes Python tests passed** (0.648 seconds), including the new source-learning contract and shared durable-worker regression tests. The actual Python-to-HTTP fixture passed at 2026-10-06T06:34:57.065Z: synthetic article observation → cited lesson proposal → independent review → cross-bot transfer → fresh-task assessment. It used one stand-in call at each of three inference stages despite injected response loss; final assessment was 16/16 with 10 graph nodes and 9 edges, zero wallet balance and a valid audit chain.

No provider inference or learned improvement is established. Model, financial and persistent services were not activated; Docker remains deferred. Migration 020 is required for the new contracts. The dated v0.1.25 codebase assessment is retained with a development-update note, not represented as a new source audit.

## Version 0.1.25 - external source observation provenance

Compilation and the full **101-test backend suite passed** with zero failures (348.842 seconds). Log: `.local/backend-tests-v025.log`.

The focused source-observation and bot-knowledge run passed all **11 tests**. Coverage includes immutable revisions, duplicate ingestion, source-origin binding, future-date rejection, independent review, halt/revocation, HTTP roles and provenance in bot context/graph. The batch importer passed **2 tests**, including stable retry keys after lost acknowledgement and rejection before credential transmission.

The actual Python-to-HTTP knowledge and fresh-assessment fixture passed again at 2026-10-06T01:39:16.409Z with the new context shape and migration 019. Its deterministic stand-in still does not demonstrate real model inference. Local links in the four updated entry-point documents resolved successfully.

No external publisher was contacted or authenticated by these checks. The new importer submits collector-provided excerpts for separate review. RSS/API retrieval, extraction into lessons and persistent collection remain future work. Wallets and model services were not activated.

## Version 0.1.24 - fresh-task knowledge assessments

Build and all **97 backend tests passed** (268.838 seconds). New coverage checks fresh task attribution, independent numerical grading, reusable passing and failing feedback, exact answer contracts, immutable records, shared model quotas and evidence withdrawal. Financial balances remain unchanged.

After the full run, portfolio R&D submission/preflight received an explicit request-type guard to reject knowledge and assessment tickets cleanly. Compilation and all seven focused knowledge tests passed again (30.340 seconds), including both cross-route rejection cases. CLI scripts passed Node syntax checks.

All 16 dispatch, learning and R&D regression tests also passed after that guard (36.281 seconds).

All **25 Hermes Python tests passed** with mocked inference. The actual Python-to-HTTP knowledge fixture passed at 2026-10-06T01:24:43.537Z, including a reviewed transfer, four fresh cases, 16 backend checks and assessment graph relationships. Injected response loss at both submission stages reused saved answers without repeating inference. Report: `.local/knowledge-verification.json`.

The fixture uses a deterministic solver: this demonstrates the workflow, not real model execution, causal learning improvement or trading competence. Migration 018 adds append-only assessment records. No model provider was activated; live Docker testing remains deferred.

## Version 0.1.23 - bot knowledge and cross-bot reasoning

Build and all **94 backend tests passed** (289.340 seconds). After adding reusable prior plans and reviewed experience context, a rebuild and all four focused knowledge tests passed again. Coverage includes retired mentor knowledge, exact citations, independent review, graph consistency, immutable history, shared model quotas, and halt/policy/source withdrawal.

All **21 Hermes Python tests passed** with mocked inference. They cover strict plan validation, no tool surface, lost-response replay, changed request rejection and no automatic regeneration after uncertain inference. The actual two-bot Python-to-HTTP fixture passed again at 2026-10-05T16:36:47.199Z. It verified reviewed lesson transfer, independent evaluation and graph relationships, with one model-stand-in call despite response loss and no financial writes. Report: `.local/knowledge-verification.json`. This is not real model inference or demonstrated improvement.

Qwen/Qwen3.5-9B is the provisional candidate, with a disabled example profile. No model download, paid call, server installation or persistent activation occurred. Hardware/model quality, external-source automation and learning benefit on fresh tasks remain unverified or unfinished. Migration 017 adds knowledge lineage records; acceptance never grants fitness, curriculum or deployment authority.


## Version 0.1.22 — owner research approval records

`npm.cmd test` passed compilation and all **90 backend tests** in 190.088 seconds, with zero failures. Four new cases cover exact candidate binding, passing independent review, strict owner authority/schema, immutable history, historical command replay, permanent revocation during halt, changed policy support, failed candidates, HTTP authentication/roles and read-time expiry. The existing financial, academy, lifecycle, dispatch, reporting and recovery regressions passed against migration 016.

Approvals are records for further research only: no worker consumes them as an execution gate, and they cannot deploy code, alter curriculum or grant money/trading authority. Revocation does not roll back processes. Migration 016 must be applied by rebuilding/restarting before the new routes are available. No persistent approval or policy was created during these isolated tests.

Owner CLI syntax passed. Python and the actual artifact-recovery fixture were unchanged and were not rerun; the prior 64-test Python run and v0.1.21 HTTP fixture remain historical evidence. Live Docker testing remains explicitly deferred. Current API, approval guide, roadmap, README and continuation context were updated.

> [Current implementation, validation and limits](current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

## Versions 0.1.16–0.1.21 — isolation adapter, execution observations and recovery

Latest source is v0.1.21. `npm.cmd run build` passed. All **64 Python tests** passed together in 11.856 seconds: `test_artifact_batch.py`, `test_artifact_inspection.py`, `test_artifact_recovery.py`, `test_artifact_executor.py`, `test_execution_reporting.py`, `test_sandbox_registry.py`, `test_artifact_sandbox.py`, `test_paired.py`, `test_skills.py`, `test_bridge.py` and `test_lab.py`.

Coverage includes strict selected-journal limits, mixed batch failures, reporting outages, read-only inspection, no secret/raw-error disclosure in summaries, lost acknowledgements, identity mismatch, source/runtime-independent submission replay, immutable attempt budgets and container ownership cleanup. Docker transport/guard tests use mocks or synthetic system files; they are not a live container test.

Actual Python-to-HTTP batch recovery passed on 5 October 2026, from `2026-10-05T16:05:22.930Z` to `2026-10-05T16:06:02.406Z` (21:36:02 IST). The current `.local/paired-artifacts-verification.json` records two original solver executions, one deliberately lost submission response, zero additional executions during batch recovery, no pending reports, and a historical receipt on subsequent replay. Local inspection correctly changed from saved-unconfirmed to acknowledgement-saved. Six ordered backend observations were verified against separate submission/review facts. Independent grading detected the injected eight cost errors (baseline 24/32, candidate 32/32, eight improvements, zero regressions); promotion remained forbidden. Bot, exam, lesson and financial journal counts were zero, and audit integrity passed.

The latest complete backend regression run was **v0.1.18: 86 tests passed**, including migration 015, reporting authorization, immutability, deduplicated notifications, transition checks and post-halt/cancellation reporting. No backend service/schema changed in v0.1.19–0.1.21, so the full suite was not repeated; the latest isolated HTTP fixture exercised the current compiled backend. The earlier v0.1.18/19/20 Python totals were 52/56/61 checks, superseded by the current 64-case run.

Docker Desktop startup attempts did not establish a usable engine. The owner explicitly deferred live Docker testing; no live isolation result is claimed. No persistent worker/policy, paid model call, deployment, financial account or recurring recovery task was activated. Model learning, independent execution attestation, release/rollback governance and production validation remain unfinished. Documentation was refreshed across README, KT, resume instructions and every guide/design/template, retaining older dated evidence below as historical records.

## Version 0.1.15 — source-verified trusted local execution and durable replay

Added the manual artifact executor, separate source-snapshot child host, SQLite retry journal, scoped Node launcher, read-only descriptor command and an artifact mode for the existing paired integration harness. No backend service, database migration or dependency changed. Trusted-code acknowledgement is required; these processes are not an OS sandbox and do not provide remote attestation.

**32 Python checks passed**: the final 31-case run of `test_artifact_executor.py`, `test_paired.py`, `test_skills.py`, `test_bridge.py` and `test_lab.py`, plus the subsequently added completed-baseline/candidate-retry case run separately. Ten artifact cases cover source mismatch/path escape, acknowledgement, exact snapshots despite path changes, removed credential inheritance, direct-process timeout, bounded output, invalid answers, lost-response replay, completed-arm reuse, failure/interruption budgets, changed execution identity and exclusive locks. The initial run found unclosed SQLite handles in test inspection helpers on Windows; these helpers and fixture inspection now close connections explicitly, and the final runs passed. The runner itself already closed its connection in `finally`.

`npm.cmd run verify:paired-artifacts` passed compilation and actual Python-to-backend execution. Two hashed source snapshots were executed exactly once each. The fixture discarded one response after the real backend accepted its submission; resuming replayed the saved body/key without executing either arm again. A further call returned a historical receipt. Independent backend grading found the eight deliberately injected baseline cost errors: 24/32 baseline checks, 32/32 candidate checks, eight improvements, zero regressions and `promotionAllowed: false`. Bots, student exams, lessons and financial journals remained empty; audit integrity passed.

Report `.local/paired-artifacts-verification.json` started `2026-10-05T08:27:14.342Z`, finished `2026-10-05T08:28:59.721Z` (**5 October, 13:58:59 IST**). Fixture sources and execution journals remain under the report's `.local/paired-artifact-fixtures` directory without raw API tokens. The descriptor CLI and both Node script syntax checks also passed. This is evidence of checked local source execution and reliable transport, not learned model improvement or an independently attested runtime.

The prior **83-test backend suite** remains v0.1.14 evidence; it was not rerun because no backend service or schema changed. The new workflow exercised the existing routes in its own fresh backend. Department, Hermes and supervisor suites were not repeated. Docker probing found an installed CLI but unavailable daemon and unreadable user config, so no container isolation was tested or enabled. No persistent community, policy, financial account, provider or automatic deployment changed. OS isolation, memory/disk/network restrictions, descendant cleanup after parent death, remote attestation and release/rollback governance remain unfinished. See [artifact execution](artifact-execution.md).

## Version 0.1.14 — pre-registered paired academy experiments

Added migration 014, immutable plans with two producer declarations and identical generated cases, fixed thresholds, assigned researcher access, complete atomic submissions, independent backend grading, cancellations and inclusive status history. The shared producer-registration helper now also serves paired plans. Added a Python protocol helper, owner CLI commands and isolated actual Python-to-HTTP verification. Existing department schedules and financial permissions did not change.

`npm.cmd test` passed compilation and **all 83 backend tests**, zero failures. Seven new cases exercise fixed plans, author/version binding, immutable answers/reviews, missing and duplicate cases, client-grade rejection, per-check regressions, halt, policy withdrawal, cancellation, expiration, bounded registration history and HTTP roles. The complete suite also covers migration 014 with existing ledger, academy, recovery, lifecycle and dispatch controls. An initial targeted run exposed a test assertion using asynchronous rejection for synchronous schema validation; the assertion was corrected before this complete passing run.

All **22 Python tests** passed (`test_skills.py`, `test_paired.py`, `test_bridge.py`, `test_lab.py`), including four new paired-protocol cases for input isolation, version mismatch, incomplete execution and duplicate cases. CLI and integration-script syntax checks also passed.

`node scripts/verify-paired-skills.mjs` passed using the compiled backend, an in-memory database and actual Python HTTP calls with ephemeral scoped credentials. Eight deliberately injected fixture cost errors yielded baseline 24/32 checks, candidate 32/32, eight improvements and zero regressions; the backend returned `meets-criteria` with `promotionAllowed: false`. Counts of bots, student exams, lessons and financial journals remained zero; the audit chain verified. Report `.local/paired-skills-verification.json` started `2026-10-05T08:02:12.962Z`, finished `2026-10-05T08:02:24.761Z` (**5 October, 13:32:24 IST**). This demonstrates detection of injected errors, not an actual learned model upgrade.

The approximately four-minute department integration, Hermes and supervisor-specific suites were not repeated because their implementations/schedules were unchanged; their previous results remain historical. No persistent database, policy, provider or financial account was activated. Artifact attestation, isolated execution, durable paired-result retries, live model inference, statistical/generalisation evidence and release/rollback approval remain future work. See [paired experiments](skill-experiments.md).

## Version 0.1.13 — exam attribution and failure diagnosis

Added migration 013, pre-question producer declarations and immutable attempt binding, backend diagnosis from failed grade checks, recurring-failure reports, deterministic corrective proposals with separate review, and descriptive version comparisons. Python exam workers now declare their normalized source fingerprint and echo the bound manifest hash. Both department roles run bounded remediation cycles. The optional model-reference field records a declaration only; no model/provider was selected or called.

Executed successfully: `npm.cmd run build`, all **76 backend tests** (`node --test --test-concurrency=1 backend/dist/test/*.test.js`), all **18 Python tests** (`test_skills.py`, `test_bridge.py`, `test_lab.py`), and CLI syntax validation. Tests cover attribution mismatch, explicit legacy attribution, diagnosis/review deduplication, self-review refusal, revoked support, recovery-lesson compatibility, complete outcome comparisons, and current HTTP boundaries.

The actual Python department integration (`node scripts/verify-organisation.mjs`) passed **all nine checks** with three college students, three passed exams, three evaluated trials and one verified factual memory. Every exam carried the same declared producer hash, `f3abc39471372183f03252df7bbc0ee98388670839fa8594761282dba72a346a`; no failure diagnosis was generated for these passing exams. Failure-to-lesson paths were exercised separately by the backend tests. Both roles stopped cleanly (expected code 130), budgets stayed zero, wallets/ledger remained empty and the audit chain verified.

Latest report: `.local/organisation-verification.json`, started `2026-10-05T07:39:18.959Z`, finished `2026-10-05T07:43:06.587Z` (**5 October, 13:13:06 IST**). It supersedes earlier reports at that path. All workflow activation was confined to the isolated test database. Persistent deployment and approval remain unchanged. Declared fingerprints are not execution attestation; comparisons do not establish an improved model or authorise an upgrade. Existing supervisor/Hermes implementations were unchanged and their separate suites were not rerun.

## Version 0.1.12 — bounded school recovery

Added migration 012 and an immutable, owner-controlled one-attempt recovery exception after three consumed attempts and a newly reviewed corrective lesson. It binds policy revision and lesson fingerprint, expires after seven days, supports append-only revocation, and consumes the extra attempt atomically within the existing global quotas. Claim, submission, grading and admission recheck current support. Owner report and CLI now expose exhausted attempts and recovery records. No Python solver or financial authority changed; no persistent policy or student approval was applied.

`npm.cmd test` passed compilation and **all 72 backend tests**, with zero failures. Five new recovery cases and expanded HTTP role checks exercise a real HTTP approval/replay, independent lesson review, bounded retries, concurrent claims, quotas, policy changes, expiry, revocation, immutable history and admission after a fresh pass. The full suite also verifies the existing financial, dispatch, learning and lifecycle controls against migration 012 in isolated databases.

No new Python/model code was introduced, so Python tests and the approximately four-minute monitored-team workflow were not repeated. Their existing reports remain v0.1.11 evidence, not verification of a new recovery worker run. The new recovery flow was exercised through HTTP approval plus backend claim/submission/evaluation/admission in the regression suite. Persistent migration/startup, real correction quality and model improvement remain unverified. The shared solver does not learn from free-form lessons.

## Version 0.1.11 — academy skills

Added migration 011, an optional owner-controlled school gate, four-check synthetic rubric, immutable attempts/answers/reviews, separate author/evaluator identities, three-attempt lifetime cap, owner quotas, deadline/policy/evidence/halt checks, report blockers and department/CLI integration. Updated workers require the new routes and migration. No dependency was added and no persistent policy was enabled.

Executed results: `npm.cmd test` passed compilation and **all 67 backend tests**. All **16 academy Python tests** passed (three new skills, four bridge, nine lab). The six new backend cases also passed when run separately before the complete suite. See [academy skills](academy-skills.md) for the deliberately limited competence claim and gate scope.

The enhanced integration ran via `node scripts/verify-organisation.mjs` using the compiled backend, and passed all eight checks. Three students each passed an independently graded exam before admission; three portfolio trials were evaluated and one factual memory verified. Both supervisors stopped cleanly, all bots retained zero budgets, and wallets/ledger remained empty. Saved report `.local/organisation-verification.json` now records `passedExams: 3`, started `2026-10-05T02:53:24.591Z`, finished `2026-10-05T02:56:34.159Z` (**5 October, 08:26:34 IST**). This supersedes the older report at the same path. Persistent backend startup/migration and activation were not performed. Existing supervisor/Hermes tests were not rerun because those implementations were unchanged.

## Integrated organisation run — 5 October 2026

`npm.cmd run verify:organisation` passed, including compilation and the new `scripts/verify-organisation.mjs` check. Its fresh in-memory backend exercised the actual starter HTTP import and replay, then activated bounded policies only within that fixture and ran the researcher/evaluator supervisors with actual Python departments. All seven integration assertions passed. The saved report records **three college students, three evaluated trials and one independently verified factual memory**, with zero failed supervisor cycles, no trading graduation, zero budgets, empty wallets/ledger and a valid audit chain. Both roles acknowledged stop after cancellation (expected return code 130).

Report: `.local/organisation-verification.json`. Started `2026-10-05T02:32:40.160Z`, finished `2026-10-05T02:36:33.747Z` (5 October, **08:06:33 IST**). Three different methods were admitted; this run did not require every new student to finish a trial before success. The earlier separate portfolio check covered fitting all three methods.

`npm.cmd run test:supervisor` also passed **six tests**, including two new actual child-process cases for owner cancellation and heartbeat denial. The latter waits for the real 20-second heartbeat and confirms the child has exited. These two cases use a temporary Node child; they complement the real Python team run. This brings the previously verified 99 distinct tests to 101; only compilation and the six relevant supervisor tests were rerun in this continuation. No backend service or migration changed.

`prepareDepartment` now accepts an optional explicit environment, defaulting to `process.env`, so the integration can provide ephemeral principals without mutating global environment or loading `.env`. The launcher still selects one role token and passes its existing restricted environment to children.

No persistent owner database, policy, bank, model provider or community was changed. Test-specific replay entries were retained under the ignored bridge journal. Persistent deployment, OS-crash recovery, natural lease expiry after process death, real model inference and production isolation remain separate verification work. See [the repeatable workflow](organisation-verification.md).

## Current verification — execution authorised, v0.1.10

The owner explicitly authorised assistant execution: “if you needed access for execute you can takeover it and run it”. This supersedes the earlier user-only terminal preference. The sections below retain the historical status at each increment; this section records the current results.

Fixed the ambiguous `worker` import in both skfolio bridge and department entry points to `services.research.worker`, with explicit Python package markers. This also avoids confusing the shared HTTP client with Hermes' worker module. Editor diagnostics have not been observed after refresh.

Executed successfully:

| Command | Result |
| --- | --- |
| `npm.cmd test` | TypeScript build succeeded; 61 backend tests passed, zero failures. Includes migrations through 010 in isolated databases, financial controls, lifecycle, dispatch, learning, experiments and supervisor sessions. |
| `node --test scripts/organisation-starter.test.mjs scripts/department-session.test.mjs` | Eight Node contract tests passed. |
| Academy Python: `-m unittest -v test_lab.py test_bridge.py` | 13 tests passed in `integrations/skfolio`. |
| Academy Python: `-m unittest -v test_hermes.py test_development.py` | 17 mocked Hermes/development tests passed in `integrations/hermes`; no actual model inference. |
| `npm.cmd run organisation:prepare` | Exported and validated the offline starter bundle and review without fitting or backend writes. |
| `node integrations/skfolio/http-check.mjs` | Passed actual Python-to-HTTP fitting/evaluation for all three skfolio methods on a fresh in-memory backend. Verified metrics against Python references, retry deduplication, role restrictions, no trading graduation, empty ledger and audit integrity. |

The HTTP result is saved at `integrations/skfolio/.state/last-http-check.json`, timestamp `2026-10-04T18:22:14.638Z` (4 October, 23:52:14 IST). The `verify:portfolio` wrapper was not rerun because its build/test stages passed separately. Do not describe an older wrapper report as this run's result.

Prepared plan SHA-256: `50b806612b51ef73bf0ae60c2cd07f936226b77e1a540bc3d780ed0bab7cdd5e`. Private local artifacts: `.local/organisation-starter/plan.json` and `REVIEW.md`. Nine historical example windows and three specialist blueprints are ready for review. Preparation does not import or activate the department.

At the end of this earlier checkpoint, starter API import and monitored team operation were still pending. The integrated run above now covers them in an isolated fixture. Persistent deployment, configured Hermes inference and production isolation remain unverified.

## Version 0.1.10 — supervisor sessions and monitoring, execution pending

Added migration 010, exclusive current department-role sessions, monotonic heartbeats/replay handling, current-clock lease checks, owner status/report visibility and supervisor fail-stop/release integration. Four backend and four Node contract cases were written; Node cases are selectable with `npm run test:supervisor`. No build, migration, tests, API calls or workers were run. The latest owner evidence remains the v0.1.8 empty read-only snapshot; no starter preparation/import output has been received. See [department monitoring](department-monitoring.md) for the cooperative guard scope and the absence of a background stale-alert service.

## Version 0.1.9 — starter department preparation, execution pending

Added an offline bundled-example exporter, strict plan validation, explicit hash-bound owner-run import using distinct role credentials, stable request recovery, current-support checks and proposed activation files. Four Node contract cases were written in `scripts/organisation-starter.test.mjs`; the optional command is `npm run test:starter`. No scripts, tests, fitting, API writes or policy activation were run by the assistant. No new migration or dependency. See [starter department](organisation-starter.md).

## Version 0.1.8 — owner-confirmed read-only endpoint responses

The owner supplied successful `lifecycle:admin -- experiments` and `lifecycle:admin -- report` output. The report is timestamped **4 October 2026, 23:18:52 IST** (`2026-10-04T17:48:52.839Z`). Experiments returned an empty list. The report included v0.1.8 experiment counts and showed zero managed students/blueprints/approved dispatch datasets, disabled lifecycle/dispatch/learning/R&D, no system halt, paper mode, no live execution and unknown worker liveness. This confirms those read routes and their schema queries respond; the attachment did not include a fresh build log, test results, worker run or non-empty experiment evaluation. The old Ruflo degraded notification is historical inbox data, not a fresh health check.

## Version 0.1.8 — registered diagnostic experiments, execution pending

Added migration 009, immutable owner-registered R&D experiment plans, independent aggregate assessment, cancellation/history, owner status and report counts, and evaluator-worker integration. Four backend cases were written for registration/period reuse, complete-set assessment/idempotency, halt/support withdrawal/cancellation, and positive diagnostics without recruitment, money or additional reputation. The earlier fixture factory fix is preserved. No build, migration, tests, server, worker or model inference was run by the assistant; no successful owner rebuild has been received since the v0.1.7 errors below. See [registered experiments](development-experiments.md) for scope and remaining experiment-isolation limitations.

## Version 0.1.7 — owner build failure and fixture correction

The owner ran `npm run build` and supplied two TS2349 errors: `dispatch.test.ts:186` and `lifecycle.test.ts:142` called `f.evidence()` after each local setup had replaced the shared fixture's function with an evidence record. Both setups now preserve the factory as `createEvidence`, and the two callers use it to create independent verified evidence. Existing evidence-record references remain intact. This corrects the reported source errors; a successful rebuild is still pending. No build or tests were run by the assistant.

## Version 0.1.7 — learning, R&D and supervisor source, execution pending

Added migrations 007/008, immutable factual memory/profiles/reviews, time-filtered memory retrieval, owner-budgeted Hermes R&D requests/proposals/reviews, a finite two-role supervisor and administration commands. The existing Hermes adapter/runner was extended for a structured capability proposal task; its prior tests are historical, not verification of the modified code. Five backend cases and three Python development cases were written. No build, tests, migrations, package installation, supervisor, worker, provider call or policy activation was performed. See [learning and development](learning-and-development.md). Versions 0.1.4–0.1.6 also remain unconfirmed.

## Version 0.1.6 — owner report code, execution pending

Added an owner-only organisation report and CLI read command, shared dataset eligibility with dispatch, and strengthened assignment submission to require a non-empty current verified curriculum. Three additional regression cases cover report permissions, no side effects, work/capacity states, source revocation, expired leases and token omission. No new migration or dependency is required. No build, tests, migrations, server start or worker execution was performed. See [organisation report](organisation-report.md). v0.1.4/v0.1.5 execution also remains unconfirmed.

## Version 0.1.5 — research assignment code, execution pending

The approved-dataset dispatcher, additive migration 006, lease-fenced portfolio submissions, finite department launchers, retirement cancellation/history and operator guide are written. Four backend dispatch regression cases and one Python bridge lease-recovery case were added, and lifecycle fixtures were updated to use assignments. No compilation, tests, migration, server startup or worker execution was performed for this increment, in accordance with the owner's terminal-execution preference. No policy was enabled. See [research dispatch](research-dispatch.md). Earlier passing results below do not verify the new code.

## Version 0.1.4 — lifecycle code, execution pending

The governed example-research lifecycle, migration 005, administration CLI, bounded cycle worker and regression tests are written. No build, migration, tests, or worker run has been performed for this increment. The owner retains terminal execution. See [research lifecycle](research-lifecycle.md).

## Version 0.1.3 — owner confirmed build and startup

The owner supplied terminal output on 4 October 2026 confirming successful TypeScript compilation and backend startup in paper mode at `127.0.0.1:3000`, with the portfolio routes registered. Database initialisation completed before startup. This confirms build and startup only; the new portfolio tests, Python bridge and end-to-end evaluation have not yet been verified. The owner deferred testing. Instructions remain in [portfolio backend](portfolio-backend.md).

## Version 0.1.2 portfolio academy

The actual skfolio 1.4.11 integration completed **108/108 trials**, with zero failed attempts in the final plan. A second launch recorded **zero new attempts**. Nine new tests passed, covering future-data separation, costs, drifting buy-and-hold weights, invalid allocations, retry exhaustion, crash recovery, concurrent-run exclusion and transient Windows report locks. `pip check` passed for the isolated environment. See the [saved result](portfolio-academy-result.json) and [academy contract](portfolio-academy.md).

The final example run gave inverse-volatility positive relative reward in 19 windows and negative reward in 17; minimum variance had 18 of each. These are diagnostic scores on a restricted, stale example dataset, not trading qualification or realised revenue. A development run exposed a transient Windows report-replacement lock; the bounded retry fix is tested. Its earlier plan's partial records remain in the local journal. Core backend/Ruflo/Hermes source was unchanged in this increment; the earlier checks below retain their prior validation dates rather than being claimed as fresh reruns.

This report describes the local software checks performed for backend foundation v0.1, updated for v0.1.1's Ruflo hardening. It does not establish market performance or live-trading readiness.

## Automated checks

| Check | Observed result |
| --- | --- |
| TypeScript compilation and Node backend tests | 28 passed, 0 failed. |
| Python deterministic research/evaluation tests | 10 passed, 0 failed. |
| Hermes adapter/runner contract tests | 14 passed, 0 failed; actual provider not invoked. |
| Ruflo MCP client/coordinator contract tests | 10 passed, 0 failed; simulated MCP peer. |
| Ruflo feed, HTTP, runtime and batching tests | 8 passed, 0 failed. |
| Ruflo installed TOML dependency regression | 1 passed, 0 failed. |
| Root `npm audit --omit=dev` | 0 reported vulnerabilities. |
| Ruflo installation audit, optional dependencies omitted | 0 reported vulnerabilities after the `toml@4.2.0` override. |
| Actual Ruflo backend/MCP lifecycle | **Passed on normal Windows host**: create/status/complete, restart without duplicates, owner notifications, denied wallet access and zero financial transactions. The earlier restricted-environment smoke failed on OS profile lookup. |
| Actual Hermes model-provider smoke | **Deferred** at owner's request to choose the model later. |

The latest suites total 71 passing automated tests; 28 backend and 19 Ruflo tests were rerun for v0.1.1, while the unchanged Python/Hermes suites retain their earlier 24 passing results. The unsuccessful/deferred external integration checks are separate results. The host used Node 24.21.0 and the bundled Python runtime; tests used an embedded PGlite database. A standalone PostgreSQL server and container isolation were not exercised.

The actual backend-to-Ruflo command, `npm run test:ruflo:live`, initially stopped at runtime preflight with `OS_PROFILE_UNAVAILABLE` in the restricted execution environment. The owner then ran the same command from a normal host terminal. Its report passed at **06:59:54 IST on 4 October 2026**. The saved report, single completed upstream task and durable coordination journal were inspected. The preflight verifies packages and the actual OS identity before writing a coordination intent. No identity fallback or upstream policy bypass was added.

The real coordination worker was also run against the persistent local API. Its OS-profile failure reached `/operations.integrations` and the owner inbox exactly as a structured degraded status; the organisation's halt state remained false. HTTP tests verify repeat-report deduplication, recovery notifications and refusal of coordinator financial/control access. Completion-recovery tests verify that a lost upstream acknowledgement cannot be retried with a different result.

Financial tests cover contribution-only funding, signature binding/replay, duplicate requests, concurrent allocation/reservation, loss recovery, owner transfers, carry-forward rounding, balanced/append-only journals, costs and partial exits. Research tests cover chronological separation, independent roles, retired bots, expired lease recovery, retry behaviour and stale-token rejection. Regression tests cover evidence revocation and changing budgets/limits between order reservation and fill.

## Full paper demonstration

The synthetic HTTP + Python workflow completed with one admitted bot reaching paper qualification, a contribution, a buy and sell, and an exact profit allocation. After restarting the persistent backend and applying the newer migration, rerunning the demo reused existing business operations and left these values unchanged:

| Field | Paise | Rupees |
| --- | ---: | ---: |
| Owner contributions | 1,000,000 | ₹10,000.00 |
| Cumulative realised net profit | 4,839 | ₹48.39 |
| Already allocated profit base | 4,835 | ₹48.35 |
| Wallet 1 | 1,002,905 | ₹10,029.05 |
| Wallet 2 | 1,934 | ₹19.34 |
| Eligible carried remainder | 4 | ₹0.04 |
| Open position cost / pending distribution | 0 / 0 | ₹0 / ₹0 |

The rerun's audit chain verified with 28 events. A rerun legitimately adds fresh quote events and a new unused owner challenge; it does not add another contribution, fill or allocation. The demo's increasing synthetic prices intentionally exercise a successful software path. They are not real market observations or an investment return estimate.

The durable-database test separately closes and reopens a database with a **pending** protected allocation and verifies that its reservation, allocated base and idempotent retry survive.

## Known validation gaps

- No live bank/broker/exchange, real news feed, DEX, model service or externally settled transfer has been exercised.
- No evidence yet of realistic strategy profitability, calibrated forecasts, multi-regime generalisation or high-frequency performance.
- No OS-level worker sandbox, hardware owner signing, production secret rotation, disaster recovery or penetration test.
- The original momentum evaluator is a trusted service; its metrics are not accepted from the researcher, but the core does not independently recompute that evaluator's report. Portfolio evaluations introduced in v0.1.3 are instead calculated in the backend from weights and held-out observations; that new path remains unverified.
- Ruflo must run on a host with a functioning OS user profile; its verified integration is the bounded research-task mirror. Broader swarm/model features are not enabled or validated. Hermes requires a selected model and pinned installation before real inference can be verified.

The [roadmap](roadmap.md) lists the corresponding work. These gaps do not prevent running the deterministic local foundation, and they must not be mistaken for completed capabilities.

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 7 October 2026; historical records retain their original scope.
