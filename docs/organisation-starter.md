# Prepare the first research department

> [Current implementation, validation and limits](current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

Current worker requirement: v0.1.11 adds [academy skill routes](academy-skills.md) and migration 011. Rebuild/restart the backend before using updated department workers. The optional exam gate defaults off and is not enabled by starter import. The isolated organisation check explicitly enables it only in its disposable database.

Version 0.1.9 adds an explicit preparation/import workflow for the empty managed community shown in the owner's v0.1.8 report. It uses the installed, pinned skfolio bundled historical example. It creates no new foundation model and needs no inference provider or market subscription. Offline preparation, four contract tests and actual import/replay against an isolated backend have passed.

The subsequent v0.1.10 [supervisor monitoring](department-monitoring.md) requires a current backend and migration 010 before launching workers. The [isolated organisation verification](organisation-verification.md) passed a complete monitored research/memory workflow. The owner's persistent community has not been imported or activated by that check. Offline preparation itself needs no server.

## Prepare and inspect

From the project folder:

```cmd
npm run organisation:prepare
```

This launches the existing academy Python environment with no API token, owner key or model credentials. It checks installed package versions on first export and writes `.local/organisation-starter/plan.json` plus `REVIEW.md`. It does not call the backend, fit a portfolio, rerun the completed offline academy, fetch live data or start a worker. Preparation has a 90-second deadline.

The plan contains nine chronological windows, each with 252 training and 63 holdout observations, using the first nine eligible windows from the academy's existing return series. The methods are fixed; no window is selected based on its outcome. The bundled data was already used in previous examples and is not a pristine holdout or a live feed. The plan records the package version, dependency-lock digest, creation time, observation timestamps and exact returns. Creation time represents this exported example snapshot, not the historical publication time of market information.

The CLI validates dimensions, finite return bounds, chronological order, non-overlapping holdouts, future timestamps, the local dependency-lock digest and API request sizes. Hashes bind the bytes the owner reviewed; they are not vendor signatures or proof that local code/packages were untampered. Keep the trusted source checkout and dependency installation intact.

Existing plan/review files are preserved. Rerunning prepare reuses the plan and its SHA-256. Do not delete or edit recovery files merely to force a retry; reconcile a changed plan explicitly. No generated files or credentials have been created by the assistant in this development turn.

## Register the reviewed plan

Read `REVIEW.md` and `plan.json`. The review file gives the exact command with its actual SHA-256:

```cmd
npm run organisation:apply -- --approve <SHA256_FROM_REVIEW>
```

The command requires a running paper backend. It refuses a system halt, enabled lifecycle/dispatch/learning policies, an existing managed community, unrelated blueprints or a revoked current reflection profile. Existing non-managed demo bots and balances are not changed.

The bounded setup parent holds the configured owner, researcher and evaluator credentials. All three identities/tokens must differ. The fixed setup uses existing role-specific endpoints to register:

- One approved source pointing to skfolio and one zero-budget curriculum record.
- One example-data evidence record and one fixed curriculum lesson, authored as researcher and reviewed as evaluator.
- Nine immutable datasets and three distinct blueprints: equal-weight baseline, inverse-volatility allocation and constrained minimum-variance allocation.
- The supported deterministic factual-memory profile, or an existing non-revoked profile with the same manifest.

This bootstrapping process is operator-directed. Reviewer calls certify the fixed local example contract after structural validation; they do **not** provide independent scientific review, financial validation or independent organisational judgment merely because different API identities are used. The curriculum record is an identity for retaining instructions, not a trained teaching agent. No model receives these credentials. Plans cannot provide routes, commands, arbitrary lesson instructions, financial transactions or policy changes.

Every mutation uses a stable role/body/plan-derived idempotency key. After a lost response, rerun the same command against the same database with the same plan and principal IDs. `.local/organisation-starter/binding.json` pins the local recovery context to the API origin and principal IDs without storing tokens. Partial registrations are retained; the import is **not** one cross-request atomic transaction and has no destructive rollback. Before reporting completion, the command rechecks policy revisions, curriculum/evidence availability, blueprint approval and model validity. Cached receipts cannot restore revoked support.

Successful registration writes `receipt.json` and three proposed `*-enable.json` files. **It leaves policies disabled and starts no workers.** If preparation is interrupted during a file write, a differing/partial existing file blocks automatic overwrite; preserve it and reconcile it before continuing. After activation, setup is no longer a suitable recovery command—use the normal status and worker commands.

## Activate a bounded example session

Review the generated activation files before submitting them. Their proposed limits are three managed students, three births/day, three lifetime births, 27 total research assignments (nine per student), and 27 factual reflections. The lifecycle cycle interval is 60 seconds, with at most one birth per cycle. Other existing fitness rules remain as read from the owner policy. A third birth or college admission needs later eligible cycles; the first worker cycle will not create a complete department instantly.

The files contain the policy revisions observed during registration. If the owner changes policy, the backend rejects stale revisions. These are proposed changes to the existing pool/caps, not an additive budget, and they must not be submitted blindly over a later configuration.

With the backend running, the owner may explicitly apply the reviewed files:

```cmd
npm run lifecycle:admin -- learning-policy .local/organisation-starter/learning-enable.json
npm run lifecycle:admin -- dispatch-policy .local/organisation-starter/dispatch-enable.json
npm run lifecycle:admin -- policy .local/organisation-starter/lifecycle-enable.json
```

Each is a separate command; stop and inspect an error before continuing. Then, to run a finite example session:

```cmd
npm run worker:organisation -- --minutes 30
```

The session can admit students, verify their curriculum references, dispatch fitting work, evaluate portfolios, compile/review memory and assess lifecycle fitness. It does not enable Hermes inference, Ruflo scheduling, live execution or any financial transaction. No R&D experiment is registered automatically; those require a recommended proposal and unused periods through their separate workflow. The proposed pool is reused across the three fixed-method students for comparison, not reserved for clean R&D validation.

Assignments and reflections have independent limits. Completion is not guaranteed within 30 minutes; inspect status and rerun a finite session if appropriate. Lost/failed assignments consume the configured historical quota. Do not increase limits or reset counters just to force a positive result. Equal-weight has a diagnostic reward of zero against itself and is expected to remain a neutral reference.

Inspect progress from another terminal:

```cmd
npm run lifecycle:admin -- report
npm run lifecycle:admin -- community
npm run lifecycle:admin -- learning
```

Ctrl+C stops the local session. Existing policy/operations commands can pause future work. The application is not continuously operating merely because the API server is running. Supervisor heartbeats have contract and isolated workflow verification; background stale alerts, live data ingestion and autonomous creation of new techniques/departments remain separate development work.

## Verification

All four `npm run test:starter` contract cases passed for malformed plans, role/origin restrictions, lost-response recovery without policy writes, and refusal to bypass active policies or revoked support. Actual offline Python export, plan validation, real HTTP import/replay and a monitored research/memory session also passed. Import and activation occurred only in a temporary test database. The local plan/review exist; persistent deployment remains separate. See [verification](verification.md) for exact results and [organisation verification](organisation-verification.md) to rerun the check.

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
