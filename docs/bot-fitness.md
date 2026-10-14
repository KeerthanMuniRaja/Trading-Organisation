# Bot fitness reports (migration 031)

Role-specific fitness (FITNESS-01 in the [remaining-work assessment](remaining-work-assessment.md)) records, on the organisation's own bot records, whether each bot beats **the do-nothing version of its own job**, by more than luck:

| Bot's job | Its baseline |
| --- | --- |
| Analyst | `always-neutral` |
| Portfolio manager | `always-hold` |
| Allocator | `buy-and-hold` or `equal-weight-basket` |
| Any strategy | `cash` |

Before this, verdicts lived only in local research reports ([trading desk fitness](../integrations/trading-desk/README.md#bot-fitness-survival-of-the-fittest-on-evidence)), where promotion and retirement decisions could not see them.

## Rules the backend enforces

| Rule | Enforced as |
| --- | --- |
| The verdict is computed, not claimed | The evaluator submits counts: decisions judged, wins and losses where bot and baseline disagreed, and failed calls. The backend computes the exact one-sided sign test (log-space, so large samples do not overflow) and the verdict. A request carrying its own `verdict` is rejected. |
| Thresholds are fixed | Fewer than 20 disagreements is `insufficient-evidence`. Otherwise p < 0.05 decides `adds-value` or `worse-than-baseline`, and anything else is `no-detectable-skill`. |
| Independent judgement | Only owner or evaluator roles may report. When a report cites evidence, that evidence must be verified, from an approved source, and not written by the reporter. |
| No impossible reports | Wins plus losses cannot exceed decisions judged, the period must start before it ends and cannot end in the future, and the bot must exist and not be retired. |
| History is permanent | Reports are append-only, and re-submitting the same report returns the existing one (`duplicate: true`). Every report is audited, which notifies the owner. |
| Recommendations, never actions | The query groups reports by role and baseline. It recommends, from the latest two, one of: `review-for-retraining-or-retirement` (worse twice running), `candidate-for-more-responsibility`, `collect-more-evidence` or `keep-observing`. It never changes a bot's state, budget or authority. |

## API

| Route | Roles | Body |
| --- | --- | --- |
| `POST /v1/bots/fitness` | owner, evaluator | `{botId, role, baseline, testName, periodFrom, periodTo, judged, wins, losses, failed?, model?, evidenceId?}` with an `Idempotency-Key` |
| `POST /v1/bots/fitness/live` | owner, evaluator | `{botId, releaseId?}`: the backend computes a report from the bot's scored paper calls on new days (against cash); see [releases](releases.md#judged-on-live-paper-calls-fitness-02) |
| `POST /v1/bots/fitness/query` | owner, researcher, evaluator | `{botId, limit?}` returns the reports (newest first) and a summary per role and baseline with the latest verdict and recommendation |

The `model` field records which model produced the behaviour being judged. After a model switch, a bot's track record should be re-earned rather than inherited (see [switching models](../integrations/trading-desk/README.md#switching-models-what-carries-over-and-the-comparison)).

## Example

The eight-week desk replay gave the trend analyst 5 wins and 8 losses against always-neutral, 13 disagreements in all. Reported, that is `insufficient-evidence`: weak, but too little evidence to judge. Two consecutive `worse-than-baseline` reports for the same role and baseline would recommend a retraining or retirement review. The decision would still be the owner's.

## Verification

`backend/test/bot-fitness.test.ts` covers:
- exact p-values against known values, the thresholds, and large samples without overflow;
- verdicts computed by the backend, duplicates, roles, extra fields, impossible counts, future periods, unknown and retired bots;
- evidence that must be verified and independent;
- append-only history, recommendations from consecutive reports, no automatic state or budget change, and audit-chain validity;
- routes registered and guarded over HTTP.
