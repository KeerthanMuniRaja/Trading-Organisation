# Ruflo coordination integration

> [Current implementation, validation and limits](current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

Status: **implemented and verified end to end on the normal Windows host** on 4 October 2026. The actual installed Ruflo created and completed a task from the backend HTTP feed, retained it across restart and avoided duplicate creation. The test also verified owner failure/recovery notifications and denied coordinator wallet access. The saved report and retained task/journal state were inspected. The core research jobs and paper demo still work independently.

The restricted execution environment cannot resolve the OS profile. Run the integration from the normal host terminal or an appropriately isolated deployment with a working OS identity; no upstream security checks were disabled. This validation covers the selected three-tool research-task integration, not every Ruflo swarm, model or execution feature.

## Upstream use and boundary

The integration uses [Ruflo](https://github.com/ruvnet/ruflo) `3.51.1` and `@claude-flow/cli` `3.51.1`, with a separate npm lockfile. Both installed package manifests identify MIT licensing. Retain upstream notices in retained dependency images. The upstream source reference is a review aid; installed packages are identified by exact versions and lockfile integrity values.

`RufloCoordinator.open()` launches the actual installed `ruflo/bin/ruflo.js mcp start --transport stdio` command. It verifies the MCP protocol handshake and the precise tool schemas for:

```text
task_create
task_status
task_complete
```

Our client permits only unassigned research task records, known task IDs and application-owned completion references. It never calls agent spawning, shell execution, swarm orchestration, arbitrary memory, financial or deployment tools. Ruflo's `--tools` option limits the advertised catalogue; it is **not** the security boundary. The client enforces its own call allowlist and rejects unexpected contracts, malformed replies and server requests for sampling or other client services.

The coordinator API credential reads `/v1/coordination/tasks`. That feed exposes IDs, hypotheses, states and timestamps, with no training data, holdout, credentials or balances. `worker.mjs` mirrors those records; NestJS remains the job scheduler and authority for results. The mirror is deliberately separate from Hermes: this release does not hand a model the broader Ruflo tool catalogue.
The coordinator can also post its own structured health to `/v1/coordination/status`. Failure and recovery transitions enter the owner's audit/inbox; repeated identical reports do not duplicate notifications. It still cannot alter money, evaluation, bot permissions or the global halt state.

## Install and verify

From the project root:

```cmd
Push-Location integrations/ruflo
npm ci --ignore-scripts --omit=optional
npm test
npm run smoke
Pop-Location
```

The actual smoke creates, reads and completes one local research task and checks durable state. It does not use a model or trade. It exits nonzero when the lifecycle fails and saves the result in ignored `.state/last-smoke.json`. The in-process tests use a simulated MCP peer to exercise permission, retry and persistence contracts; they cannot establish that upstream task execution works on a host.

The root command below additionally tests the actual backend-to-Ruflo flow, completion, restart/replay, owner notifications and denied wallet access. It uses a fresh in-memory database and generated test identities; it never loads the owner's `.env`, signing key or database. The report is saved to `integrations/ruflo/.state/last-live.json`.

```cmd
npm run ruflo:doctor
npm run test:ruflo:live
```

After the live check passes on the target host and the backend has a dedicated coordinator principal:

```cmd
npm run worker:coordination -- --once
REM Omit -- --once for periodic mirroring.
```

Fresh `dev:setup` configurations include the dedicated principal. The local configuration used to build this release was extended without rotating existing credentials. Production workers must receive only their own token and API origin, not the core `.env`.

## Security override

The initial audit found high-severity advisories in upstream's transitive `toml` parser. This integration overrides it to `4.2.0`, which is identified as patched for [uncontrolled recursion](https://github.com/advisories/GHSA-82x6-q7mm-w9cf) and is above the fixed version for [prototype pollution](https://github.com/advisories/GHSA-v5mp-jgw5-2x6j). The installed production tree, with optional packages omitted, now audits with zero reported vulnerabilities.

The dependency regression confirms ordinary TOML parsing and controlled rejection of excessive nesting. Full compatibility across unused Ruflo features has not been established; only the selected MCP interfaces are in scope. Keep the override and lockfile together, and retest before an upstream upgrade.

## Host limitation observed

The earlier restricted-environment failure is retained below for diagnosis. The subsequent normal-host run passed at **06:59:54 IST on 4 October 2026**, with report `status: passed`, `phase: complete`, one completed upstream task and no financial transactions. It exercised the current adapter and its durable completion-intent journal. `npm run test:ruflo:live` reproduces that check with fresh synthetic state.

The installed process reports these three tools and completes `initialize` / `tools/list`. On `task_create`, it returns:

```text
Failed to execute MCP tool 'task_create':
A system error occurred: uv_os_get_passwd returned ENOMEM (not enough memory)
```

A direct Node `os.userInfo()` call showed the same host failure. The inspected upstream policy runtime uses the OS identity to locate its trust configuration. We did not replace that lookup, falsify an identity or disable the security policy. Retest on a host whose normal OS user profile is available. The error alone is not evidence that the application needs more RAM.

The installed package pin is `3.51.1`; the MCP `serverInfo` returned `version: 3.0.0`. We record that upstream metadata as observed, rather than presenting it as a different installed package version.

## Persistence, budgets and recovery

Task creation writes a durable intent before invoking upstream and records the returned task ID afterward. If the response is lost, the journal retains an unknown outcome and refuses to blindly create another task. A journal lock prevents simultaneous local writers. Completion also records its intended result digest before the call; after a lost response, only the identical result may be retried. Upstream's returned completion must match that result before our journal marks it complete.

The development mirror is bounded to 100 retained task mappings and 2 MiB journal input. It batches at most 25 tasks per MCP session to remain within the 64-request session budget. Transport responses and deadlines are bounded; long hypotheses are represented by a bounded prefix plus a digest. These are first-release capacity limits, not a scalable organisation-wide scheduler.

If creation has an unknown outcome, stop the mirror and inspect the retained journal and upstream task store before deciding how to reconcile. This release provides no automatic reconciliation or journal compaction command. Do not delete a journal to force retries. Verify there is no live coordinator before recovering a stale lock.

The child receives a fresh dedicated working directory, runtime paths and bounded configuration, with no application/model/proxy credentials. This does not isolate it from files available to its OS identity. Deploy with a separate unprivileged account/container and no core secrets or financial database access.
The worker now reports sanitised failure codes to the owner inbox when the backend is reachable. An unreachable backend produces a local notification-delivery error. Only temporary backend HTTP failures are retried automatically; permission errors and uncertain MCP writes stop the worker. `RUFLO_STATE_DIR` optionally selects an owner-configured state directory. SIGINT/SIGTERM stop polling and release the active session after any in-flight bounded call finishes.

The runtime preflight now checks pinned packages, Node 24 and the actual OS profile before creating a task intent. A missing profile is reported as `OS_PROFILE_UNAVAILABLE`; no fallback identity, trust-root substitution or policy bypass is installed.

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
