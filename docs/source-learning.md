# Article-to-lesson learning — v0.1.26

The source learning worker uses the existing pinned, tool-disabled Hermes adapter to propose a lesson from an independently reviewed article observation. It produces a lesson, an exact supporting quotation and a limitation. Matching text proves quotation membership only; it does not prove that the interpretation is correct or that a bot has learned a useful trading skill.

## Workflow

1. Register/import a source observation and independently review its evidence using the [source intake workflow](source-observations.md).
2. With an active bot and an enabled owner development-model policy, request a source-learning ticket. It freezes the bot context, article snapshot, policy revision and model profile for ten minutes. It consumes one slot from the shared development request quota.
3. The researcher worker rechecks current authorisation, invokes Hermes once, validates its closed JSON output and saves the proposal before submission. If a submission response is lost, a rerun replays the saved proposal/key. Uncertain inference cannot be regenerated automatically.
4. Submission checks the exact quotation against the frozen source text, creates an unverified lesson and retains the structured proposal. The lesson includes the quoted evidence and limitation.
5. A separate evaluator accepts or rejects the source-learning proposal. Acceptance requires current policy, source/evidence support, an active bot and an unhalted system. Rejection remains possible after support withdrawal. The decision and reason are immutable. The generic lesson verification route cannot bypass this review or promote a rejected extraction.
6. An accepted lesson can enter the existing cross-bot transfer workflow. Its extraction and source observation appear in the recipient's knowledge graph. Assessment remains a separate step.

The worker does not fetch websites, approve its own output, update weights, schedule repeated runs or obtain trading authority. Source withdrawal makes dependent knowledge unusable through the existing evidence checks. A historical accepted review is not a promise of current source validity.

## Commands

Rebuild/restart the backend through migration **020**. Actual inference requires a configured Hermes environment and a matching enabled owner model profile. The provisional model has not been activated or benchmarked by this implementation.

```cmd
npm run worker:knowledge -- source-learn --bot-id mentor --evidence-id <reviewed-observation-evidence-id> --request-key source-lesson-001
```

Keep the same request key and inputs when recovering an interrupted command. The launcher supplies the researcher credential; source-learning journals live under `integrations/hermes/.state/source-learning`.

Inspect `GET /v1/learning/sources` with an owner/evaluator credential to review the frozen article, model, proposal, lesson ID and review history (newest 100; no pagination). Prepare a review JSON file:

```json
{
  "requestId": "request-UUID-returned-by-the-worker",
  "decision": "accepted",
  "reason": "The quoted passage supports this bounded lesson; the limitation identifies what remains uncertain."
}
```

```cmd
npm run worker:knowledge -- source-review review.json
```

The launcher supplies the evaluator credential for this command. Use `rejected` with an evidence-based reason when the lesson is unsupported. Changes require a new proposal rather than rewriting an old decision. After acceptance, use the returned lesson ID in the existing [knowledge transfer commands](bot-knowledge.md).

## API

| Route | Role | Contract |
| --- | --- | --- |
| `POST /v1/learning/sources/requests` | researcher | `{botId,evidenceId}`; reviewed observation only; idempotency key. |
| `POST /v1/learning/sources/preflight` | researcher | `{requestId}`; read-only current authorisation check. |
| `POST /v1/learning/sources/proposals` | researcher | `{requestId,contextHash,proposal:{lesson,quote,limitation}}`; idempotency key. |
| `POST /v1/learning/sources/reviews` | evaluator | `{requestId,decision,reason}`; independent from proposer; idempotency key. |
| `GET /v1/learning/sources` | owner/evaluator | Frozen context and historical proposal/review state. |

Text limits: lesson 500 characters, exact quote 10–500 characters, limitation 300 characters. A review decision is separate from the initial evidence review; the source's factual content and the proposed generalisation must both be examined.

## Validation scope

Backend tests cover citation fabrication, changed context/identity, dedicated review enforcement, rejected-lesson bypass, quota sharing, halt, source withdrawal, retired recipients, policy change, graph lineage and HTTP roles. Python tests cover the tool-disabled prompt contract and durable replay without duplicate inference. The HTTP fixture now starts with a synthetic article observation, generates a lesson through the actual Python worker with a deterministic stand-in, reviews it, transfers it to another bot and grades fresh tasks. It injects lost acknowledgements at all three submission stages.

This completes a bounded extraction mechanism, not the full DATA-02 work package in the [remaining-work assessment](remaining-work-assessment.md): multi-source corroboration, entity/claim modelling, reliable automatic judgement, production Hermes qualification and continuous orchestration remain outstanding. Saved direct 4B source-lesson outputs passed their schemas, but this does not verify factual quality or the production learning path; see [model selection](model-selection.md).

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 7 October 2026; historical records retain their original scope.
