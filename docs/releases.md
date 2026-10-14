# Bot releases: switching models safely

Implements the core of **RELEASE-01** and **AI-02** from the [remaining-work assessment](remaining-work-assessment.md). Code: [`backend/src/bot-releases.ts`](../backend/src/bot-releases.ts) (migration 039), worker gate [`integrations/trading-desk/release_gate.py`](../integrations/trading-desk/release_gate.py). Tests: `backend/test/bot-releases.test.ts`, `integrations/trading-desk/test_release_gate.py`.

A **release** is one exact version of a bot:
- the model name;
- the prompt fingerprint;
- a fingerprint of the code that turns model output into decisions;
- bounded settings: temperature, maximum tokens, timeout.

Workers run only an authorised release, so moving to a stronger model is a controlled, reversible step rather than a code change.

## Lifecycle

| Step | Route | Who | Rule |
| --- | --- | --- | --- |
| Register | `POST /v1/releases` | owner or researcher | Versions number 1, 2, 3 per bot. An identical version returns the original. |
| Evaluate | `POST /v1/releases/evaluations` | evaluator or owner, **never the release's author** | Links a fitness report for the **same bot and model**. **Canary-eligible:** the verdict is not `worse-than-baseline`. **Active-eligible:** additionally there was enough evidence (`adds-value` or `no-detectable-skill`). The newest evaluation decides, so a later worse result withdraws eligibility. |
| Stage | `POST /v1/releases/stages` | **owner only** | `canary` is a trial running beside the active release. `active` is the version the bot runs. `revoked` is permanent; register a new release instead. |
| Roll back | `POST /v1/releases/rollbacks` | **owner only** | One step: revokes the current active release and reactivates the previous one |
| Check | `POST /v1/releases/check` | workers (trader bound to its own bot) | `allowed` only for the exact active release or an exact canary |
| View | `POST /v1/releases/view` | owner, evaluator, researcher | Shows each release with its stage and evaluations |

## The future model switch, step by step

1. Run the same tests with the stronger model, such as the allocator's forward test or the desk batches, and submit the fitness counts. The backend computes the verdict.
2. Register the release with the new model name and the unchanged prompt fingerprint. Get the code fingerprint from `release_gate.py --fingerprint-only`.
3. An evaluator links the fitness report.
4. You start a **canary** beside the current release.
5. When the evidence is enough and not worse than its baseline, you set it **active**, and the old version stops being authorised.
6. If anything goes wrong, a **rollback** restores the previous release at once.

The test `a model switch: evaluate, canary beside the active release, activate, then roll back in one step` plays exactly this out, from a 4B release to an Opus release.

The worker gate refuses to run if the registry cannot be reached. An unverified version is never treated as allowed. (It is available to workers, but no worker calls it yet. See the note at the end.)

## Qualifications expire (SCHOOL-01)

An evaluation is valid for **180 days**. Staging a release as canary or active needs an evaluation newer than that. An active release whose newest evaluation is older raises the `release-evaluation-expired` alert until it is re-tested on recent data. Markets change, so a qualification earned long ago must be re-earned.

## Judged on live paper calls (FITNESS-02)

A release is usually first evaluated on backtests, which are data already seen. The real test is new days, so the backend files that judgment itself.

**The live report.** `POST /v1/bots/fitness/live` with `{botId, releaseId?}` (evaluator or owner) builds a fitness report from the bot's scored `enter-long` and `exit` calls, optionally for one release. Nobody types the numbers:
- **Judged against staying in cash:** a long is right only if it beat round-trip costs, an exit only if the price then fell.
- **Same test as before:** the same exact sign test and thresholds as every fitness report. Fewer than 20 decided calls is `insufficient-evidence`.
- **Linked to the release:** for a release, the report carries that release's model, so it can evaluate the release.
- **No duplicates:** identical numbers file nothing new.

**Every day.** The cycle step `live-fitness` (`npm run fitness:live`) files the report for each bot's active release. Once there is a real verdict, it **re-evaluates the active release** with it. The newest evaluation decides, so a release that is worse than cash on new days loses its eligibility.

**When a release fails.** An active release whose newest evaluation is not active-eligible raises the `release-failing-evaluation` alert. The owner decides whether to roll back or revoke it; nothing changes automatically.

**Limitation.** In a strongly rising market, most longs beat cash, so this test is lenient on long-only bots. Compare with the scorecard's realised P&L and the equal-weight basket before trusting an `adds-value` verdict.

## Enforced in the trading path (migration 043)

Release control does not depend on workers remembering to call the gate. **The backend enforces it at proposal time:**
- **After a release is registered,** `POST /v1/trading/signals` accepts a proposal only when its `model` and `promptVersion` match the bot's active release or a canary. Anything else is refused with *not an authorised release*.
- **Registered but nothing live:** a bot with releases but none active or in canary cannot propose at all.
- **Never registered:** bots that have never registered a release work as before.
- **Stamping:** each proposal records the `releaseId` that made it. The bot's scorecard splits scored calls `byRelease`, so a canary's **live** accuracy can be compared with the active release's before you promote it.

**Direct orders are closed too.** A bot under release control cannot place orders through `/v1/paper/orders`; it trades only by executing its reviewed proposals (PAPER-04).

**Not enforced (audit, 14 October 2026).** The **code fingerprint** is not checked on the trading path. Proposals carry only the model and prompt version. The worker gate (`release_gate.py`) checks the fingerprint, but no worker calls it yet, so editing a bot's code without changing its rule version keeps proposing under the old release. Until proposals carry the fingerprint, change the rule version (`promptVersion`) whenever the decision code changes.
