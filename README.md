# Trading Organisation — backend foundation

Version **0.1.34** adds [method-based assessments](docs/assessment-methods.md): bots choose computations and the backend does the arithmetic. With directly relevant lessons, local Qwen3.5-4B chose correctly 96% of the time vs 77% without. In the real chain, one news-derived lesson was not enough (8/16), so learning from real sources is not yet demonstrated.

Version **0.1.33** runs the organisation's learning chain on a real local model. Qwen3.5-4B, schema-constrained through the new owner-selectable `direct-structured-v1` engine, completed source lesson → review → transfer → fresh assessment end to end (`npm run verify:real-model`). The bot scored 6/16 on the assessment, and arithmetic remains its weakness. See [model selection](docs/model-selection.md).

Version **0.1.32** builds our owner-controlled bot organisation: NestJS/TypeScript authority, Python research, specialised bot identities, an academy, reviewed shared knowledge, finite learning workflows and paper trading. **All money, quotes, fills and bank references are simulated.** APP_MODE=live is rejected.

This release fixes benchmark pairing, Hermes timeout handling and publisher crash recovery. [Current status](docs/current-status.md) separates implemented behaviour from remaining work; [verification](docs/verification.md) records the checks.

The preferred experimental local reasoning profile is **Qwen3.5-4B Q4_K_M**, shared across bots with distinct contexts. The saved 2B benchmark failed important tasks, so it is not qualified as the general reasoning model. Newer constrained direct 4B reports pass the tested output schemas but do not qualify production Hermes or numerical accuracy. See [model evidence](docs/model-selection.md), the [model strategy and organisation graph](docs/model-strategy.md), [local runtime](docs/local-model.md) and [ten-repository reference map](docs/reference-map.md). The example policy stays disabled.

The bot community grows through reviewed knowledge and measured skills, with preserved experience on retirement. Continuous autonomous growth, general self-repair, model fine-tuning and profitable live trading are not complete. [Remaining work](docs/remaining-work-assessment.md) tracks those gaps.

For continuity use [KT.md](KT.md) and [RESUME-PROMPT.md](RESUME-PROMPT.md).

## Run locally

Use Node.js 24 and Python 3.12 or 3.13. Run these commands from this project directory. The default database is persistent PGlite in `.data/paper`; Docker is not needed.

```cmd
npm ci --ignore-scripts
npm run dev:setup
npm run build
npm start
```

`dev:setup` creates unique development credentials and an Ed25519 signing key in ignored local files. Run it once for a new checkout; it refuses to overwrite an existing `.env`. The workspace in which this project was built is already configured. Keep `.env`, `.local`, and `.data` private. Do not expose this development server to the internet.

In a second terminal in the same project directory:

```cmd
REM Set this only if Python is not already on PATH:
REM set "PYTHON_BIN=C:\absolute\path\to\python.exe"
npm run demo
```

The demo performs a complete synthetic journey: register evidence → admit a distinct bot → review its lesson → complete school → research a momentum candidate → independently evaluate it → qualify for paper trading → record an owner contribution → buy/sell → allocate and confirm the 60/40 profit split. It writes `.local/demo-report.json`. Stable idempotency keys make reruns reuse existing business operations instead of funding or trading again. Use a fresh database to demonstrate a different research engine; the existing completed demo does not rerun its research job.

For ongoing research, start workers in separate terminals:

```cmd
npm run worker:research
npm run worker:evaluation
REM Add -- --once to process at most one job and exit.
```

These local launchers read the development configuration and pass each worker only its role token. Deployments must provision scoped secrets independently; the launchers are not an OS security boundary.

## Earlier implementation milestones

These version-specific descriptions are historical. For the current inventory and limits use [current status](docs/current-status.md).

Version 0.1.7 adds [learning and R&D](docs/learning-and-development.md): immutable experience reflections, independent verification, temporally filtered shared memory, versioned reflection profiles and a finite two-role supervisor. `worker:organisation -- --minutes 30` runs the configured research/evaluation/memory workflow. An optional `worker:development` uses the existing pinned Hermes runtime and an owner-selected existing model to draft unverified research capabilities; independent review does not automatically recruit bots or deploy strategies. Both policies default off. Backend and mocked Python tests passed; actual model calls remain deferred.

Version 0.1.6 adds the [owner organisation report](docs/organisation-report.md). `npm run lifecycle:admin -- report` explains each managed student's current work and blockers, remaining assignment capacity, admission limits and unread notifications. It is read-only and does not infer worker health from an outstanding lease. Its backend report tests passed; see the dated verification record.

The new [portfolio academy](docs/portfolio-academy.md) uses the actual pinned skfolio library for a resumable, offline exercise: three allocation methods across 36 historical example-data windows, with costs and positive/negative feedback. Run `npm run academy:run` after installing its isolated environment. It needs no model API and stops after completing the exercise. This local lab is not yet connected to backend graduation or trading; its bundled example data is restricted to testing.

Version 0.1.3 adds a separate [portfolio backend connection](docs/portfolio-backend.md): the Python researcher receives training data and submits weights; an independent evaluator requests backend-calculated holdout results. Reviews enter the audit log and owner inbox, while example results remain ineligible for graduation or trading. `npm run worker:portfolio` operates on registered dataset/trial IDs. The three-method isolated portfolio workflow passed; persistent deployment remains separate.

