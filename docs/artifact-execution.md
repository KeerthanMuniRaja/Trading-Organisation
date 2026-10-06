# Artifact execution, isolation and recovery

> Documentation refreshed for v0.1.21 (5 October 2026). [Current implementation, validation and limits](current-status.md). Dated milestones and design proposals retain their original scope.

Version 0.1.15 adds a manual runner for reviewed standalone Python solvers in paired academy experiments. It checks source bytes, separates each arm into a process, bounds execution time/output and preserves results for retries. **This mode is not an OS sandbox and must not execute untrusted generated code.** Trusted local mode requires the explicit `--trust-reviewed-local-code` flag and is not called by autonomous department cycles.

## Source verification

An artifact directory contains its Python source and an `artifact.json` descriptor with exactly `sourceFile` and `producer`. The producer uses the existing deterministic name/version/source-SHA256 contract; model manifests are not supported by this runner. The source filename must be a basename beside the descriptor, and its resolved path cannot escape that directory.

The runner reads at most 64 KiB, normalizes CRLF to LF, decodes UTF-8 and checks SHA-256 against the descriptor before contacting the backend. It sends that exact source snapshot to a child that checks the hash again and compiles those same bytes, without reopening the original source path. Both producer-manifest hashes must match the owner-registered paired plan.

Source hashing covers this one file, not Python itself, imported dependencies, the operating system or a model's weights. Runtime version and host/executor file hashes bind the local journal to its execution configuration. The backend still receives ordinary paired submissions and does not independently attest execution or require this runner. A compromised local host or solver can fabricate local receipts; the receipt explicitly states `remoteAttestation: false`.

## Process limits and their scope

Each arm runs in a fresh Python process with `-I -S`, a temporary working directory and a restricted environment. API tokens, owner principals and provider credentials are not forwarded. Only Windows runtime essentials and temporary-directory variables are supplied. The source must expose `solve(challenge)` and return the existing answer contract. Site packages and repository imports are not automatically available.

The healthy supervising process enforces a default 10-second deadline per arm (configurable 0.1–30 seconds), 128 KiB stdout, 16 KiB stderr and 192 KiB input. It terminates and waits for the direct child on timeout, rejects invalid output and never prints arbitrary solver exceptions. The runner validates each returned case ID, answer shape and numeric bounds before constructing a submission.

These controls do not restrict filesystem or network access under the current OS identity, limit memory/disk consumption, protect the parent from hostile code, or guarantee descendant cleanup after an OS/parent crash. Solvers must not spawn descendants. Temporary working directories and isolated Python import flags are not a security boundary. Strong OS isolation and independently trusted execution evidence remain prerequisites for unattended generated-code execution and release approval.

A Docker Linux adapter was added in v0.1.16. It requires a full local `sha256:` image ID, makes no pulls, enforces Linux/cgroup-v2 prerequisites and checks the effective runtime guard. It requests no network or host mounts, a read-only root, non-root UID/GID, dropped capabilities, no-new-privileges, seccomp, CPU/memory/PID limits and bounded tmpfs. There is no fallback to trusted-local execution. Live verification remains deferred because Docker Desktop did not establish a usable engine; mocked transport and runtime-guard tests are not live isolation proof.

Version 0.1.17 added durable ownership records before creation, nonce labels, exact container/image/name matching and removal by verified container ID. Cleanup uncertainty blocks new execution. `artifact_executor.py sandbox-recover` recovers recorded stale/failed operations; explicit absence acknowledgement is needed for uncertain creation. Recovery runs when invoked or on a later operation, not as a continuous reaper. Parent death does not guarantee immediate cleanup.

## Durable retry behavior

A SQLite journal and OS file lock serialize each backend-origin/credential/experiment combination. Journals contain a credential hash, never its raw token. They preserve the fixed work payload, per-arm attempts and completed receipts, the exact submission payload and submission acknowledgements/events.

- Each arm gets at most two local attempts. Failed or interrupted executions retain their cost. A completed baseline is reused if the candidate later retries.
- Current backend support is rechecked before each new arm; final submission still enforces the server's policy, halt, identity and deadline controls.
- The exact paired submission is committed before sending it. After a lost response, the runner resends that body with the same idempotency key without rerunning solvers or trying to fetch already-submitted work.
- An acknowledged rerun returns an explicitly historical receipt, not confirmation of current policy support or permission to deploy.
- Changing artifacts, interpreter version, host/executor source or timeout refuses rebinding an existing journal. Keep the original files/configuration for further execution. The separate saved-submission recovery command can replay without them because it never executes source.
- An interrupted `running` attempt is marked interrupted on restart. Recovery does not discard previous answers or failures.

These are local reliability controls, not tamper-proof history or a server-wide execution budget. Deleting/moving journals, changing state paths or rotating credentials can create a different local scope. Preserve the state directory. Backend experiment quotas and financial permissions remain independently enforced. CLI execution publishes fixed operational codes through the durable outbox into backend observations and owner inbox entries. Raw errors are excluded; initial failures before saved work may have no report. See [monitoring and recovery](artifact-recovery.md).

## Prepare and run a reviewed pair

Place each reviewed standalone solver in its own directory. The read-only descriptor command hashes the file without executing it; save its output beside that file:

```powershell
& .\integrations\skfolio\.venv\Scripts\python.exe .\integrations\skfolio\artifact_executor.py describe .\.local\candidate\solver.py --name candidate-solver --version 1 | Set-Content -Encoding utf8 .\.local\candidate\artifact.json
```

Prepare the baseline descriptor similarly, then use both descriptors' `producer` objects in the existing owner [paired experiment registration](skill-experiments.md). The assigned researcher ID must match the configured scoped researcher credential. No code is reviewed, approved or registered merely by generating its descriptor.

With an actual experiment UUID, run one manual diagnostic operation from the project root:

```powershell
npm run worker:paired-artifacts -- --experiment EXPERIMENT_UUID --baseline .local/baseline/artifact.json --candidate .local/candidate/artifact.json --trust-reviewed-local-code
```

The Node launcher selects only the researcher credential for the Python coordinator. That coordinator retains API access; solver children receive none. Default state is `integrations/skfolio/.state/paired-artifacts`; `--state` selects another directory. A separate evaluator must still review the submitted experiment. No runner command approves a release, changes a model, grants school admission or accesses money.

## Verification

`npm run verify:paired-artifacts` builds and runs a temporary backend with scoped ephemeral credentials. It generates two trusted fixture artifacts, intentionally injects cost errors into the baseline, executes both source snapshots, and simulates losing a response **after actual backend acceptance**. Retry must preserve exactly two solver executions and produce one backend submission. A further retry returns the historical receipt. The evaluator checks all cases; bots, school exams, lessons and financial journals remain empty.

The report is `.local/paired-artifacts-verification.json`. Generated fixture sources and journals are kept under `.local/paired-artifact-fixtures` for inspection; they contain no raw tokens. The test does not activate persistent automation, call a provider or touch a financial account. Exact results are in [verification](verification.md). Current execution reporting requires migration 015; paired experiment routes originated in migration 014. Rebuild/restart before using reporting.

## Current operation commands

Use `--sandbox-image sha256:FULL_LOCAL_IMAGE_HASH` instead of `--trust-reviewed-local-code` for the Docker adapter after an appropriate local image and engine are available. Do not treat this example as a completed Docker validation. No image is pulled or built automatically. For journal inspection, selected-journal batch recovery and backend reports, follow [the recovery guide](artifact-recovery.md).
