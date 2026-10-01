# Trading Organisation — backend foundation

[Vibe-Trading news adapter](integrations/vibe-trading/README.md) now converts saved upstream news results into reviewed-source observation submissions. It includes offline preparation, explicit submission and provenance diagnostics; upstream runtime activation and automatic collection remain pending.

Version **0.1.27** adds [bounded learning workflows](docs/learning-workflows.md): owner-defined programmes, role-specific next actions, durable stage links and finite polling. Rebuild/restart through migration **021**. Source and transfer judgements still require independent review.

The preceding source-learning increment adds [article-to-lesson proposals](docs/source-learning.md), independent review and source-to-bot graph lineage. Actual model inference remains unverified.

[Remaining work to achieve the full organisation](docs/remaining-work-assessment.md) — implementation-backed assessment, priorities, dependencies and completion gates (6 October 2026).

The learning workflow tests accepted transfer plans on fresh synthetic tasks and returns independently graded feedback to future bot context. [Source observations](docs/source-observations.md) add article provenance, immutable revisions and a bounded batch importer. Automatic feed retrieval, model execution, causal improvement and live-market competence remain unverified or unfinished.

The main development focus is now [bot reasoning, knowledge graphs and cross-bot learning](docs/bot-knowledge.md). The first workflow connects reviewed lessons and experience to Hermes-generated application plans and independent evaluation; actual model inference and measured skill improvement remain unverified.

> Documentation refreshed for v0.1.21 (5 October 2026). [Current implementation, validation and limits](docs/current-status.md). Dated milestones and design proposals retain their original scope.

**Continuing in another account or chat?** Start with [KT.md](KT.md), then use the [resume prompt](RESUME-PROMPT.md). They preserve owner requirements, implementation context, unverified work and terminal-execution preferences.

Version 0.1.27 extends our trading organisation backend: an owner-controlled NestJS/TypeScript core, Python research, an academy with independent evaluation, reviewed shared knowledge, registered R&D experiments, monitored department supervisors, paper execution, and your two-wallet financial rules. **All money, quotes, fills and bank references are simulated.** `APP_MODE=live` is rejected. Current tests and integration results are in the [verification record](docs/verification.md); persistent activation and model inference remain pending.

Owner [research approvals](docs/research-approvals.md) now record a specific independently evaluated candidate, with bounded expiry and permanent revocation. This is governance for further research, not execution or deployment authority. Rebuild/restart through migration **016** for these routes.

The [artifact runner](docs/artifact-execution.md) supports reviewed local source and a Docker Linux adapter whose live validation remains deferred. Backend execution reports, durable outbox delivery, read-only journal inspection and bounded saved-submission recovery are implemented. See [current status](docs/current-status.md) and the [recovery guide](docs/artifact-recovery.md). Synthetic comparisons do not deploy versions or establish learned trading ability.

New [paired academy experiments](docs/skill-experiments.md) compare baseline and candidate declarations on identical cases under pre-registered criteria, with independent review and retained incomplete/failure history. Results cannot approve or deploy versions. Rebuild/restart through migration **015** before using these routes; `npm run verify:paired-skills` tests actual Python-to-HTTP transport in a temporary fixture.

The new [exam diagnostics](docs/skill-diagnostics.md) bind declared worker fingerprints before questions, preserve observed failure patterns, and produce corrective lessons through separate proposal/review roles. Version comparisons report complete outcome counts but cannot approve upgrades from unpaired random exams. Updated departments require a backend rebuilt/restarted through migration **013**.

The new [school recovery workflow](docs/skill-recovery.md) lets the owner approve one extra exam after three consumed attempts, a graded failure and a newly reviewed corrective lesson. Approval is revocable, expires after seven days and preserves all counters/history. It does not grant trading authority or change model code. Rebuild/restart through migration **012** before using recovery routes.

