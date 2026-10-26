# The organisation cycle, point-in-time knowledge and compute accounting

Three pieces that make the organisation run on its own and stay auditable. They need no model unless stated.

## One finite cycle (AUTO-01): `npm.cmd run cycle`

[`scripts/organisation-cycle.mjs`](../scripts/organisation-cycle.mjs) runs these steps in order. Each step is a separate process with a time limit.

| Step | What it does | Needs |
| --- | --- | --- |
| `backend-health` | Stops the cycle if the API is down | backend running |
| `market-data` | Refreshes daily prices for the eight shares | internet (Yahoo) |
| `news-<feed>` | One poll of every **enabled** feed in `.local/feed-*.json`. Each feed's own poll interval is respected. | internet (approved publishers) |
| `news-triage` | Sets aside waiting news that names no tracked share or market driver ([relevance triage](evidence-triage.md)) | backend |
| `claims-and-fact-check` | Claim analyst (model) plus fact-checker (no model), via `autolearn.py --cycles 1` | `--with-model`, local model server, `.local/claims/autolearn.json` |
| `headline-reader` | The model reads each new verified headline once into a strict schema: event, direction, materiality, fact or opinion or rumour, and a 140-character summary. Results are cached in `.local/trading-desk/headline-reads.json`, at most 40 a run. The model never changes a headline's share links. The debate shows each headline with its reading (NEWS-04, from Anthropic's financial plugins) | `--with-model`, verified headlines exist |
| `chain-links` | Adds inferred driver links to the verified headlines | verified headlines exist |
| `forward-daily-rules`, `forward-portfolio` | Scores the pre-registered forward tests on new days | none |
| `rule-bot` | Once a month, the model-free rule bot proposes its top-3 momentum trades ([trade signals](trade-signals.md#the-rule-bot-a-model-free-member)) | `RULE_BOT_ID` set, the bot qualified, a trader credential bound to it |
| `model-allocator-decide` | The model allocator decides any new month in its pre-registered forward test (at most 2 model calls) | `--with-model`, `MODEL_ALLOCATOR_RUN` and `MODEL_ALLOCATOR_BOT` set |
| `model-allocator-propose` | Turns a current decided month into proposals, citing the facts the model saw, recomputed and verified by the evaluator ([trade signals](trade-signals.md#the-model-allocator-in-the-daily-cycle)) | `MODEL_ALLOCATOR_RUN` and `MODEL_ALLOCATOR_BOT` set; no model needed |
| `eod-trading` | Reviews waiting proposals at the verified close, executes accepted ones at the verified next open | backend, daily data |
| `rule-bot-entries`, `eod-trading-entries` | A second pass on the same day: once the month's exits have filled, the rule bot sends the entries the exits made room for, and they are reviewed. A proposal turned down **only** for a passing reason (a loss-brake pause, a stale quote, a halt) is sent again on a later day; any lasting reason stays final. Found by the 2020 replay, where a one-week brake kept the bot in cash for the whole April rebound | `RULE_BOT_ID` set |
| `mentor-refresh` | Re-checks the mentor's lessons on our own price data ([mentor](mentor.md)) | daily data |
| `broad-data` | Keeps the NIFTY 500 research files (never traded) at most 28 days old: at most 40 downloads a run, 1 s apart, from the approved price source; the rest wait for the next day ([factor lab](factor-lab.md)) | the constituent list `.local/trading-desk/datasets/ind_nifty500list.csv`; skipped in a replay |
| `factor-lab` | Judges each month once it has closed (reruns only until last month has a report) ([factor lab](factor-lab.md)) | `.local/trading-desk/daily-nifty500` |
| `organisation-lessons` | Turns the newest factor-lab and scout reports into the organisation's own lessons, read by the debate beside the mentor's ([mentor](mentor.md)) | none (no reports: no lessons) |
| `outcome-labels` | Labels each logged debate argument by what really happened to the call it argued, for a later fine-tune ([mentor](mentor.md#training-on-reality)) | scored proposals |
| `score-signals` | Scores proposals whose horizon has passed | backend, daily data |
| `review-scorecard` | Read-only. Shows how the calls the risk review took and turned down went: by fate, by rejection reason, and by the regime when each call was made and when it ended. For buys it also shows the worst and best price while held (MAE/MFE). Writes `.local/trading-desk/review-scorecard.json` | backend (evaluator credential) |
| `live-fitness` | Files each bot's fitness report from its scored paper calls; once there is a verdict, re-evaluates its active release with it | backend |
| `paper-snapshot` | Records today's per-bot P&L mark (evaluator credential) | backend |
| `charter-guard` | The founder charter's last-resort stop: when the organisation's total paper loss reaches `organisationLossPaise`, it opens a critical incident and halts the system ([charter](charter.md)) | backend (evaluator credential) |
| `alerts` | Evaluates alert rules and delivers new alerts | backend |
| `owner-digest` | Writes the day's summary to `.local/digests/<day>.md` | backend |

**Resuming:** a daily journal (`.local/cycles/<day>.json`) makes reruns resume. Finished steps are skipped, and only failed or skipped ones run again. `--force` reruns everything.

**Run manifests (TRUST-01, 21 Oct 2026).** Every run adds an entry to `runs` in the day's journal, so any later result
can be traced to what produced it:
- **code:** the commit and a content fingerprint of `integrations/`, `scripts/` and `backend/src/`. The fingerprint is
  the same on Windows and Linux, and it changes with any uncommitted edit;
- **switches:** the settings that change what a cycle does (bot IDs, sources, the model name). Never a credential or a
  limit;
- **data:** at the end of the run, each share's bar count and last session, with one fingerprint of the price files.

A failure to describe a run is recorded and never stops the run.

**The digest checks itself.** "Can you trust this digest?" comes straight after "Needs you". It lists what to check
first:
- no cycle today, or failed or degraded steps;
- stale prices, or a share behind the others;
- a regime that is not fresh;
- live knowledge or the knowledge index more than 2 days old.

It also shows the code commit, and says when the code changed since the previous run, so results before and after come
from different code.

The self-check also covers:
- **arithmetic:** total P&L equals realised plus open, accuracy lies between 0 and 1, and every count is a whole
  number;
- **crashed runs:** runs that started but never finished;
- **the limits banner:** the limits the running backend actually loaded, and the share of the realised-loss limit used,
  from `limits` in `POST /v1/owner/digest`. When a limit setting in the digest's own environment differs from what the
  backend loaded, it says so by name only: a stale shell variable, or a backend not restarted after a change.

**Refused orders (TRUST-03, migration 053).** A refused reserve or fill used to leave no trace, because its transaction
rolls back:
- each business refusal (403, 404 or 409) is now kept in `order_refusals`, written separately after the rollback, once
  per request;
- the caller still gets exactly the same error;
- the digest counts them, with the commonest reasons;
- `POST /v1/paper/refusals/query` lists them.

**Review scorecard (TRUST-02).** A verdict needs 20 or more scored calls on each side and a gap of at least 10 points in
the share right:
- `review-turns-down-worse-calls`: the review is helping;
- `review-turns-down-better-calls`: the review blocks winners, so the owner should look at the reasons;
- `no-clear-difference` or `insufficient-evidence`.

It changes nothing: the review rules and limits stay the owner's.

**First live run (13 October 2026):**
- 55 new news items from three publishers;
- prices refreshed to 13 October;
- forward tests scored;
- today's P&L mark recorded;
- no alerts raised.

A same-day rerun repeated nothing.

### Self-recovery (RECOVERY-01)

| Mechanism | Behaviour |
| --- | --- |
| **Runbook retries** | Network steps (market data, news feeds) retry twice, waiting 30 s and then 90 s. Other steps do not retry. |
| **Postconditions** | A step counts as done only if its own report says so. `market-data` is **degraded** when the data steward kept previous data for any share. A feed is **failed** when it reports a fetch or parse failure, even if the process exited cleanly. |
| **Circuit breaker for model agents** (21 Oct 2026, from FinceptTerminal) | A model step (debate, scenario panel, claims, learning, allocator, TradingAgents, playbook drafts) that failed 3 cycles in a row **rests for 2 days**: it is skipped with the reason, and no model time is spent. Then it tries once. A success closes the circuit; a failure opens it again. Other steps are unaffected, and the escalation below still tells you |
| **Failure streaks** | `.local/cycles/streaks.json` counts consecutive failed cycles per step. A success or a degraded run resets the count. |
| **Escalation** | On the **3rd consecutive failure**, the step is reported once as a **warning** incident (`POST /v1/incidents`, evaluator credential). That raises the `incident-open` alert. It is never critical, because a critical incident would halt new risk. If the backend itself is down, the escalation goes to `.local/alerts/outbox.jsonl` instead. A new streak after a recovery can escalate again. |

Restarting is not counted as repair. Escalations stay open until someone resolves the incident.

**The cycle never trades, funds or changes limits.** Scheduling it is the owner's choice. There is no built-in schedule: run `npm run cycle` after 16:00 IST, or set up an operating-system scheduled task. A rerun on the same day skips steps already done, so run it after the close, not before.

## What was known when (KG-01): `POST /v1/knowledge/as-of`

[`backend/src/knowledge-asof.ts`](../backend/src/knowledge-asof.ts) answers `{asOf, symbol?, botId?}` with:
- the evidence received by the cutoff;
- each item's **status at the cutoff**: unverified, verified, rejected, revoked or source-revoked, and whether a bot could use it;
- claim decisions taken by then;
- the bot's lessons verified by then.

**How it is rebuilt:** evidence keeps only its current status, so the timeline comes from the append-only, hash-chained audit log. A change after the cutoff is **listed but not applied**, so a past decision is judged on what could have been known.

**A test caught a hindsight leak and it was fixed:** the bot filter had included lessons created after the cutoff.

## Compute accounting (COST-01): `POST /v1/compute/usage`

[`backend/src/compute-usage.ts`](../backend/src/compute-usage.ts) combines two sources of model usage:
- usage that workers report per bot (`POST /v1/compute/usage/reports`, append-only, deduplicated);
- the backend's own model tickets, attributed to a bot when the request names one and otherwise labelled `unattributed`.

It totals tokens, calls and latency per bot and per department. The owner may set a daily token budget per department (`POST /v1/compute/budgets`, owner only). The `compute-over-budget` alert fires when a department exceeds its budget, and resolves when the department is back under it or the budget is removed. Budgets inform the owner; they do not throttle.

## Security (SEC-01)

- **`npm.cmd run scan:secrets`** scans everything git would publish for keys, tokens and forbidden paths before a push. The repository scanned clean on 13 October 2026.
- **`backend/test/injection.test.ts`** plants hostile instructions in news, theses, rationales and contest entries, and shows that none of them changes authority, limits, review outcomes or sizing.
- See the [threat model](threat-model.md).
