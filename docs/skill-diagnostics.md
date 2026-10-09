# Worker attribution, diagnosis and corrective proposals

> [Current implementation, validation and limits](current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

Version 0.1.13 adds attribution and failure analysis to **academy exams**. Portfolio trials, Hermes inference and the other departments do not yet share this new producer registry. Existing records are not backfilled with guessed worker versions.

## Declared producer identity

A researcher may supply a producer manifest when claiming an exam, before receiving its questions:

```json
{"name":"research-basics-python","version":"1","kind":"deterministic","sourceSha256":"<64 lowercase hex characters>"}
```

Model-based declarations require an additional `modelRef` label. Recording that label does not load or approve a model, verify its weights or invoke a provider. The current worker is deterministic and supplies no model reference.

The backend hashes canonical manifest JSON, stores it immutably, and binds it to the attempt. Submissions must echo the same hash. A running attempt cannot be relabelled by changing the worker version; wait for the existing attempt to resolve/expire rather than replacing its provenance. Legacy clients may omit the manifest; their attempts remain explicitly unattributed. At most 100 declared producer profiles can be registered.

The Python adapter calculates SHA-256 of its `skills.py` source after CRLF-to-LF normalization. Its manifest digest uses sorted, compact JSON matching backend canonicalization. This is an **authenticated worker declaration, not execution attestation**: the backend does not inspect a remote process, verify that the declared code ran, or fingerprint every dependency. Different labels/fingerprints do not establish different or improved brains.

## Automatic diagnosis

When the evaluator requests grading and the backend records a failed exam, the same transaction records the failed check names and a factual diagnosis. A failure in cost arithmetic is distinguished from failures in drawdown, information timing and abstention. Reports aggregate recurring failures per student and declared producer, including an unattributed group.

These reports identify incorrect outputs, not a proven root cause. Invalidated exams, expired leases and ungraded work are not labelled as skill failures. They remain visible in version outcome counts. Earlier failures are not silently re-graded or erased.

## Corrective-learning proposals

The research department proposes at most ten deterministic corrective plans per cycle from graded failure cases with current policy and verified curriculum. There is at most one proposal per diagnosis. The template contains the exam identity and guidance only for its failed checks; it contains no commands or permission changes.

A different evaluator identity rechecks the proposal against the recorded diagnosis/template, current policy, active bot and supported curriculum/evidence. A successful review creates one verified lesson with the original proposer as author and evaluator as reviewer. Withdrawn support produces a preserved rejected review. Polling or retries cannot duplicate the lesson. The review checks this narrow contract, not arbitrary semantic truth or financial suitability.

Verified lessons are visible through existing knowledge APIs. They are **not automatically appended to a student's curriculum**, applied as code patches, treated as weight updates, or used to reset exam budgets. The owner may select the lesson associated with the latest failed exam for the existing [bounded recovery workflow](skill-recovery.md). Approval of the extra attempt remains a separate owner action.

Proposal/review cycles honour the current skill-policy enabled state and system halt. The number of cases and lessons is bounded by the existing attempt quotas, with a ten-item cycle limit. Historical diagnoses/proposals/reviews remain preserved after withdrawal or retirement; current knowledge retrieval filters unsupported lessons.

## Comparing versions

Version 0.1.14 adds a separate [paired experiment workflow](skill-experiments.md) with pre-registered identical cases. The descriptive endpoint documented here retains its original limitations. Neither workflow authorises a release; executable artifact verification and release governance remain future work.

Version reports group **all attempts** by declared producer, rubric and policy revision. Counts include passed, failed, invalidated, awaiting review, expired and outstanding attempts. Comparisons return baseline and candidate groups without pooling policy revisions or concealing failed work.

The result is always `descriptive-only`, with `promotionAllowed: false`. Students receive different random questions and may have different histories; these cohorts are not a paired experiment. There is no automatic version approval or deployment endpoint. A future comparison stage must pre-register paired cases, verify executable artifacts, evaluate regressions and maintain a separate release decision before replacing a worker.

## Operations

Rebuild/restart the backend through migration **013** before starting updated Python departments. Normal department cycles now include remediation; the existing skill policy still defaults off. No inference provider or new dependency is required.

```cmd
npm run lifecycle:admin -- skill-diagnostics
npm run lifecycle:admin -- skill-versions
npm run lifecycle:admin -- compare-skill-versions comparison.json
```

The comparison file contains `baselineHash` and `candidateHash`, taken from the version report. Its POST endpoint is read-only; no idempotency key is needed by the server.

| Route | Role | Purpose |
| --- | --- | --- |
| GET `/v1/skills/diagnostics` | Owner/evaluator | Cases, recurring failures and corrective proposals/reviews. |
| GET `/v1/skills/versions` | Owner/evaluator | Declared profiles and complete outcome counts. |
| POST `/v1/skills/versions/comparisons` | Owner/evaluator | Descriptive baseline/candidate report. |
| POST `/v1/skills/remediation/cycles` | Researcher/evaluator | Propose or independently review, using an idempotency key. |

Validation and remaining deployment limitations are recorded in [verification](verification.md).

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 7 October 2026; historical records retain their original scope.
