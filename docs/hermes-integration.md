# Hermes research integration

> Documentation refreshed for v0.1.21 (5 October 2026). [Current implementation, validation and limits](current-status.md). Dated milestones and design proposals retain their original scope.

Status: optional implemented adapter, with local contract tests. The default deterministic paper demonstration needs no Hermes installation or model credentials. No real model/provider call has been validated in this workspace. This is an explicitly bounded first integration, not a claim that Hermes has been trained into an advanced trader.

Version 0.1.7 extends the adapter/runner with an optional [capability-proposal task](learning-and-development.md#existing-model-rd-through-hermes), using the same pinned actual `AIAgent`. This changed source is unverified; earlier contract passes do not cover it. It receives approved temporal memory, returns a structured unverified hypothesis and uses a separate R&D budget/review path. It does not replace the existing momentum selector or enable tools.

## Role in this organisation

`integrations/hermes/worker.py` claims researcher jobs from the existing NestJS API. It computes training metrics for approved momentum lookbacks 2 through 20, then asks the actual Hermes `run_agent.AIAgent` to choose one candidate. Only numeric training summaries enter Hermes. No holdout data, ledger, wallet, owner, execution, or evaluator credential enters the child process.

The adapter validates the returned JSON and computes the candidate's reported performance itself. NestJS validates the completion and queues the separate evaluator. A candidate cannot grant itself paper qualification, deploy code, execute a trade, create a department, or change a financial rule. These decisions remain in the core's existing policy and role checks.

The [official programmatic-integration documentation](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration) identifies direct `AIAgent` embedding as a supported Python option. The adapter uses that interface rather than treating an arbitrary chat API as Hermes.

## Reviewed source pin and licence

The integration targets [release v2026.9.24 / version 0.21.5](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.24), commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`. The exact constructor, empty tool selection, result shape and lifecycle are tied to [that source revision](https://github.com/NousResearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/run_agent.py). Upstream's [licence is MIT](https://github.com/NousResearch/hermes-agent/blob/f97608f178d1ffeca59860195ab7da295f7c8e5f/LICENSE); retain its notice when redistributing source or builds. Model weights, provider contracts and transitive dependencies have their own terms.

The worker rejects a different HEAD or a dirty checkout and refuses a source-local `.env` or `config.yaml`. Its Git checks are local reads in a sanitized environment with personal/system Git configuration, credential helpers, prompts, hooks and filesystem-monitor commands disabled. No remote Git credentials are needed. The source pin is recorded in `integrations/hermes/source-lock.json`. Updating it requires a new source review and integration test, not an automatic update by a learning bot.

## Isolated installation

Install Hermes separately from this backend. Do not use a personal Hermes profile or a checkout holding credentials. The reviewed release specifies Python `>=3.11,<3.14`. Use its lockfile in a dedicated environment; there is no runtime package installer in our adapter.

Example preparation commands, run deliberately in an appropriate development directory:

```powershell
git clone https://github.com/NousResearch/hermes-agent.git hermes-research-source
git -C hermes-research-source checkout --detach f97608f178d1ffeca59860195ab7da295f7c8e5f
uv sync --project hermes-research-source --frozen --python 3.12
```

These install commands are documented, not executed by this integration. Confirm installation against upstream's instructions, archive the reviewed source and locked dependencies, and run the provider smoke test before deployment. The repository and provider are separate dependencies: retaining a source checkout does not remove model-serving or network availability requirements.

## Worker configuration

Provide these values only to this optional worker process:

| Variable | Meaning |
| --- | --- |
| `HERMES_ENABLED=true` | Explicit enablement; all other values fail closed. |
| `HERMES_SOURCE_PATH` | Absolute path to the clean pinned checkout. |
| `HERMES_PYTHON` | Absolute Python executable in the isolated Hermes environment. |
| `HERMES_MODEL` | Model identifier served by your selected compatible endpoint. |
| `HERMES_MODEL_BASE_URL` | Chat-completions endpoint base URL; HTTPS or loopback HTTP. |
| `HERMES_MODEL_API_KEY` | Model-serving key; a configured placeholder is acceptable only for a local server that requires no authentication. |
| `API_URL` | Organisation backend origin. |
| `API_TOKEN` | A dedicated **researcher** principal token, never owner/trader/evaluator/treasury credentials. |

From the project root:

```powershell
python integrations/hermes/worker.py --role researcher --once
python -m unittest discover -s integrations/hermes -p "test_*.py" -v
```

The launcher Python may be the same as `HERMES_PYTHON` or another Python 3.11+ interpreter; only the child requires upstream dependencies. If the demo launcher supports `RESEARCH_ENGINE=hermes`, select it to use this entrypoint. Do not copy the main `.env` into the Hermes checkout. The evaluator continues using `services/research/worker.py --role evaluator` in its separate process.

Only the model key and necessary OS runtime settings reach the child environment. Model identifier, endpoint, source path and numeric trial summaries travel through stdin. The organisation API token stays in the wrapper. The subprocess receives a fresh temporary home/config/cwd, no inherited proxy configuration, no inherited `PYTHONPATH`, no ambient provider keys, and no personal Hermes memory.

## Enforcement and limits

- No Hermes tools are enabled. The adapter aborts if any tool appears and denies both tool-dispatch paths at the pinned revision. An MCP refresh hook is disabled; that private hook must be rechecked on upgrades.
- Context files, persistent memory learning, background review and checkpoints are disabled for this integration. Accepted lessons and experiment results belong in the organisation's reviewed evidence/knowledge workflow. Enabling upstream autonomous skill execution is future work, not a hidden side effect.
- The prompt is guidance, not the security boundary. The JSON schema, role-scoped backend, independent evaluator, disabled tools and deployment isolation enforce the boundary.
- Calls have a 70-second process deadline and a 45-second agent run budget, leaving room in the current 120-second job lease for source verification and completion retries. Failure returns no accepted candidate. The shared HTTP client owns bounded transient-only completion retries using one result and one idempotency key. A 401/403, including a stale lease, fails immediately. Exhausted retries stop this optional worker rather than claiming again and regenerating model output. Model failures are not silently replaced by successful deterministic results.
- A process and sanitized environment are **not an operating-system sandbox**. A compromised upstream dependency could read files accessible to its OS user. Production deployment must use a separate unprivileged identity/container, no backend `.env` or database mounts, a read-only dependency image, resource quotas, and egress limited to the configured model endpoint. Host administrators remain trusted.
- No upstream install, update, terminal tool, live trade or messaging gateway is launched automatically. Retained Hermes logs are not used as the organisation's audit ledger; successful candidate and experiment outcomes are recorded by the core.
- This adapter compares a narrow, approved strategy family. It does not browse news, write strategies, retrain model weights, prove profitability, or qualify a bot for real capital. Those capabilities need separate evaluated plugins and resource authority.

## Validation and remaining checks

The stdlib suite covers malformed/model-generated commands, non-finite JSON, duplicated keys, configuration failure, credential isolation, dirty/wrong source, unexpected tool injection, refused tool execution, subprocess deadlines, output bounds, holdout separation, deterministic scores, role separation and uncertain completion retries.

Before enabling inference, run against the actual pinned installation and selected provider with a paper experiment. Verify successful completion, provider timeout, a malformed reply, blocked tools, and separate evaluator completion. Inspect the real process/network boundary. This external smoke test has not been run because Hermes and provider credentials are not provisioned here; unit/contract success does not establish provider compatibility.
