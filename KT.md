# Knowledge transfer: continue the trading organisation

### Added on 28 October 2026 (read this first; [project log](docs/project-log/2026-10-28.md))

- **Working arrangement.** On weekdays the agents develop alone. Anything only the owner can do is queued in
  [founderReview.md](founderReview.md) under "This weekend" (W1…), each with a recommendation and command; the owner
  works through it on Saturday and Sunday.
- **Running by itself.** The supervisor (`npm run supervisor`, a minimized window) runs readiness at 09:00, news through
  the day, the cycle with the model at 16:05 and the Friday backup. It does not survive a reboot yet (W6).
- **News is now read.** `.local/claims/autolearn.json` was missing since the move, so the fact-checker, the headline
  reader and the chain links never ran. It is restored: 80 model calls a cycle, newest news first. STARTUP checks
  for it.
- **Market pulse** (`npm run pulse`, [market pulse](docs/market-pulse.md)):
  - movers and the press's reasons, big players and FII/DII flows, read by rules from every headline;
  - sectors, breadth and the week's movers from the NIFTY 500 prices;
  - unexplained desk moves are flagged.

  The debate, the digest and the status screen show it.
- **Teaching:**
  - **organisation lessons** come from our own research, including "after a deep fall" with whether it holds now;
  - **curriculum v3** adds four tips tested on 484 shares with a noise test;
  - **exams** cover the lessons and the sector context.
- **Research:** momentum-12-1 passed the factor lab on 484 shares (a candidate only). Its pre-registered forward test
  `momentum-12-1-from-2026-11` counts from November, with the verdict at 24 months.
- **Fixes:**
  - the claims `.env` reader stripped no quotes;
  - Windows file locks stopped atomic writes (every replace now retries);
  - a model timeout failed the whole R&D step;
  - a day when every scenario voice failed was filed as empty calls;
  - triage `scope-v3` stops counting SBI Life, SBI Mutual Fund, ITC Hotels and NTPC Green as ours;
  - three trading-desk test files were outside the gate, and a test now catches that.
- **The old name "Nexus" is gone** from the repository; never use it.
- **Evening: moving machines and the model gap.**
  - **Moving:** `npm run handover` on the old machine, then `scripts\setup-machine.ps1` (with `-Check` to preview) on
    the new one ([STARTUP section 0](STARTUP.md)). A handed-over machine's supervisor refuses to start
    (`--take-back`).
  - **Model speed:** `npm run model:tune` (llama-bench measures threads, and the Vulkan graphics build if installed)
    writes `.local/models/tuning.json`, which `serve` uses.
  - **The decision model:** `npm run model:upgrade` pins it to the publisher's sha256, serves it on 8081, and routes the
    debate and TradingAgents to it only after our exams say SHIP (`routing.json`). The supervisor starts it
    optionally, and the cycle falls back to the 4B.
  - **Debate second pass:** `debate.self_check`, judged by the exams; `DEBATE_SELF_CHECK=0` turns it off.
  - **TradingAgents:** it rates its holdings plus 2 rotating shares a week with 3 tool rounds. At 8 rounds the laptop
    needed about 2.5–3 hours for one share.
  - `npm run status` shows the tuning and the decision model.
- **Late afternoon fixes (live).**
  - The supervisor's news polls had never run between cycles: node went through the Windows shell, so the space in
    "Program Files" split the command.
  - It also stopped scheduling for hours while its heartbeat said alive. Status now shows **STUCK**, and a failing
    loop exits.
  - The scenario panel now receives the regime with the note that it is never by itself a reason for a
    share-against-market call. Scenario exams can be judged correct.
  - The secret backup (`DO NOT OPEN`) was refreshed (it lacked 4 settings); the handover refreshes it, and the setup
    restores from it.

## Live paper testing — from 15 October 2026

Daily operation is in the [live testing runbook](docs/live-testing.md).
- **Before the open:** `npm run readiness` gives a go/no-go.
- **After 16:00 IST:** `npm run cycle` runs the day's work.