The new [research-basics exam](docs/academy-skills.md) can require a managed school student to demonstrate cost calculations, drawdown, data timing and abstention before college admission. A separate evaluator requests backend grading; attempts and failures are preserved. The gate defaults off and gives no trading authority. Updated Python departments require a current backend with migration **011** before launch.

`npm run verify:organisation` repeats the integrated starter/research/memory/supervisor check using fresh ephemeral credentials and an in-memory database. It does not load `.env` or alter the persistent community. See [organisation verification](docs/organisation-verification.md) for prerequisites, duration and scope.

The latest [department monitoring](docs/department-monitoring.md) adds renewable supervisor sessions and owner-visible responding/degraded/stale/stopped states. Rebuild/restart before using updated launchers, because they now require the new worker-session routes and migration 010. Inspect with `npm run lifecycle:admin -- workers`. This guard covers the updated launchers, not every possible API client or operating-system process.

To prepare that first community, `npm run organisation:prepare` exports a reviewable plan from the existing bundled skfolio examples. It makes no backend changes. The [starter guide](docs/organisation-starter.md) explains the separate explicit import and proposed activation steps for three students, nine windows and a bounded session. Preparation does not require a model provider.

The new [registered experiment workflow](docs/development-experiments.md) fixes a proposal's datasets and diagnostic thresholds before work, waits for all planned results, and preserves positive and negative outcomes. It integrates with the existing evaluator loop and owner report; it does not automatically create a bot or deploy model-generated strategies. Inspect plans with `npm run lifecycle:admin -- experiments` after rebuilding/restarting. No new dependencies are needed.

The long-term idea is retained in the [knowledge base](docs/knowledge-base/README.md). This README and [implementation roadmap](docs/roadmap.md) distinguish source implementation from that future design. The owner wants to reuse existing models and frameworks; a specific serving model/endpoint has not been chosen. The default workflow needs no model API.

## Run locally

Use Node.js 24 and Python 3.12 or 3.13. Run these commands from this project directory. The default database is persistent PGlite in `.data/paper`; Docker is not needed.

```powershell
npm ci --ignore-scripts
npm run dev:setup
npm run build
npm start
```

`dev:setup` creates unique development credentials and an Ed25519 signing key in ignored local files. Run it once for a new checkout; it refuses to overwrite an existing `.env`. The workspace in which this project was built is already configured. Keep `.env`, `.local`, and `.data` private. Do not expose this development server to the internet.

In a second terminal in the same project directory:

```powershell
# Set this only if Python is not already on PATH:
# $env:PYTHON_BIN = 'C:\absolute\path\to\python.exe'
npm run demo
```

The demo performs a complete synthetic journey: register evidence → admit a distinct bot → review its lesson → complete school → research a momentum candidate → independently evaluate it → qualify for paper trading → record an owner contribution → buy/sell → allocate and confirm the 60/40 profit split. It writes `.local/demo-report.json`. Stable idempotency keys make reruns reuse existing business operations instead of funding or trading again. Use a fresh database to demonstrate a different research engine; the existing completed demo does not rerun its research job.

For ongoing research, start workers in separate terminals:

```powershell
npm run worker:research
npm run worker:evaluation
# Add -- --once to process at most one job and exit.
```

These local launchers read the development configuration and pass each worker only its role token. Deployments must provision scoped secrets independently; the launchers are not an OS security boundary.

## What is implemented

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

- [Architecture and runtime knowledge graph](docs/architecture.md)
- [Financial invariants and examples](docs/financial-model.md)
- [API roles and request flow](docs/api.md)
- [Security boundaries and operations](docs/security-and-operations.md)
- [Hermes integration](docs/hermes-integration.md) and [Ruflo integration](docs/ruflo-integration.md)
- [All ten reference repositories mapped to implementation](docs/reference-map.md)
- [Validation record](docs/verification.md) and [remaining development stages](docs/roadmap.md)

## Tests

```powershell
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
