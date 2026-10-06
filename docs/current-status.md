# Current implementation — v0.1.34

**v0.1.34:** [method-based assessments](assessment-methods.md) (migration 023).
- **What changed:** under rubric `research-methods-v1`, bots choose how to compute costs, drawdown, record eligibility and action, and the backend derives the numbers. The default rubric is unchanged; learning workflows can opt in.
- **Benchmark on local 4B:** 96% with directly relevant lessons vs 77% without, across 3 pairs.
- **Real chain:** with only one model-extracted article lesson, the bot scored 8/16. Mechanism works; competence from real sources is not yet shown.

**v0.1.33:** the production workers can now use the measured-better local setup.
- **Owner-selectable engine:** the development policy accepts `"engine": "direct-structured-v1"`. This is a schema-constrained chat completion with no agent loop or tools, reporting real token usage. The default stays `hermes-rd-v1`.
- **Real end-to-end run:** `npm run verify:real-model` ran source lesson → review → transfer → fresh assessment through the production worker CLI on local Qwen3.5-4B in 4 min 45 s. The assessment passed 6/16 checks; costs and drawdown failed.
- **Evidence:** see [model selection](model-selection.md#production-path--v0133). No persistent policy, worker or service was activated.

Updated 6 October 2026. This is the current index for the documentation set. Dated milestones and the brainstorming knowledge base retain their original scope. The full organisation is still under development.

## This update

- Model benchmark comparisons now use matching, completed, contract-valid assessment pairs. All attempted arms retain failure counts and coverage; incomplete runs cannot invent pairs. Reports use reportVersion 2.
- Hermes benchmark timeouts now honour the explicit option or inherited setting, retain production task caps, and report effective per-task values.
- Publisher recovery restores durable Retry-After deadlines and failure counts after a crash; replaying a saved 304 clears previous failures.
- [Model strategy](model-strategy.md) maps the ten supplied repositories to the organisation and recommends Qwen3.5-4B Q4_K_M as the preferred experimental shared local candidate. It is not qualified yet. The disabled example points to its loopback alias.

## Implemented foundation

| Area | Available | Boundary |
| --- | --- | --- |
| Governance and money | NestJS roles, audit history, paper treasury, fixed two-wallet rules | APP_MODE=live rejected; no real bank/exchange access |
| Bot lifecycle | Registration, example school/college examinations, governed admission/retirement, preserved history | No proven advanced trader or unlimited autonomous population |
| Research and teams | Numerical Python research, constrained skfolio adapter, R&D proposals, dispatch, finite department supervision | Example/research results; general autonomous hiring and department discovery unfinished |
| Learning | Reviewed lessons, cross-bot discovery, bounded context, transfer proposals, fresh assessments and SQL-backed graph | Feedback and memory reuse; no demonstrated model-weight training or trading improvement |
| External information | Publisher RSS/Atom and bounded Vibe MCP intake, snapshots, revisions, review inbox, article-to-lesson contracts | Real publisher validation and corroboration still pending |
| Inference | Pinned tool-disabled Hermes adapter, versioned prompts, doctor/benchmark, immutable outcome reports and token ceiling | Outcome reports are worker claims; provider usage/financial cost attestation absent |
| Coordination | Scoped Ruflo mirror and application-owned workflow records | Upstream coordination cannot change authority |
| Operations | Owner inbox, durable outboxes/journals, bounded recovery, local artifact runner and Docker adapter | Live Docker isolation deferred; no autonomous deployment or guaranteed recovery |

Migration 022 is the latest required migration. This update adds no migration or backend API. Existing reviewed lessons from retired bots remain reusable when their support is valid. A learning proposal or a benchmark never grants trading, recruitment, spending or deployment authority.

## Actual model evidence

Local runtime and 2B/4B GGUF files exist. The saved 2B direct benchmark contains twelve real-model calls, including two failed source-lesson outputs and one malformed assessment response. Offline corrected regrading yields one complete valid pair from two planned and no learning gain. See [model strategy](model-strategy.md) and [verification](verification.md). Newer 4B reports include a constrained direct run with 6/6 valid outputs and 2/2 complete pairs, but drawdown scored 0/16. See [selection evidence](model-selection.md). Production Hermes qualification remains open; a direct benchmark does not establish it. Model service liveness is not inferred from saved files.

Observed hardware: i7-1355U, 15.69 GiB RAM and about 1.24 GiB free at inspection. One shared endpoint with distinct bot contexts is the recommended starting point. Weight-file size is not total memory. No new download, model call, persistent worker, private configuration or financial connection was activated by v0.1.32.

## Validation

The new targeted regression checks are recorded in [verification](verification.md). The earlier full backend result of 116 tests belongs to v0.1.30; it is not represented as a new full-suite run. Docker testing remains deferred by the owner.

## Next development priorities

1. Separate method from arithmetic in fresh assessments: the model states the computation and rules, and the backend computes the numbers. Then extend constrained 4B evaluation to fresh held-out cases. The constrained output mode now runs in production workers through the direct engine (v0.1.33); the Hermes-path equivalent remains unverified.
2. Validate one owner-selected publisher end to end, including review, cited lessons, transfer and fresh evaluation.
3. Add evidence-backed claim/entity extraction and corroboration, then bounded organisation-wide scheduling with health reporting.
4. Expand role-specific fitness, novelty checks and measured specialist evaluations; preserve failure knowledge when retiring bots.
5. Add independently governed release/rollback and validated host isolation before generated-code deployment; market-connected execution remains a later milestone.

## Read and operate

- [Documentation index](documentation-index.md), [model selection evidence](model-selection.md)
- [Model strategy](model-strategy.md), [local serving](local-model.md), [readiness and usage](model-readiness.md)
- [Learning workflows](learning-workflows.md), [bot knowledge](bot-knowledge.md), [discovery](knowledge-discovery.md)
- [Publisher feeds](publisher-feeds.md), [source observations](source-observations.md), [Vibe integration](../integrations/vibe-trading/README.md)
- [Reference map](reference-map.md), [remaining work](remaining-work-assessment.md), [roadmap](roadmap.md)
- [Architecture](architecture.md), [API](api.md), [financial rules](financial-model.md), [security](security-and-operations.md)

Wallet 1 receives all owner deposits; eligible cumulative realised net profit is allocated 60/40 without redistributing the same profit. Wallet 2, bank withdrawals, ratio changes and permission changes stay outside bot authority. Preserve private .env, journals, signing keys and local state; do not publish them.

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
