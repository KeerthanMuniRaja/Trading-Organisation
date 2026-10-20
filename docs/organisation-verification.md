# Verify the research organisation together

> [Current implementation, validation and limits](current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

`npm run verify:organisation` builds the backend and runs the starter importer, HTTP API, database, Node supervisors and actual Python departments together. It requires the existing pinned skfolio environment and the bundle produced by `npm run organisation:prepare`.

The check uses an in-memory database on an ephemeral loopback port and freshly generated role credentials. It does not read `.env`, migrate `.data/paper`, import into the owner's community, call a model provider or connect a venue. Temporary test-policy activation is restricted to this database. The existing replay journal may receive new isolated test-trial entries under `integrations/skfolio/.state/bridge`; existing entries are retained.

The workflow verifies:

1. Importing the prepared plan and replaying the same import without duplicate records or enabled policies.
2. Supplying only the correct role credential to each Python child.
3. Running researcher and evaluator supervisors together and refusing a competing supervisor for an occupied role.
4. Enabling the optional skill gate in the fixture, creating three distinct students, independently grading each student's research-basics exam, admitting them to college, fitting portfolio examples and evaluating their results.
5. Proposing and independently verifying factual shared memory through the real department loop.
6. Keeping supervisors fresh across multiple cycles, cancelling the team and recording both sessions as stopped.
7. Preserving zero bot budgets, no trading graduation, empty wallets/ledger and a valid audit chain.

The v0.1.13 check also requires every passed exam to carry the actual Python adapter's declared source fingerprint and verifies that passing exams create no failure diagnoses. The backend suite separately covers failed exams and corrective proposals; the successful team scenario does not inject a model/worker defect.

The lifecycle retains its real 60-second cadence; the test does not rewrite database timestamps or skip school. Allow roughly four minutes after startup, with a 330-second cancellation deadline for the check. It stops early on success. The JSON result, check names and timestamps are saved in `.local/organisation-verification.json`. A failed run exits nonzero and identifies the last phase; preserve the report when investigating.

`npm run test:supervisor` additionally runs two actual child-process tests, checking cancellation and heartbeat denial while a child is active. These use a temporary Node child, not a model or a Python fitting process. They verify process exit; they do not establish an OS security boundary. Existing four client contract cases cover heartbeat retries, sequencing and loss handling.

This proves bounded software behaviour on previously used historical examples and synthetic exams. Factual reflections are recorded experience, not model-weight updates; the exam measures a shared deterministic adapter. The check does not validate profitability, new strategy discovery, unseen holdouts, production isolation, persistent deployment, sudden OS process termination or recovery after a machine crash.

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 7 October 2026; historical records retain their original scope.