Version 0.1.4 adds a [research bot lifecycle](docs/research-lifecycle.md): owner-approved capability blueprints, bounded admissions, reviewed curriculum, performance reputation, mentor designation, retirement draining and preserved knowledge archives. It is disabled by default and applies only to zero-budget example-research students. It does not yet discover opportunities, invent skills, spawn model processes or create departments autonomously. Use `lifecycle:admin` to inspect policy and `worker:lifecycle` for explicitly started cycles after configuration. Backend and isolated department checks passed; persistent activation remains separate.

Version 0.1.5 adds a [bounded research department](docs/research-dispatch.md): owner-approved dataset pool, daily/lifetime assignment limits, independent workers, expiring leases, durable trial submission and automatic evaluation/lifecycle dispatch cycles. Managed students must use this queue; they cannot bypass it through manual portfolio submissions. `worker:department` runs one cycle or a finite session after configuration. Failed and retired work remains recorded. No automation is enabled by installing this code; isolated build and workflow checks passed.

| Area | Working behaviour |
| --- | --- |
| Treasury | Integer-paise double-entry journals; all owner contributions enter Wallet 1; cumulative realised profit accounting; exact 60/40 allocation with carried fractional remainder; protected pending transfers and Wallet 2. |
| Authority | Default-deny API roles; one owner; bot-bound trader identities; signed, expiring owner transaction challenges; no bot bank withdrawal or permission-editing endpoint. |
| Research | Chronological training/holdout datasets, momentum parameter trials, separate evaluator jobs, leases, bounded retries and failure incidents. |
| Academy | School lessons with independent review, college experiments, paper qualification, declared capability deduplication, retirement with reviewed knowledge preserved. |
| Paper execution | Fresh approved-source quotes, fees/slippage, buy/sell accounting, shared reservations, position/budget limits, loss stop and critical-incident halt. |
| Knowledge | Source registry, evidence provenance and hashes, review/rejection/revocation, linked lessons, datasets and experiments. Revoked support blocks dependent new risk. |
| Operations | Incident records, evidence-backed resolution, owner resume control, durable owner notification inbox and hash-linked audit history. |
| Hermes | Optional real `AIAgent` adapter for bounded research candidate selection; contract tested, actual model inference deferred. |
| Ruflo | Pinned local MCP task mirror, bounded retries/sessions, durable completion recovery, startup diagnostics and owner health notifications. Actual backend-to-Ruflo lifecycle and restart verification passed on the normal Windows host. |

This release learns through parameter experiments and reviewed reusable lessons. It does not train a foundation model, infer traders' private intentions, continuously scrape the internet, create autonomous departments, or demonstrate profitable live trading. The current paper execution demo is scripted; the research result is not yet an unattended market-to-order trading loop.

## Read the design and contracts

Start with the [complete documentation index](docs/documentation-index.md).

- [Architecture and runtime knowledge graph](docs/architecture.md)
- [Financial invariants and examples](docs/financial-model.md)
- [API roles and request flow](docs/api.md)
- [Security boundaries and operations](docs/security-and-operations.md)
- [Hermes integration](docs/hermes-integration.md) and [Ruflo integration](docs/ruflo-integration.md)
- [All ten reference repositories mapped to implementation](docs/reference-map.md)
- [Validation record](docs/verification.md) and [remaining development stages](docs/roadmap.md)

## Tests

```cmd
npm test
python -m unittest discover -s services/research -p "test_*.py" -v
python -m unittest discover -s integrations/hermes -p "test_*.py" -v
npm run test:ruflo
```

The Ruflo contract suite above uses a fake MCP peer to test our enforcement. Installing the optional integration enables an additional dependency regression and a separate actual-upstream smoke test; see its guide. Contract tests do not stand in for a working upstream runtime.

For actual backend-to-Ruflo verification after installing its optional dependencies, run `npm run test:ruflo:live`. It uses fresh test state and saves `integrations/ruflo/.state/last-live.json`. `npm run ruflo:doctor` checks runtime prerequisites without starting an agent. A passing live report is required before describing the integration as fully verified.

The host run passed on 4 October 2026. This restricted execution environment still cannot resolve the Windows OS profile; run the Ruflo worker in the normal host terminal or a deployment with a real OS identity. No upstream security check was disabled to obtain the pass.

## Source ownership and independence

Our core owns identities, capital, audit records, learning evidence, qualification and job state. Hermes and Ruflo have no authority to rewrite those rules. Both are optional, version-pinned integrations. The other repositories are architectural references or future candidate plugins, not bundled execution engines.

Retain reviewed source, lockfiles, notices, dependency archives, model artifacts where permitted, and reproducible deployment images. This source ZIP excludes installed dependencies, credentials and databases: it is a development handoff, not an offline deployment image. GitHub disappearance would not erase a retained deployment, but initial installs, missing packages, model services, brokers and data providers remain separate availability dependencies.

<!-- documentation-navigation -->
[Documentation index](docs/documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