The model-free [rule bot](docs/trade-signals.md#the-rule-bot-a-model-free-member) keeps proposals flowing without the local model. Owner activation: `npm run rulebot -- plan | credential --yes | apply --yes`.

### Added on 20 October 2026 (read this first)

The organisation now manages itself like a firm, with the owner as CEO:
- **Management review** (migration 051, [management](docs/management.md)). Every cycle, fixed rules (`management-v1`) review each bot in paper trading and recommend watch, suspend, a 25% budget raise or retirement. Nothing changes until the owner accepts.
- **Owner agenda.** `npm run agenda` lists every decision waiting on the owner: recommendations, births, departments, releases ready to activate, and qualifications. `npm run agenda -- accept <id>` or `decline <id>` answers through the existing owner routes.
- **R&D scout** ([R&D scout](docs/rnd-scout.md)). Every cycle it screens 13 strategy ideas, net of costs and Bonferroni-corrected. None passes on data through 2026-09; the best is the live momentum rule (p = 0.027). With `RND_SOURCE` set, a passing idea becomes verified evidence and a birth proposal. Not built yet: onboarding and a runner for R&D-born bots (deliberately left until an idea passes).
- **Release gate.** The cycle runs the rule bot only while its code fingerprint matches its authorised release. `rule_bot.py` changed at 14:36 on 14 October, probably after its release was registered. If the gate refuses it, run `npm run rulebot -- apply --yes` (v2 for the current code). Accepted proposals still execute.
- **Fact-checking.** Verified claims are recorded in the backend claim registry, with fact keys.
- **Holidays.** Readiness reads an owner-supplied `.local/nse-holidays.json`.
- **CI.** `.github/workflows/verify.yml` runs the full gate on GitHub. It runs for the first time on the next push.
- **Later the same day:**
  - **R&D bots:** `rnd_bot.py` onboards R&D-born bots (release, fitness, evaluation) and runs them monthly, gated by their release. `npm run bot-credential -- --bot <id> --yes` gives a bot its trader credential, and the agenda has a `budget` item.
  - **Partial fills:** at most 1% of the session's volume (`maxQuantity` on execution).
  - **Budgets:** department ceilings are enforced, and `POST /v1/compute/allowance` gates the model allocator's model step.
  - **Learning:** the cycle advances open learning workflows (with the model).
  - **Academy:** exams, lifecycle, dispatch, experiments and memory cycles run daily, and stay disabled until their policies are on.
  - **Credential backups:** `npm run env:prune` prunes old `.env` backups (owner, `--yes`).
- **Live, 20 October:**
  - **Rule bot:** release v2 (current code) is active.
  - **Fills:** the three buys filled at the 19 October open.
  - **Migration:** 051 is applied.
- **Standing approvals** (migration 052, [autonomy](docs/autonomy.md)): the owner approves classes of decisions once, with `npm run autonomy -- set <policy.json> --reason "..."`. The cycle's `autonomy` step then carries them out as `autonomy-policy`. With no policy, nothing is automatic.
- **Self-development** (all owner opt-in through the policy):
  - **Ideas:** R&D invents new ideas as grammar specs (`rnd_ideas.py`, `--invent model`), recorded in an append-only ledger, with a Bonferroni bar over every idea ever tried.
  - **Live keep or revert:** `promoteCanaries` keeps a version that wins live; `rollbackFailingReleases` drops one that loses live.
  - **Code fixes:** `trialNewReleases`, with `release-renewal.mjs`, turns a same-rule code fix into a trial release by itself.
- **Supervisor:** `npm run supervisor` (built, not installed) runs readiness, the cycle and the Friday backup on trading days.
- **Reference review** (TradingAgents, FinceptTerminal; `docs/reference-review-2026-10-20.md`), and what was adopted from it:
  - post-trade reflections (cycle step `reflections`);
  - the debate desk (`debate.py`, model plus `debate-setup.mjs`);
  - risk metrics (volatility, Sharpe, VaR) in the benchmark and digest.

  No code was copied from either project.
- **On the next backend start:** migrations 052, 053 (refused orders) and 054 (loss brakes) apply. Take a backup first.
- **Owner's direction:** agents decide and act, and the system develops itself; the owner approves and oversees. Build towards this.

### Added on 22–23 October 2026 (read first)

- **The owner is moving to a new machine** (24 Oct) and working without Claude for three days. Their plan, and what
  to ask for when they return, is in `founderReview.md` Part 0. Their notes will be in `.local/owner-notes.txt`, which
  the data export carries to the private data repository.
- **First live run, 22 Oct:** 35 steps done, migrations 052–054 applied. It found and fixed the benchmark start for
  bots whose record predates the basket marks.
- **Model:** 6 of 8 evaluation tasks pass on Qwen 3.5-4B ([model evaluation](docs/model-eval.md); an earlier "7 of 8"
  was a miscount).
  - The headline reader is on prompt v2.
  - Debate citations are grounded (MODEL-04): a quote checked in the evidence, or a citation derived from the argument.
  - Playbook phrases are escaped literals (`playbook_drafts.literal`).
  - Lesson: keep instructions stable and put self-explaining context in the data. One extra sentence flipped the
    debate's citations.
- **New this week:**
  - news polled all day by the supervisor;
  - a follow-through-day re-entry signal;
  - a shuffled-history test and a plateau report;
  - a circuit breaker for model steps;
  - a headline reader;
  - a weighted, two-round scenario panel with persona lessons;
  - TradingAgents readability counts;
  - an events calendar (`.local/events.json`), plus results days read from the press (`results_calendar.py`, NEWS-07,
    28 Oct);
  - point-in-time NIFTY 50 research (`.local/trading-desk/datasets/nifty50-membership.json`).
- **Owner's direction:** useful code may be taken from the reference repositories (personal use) with a one-line source
  note.
- **Waiting on the owner:** B1, B3, B4, B6, B10, B11, B14, B16, B25 and B26 (the exposure limit).

### Added on 21 October 2026

- **Founder review** ([founderReview.md](founderReview.md)): the switch-on checklist (planned for Sat 24 Oct) and all pending decisions. Keep it up to date as items close.
- **Data repository** ([data export](docs/data-export.md)):
  - the collected data and backups live in the **private** repository `KeerthanMuniRaja/trading-organisation-data`;
  - its clone is at `.local/data-repo`, and `npm run export-data -- --write` refreshes it;
  - secrets and the model file are never exported.

  The code repository is **public** (B25).
- **Live operations are paused until Saturday.** The backend has been stopped since 20 Oct. Migrations 052–054 apply on the next start, so take a backup first.
- **Autonomy:**
  - **Rehearsal:** `backend/test/rehearsal.test.ts` checks the invariants over 8 rounds, with injected failures.
  - **Starter policy:** `docs/policies/autonomy-starter.json` is protective only.
  - **Supervisor:** catches up missed jobs, survives job errors and writes a heartbeat. Readiness and status show it; `scripts/install-supervisor-task.ps1` registers it (owner-run).
  - **Preflight:** `npm run preflight` gives READY or NOT READY for the switch-on.
- **Model:**
  - **Evaluation:** `integrations/model-eval/model_eval.py` tests all six model tasks with their real prompts. The first run on Qwen 3.5-4B: 37/37 valid and safe, claims perfect, sensitive to wording or order ([model evaluation](docs/model-eval.md)).
  - **Training data:** every production model call is journaled in `.local/model-calls/`; `build_dataset.py` writes SFT and preference data in Soup's formats.
  - **Soup** is a fine-tuning tool that needs a GPU. It has not been used.
- **Research:**
  - **Slower rebalancing:** a `rebalance` interval (1, 3, 6 or 12 months) in the grammar.
  - **Scout fixes,** found by the source review: next-open entry, drift-aware turnover, no tax on the first purchase, sign-test proof time, and a 5,000-sample bootstrap with an error margin.
  - **Method cards** are now version 2, with corrected numbers and attributions. Our regime, trend-template and pullback are simplified variants of the originals.
  - **Result:** nothing passes. Yearly momentum keeps 11.2% after tax, against the basket's 12.55%.
- **Source-code review of 13 projects:** seven notes and a ranked gap analysis in `docs/research-notes/`. The top gaps are self-expiring loss brakes, unrealised-loss and horizon exits, and broker-readiness items. The cheap fixes the agents can make are listed in Part C of the founder review.
- **Intraday monitor** (`scripts/intraday-monitor.mjs`): feed-agnostic, tested on 38 replayed days. A broker adapter waits for the founder's choice.
- **Gap fixes that need no owner decision** (commits 761572b to fb9da65; see the [project log](docs/project-log/2026-10-21.md)):
  - **Debate:**
    - it sees only headlines and prices from before the signal;
    - the bull answers the bear;
    - it sees the bot's own scored record, data-status markers and a press dossier.
  - **Scenario panel:** failed voices are left out of votes and scoring (`failedVoices`).
  - **Model gate:** `--baseline` regression, judge fingerprints, and exit 1 on DON'T SHIP. Evaluation rows never enter training data.
  - **Knowledge index** (`knowledge_index.py`, cycle step `knowledge-index`, `npm run knowledge`): one SQLite file with
    FTS5, holding shares, sources, drivers, items, stories, daily regimes, ideas, method cards, problems and panel calls.
    `dossier(symbol, as_of)` is point-in-time ([knowledge index](docs/knowledge-index.md)).
  - **Luck guards** (`research_checks.py`):
    - every idea gets a probabilistic and a deflated Sharpe ratio, robustness (years ahead, twice the costs, India's
      stress windows) and `beatsMatchedRandomPct`;
    - the best deflated Sharpe is 0.22 on the 8 shares and 0.31 for NIFTY 50 reversal, against a bar of 0.95.
  - **Regime v2** (`market_regime.risk_v2`): studied beside v1; it warns less sharply, so v1 stays.
  - **Trust checks** ([operations cycle](docs/operations-cycle.md)):
    - a run manifest in every cycle journal (`runs`: code commit and fingerprint, switches, prices);
    - the digest's "Can you trust this digest?" section;
    - `review_scorecard.py` (cycle step `review-scorecard`), comparing calls the review took with calls it turned
      down.
  - **Refused orders** (migration 053, `order_refusals`, `POST /v1/paper/refusals/query`): every 403, 404 or 409 refusal
    of a reserve or fill is kept after its rollback, once per request; the caller's error is unchanged.
  - **Digest:** a limits banner (what the running backend loaded, with a name-only warning when settings differ),
    arithmetic checks, crashed runs, refused-order counts and the loss-brake state.
  - **Loss brakes** (migration 054, `protections.ts`, `npm run protections`, [protections](docs/protections.md)):
    - daily, weekly and monthly loss pauses, measured on realised losses or on the fall in value (`measure: equity`,
      27 Oct), a losing-streak pause and a per-share cooldown;
    - they pause new buys only and lift by themselves;
    - they are set by the owner only, and are off until then (founder review B3);
    - the review rules are now `signal-risk-v3`, identical to v2 with no policy.

### Added on 27 October 2026 ([project log](docs/project-log/2026-10-27.md))

- **Founder charter** (`npm run charter`, [charter](docs/charter.md)): autonomy rules and brakes applied together.
  - `management-v2` also cuts budgets (`reduce-budget`, migration 055; standing approval `reduceBudget`).
  - `management-v3` only watches, rather than suspends, a bot at the 15% loss limit that is ahead of the basket
    (`market-fall`). Found by the year-long 2020 replay ([management](docs/management.md)).
  - Cycle step `charter-guard` (`POST /v1/protections/guard`, evaluator) halts all new buying at the organisation loss
    limit (`organisationLossPaise`). It never resumes by itself.
  - `management-v4` (evening, migration 056) gives a loss-limit suspension a way back: `reinstate` after 20 days, once
    the bot holds nothing or has recovered, with 25% less budget; afterwards only its loss since returning counts.
    Standing approval `reinstateSuspended` (in the charter, not the starter policy).
  - `management-v5`: losses, the worst fall and the basket comparison take budget changes out (`performanceCurve`), so a
    budget cut no longer reads as a fall, as trailing the basket, or as a bigger loss.
- **New machine (27 Oct evening):** the organisation ran from `C:\Keerthan\Project\Trading-Organisation`, renamed by
  the owner to `C:\Keerthan\Project\Organisation` on 29 Oct (STARTUP.md done, 23 Oct backup restored, starter policy and suggested brakes set, model members created). The
  llama.cpp runtime is a separate install: `npm run model:local -- install runtime` (STARTUP.md step 7 now says so).
- **Mentor** (`mentor.py`, `knowledge/mentor-curriculum.json`, cycle step `mentor-refresh`, [mentor](docs/mentor.md)):
  lessons checked on our data; the debate and the panel read at most 3 as data; contradicted lessons are never shown.
- **Training on reality:** the debate log plus `outcome_labels.py` (cycle step `outcome-labels`) feed
  `build_dataset.py`'s `<task>/outcome-kto.jsonl`. Claude's outputs are never training targets.
- **Rule bot:** a second pass the same day once exits fill (`rule-bot-entries`, `eod-trading-entries`). It also
  retries, at most once a day, a buy refused only for a passing reason.
- **Replay:**
  - `run --protections/--autonomy/--charter` and `prepare --limits`;
  - the report has `tradingWholeRun` with rejection reasons, and equity curves;
  - the 2020 crash runs revised B3 (value-based brakes, daily and weekly), raised the charter stop to ₹2,000 and added
    B27 (the lifetime realised-loss limit) ([replay](docs/replay.md)).

### Added in the evening of 20 October 2026

- **World news:** a catalogue of 12 sources in 6 regions, all off until the owner enables them. The owner tools are `npm run world -- probe | enable --yes | coverage | stories`. Also:
  - 8 world drivers in `impact_links.json`;
  - triage `scope-v2`, with world terms;
  - cycle steps `world-stories` and `link-study` (links tested on every collected headline). See [world news](docs/world-news.md).
- **Market regime** (`market_regime.py`), with the cycle steps `market-regime` and `regime-study`. It is advice only. On 10 years it warns of falls, but as a cash filter it loses return ([market regime](docs/market-regime.md)).
- **R&D:**
  - **History:** 10 years of prices for the 8 shares. The owner confirmed Axis Bank on 23 Mar 2020 and SBI on 25 Oct 2017. `daily.years_to_fetch` keeps the long history on refresh.
  - **Catalogue:** 17 ideas, with new families `trend-template` and `pullback` and the filter `distribution-days`.
  - **Checks on every idea:** lookahead and warm-up, statistics, 100 random pickers and walk-forward (`research_checks.py`).
  - **Result:** no idea passes. Momentum 6m top 3 has 0.00% average excess over 106 months. Walk-forward selection loses (−0.35% a month).
- **NIFTY 50 research universe** (research only, never traded):
  - `datasets.NIFTY50`, with files in `.local/trading-desk/daily-research`;
  - `rnd_scout.py --universe nifty50` (37 shares);
  - 7 shares are kept back until the owner confirms their large moves.
- **Scenario panel** (`scenario_panel.py`, in shadow, needs the model): five personas, scored per persona ([scenario panel](docs/scenario-panel.md)).
- **Knowledge:**
  - `knowledge/methods.json`: 17 method cards, fed to R&D invention;
  - `knowledge/problems.json` with `scripts/playbook.mjs`: the cause, fix and decider for failed steps, shown in the journal, the escalation and readiness. Unknown failures are logged to `.local/cycles/unknown-problems.jsonl`;
  - `live_knowledge.py`: the cycle step `knowledge-refresh` writes `live.json`, and the briefing goes to the debate desk and the scenario panel.

  See [research methods](docs/research-methods.md).
- **Licences:** none of the reference projects' code was copied (freqtrade, backtesting.py, vectorbt, Lean, nautilus_trader, MiroFish, claude-trading-skills, a-stock-data, FinnewsHunter).
- **Open owner decisions:**
  - whether R&D should also judge ideas on risk, not only return (the trend filter's only route to a bot);
  - which of the 7 NIFTY 50 moves are real;
  - which world sources to enable.
- **Push:** this evening's commits wait until the 5-day push plan finishes on 25 Oct (`.local/push-due.ps1`).

### State on 14 October 2026

**Live setup.**
- **Order limit:** ₹5,000 per order (`MAX_ORDER_PAISE=500000`).
- **Rule bot:** `momentum-rules` is active and qualified for paper trading. Its release v1 is evaluated on the regime study (seen data, p ≈ 0.03).
- **Backup:** the live database was backed up before the changes. Migrations 049 and 050 apply on the next backend start.

**Audit.**
- **What was done.** Four independent reviews checked every planned idea against the code. The trading bugs they found are fixed and tested.
- **Where to read.** [docs/audit-2026-10-14.md](docs/audit-2026-10-14.md) is the honest status page. It supersedes the older status claims in `current-status.md` and `remaining-work-assessment.md`.

**Verification.** `npm run verify` runs every test suite (644 tests), and all pass.

**Owner controls.** Suspend or resume a bot, change a bot's budget, and retire a bot with nothing learned ([bot control](docs/bot-control.md)).

**Still needs the owner.**
- The local model, for the learning loop and the model allocator.
- An alert channel (`ALERT_WEBHOOK_URL`).
- A daily schedule.
- Confirming the market-data licence.

**Pitfalls.**
- **Environment variables win over `.env`.** A terminal that already has `MAX_ORDER_PAISE`, `PRINCIPALS_JSON` or `DATABASE_PATH` set ignores `.env`. If the readiness check shows the old limit, open a fresh terminal.
- **Large price moves.** The data steward keeps back a refresh with a move over 20% until the owner confirms it: `daily.py accept-move --symbol X --date D`.

## Current development update — v0.1.35, 7 October 2026

The checkout now includes v0.1.34's explicit direct-structured-v1 production engine and migration 023, which adds the optional research-methods-v1 assessment rubric. Existing research-basics-v1 records/defaults remain unchanged. The direct worker requests task schemas and binds tickets to the owner-selected engine; it is separate from Hermes, not a fallback or an upgrade of the pinned Hermes path.

This increment rejects direct responses unless the provider reports a normal stop with no tool calls or refusal, even when their JSON is valid. Reported tokens survive validation/completion failures in the durable failed outcome. No automatic regeneration or engine switch is added. Learning/R&D launchers now propagate HERMES_ENGINE to inference workers, while reviewer/discovery commands retain credential separation. Explicit Hermes benchmarks cannot be relabelled direct runs by ambient settings.

Validation: all 59 Python tests passed; the launcher regression passed six command/role scenarios using intercepted child launches and fixture credentials. No model, backend policy, persistent service, Docker runtime or financial connection was activated. No backend code/migration changed in this increment. Full backend tests were not rerun for these Python/launcher changes.

## Latest continuation — v0.1.34

v0.1.34 (migration 023) adds the `research-methods-v1` assessment rubric:
- The bot chooses methods, and `deriveAnswers` computes the numbers.
- The evaluator can select it per assessment (`rubric`), and a workflow can select it with `assessmentRubric`.
- The model task is `knowledge-assessment-methods`, with a deliberately neutral prompt.

Results are in [assessment methods](docs/assessment-methods.md): relevant lessons help (96% vs 77%), but one real article lesson did not make a bot competent (8/16). Next: many reviewed relevant lessons, evaluated on the knowledge actually transferred, plus a real market/data choice from the owner.

## Continuation — v0.1.33

v0.1.33 adds an owner-selectable `direct-structured-v1` inference engine:
- Selected by `"engine"` in the development policy's model profile, with `HERMES_ENGINE=direct` in the worker.
- A schema-constrained chat completion with no tools, reporting real token usage.
- Workers refuse tickets whose engine differs from their own.

`npm run verify:real-model` passed the full learning chain on the local Qwen3.5-4B (llama.cpp, `npm run model:local`); the assessment scored 6/16. See [model selection](docs/model-selection.md). Next: assessments should test the method, with the backend doing the arithmetic.

Two agents worked on this checkout on 6 October. v0.1.32 came from a parallel review session, and its fixes are preserved. Coordinate so only one agent edits at a time.

## Previous continuation — v0.1.32

The review fixes are complete: benchmark pairing/coverage, effective Hermes timeouts and feed crash recovery. Read [current status](docs/current-status.md), [model strategy](docs/model-strategy.md) and the newest [verification](docs/verification.md). Both local GGUF candidates exist; the saved direct 2B report failed source-learning and numerical checks. Newer free-form and constrained 4B reports are now saved. Constrained 4B is the preferred experimental profile: six tested outputs valid, drawdown 0/16, production Hermes schema support and qualification still open. See [model selection](docs/model-selection.md). Do not claim no real inference has run or treat direct runs as pinned-Hermes qualification. The disabled example uses the 4B alias on port 8080; private .env was not changed.

Migrations remain through 022. Ten distinct user-supplied repositories were identified and reviewed at capability level, not fourteen full codebases. The organisation retains separate bot contexts, reviewed knowledge and deterministic authority; unlimited growth, autonomous fine-tuning and live trading are not implemented. Use Command Prompt, not PowerShell. Docker testing remains deferred. Earlier continuation sections below are historical.

## Historical continuation — v0.1.30

v0.1.30 adds migration 022:
- Immutable `inference_reports` (one per model ticket).
- The `inference_request_kind` and `inference_reservation` SQL functions.
- An optional owner `maxTokensPerDay` checked by `assertTokenCapacity` before every `development_requests` insert.

Workers report through `integrations/hermes/inference_reporting.py`. Owner view: `lifecycle:admin -- inference-usage`.

Still needed from the owner: a model endpoint.

## Continuation — v0.1.29

v0.1.29 adds [model readiness tooling](docs/model-readiness.md): versioned prompt contracts (`integrations/hermes/contracts.py`), `model:doctor`, and a budgeted `model:benchmark` with a paired with/without-lessons comparison. 46 Hermes tests pass.

The next real step needs the owner:
1. Choose a model, its weight revision and a server (local CPU is feasible but slow on this 15.7 GB, no-CUDA machine) or a hosted budget.
2. Run the doctor and benchmark.
3. Install the pinned Hermes checkout.

Then implement per-request usage recording in the backend.

## Continuation — v0.1.28

Updated 6 October 2026. Versions 0.1.23–0.1.27 built the learning pipeline: cross-bot transfer, knowledge graph, fresh-task assessments, source observations, article-to-lesson proposals, bounded learning workflows, the review inbox, lesson discovery and the Vibe news cycle. See [current status](docs/current-status.md).

v0.1.28 adds [publisher feed intake](docs/publisher-feeds.md) (`sources:feed`), a generic RSS/Atom adapter for DATA-01 with checkpointed, replay-safe submission. Verified results:
- 113 backend tests.
- 19 feed tests.
- 34 Vibe/importer tests.
- 34 Hermes Python tests (from v0.1.27, unchanged).
- The real-backend feed check.

Still unset: the owner's first publisher, the model endpoint (Qwen3.5-9B is only provisional) and the first market. Docker testing stays deferred.

Git requires `-c safe.directory=...` in this folder (the repo is owned by another Windows identity). The work from v0.1.23 onward is uncommitted. The project folder is now `Trading-Organisation`.

## Previous continuation — v0.1.22

Migration 016 and `backend/src/research-approvals.ts` add owner-only, append-only research candidate approval/revocation with expiry and effective policy/halt state. Exact passing paired plan/candidate hashes and independent evaluation are required. No worker consumes these records, so they are not a deployment allowlist or code rollout. Read [the contract](docs/research-approvals.md) and newest verification entry. Preserve historical receipts and never treat them as current permission. Earlier milestone text below remains historical.

> [Current implementation, validation and limits](docs/current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

Updated: 6 October 2026. Source version: **0.1.32** (sections below the latest continuation are historical). This is the resumption entry point for another Codex account or a new coding chat. It preserves the owner's decisions and implementation context; it is not a claim that unfinished capabilities are working.

## Start here

Open the existing `trading-organisation` folder and read this file before editing. The latest continuation adds bounded recovery, inspection and owner-visible execution monitoring. Do not restart from scratch or replace our design with an upstream application.

### Latest continuation: v0.1.21 execution monitoring and bounded recovery

Read [current status](docs/current-status.md), [execution](docs/artifact-execution.md), [recovery](docs/artifact-recovery.md) and [verification](docs/verification.md). Versions 0.1.16–0.1.21 add a Docker Linux adapter, durable owned-container registry, migration 015 execution reports, a Python outbox, saved-submission recovery, read-only journal inspection and one-pass recovery of 1–10 explicitly selected journals. Recovery never executes solvers and does not need the original artifact/runtime; ordinary execution retries still require the original binding. Backend claims and local snapshots do not establish liveness, attestation or upgrade authority.

Current build, 64 Python tests and actual HTTP batch recovery passed. The latest full backend suite is the v0.1.18 run of 86 tests; no backend source/schema changed afterward. Exactly two original solver executions survived an injected lost response, with zero financial writes. Migration 015 requires backend restart. Docker Desktop launch attempts did not establish an engine; the owner said “Continue coding; test Docker later.” Do not retry Docker without that deferred work being resumed.

No new dependencies, live model call, recurring automation, persistent policy activation, release or financial connection were introduced. Preserve journals/private state. Development execution is authorised. The owner requested this full documentation refresh after previously prioritising coding; routine handover edits must not displace development. Next priorities are in the current-status page: deferred live isolation validation, independently trusted provenance, separate owner-governed release/rollback and wider real-input evaluations.

### Historical milestone notes

The entries below describe their original version and original test status. Their “next”, “unverified” and “pending” statements do not override the current status or later dated verification evidence.

### Previous increment: v0.1.14 paired version experiments

Read [paired experiments](docs/skill-experiments.md). Additive migration 014 preserves immutable owner plans, both-arm submissions, independent reviews and cancellations. `SkillExperiments` registers two producer manifests, an assigned researcher, 8–32 fresh synthetic cases and fixed check-level thresholds. Questions are generated after plan input and only disclosed to the assigned researcher with matching hashes. Every case must appear exactly once in one atomic submission. A different evaluator from both the registering owner and researcher requests backend grading. Improvements and regressions are counted separately, overall and per skill.

Plans require enabled skills and respect halt, policy revision, a 24-hour submission deadline, three active slots, ten registrations per rolling day and 100 lifetime registrations. Cancellation/expiry never refund history. Timely submissions may be graded after the deadline. Unsupported submissions are invalidated. Status keeps incomplete, expired, cancelled and failed plans visible; completed reports retain current-support information. All verdicts have `promotionAllowed: false`. No money, student exams, curricula, lessons, reputation, recruitment or deployed artifacts change.

`integrations/skfolio/paired.py` is a helper for trusted solver functions, not an artifact loader, sandbox, timeout supervisor or durable replay journal. It is not scheduled by departments. The new `verify:paired-skills` workflow compares a deliberately broken cost fixture with our existing solver over actual Python-to-HTTP transport in an isolated database. Its passing score verifies the protocol, not a learned improvement. Declared artifacts are not execution-attested; no real model/provider was selected.

Verification: compilation and all 83 backend tests passed, all 22 academy Python tests passed, and actual Python-to-HTTP paired verification passed at 13:32:24 IST on 5 October. The fixture deliberately injected eight cost errors and detected all eight, with no regressions or financial effects. Report: `.local/paired-skills-verification.json`; this is not the older department-run report. See the newest [verification entry](docs/verification.md) for exact scope. Rebuild/restart through migration 014 to use the routes. CLI: `skill-experiments`, `skill-experiment <file>`, `cancel-skill-experiment <file>`. No persistent activation occurred. Next: verified executable artifacts with isolated bounded execution and durable retries, separate owner-governed release/rollback, wider specialist evaluations and real-input provenance. Do not auto-promote solely on synthetic criteria.

### Previous increment: v0.1.13 exam diagnosis and provenance

Read [skill diagnostics](docs/skill-diagnostics.md). Additive migration 013 stores immutable declared worker manifests, exam attribution, diagnoses and corrective proposals/reviews. Updated Python `skills.py` declares its normalized source-file SHA-256 before receiving questions and echoes the bound manifest digest on submission. Existing/unattributed attempts remain explicitly unknown. The backend does not attest that a declared artifact actually ran; the hash covers this one file, not every dependency. Optional model-reference labels do not select or invoke a provider.

The grading transaction records factual failed checks only for failed exams, not invalidated/expired work. Reports group recurring failures by bot and declared version. Researcher cycles propose fixed-template corrective plans; a different evaluator rechecks current policy, evidence, curriculum and template before creating one verified lesson. Retired/unsupported cases cannot create new lessons. Proposals/reviews/diagnoses are deduplicated and append-only. Lessons enter the shared knowledge records but do not silently change curriculum, code, weights, quotas, reputation or permissions. Owner recovery approval remains separate; its existing workflow can use the latest failure's resulting lesson.

Owner/evaluator version comparisons include all outcomes grouped by rubric and policy revision. They always return descriptive-only / promotionAllowed=false: different random exams are not a paired experiment. No release approval or auto-deployment exists. Attribution currently covers academy exams, not all portfolio/Hermes results. The new worker endpoints require backend rebuild/restart through migration 013.

Verification: compilation, all 76 backend tests, all 18 academy Python tests and all nine actual department integration checks passed. The latest `.local/organisation-verification.json` finished at 13:13:06 IST on 5 October, with three passed exams, three college students, three evaluated trials and one verified factual memory. All exams carried the declared Python fingerprint and generated no false failure diagnoses. Failure/remediation paths passed in the backend suite. See the newest [verification entry](docs/verification.md) for exact scope. No persistent activation or model call was made. Next: pre-registered paired version evaluations and executable artifact verification before release approval, broader worker provenance, then real-input ingestion. Do not claim an individual bot trained itself from these templates.

### Previous increment: v0.1.12 school recovery

Read [skill recovery](docs/skill-recovery.md). Additive migration 012 stores immutable one-per-bot recovery approvals, revocations and consumed-attempt links. After exactly three consumed exams and a latest graded failure under the current skill policy, an owner may approve one new exam following a newly created, independently reviewed corrective lesson. The lesson is appended to curriculum and its content/author/reviewer/evidence fingerprint is bound to the approval. Approvals expire in seven days, cannot be replaced, and never reset the original attempt or global quota history.

`skill-recovery.ts` rechecks current support for claims, submissions, grading and school admission. Revocation, expiry, policy changes or modified lesson support can invalidate a pending or historically passed recovery before admission. College students are not retroactively demoted. Normal Python departments consume the extra attempt automatically when authorised; Python/model code did not change. A corrective lesson and new pass do not prove a model changed or learned. No money, reputation, trading permissions or credentials follow.

Owner CLI: `skill-recoveries` reads history, `skill-recovery <file>` approves, and `revoke-skill-recovery <file>` revokes. These are subcommands of `lifecycle:admin`. Report students now include `skillBudget` and `SKILL_ATTEMPTS_EXHAUSTED` when no exam outcome is pending. Rebuild/restart the backend through migration 012 before using recovery. Nothing was activated in the persistent database. See the latest [verification](docs/verification.md) for current results; older team/Python results below are historical.

Verification: compilation and all 72 backend tests passed, including five new recovery cases and expanded HTTP access checks. Python and the monitored team were not rerun because their code did not change; the existing saved team report remains v0.1.11 evidence. No persistent activation or recovery approval was made.

Next work: versioned worker/solver attribution, automated diagnosis and reviewed remediation proposals, appeals for expired/invalidated attempts, real-input provenance and executable hypotheses. This increment does not permit endless retries or automatic code/model upgrades.

### Previous increment: v0.1.11 academy skills

Read [academy skills](docs/academy-skills.md). Migration 011 adds an initially disabled owner policy and append-only challenge/submission/review tables. The `research-basics-v1` rubric tests cost arithmetic, peak-relative drawdown, information availability at a cutoff and abstention under controls. TypeScript grades a stored random synthetic scenario; Python independently computes answers. This measures the shared deterministic adapter, not learning by an individual language model. No model weights, reputation, funds or trading permission change.

An enabled policy gates both automatic and owner-requested college admission for managed school students. Existing college and owner-created bots are not retroactively gated. Submission is author-bound with a 120-second deadline; a different evaluator identity requests backend grading. Current rubric/policy/curriculum, evidence, halt and school status are checked again. All attempts, including expired/invalidated ones, count toward three lifetime tries per bot and owner day/lifetime budgets. Policy revisions cannot reset counters. Failed students remain in school; remediation/re-examination is future work, not silent deletion.

Python departments now call `/skills/claims`, `/skills/submissions` and `/skills/cycles`; rebuild/restart the backend through migration 011 before using these updated workers. CLI reads: `lifecycle:admin -- skills`; owner policy file: `lifecycle:admin -- skills-policy <file>`. The owner report includes `SKILL_ASSESSMENT_REQUIRED`. Starter import still leaves this optional policy disabled; only the isolated integration test enables it automatically in its disposable database.

Verification: compilation, all 67 backend tests and all 16 academy Python tests passed. The exam-enabled isolated team also passed at 08:26:34 IST on 5 October: three passed exams, three college students, three evaluated trials and one verified factual memory. Its current report is `.local/organisation-verification.json`; details are in [verification](docs/verification.md). No persistent policy or database was changed. Preserve the same plan and private runtime files. Next: governed remediation, skill-version/worker attribution, new executable research methods and evaluation isolation; basic exam success is not general trading competence.

### Earlier v0.1.10 verification and execution permission

Historical result: `npm run verify:organisation` passed on 5 October 2026 at 08:06:33 IST, before the exam gate. That report has been superseded by the v0.1.11 run above. The six supervisor tests passed, including two actual child-process termination cases; the then-verified distinct test total was 101. `prepareDepartment` accepts an optional explicit environment for isolated checks, retaining its default and scoped child credentials. The repeatable guide is [organisation verification](docs/organisation-verification.md).

The actual three-method Python-to-backend portfolio integration also passed, using ephemeral credentials and a fresh in-memory database. Its report is `integrations/skfolio/.state/last-http-check.json`; it verifies scoring agreement, retry deduplication, permissions, no trading graduation and an empty financial ledger. It does not establish monitored team operation or starter import.

The owner now permits assistant command execution. TypeScript compilation and all 61 backend tests passed, as did eight Node starter/supervisor tests, 13 skfolio Python tests and 17 mocked Hermes/development tests. See the current section of [verification](docs/verification.md); historical “not run” statements below describe earlier increments and are superseded by that record. The skfolio entry points now import `services.research.worker` with explicit package markers.

`organisation:prepare` completed and generated `.local/organisation-starter/plan.json` and `REVIEW.md`, hash `50b806612b51ef73bf0ae60c2cd07f936226b77e1a540bc3d780ed0bab7cdd5e`. Preserve this directory. The bundle contains nine already-used historical example windows and three specialist blueprints. Import and bounded activation were verified only in the temporary integration database. The owner's persistent community remains unchanged. Next development: provenance-aware real-input ingestion and measurable skill assessments, then executable hypotheses and evaluation isolation before recruitment based on new techniques. Actual Hermes inference still needs a configured provider/model; evidence-backed novelty and genuine model learning are not implied by passing example workflows.

### Latest continuation: v0.1.10 department monitoring

Read [department monitoring](docs/department-monitoring.md). New migration 010 and `backend/src/department-sessions.ts` implement one current supervisor per department role, a 90-second renewable lease, immutable session IDs, sequence/body replay checks, monotonic cycle counters and owner-only status. Current-clock checks use `clock_timestamp()` after the database lock. Duplicate messages do not refresh the lease. Expired/stopped sessions cannot resume or overwrite a replacement. Failure/recovery/start/stop transitions audit to the owner inbox; ordinary heartbeats do not.

`scripts/department-session.mjs` makes bounded exact-body retries and serialises heartbeat updates. The shared department runtime acquires a session before spawning Python, reports every 20 seconds, stops its child on lease loss, and attempts final stop on exit. The team launcher aborts its peer on failure. This is a cooperative guard for the updated launchers, not execution fencing for direct Python, old launchers or every API transaction. No background stale-alert service exists: staleness is computed on owner reads; replacement records an expired-session event. `workerLiveness` now summarises both roles and `workers` carries details. Initial no-session state remains `not-observed`.

Four backend and four Node contract cases were written, not executed. `npm run test:supervisor` selects the Node cases. No build/migration/API call/worker/test/model inference or activation was run by the assistant. No owner starter output arrived. Rebuild/restart the backend before updated workers, then inspect `lifecycle:admin -- workers`. Do not tell the owner that no rebuild is needed based on the previous scripts-only increment. The starter preparation command remains pending and can run offline independently.

### Previous increment: v0.1.9 starter department

Owner output: `lifecycle:admin -- experiments` returned `items:[]`; `-- report` returned a snapshot at 4 October 2026 23:18:52 IST. Zero managed students, blueprints and approved dispatch datasets; lifecycle/dispatch/learning/R&D disabled; no global halt; paper mode; worker liveness unknown. The v0.1.8 read endpoints and schema queries respond. No build/test log or actual worker/experiment result accompanied this output. The old Ruflo degraded inbox event is historical and does not establish current runtime health.

Read [starter department](docs/organisation-starter.md). `integrations/skfolio/prepare_organisation.py` exports nine chronological bundled-example windows (252 training/63 holdout rows each) without fitting, backend access or model credentials. `scripts/organisation-starter.mjs` validates the plan and writes a review with its byte hash. Explicit `organisation:apply -- --approve HASH` uses distinct owner/researcher/evaluator principals for fixed source/evidence/curriculum/dataset/blueprint/profile operations, stable command receipts and current-support checks. The multi-request import is not atomic; partial state is retained. Recovery is bound locally to API origin/principal IDs/plan hash. Nothing is enabled or started by apply.

The fixed bootstrap reviewer calls validate a local software-example contract; they are not independent scientific or financial review. Data was already used in the offline academy. Three blueprints cover equal weight, inverse volatility and minimum variance, plus one zero-budget curriculum identity. Generated activation proposals cap managed students at three and assignments/reflections at 27, retain other current fitness rules, and use a 60-second lifecycle cadence. The owner must separately review/submit those files and start a finite worker session. No R&D inference policy is generated. Existing demo funds/bots are not changed.

Four Node contract tests were written; `npm run test:starter` is optional and unexecuted. No scripts, tests, API calls, activation, fitting, installation or model inference were run by the assistant. No migration/new dependency in this increment. The next owner command is `npm run organisation:prepare`; it generates `.local/organisation-starter/plan.json` and `REVIEW.md`. Do not infer that those generated files or a populated community already exist. Preserve that directory after the owner creates it.

### Previous increment: v0.1.8 registered experiments

Read [registered experiments](docs/development-experiments.md). New `backend/src/development-experiments.ts` and additive migration 009 implement immutable owner plans, 3–12 disjoint windows, fixed thresholds, one plan/proposal, one active plan/bot, and a 100-plan lifetime cap. Registration rejects periods previously assigned/tested/registered anywhere, even cancelled records. It does not reserve or prioritise ordinary dispatch, so global blindness/contamination controls remain unfinished.

The evaluator department now calls experiment cycles between memory and lifecycle. It waits for all assigned, independently evaluated results occurring after registration, checks current proposal/memory/source support, computes a diagnostic aggregate and records supported-for-further-research or not-supported. No additional fitness, recruitment, money or trading authority follows. Owner cancellation preserves plans and consumed windows but does not cancel underlying research assignments/trials. Status rechecks support after historical results. Owner report adds historical experiment counters. CLI: `lifecycle:admin -- experiments`, `experiment <file>`, `cancel-experiment <file>`.

Four backend cases were written, not executed. Source review corrected the new test's budget lookup and explicitly typed status items. No build, migration, test, worker, model call, policy activation or dependency installation was run. User has not supplied a successful rebuild after the v0.1.7 fixture correction below. Next: owner verification, executable experiment specifications for genuinely new methods, evaluation isolation and statistical/novelty gates before evidence-based recruitment. Existing fixed skfolio methods do not implement arbitrary natural-language hypotheses.

### Previous increment: v0.1.7 and owner clarification

Earlier owner execution: `npm run build` failed with two TS2349 errors in dispatch/lifecycle tests because local setup overwrote the evidence factory with a record. Both setups now expose the factory as `createEvidence` and the two affected callers use it. Subsequent v0.1.8 read-route output is recorded above; no fresh test/build log was supplied. See `docs/verification.md`.

The owner explicitly clarified: reuse existing models and the supplied reference projects instead of training a foundation model from scratch. Customise the organisation's roles, memory, recruitment, retirement, management, knowledge graph and ongoing adaptation. The owner still has not supplied a model-serving endpoint/name; no provider is selected, installed or invoked by this increment. Do not interpret this as authority to choose paid services, activate inference or remove resource limits.

Read [learning-and-development.md](docs/learning-and-development.md). `learning.ts` and `learning-contract.ts` implement immutable factual reflection profiles/proposals/reviews, one per assigned evaluated trial, independent verification, and current-source/model/temporal filtering. This deterministic profile is a memory compiler, not a language model. `development.ts` implements a separate owner-selected existing-model profile, bounded 180-second inference requests, preflight, context-bound structured hypotheses and independent recommendation/rejection. A recommendation cannot create a bot, department or trading permission. New migrations are 007 and 008; both policies default off.

`integrations/hermes/adapter.py` and `runner.py` now support capability proposals using the actual pinned AIAgent; `development_worker.py` journals inference intent/output and refuses regeneration after an uncertain call. `scripts/department-runtime.mjs` is shared by the department launcher and new `run-organisation.mjs`, which directly supervises two role-scoped Python workers for an explicit finite session. Department workers now compile/review memory each cycle. skfolio receives a count of available memory but does not adapt its fixed fitting algorithm from prose. No foundation-model training or automatic strategy/code deployment has been added.

Five backend cases and three Python development cases were written, not executed. Modified Hermes paths and the supervisor require fresh verification; old Hermes passes do not establish this increment's correctness. No build, migration, test, worker, model call or policy activation was run. Next: review these increments, then implement controlled experiments and promotion of independently evaluated R&D hypotheses before autonomous recruitment. The model endpoint and initial real-world market/data provider remain outstanding configuration decisions.

### Previous increment: v0.1.6

Owner-only `GET /v1/organisation/report` and `npm run lifecycle:admin -- report` explain managed students' blockers, fresh dataset availability, pending work, allocation/admission capacity and unread notifications. `backend/src/organisation-report.ts` is read-only and explicitly reports worker liveness as unknown. `research-eligibility.ts` shares dataset selection with dispatch; portfolio submission now requires a non-empty current verified curriculum. Three new regression cases are written in `backend/test/dispatch.test.ts`, not run. No migration/dependency or policy activation was added. Read [organisation-report.md](docs/organisation-report.md) and review this increment alongside unverified lifecycle/dispatch work before expanding scope.

Original local project:

```text
C:\Users\KeerthanMuniRajaT\Documents\Codex\2026-10-03\i-x20\trading-organisation
```

The current project folder is the continuation source. Older source ZIPs do not contain the latest work. No destination GitHub repository was selected: the owner supplied a profile, `KeerthanMuniRaja`, rather than a repository. Do not assume the latest files are pushed, committed, or available through GitHub. Inspect current files and available Git status without discarding local changes.

For a new account, provide access to this folder and start a new chat with the prompt in [RESUME-PROMPT.md](RESUME-PROMPT.md). Do not rely on automatic conversation, memory, permission or connector transfer between accounts. The official [desktop documentation](https://learn.chatgpt.com/docs/app) describes opening a folder and using its files as context; it does not establish cross-account chat migration. This handover carries project context through ordinary files, not through account state.

## Owner instructions to preserve

- **Backend only** for the current development phase. Accepted stack: **NestJS + TypeScript core, Python research workers**. The original wording “rest.js” was clarified to NestJS.
- The latest owner instruction is **“if you needed access for execute you can takeover it and run it”**. Assistant development execution is authorised and supersedes the earlier user-only terminal/testing preference. Run necessary bounded checks and record actual results. This does not authorise paid inference, persistent automation activation or live financial operations.
- The earlier instruction deferred model choice; the latest clarification directs **reuse of existing models/frameworks**, not foundation-model training from scratch. A specific provider/model endpoint remains unset. Do not select a paid model, require API credits, or enable inference as a prerequisite for the default research department.
- Continue useful implementation without repeatedly asking to proceed. Ask only for genuinely missing decisions. Explain progress in simple language and distinguish the vision, source implementation and observed runtime behaviour.
- Keep financial authority with the owner. Do not activate live trading, connect a bank, spend funds, enable policies, change limits, or launch unattended sessions merely because the owner wants development to continue.
- The owner wants to understand and resume the same project, not a new chat's reinterpretation of the whole architecture. New owner instructions supersede this historical handover.

## The organisation we are building

The owner's idea is a private community of cooperating specialist bots. Bots are admitted for distinct opportunities, study shared lessons through school/college, develop and demonstrate skills, and work in departments. They share evidence and experience while making differentiated contributions. More copies are justified only by additional opportunity/capacity and different assignments, not renamed duplicate work.

Research and development should eventually run periodic hackathons, introduce new specialists, improve existing skills and propose new departments. Sustainable revenue and demonstrated value should support growth within owner budgets. Good performance earns reputation and, eventually, bounded responsibility/resources. Poor performance leads to investigation, improvement or retirement. Retiring bots transfer useful knowledge; preserve failures, provenance and accountable history instead of deleting all records.

The owner describes this as birth, education, livelihood, evolution and death in an organisation. These are software lifecycle concepts, not biological consciousness or guaranteed autonomous intelligence. Current birth creates a database identity and curriculum links; current school checks reviewed references rather than understanding. Current fitting optimises fixed portfolio methods, not a foundation model. Current retirement archives records; it does not delete all knowledge.

News, magazines, articles, business affairs and trusted market sources are central future inputs. Bots should compare historical and current scenarios, investigate large traders' observable behaviour and distinguish evidence from explanations of unknown motives. Trading hypotheses require independent validation. Stocks and on-chain DEX arbitrage were both mentioned; a first market, venue, time horizon and permitted provider have **not** been chosen.

An eventual incident “court” should gather evidence, compare accounts, identify causes and share reviewed corrections. Bounded self-repair and owner notification are requirements. No claim of zero failures, guaranteed profits, omniscient motives, universal automatic repairs or unlimited self-improvement is warranted. Fitness must respect each department's role; monitors must not be discarded simply because they do not directly produce revenue.

## Financial invariants

1. The amount originally illustrated as ₹100 was only an example. The owner manually contributes funds from SBI; 100% goes to Wallet 1 and Wallet 2 initially stays zero. No automatic bank top-up.
2. Only newly eligible **verified cumulative realised net profit**, after losses, fees and configured costs, is split: **60% retained in Wallet 1, 40% protected in Wallet 2**. No distribution of unrealised gains or repeated distribution of the same profit.
3. Trading/research bots cannot spend Wallet 2, withdraw to SBI, change 60/40, increase spending limits or modify their own permissions. A tightly scoped treasury service can credit Wallet 2 through the fixed allocation process; this is not arbitrary access to protected money.
4. The owner may transfer W1↔W2 and withdraw from either to SBI with strong transaction authorisation and ledger records. Contributions, generated profit, transfers and withdrawals remain distinct.
5. Current implementation: integer paise, double-entry journals, shared reservations, cumulative profit `P`, already allocated profit base `A`, newly eligible `max(0,P-A)`, exact five-paise distribution blocks and residual carry. Losses must be recovered above the already allocated base before further allocations. Owner deposits/transfers never reset this history.
6. All current balances, deposits, prices, orders, fills and bank references are **simulated**. `APP_MODE=live` is rejected. No broker, bank, DEX or custody connector is implemented. Managed lifecycle students have zero budget and cannot graduate to paper trading from example-data results.

Read [financial-model.md](docs/financial-model.md) and [security-and-operations.md](docs/security-and-operations.md) before changing any of these boundaries. Local signing in the demo is not production hardware-backed owner authentication.

## Read order and source of truth

| Read | Purpose |
| --- | --- |
| [README](README.md), [verification](docs/verification.md), [roadmap](docs/roadmap.md) | Current version, observed results, unfinished work. |
| [Architecture](docs/architecture.md), [API](docs/api.md) | Service and authority boundaries. |
| [Research lifecycle](docs/research-lifecycle.md) | Birth, curriculum, reputation, retirement and archives. |
| [Research dispatch](docs/research-dispatch.md) | Latest v0.1.5 queue, policies, workers and operating commands. |
| [Organisation report](docs/organisation-report.md) | v0.1.6 owner-only report, blocker meanings and snapshot limits. |
| [Learning and R&D](docs/learning-and-development.md) | v0.1.7 shared memory, actual Hermes proposal adapter, profiles, quotas and supervisor. |
| [Registered experiments](docs/development-experiments.md) | v0.1.8 fixed plans, complete-set aggregate diagnostics, worker integration and historical/current support distinction. |
| [Starter department](docs/organisation-starter.md) | v0.1.9 offline example export, explicit scoped import, recovery and separate activation proposals. |
| [Department monitoring](docs/department-monitoring.md) | v0.1.10 supervisor leases/heartbeats, cooperative scope, status and unexecuted verification. |
| [Portfolio backend](docs/portfolio-backend.md), [academy](docs/portfolio-academy.md) | Training/evaluation separation and pinned actual skfolio usage. |
| [Reference map](docs/reference-map.md), [Hermes](docs/hermes-integration.md), [Ruflo](docs/ruflo-integration.md) | Exactly what upstream reuse does and does not implement. |
| [Knowledge-base index](docs/knowledge-base/README.md) | Preserved brainstorming; follow its vision, graph, bot lifecycle and financial links. |

The knowledge base is a historical v0.3 design snapshot. Current source and implementation documents take precedence for actual behaviour; requirements in this handover preserve the owner's intent. If documents disagree, inspect implementation and report the discrepancy. Do not silently reinterpret aspirations as completed work.

## Verification checkpoint

| Increment | Evidence at handover |
| --- | --- |
| Foundation / v0.1.1 | Earlier record: 28 backend, 10 deterministic Python, 14 Hermes contract and 19 Ruflo tests passed. These are historical results, not a current whole-repository pass. |
| Ruflo actual integration | Owner-host run passed 4 October 2026 at 06:59:54 IST: bounded MCP task creation/completion, restart recovery, notifications and denied financial access. Broader swarm features were not validated. |
| v0.1.2 skfolio academy | Actual skfolio exercise completed 108/108 trials, zero failed attempts in the final plan. Rerun added zero attempts. Nine lab tests and isolated-environment dependency check passed. |
| v0.1.3 portfolio backend | Owner supplied successful `npm run build` and API startup output on 4 October 2026. Full new portfolio tests and Python-to-backend workflow were not run. |
| v0.1.4 lifecycle | Source, migration 005, worker, admin commands and seven regression cases written. Build/migration/tests/runtime not confirmed. |
| v0.1.5 research dispatch | Source, migration 006, finite department workers, four dispatch regression cases and one additional bridge recovery case written. Lifecycle fixtures updated to use assignments. Nothing in this increment has been built or run. |
| v0.1.6 owner report | Report service/route/CLI, shared dataset eligibility, empty-curriculum submission rejection and three report regression cases written. No compilation or execution. |
| v0.1.7 learning and R&D | Additive migrations 007/008, memory loop, Hermes extension, bounded R&D workflow, supervisor, five backend cases and three Python cases written. No compilation, execution, provider calls or policy activation. |
| v0.1.7 owner build attempt | Two TS2349 test-fixture errors supplied by owner; fixed by preserving the factory as `createEvidence`. Successful rebuild pending. |
| v0.1.8 registered experiments | Additive migration 009, plan/assessment/cancellation/status service and routes, evaluator integration, report/CLI, and four regression cases written. No build or execution. |
| v0.1.8 owner read responses | Experiment list and report respond, including experiment counters, on an empty disabled community. Does not verify mutations, fitting or tests. |
| v0.1.9 starter department | Python exporter, Node plan/import CLI, proposed activation files and four Node cases written; unexecuted. No migration/dependency added. |
| v0.1.10 supervisor monitoring | Migration 010, session API/report/CLI, lease-aware supervisors, four backend/four Node cases written; build and execution pending. |

No lifecycle, dispatch, learning or R&D policy has been enabled by the assistant. Latest evidence is the owner's v0.1.8 experiment/report responses described above. Current ongoing server/worker health cannot be inferred from that past snapshot or an open browser tab. Ask for fresh output only if needed.

## Implementation map

| Location | Responsibility / critical detail |
| --- | --- |
| `backend/src/app.ts`, `config.ts`, `security.ts`, `core.ts` | Nest routes, strict schemas, default-deny roles, owner signing, idempotency inputs and validation. |
| `backend/src/database.ts`, `db/migrations/001…010` | PGlite locally or optional PostgreSQL; migration checksums; serialised commands via system lock; transactional command receipts and audit/notification records. Do not edit existing migrations or open nested database transactions inside command callbacks. |
| `backend/src/treasury.ts`, `paper.ts` | Ledger/allocation, permissions, reservations, fresh quotes, simulated orders/fills and limits. Managed students are excluded from execution. |
| `backend/src/organisation.ts`, `operations.ts` | Sources, evidence review/revocation, lessons, school, incidents, halt/resume, notifications and audit integrity. |
| `backend/src/research.ts`, `services/research/worker.py` | Original bounded momentum experiment jobs; separate researcher/evaluator identities. Managed students cannot use this route to obtain trading qualification. |
| `backend/src/portfolio.ts` | Example datasets, training-only researcher responses, weight constraints, backend-computed held-out scores, independent review and cancellation. Managed submissions now require a current assignment lease. |
| `backend/src/lifecycle.ts`, `lifecycle-history.ts` | Owner-approved capability blueprints, admission caps, curriculum, disjoint assessment windows, policy-versioned reputation/streaks, mentor designation and archival. |
| `backend/src/dispatch.ts`, `dispatch-state.ts` | Owner-approved dataset pool, assignment budgets, fairness, no overlapping holdout reuse, leases, reconciliation, withdrawal/cancellation and status. |
| `backend/src/learning.ts`, `learning-contract.ts`, `development.ts` | Independently reviewed factual memory, temporal/source filtering, existing-model request budgets, structured hypotheses and review without automatic recruitment. |
| `backend/src/development-experiments.ts` | Owner-fixed R&D diagnostics, historical period exclusion, complete result aggregation, independent evaluator, support withdrawal and cancellation without rewriting history. |
| `integrations/hermes/development_worker.py`, `scripts/run-development.mjs` | One-shot Hermes R&D with scoped credentials and local inference recovery journal; requires an owner-configured model endpoint. |
| `scripts/department-runtime.mjs`, `run-organisation.mjs` | Shared finite runtime and direct supervision of researcher/evaluator processes. Does not launch model inference or enable policies. |
| `backend/src/department-sessions.ts`, `scripts/department-session.mjs` | Authenticated current-role sessions, ordered heartbeats, expiry/replacement, read-only freshness and stop-on-session-loss client. No background stale-alert scheduler. |
| `scripts/organisation-starter.mjs`, `integrations/skfolio/prepare_organisation.py` | Explicit offline preparation and operator-directed setup. API roles stay distinct, parent holds setup credentials, policies remain disabled, generated files live under ignored `.local/organisation-starter`. |
| `integrations/skfolio/lab.py` | Actual offline skfolio academy; completed journal is separate from the backend. Changing lab code/config/data changes its plan identity. Do not rerun completed exercises just to simulate progress. |
| `integrations/skfolio/bridge.py`, `department.py` | Persisted fit intent, idempotent submission, lease-bound recovery; researcher fits and evaluator asks backend to score, then advances lifecycle/dispatch. |
| `scripts/run-department.mjs` | One role credential per child, one cycle or 0–360-minute session, 110-second cycle timeout, finite retries. Local launcher is not an OS sandbox. |
| `scripts/lifecycle-admin.mjs`, `run-lifecycle.mjs` | Owner policy/status CLI and standalone lifecycle cycle worker. Department evaluator already advances lifecycle; running both is unnecessary. |
| `backend/test/`, `integrations/skfolio/test_bridge.py` | Regression cases including recent unexecuted ones. Written coverage is not a test result. |

### Lifecycle and dispatch details

Lifecycle defaults: disabled; four active students, two births per rolling 24 hours, twenty lifetime; at most one birth/cycle. Distinctness currently checks declared department/specialty/method keys, not semantic novelty. Verified curriculum leads school→college. At least three non-overlapping evaluated windows form a review; three consecutive positive/negative reviews lead to mentor designation/retirement request under defaults. Rewards are example portfolio diagnostics relative to equal weight, not cash or proof of skill. Invalidated evidence breaks streaks; no-data waits without a penalty. Policy changes reset the current fitness basis but never make old assessment periods reusable.

Dispatch defaults: disabled; twelve assignments per rolling 24 hours, one hundred lifetime; both lifecycle and dispatch must be enabled. Owner can approve up to one hundred example dataset IDs, with hard assignment ceilings of one hundred/day and one thousand lifetime. Each managed college student has at most one queued/running assignment or submitted trial. Previous assignment/trial holdout periods are excluded even after failure/cancellation. Counters include failed/cancelled work and are not reset by policy revisions.

Claims carry a two-minute lease, principal identity and random token. Three expired attempts mark a job failed without subtracting skill reputation. Submission and queue completion are atomic. A reclaimed assignment reuses saved fit weights with a new lease receipt. Global halt/disabled policy blocks new assignment, claim and submission; previously submitted evaluations may drain. Retirement cancels queued/running work, waits for outstanding submitted trials and preserves assignment/lesson/trial/review history. Reconciliation requires a running caller; the stopped application has no autonomous timer service.

## Reference repositories and independence

All ten references remain part of the design knowledge. [Reference map](docs/reference-map.md) contains their source URLs and specific roles:

- Qanat: experiment accounting and staged research inspiration.
- Awesome Systematic Trading: discovery catalogue, not a runtime engine.
- Kronos: possible future numerical forecasting; no installed weights or training pipeline.
- Freqtrade: strategy evaluation/dry-run patterns; no Freqtrade runtime enabled.
- NautilusTrader: data/risk/execution boundaries; future engine candidate.
- skfolio: actual pinned 1.4.11 optimisation library and example academy.
- Hummingbot: connector/order/arbitrage patterns; no DEX scanner or venue integration yet.
- Vibe-Trading: research roles, skills and reporting inspiration; no bundled application runtime.
- Hermes Agent: bounded real `AIAgent` adapter, contract tested; selected-model inference deferred.
- Ruflo: pinned local MCP mirror for selected research task operations, owner-host integration verified; not the authority over funds or lifecycle.

The owner accepts open-source reuse. Their independence requirement is that a retained deployment should not stop merely because an upstream GitHub repository disappears. It does not mean zero dependencies. Preserve version pins, licences, dependency records and retained artifacts; model/data/venue APIs and maintenance remain external dependencies if adopted. Do not claim all ten projects are installed or fully integrated.

## Environment and files to preserve

- Windows / PowerShell. Previously observed Node 24.21.0 and npm 11.19.0; verify environment if execution is later authorised. Root dependencies are pinned in `package-lock.json`.
- The actual skfolio environment is `integrations/skfolio/.venv/Scripts/python.exe`, previously Python 3.12.14 with a pinned 20-package lock. Its offline wheel cache was under `.local/skfolio-wheels`. See the academy installation guide rather than upgrading packages opportunistically.
- Preserve `.env`, `.local/credentials.json`, `.local/owner-signing-key.pem`, `.data/paper` and integration `.state` directories locally. These are ignored private/runtime files. **Do not paste their contents, commit credentials, or include them in a shareable KT/source ZIP.** A normal Git clone will not recreate them or the experiment history.
- Same-machine continuation can use the existing owner-controlled directory. For another machine, move source separately and provision/restore private configuration and a consistent database backup through an owner-controlled process. Do not copy a database while it is actively being written. Do not run `dev:setup` over an existing configured checkout or silently replace identity/history.
- Earlier assistant execution restrictions prevented Git/native OS-profile operations and Node `os.userInfo()` resolution. Ruflo worked in the owner's normal terminal. These are environment-specific observations, not proof that the repository is broken. Do not disable upstream safeguards or fabricate an OS identity to bypass them.
- No active assistant-created automation or ongoing training session is established by this handover. No new credentials, remote repository, deployment, model choice or bank connection was created for account switching.

## First review and continuation steps

1. Read the files in the read order and inspect current source. Preserve owner edits. Use the latest dated verification evidence when reviewing mutation/worker paths; do not treat successful read routes as a full integration result.
2. Review migration compatibility, API authorisation, lease/idempotency recovery, pause/halt/revocation handling, one-outstanding-job guarantees, assessment period reuse, retirement draining and preservation. These are review targets, not asserted defects. Report concrete findings and fix ordinary code issues within the owner's development request.
3. Run appropriate development checks directly under the latest execution authorisation. Preserve private runtime state and record results precisely in `docs/verification.md`; isolated checks do not prove persistent deployment or model inference.
4. Once the foundation is reviewed, help configure an explicit example curriculum, distinct blueprints and approved research dataset pool. Starting a worker alone does not create these approvals. Full organisation autonomy and real-market ingestion are still future stages.
5. For real inputs, obtain the first market/asset class, horizon and provider/licensing decision. Stock trading and DEX arbitrage require different connectors. Reuse of existing models is decided; the specific model and serving endpoint remain unset. Useful next backend work includes provenance-aware ingestion contracts and measured skill assessments, without inventing credentials or activating data subscriptions.
6. Keep [roadmap](docs/roadmap.md), [verification](docs/verification.md), this KT and the resume prompt current after substantive changes. Record what changed, what was observed, unresolved decisions and the next concrete step.

There is no approval to rebuild the whole stack, invent a model choice, turn on live trading, or claim profitable self-improvement. The next assistant should continue implementing the owner's institution in reviewable increments.

## Last terminal commands given to the owner

The build has now passed and offline preparation has completed. A persistent server still needs the updated build and migration 010 before department launchers. Coordinate any restart with an existing owner process rather than killing it automatically. The earlier preparation command is retained for reference:

```powershell
npm run organisation:prepare
```

The generated review now exists and contains an exact hash-bound apply command. Import, activation and worker commands have not been run against the persistent backend. They are in [starter department](docs/organisation-starter.md). Backend rebuild/status commands are retained below for reference.

From the project folder, after stopping their existing server with Ctrl+C:

```powershell
npm run build
if ($LASTEXITCODE -eq 0) { npm start }
```

In a second terminal:

```powershell
npm run lifecycle:admin -- dispatch
npm run lifecycle:admin -- report
npm run lifecycle:admin -- learning
npm run lifecycle:admin -- development
npm run lifecycle:admin -- experiments
npm run lifecycle:admin -- workers
```

No result from these latest commands has been received at handover. Worker and policy commands are in [research-dispatch.md](docs/research-dispatch.md); they require explicit owner configuration. Do not run them as part of reading this document.

<!-- documentation-navigation -->
[Documentation index](docs/documentation-index.md) · Documentation reconciled for v0.1.32 on 7 October 2026; historical records retain their original scope.
