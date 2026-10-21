# Research note: TradingAgents and FinnewsHunter (source-code study)

Date of study: 2026-10-21. Method: read-only web fetches of github.com tree pages and raw.githubusercontent.com files.
Nothing was cloned, downloaded or installed. No code is reproduced here: mechanisms are described in our own words,
with file paths and identifiers so a reader can find the original.

How confident to be in this note: every file was read through a fetch tool that returns a model-written digest of the
page, not the raw bytes. Load-bearing details were re-checked with targeted questions (for example the benchmark map
and the rating parser). Where this note says "verified in code", it means the digest of that file described it. Where it
says "README claim", the code was not checked. Section 6 of each part lists what was not read.

---

## Part A. TradingAgents (TauricResearch/TradingAgents)

### A1. What it is

- A LangGraph multi-agent "trading firm": analysts, a bull/bear research debate, a research manager, a trader, a
  three-way risk debate and a portfolio manager who issues a five-tier rating (Buy, Overweight, Hold, Underweight, Sell).
- License: Apache-2.0 (LICENSE file and repository sidebar).
- Studied: branch `main` at commit `e8f5503` (merge of v0.7.0, 2026-10-16). This is the same commit that
  `integrations/tradingagents/requirements.txt` pins for our TA-01 member, so everything below describes the code we run.

### A2. Architecture and flow (files read)

| File | Role |
|---|---|
| `tradingagents/graph/trading_graph.py` | `TradingAgentsGraph`: config, two model tiers (quick and deep), memory log, reflector, checkpointing, `propagate()`, state logging, settlement entry points |
| `tradingagents/graph/setup.py` | `GraphSetup.setup_graph`: builds the node/edge layout |
| `tradingagents/graph/conditional_logic.py` | Routing and termination of both debates |
| `tradingagents/graph/analyst_execution.py` | Registry of analyst specs (key, node name, report key, tools) and `build_analyst_execution_plan` |
| `tradingagents/agents/state.py` | `AgentState`, `InvestDebateState`, `RiskDebateState` |
| `tradingagents/agents/analysts/news_analyst.py`, `market_analyst.py`, `sentiment_analyst.py`, `turn.py` | Analysts and the single-turn tool loop |
| `tradingagents/agents/researchers/bull_researcher.py` | Bull side of the research debate (bear is the mirror image; not read) |
| `tradingagents/agents/managers/research_manager.py`, `portfolio_manager.py` | Judges |
| `tradingagents/agents/trader/trader.py` | Trader proposal |
| `tradingagents/agents/risk_mgmt/conservative_debator.py` | One of three risk debaters (aggressive and neutral not read) |
| `tradingagents/agents/context.py` | Shared prompt context: instrument identity, placeholders, portfolio context, language |
| `tradingagents/agents/rating.py` | Rating extraction from text, the `REVIEW` sentinel |
| `tradingagents/agents/structured.py`, `schemas.py` | Structured output binding with free-text fallback; Pydantic schemas |
| `tradingagents/agents/tools.py` | The 12 data tools and how the run date is injected |
| `tradingagents/agents/post_screen.py` | Optional third-party relevance/stance screen of social posts |
| `tradingagents/dataflows/router.py`, `date_window.py` | Vendor fallback chain and point-in-time clamping |
| `tradingagents/memory/log.py`, `reflection.py`, `settlement.py` | Decision log, reflection, outcome settlement |
| `tradingagents/backtest.py`, `portfolio.py`, `default_config.py`, `CHANGELOG.md` | Backtest grid, portfolio input, defaults, release history |
| `tradingagents/llm_clients/openai_client.py`, `capabilities.py` | Local OpenAI-compatible client and per-model structured-output capabilities |

Control flow (verified in `setup.py` and `conditional_logic.py`):

1. START fans out to every selected analyst in parallel, plus a "Memory Log" node. Each analyst is its own compiled
   subgraph with a private message history, and it writes only its own report key, so parallel branches never collide.
2. All branches join at Bull Researcher. Bull and Bear alternate; the router ends the debate when the turn count reaches
   two times `max_debate_rounds`. The next speaker is chosen by the prefix of the last response ("Bull..." means Bear next).
3. Research Manager judges and writes `investment_plan`, then the Trader writes `trader_investment_plan`.
4. Risk debate: Aggressive, then Conservative, then Neutral, repeating until the count reaches three times
   `max_risk_discuss_rounds`.
5. Portfolio Manager reads the plans, the risk debate and the memory lessons, writes `final_trade_decision` and
   `final_rating`, and the graph ends.
6. After the run, `record_decision` writes a full JSON state log and appends a pending entry to the memory log.

Model tiers: `quick_think_llm` serves analysts, researchers, debaters and trader; `deep_think_llm` serves the two
managers (`default_config.py`). Our `ta_decide.py` sets both to the same local model.

### A3. Key mechanisms, as implemented

**Analyst tool loop (`setup.py`, `turn.py`).** Inside each analyst subgraph: the agent node calls tools while its reply
contains tool calls; after `max_tool_rounds` tool rounds a `wrap_up` node appends a fixed "your tool budget is spent"
human message and re-invokes the model with no tools bound, asking it to write the report from what it has and to say
which data it could not get. For that last turn the history is flattened to plain text (tool calls become
"[Called name(args)]" lines) because some providers reject tool-call history when no tools are bound. The constructor
refuses a graph whose recursion limit is below two times the tool rounds plus two.

**Point-in-time protection (`tools.py`, `date_window.py`).** The run date is injected into every dated tool from graph
state, so the model cannot pass it. A requested date after the run date is pulled back to the run date; a window wholly
in the future is shifted back so it ends on the run date. Dated items outside the window are dropped; undated items are
kept only when the window reaches the present, so historical runs never see undated material. A window the feed could
not observe is reported as "unavailable", not as "empty", so the model does not read missing coverage as "no news".
Data that has no historical version is withheld from past-dated runs with a notice: company profiles, insider trades
dated by trade rather than filing, and statements dated by period rather than publication (SEC EDGAR, dated by filing,
is served as filed).

**Vendor routing (`router.py`).** Methods are grouped into categories; each category has a configured ordered vendor list
that is the whole fallback chain (it never silently adds a vendor the user did not choose). Results distinguish two
sentinels: `DATA_UNAVAILABLE` (the vendors failed) and `NO_DATA_AVAILABLE` (the vendors answered "no data", with an
instruction not to invent values). Optional categories (macro, prediction markets) degrade to a sentinel; core
categories raise.

**Anti-hallucination context (`context.py`).** At run start the ticker is resolved to a name, sector, industry and
exchange, and the agents are told not to substitute another company unless a tool result disproves the identity (for
past dates only the name is given, because sector and exchange may have changed). A missing analyst report is replaced
by an explicit "this report is unavailable" marker, not an empty string. When the opposing debater has not spoken yet,
the agent gets a marker telling it to open its own case instead of rebutting an invented one. When no portfolio is
supplied, the agents are told holdings are unknown and not to assume a flat book.

**Verified market snapshot (`market_analyst.py`, `tools.py`).** The market analyst must call
`get_verified_market_snapshot` before writing; the prompt makes it the source of truth for exact prices and indicator
values and says to flag a conflict with other tool output rather than reconcile it. It also forbids claims of support
bounces or exact moves that tool output does not show with dates and prices.

**Debate content (`bull_researcher.py`, `conservative_debator.py`).** Each debater sees all four analyst reports, the
full transcript and the opponent's latest turn, answers once, and its text is prefixed with its role name; the counter
increments. Debaters are free text (no schema). Risk debaters additionally see the trader's plan and the portfolio
context, and each is told to rebut the other two.

**Judges and structured output (`research_manager.py`, `portfolio_manager.py`, `structured.py`, `schemas.py`).**
Managers and the trader bind a Pydantic schema (`ResearchPlan`, `TraderProposal`, `PortfolioDecision`). If the provider
cannot bind, or the structured call returns nothing or fails, the code logs a warning and makes one plain free-text call
instead (no retry loop). Both judges are explicitly told that conflict between debaters is not a reason to choose Hold:
pick the stronger side, size by how decisively it wins, and use Hold only when the evidence is balanced or too thin.
For the Portfolio Manager, the typed `rating` field is the decision; the rendered text only carries it, so a rating
quoted inside the thesis cannot override it. Price fields in `TraderProposal` and `PortfolioDecision` have validators
that turn percentages, ranges and placeholders into null and parse formatted numbers.

**Rating parsing and the REVIEW sentinel (`rating.py`).** For free-text decisions, only a labelled rating line counts
("Rating: X" with decision-owned qualifiers such as "final" or "our"; "consensus rating" does not), legend lines that
echo the scale are skipped, all collected labels must agree, and anything else returns nothing. Callers turn "nothing"
into `REVIEW`, never into Hold, because an unreadable decision recorded as Hold could later be quoted as a call that was
never made (the code cites issue #1170).

**Memory log (`memory/log.py`).** One append-only Markdown file; entries separated by an HTML comment marker. A pending
entry holds date, ticker, rating and decision text; settlement rewrites its tag with raw return, alpha, holding days and
resolution date and appends a reflection. Storing is idempotent per (date, ticker). Retrieval for a run returns up to 5
settled same-ticker entries in full and up to 3 other-ticker entries in short form, newest first. For historical runs it
keeps only entries resolved on or before the run date (issue #1251), so backtests cannot learn from outcomes that had
not happened yet. Optional rotation drops the oldest resolved entries (pending ones are never dropped). Writes are
file-locked; outcome updates use write-temp-then-replace. Only the Portfolio Manager reads the lessons.

**Settlement (`memory/settlement.py`).** A decision dated d is entered at the first close after d (v0.7.0 changed this
because a run dated d reads news published after d's close) and exited `holding_period_days` sessions later (default
5). Alpha is raw return minus the benchmark over the same dates; the benchmark is picked by exchange suffix
(`.NS` maps to `^NSEI`, verified in `default_config.py`). Missing bars keep a decision pending; a price or reflection
failure is recorded and retried next run. A separate lock file allows one settlement pass at a time so two runs do not
pay for the same reflection twice; each outcome is written as soon as it is ready, so an interrupted pass keeps its work.
Settlement runs inside the graph (the Memory Log node) for every ticker with due entries, and a failure becomes a note in
state instead of stopping the run.

**Reflection (`memory/reflection.py`).** The quick model gets the decision text, raw return and alpha, and is asked for
2 to 4 plain sentences: what the alpha says about the call, which part of the thesis the window supports or undercuts
(with an explicit warning that a short window may not disprove a longer-horizon thesis), and one concrete lesson. The
output is not validated: length, format and whether it cites the figure are enforced only by the prompt, and the text
is stored verbatim and later re-read by the Portfolio Manager.

**Backtest (`backtest.py`).** Runs the full graph over a (ticker x date) grid at a fixed step, sequentially, writing to
its own memory log under `results_dir/backtest/<run_id>/` so the live log is untouched. Resumable by run id. It
deliberately has no execution model: ratings map to a direction (+1, 0, -1) and `summarize` reports per rating the
count, hit rate (sign of alpha matches direction; none for Hold) and mean alpha, plus resolved, pending and "unscored"
(REVIEW) counts. No significance test; the output itself says figures are indicative because each cell is one model
sample and text feeds are not archived.

**Portfolio input (`portfolio.py`).** An optional book (positions with signed quantity and average price, cash,
currency) rendered as text for the trader, risk team and portfolio manager. Its fingerprint is part of the checkpoint
signature, so a changed book never resumes a stale run.

**Checkpoint resume (`trading_graph.py`).** Optional SQLite checkpointer per ticker. The run signature hashes analysts,
round counts, asset type, portfolio fingerprint and config (minus paths and retry settings), so a changed setting starts
fresh instead of resuming old reports. The checkpoint is cleared on success.

**Sentiment analyst (`sentiment_analyst.py`, `post_screen.py`).** Fetches Yahoo headlines, StockTwits and Reddit for 7
days before calling the model (no tools). Optionally a third-party classifier drops posts that are clearly off-topic
(keeps them when unsure) and counts stances. Schema `SentimentReport` distinguishes "Mixed" (sources conflict) from
"Neutral" (sources silent) and asks for lower confidence when data is thin. The code itself notes these feeds are not
point-in-time for backtests.

### A4. Research ideas worth knowing

1. **Separate "unavailable" from "empty" everywhere** (`dataflows/router.py`, `dataflows/date_window.py`,
   `agents/context.py`): two sentinels for vendor failure vs no data, coverage-gap detection, explicit placeholders for
   missing reports and for an opponent who has not spoken.
2. **Run date injected, never supplied by the model** (`agents/tools.py`): the model cannot widen its own window.
3. **Withhold what has no point-in-time version** (`dataflows/date_window.py`): profiles, insider trades and undated
   statements are refused for past runs rather than served with today's values.
4. **Typed decision wins over rendered text; unreadable means REVIEW, not Hold** (`agents/rating.py`,
   `agents/managers/portfolio_manager.py`).
5. **Point-in-time memory** (`memory/log.py`): lessons are filtered by the date their outcome became known.
6. **Single-flight settlement with incremental writes** (`memory/settlement.py`, `memory/log.py`).
7. **Instrument identity anchoring** (`agents/context.py`), with a reduced form for historical dates.
8. **Tool-budget wrap-up turn** (`graph/setup.py`, `agents/analysts/turn.py`).
9. **Anti-Hold instruction for judges** (`research_manager.py`, `portfolio_manager.py`, `schemas.py`): a deliberate bias
   toward committing. Useful to know because it raises trade count.
10. **Decision-quality backtest separate from execution** (`backtest.py`): hit rate and mean alpha per rating, in an
    isolated log.
11. **Entry at the first close after the decision date** (`memory/settlement.py`, v0.7.0 changelog): because the run
    reads news published after that day's close.

### A5. Comparison with our system

**What we already do equivalently (or more strictly)**

- REVIEW instead of Hold: `ta_decide.rating_of` returns None unless exactly one rating appears, and `ta_bot.py` proposes
  nothing for None or HOLD. Our model agents use schema-constrained JSON (`debate.py` `schema()`), the same idea as the
  typed rating.
- Entry timing: our execution is at the next verified open after review, which is at least as strict as TA's
  "first close after d".
- Outcome scoring: our backend scores every call against cash with a 30 bps cost bar (`backend/src/trade-signals.ts`,
  `COST_BPS`), and our reflections (`reflections.py`) compute alpha against the equal-weight basket. TA has hit rate and
  mean alpha but no significance test; we have the sign test in fitness and Bonferroni in R&D (`rnd_ideas.py`), plus
  lookahead, warm-up, random-baseline and walk-forward checks (`research_checks.py`). On statistics we are ahead.
- Reflections: ours are deterministic text from the record, rebuilt independently by the evaluator and verified only on
  an exact match (`reflections.py`). TA's are unvalidated model prose. Ours are safer.
- Idempotent writes, atomic replace, resumable runs: present in `ta_decide.py` and throughout the backend.
- Release identity: our `ta_bot.identity` hashes engine version, model, settings and code, similar in spirit to TA's
  checkpoint run signature.
- Verified prices as the source of truth: our debaters get steward-checked closes (`debate.py` `context()`), like TA's
  verified snapshot.

**Gaps in our system**

1. **The TA member's own memory is outside our governance.** `ta_decide.default_graph` sets `memory_log_path` to
   `.local/tradingagents/memory.md`, so TradingAgents settles its own past decisions and asks our local 4B model to write
   reflections that are injected into the Portfolio Manager on later runs. Those reflections are unvalidated, and the
   memory file is not part of `config_version()` or `ta_bot.identity()`. So the member's behaviour can drift during its
   20-call shadow period, and after release, without its release identity changing. It also contradicts our rule that
   lessons need verified evidence.
2. **Our debate has no rebuttal.** In `debate.py` the bear and bull each see only the proposal and context, never each
   other. TA (and FinnewsHunter's debate mode) let the second speaker answer the first.
3. **Debaters do not see the proposing bot's own past calls on that share.** `live_knowledge.briefing()` gives today's
   regime and fixed method lessons. The per-bot reflections we already verify (`reflections.py`) are not fed back to any
   model prompt. TA's "5 same-ticker plus 3 cross-ticker settled lessons" is the bounded pattern for this.
4. **No point-in-time filter on headlines in the debate context.** `debate.context()` takes the last 10 verified
   headlines for the share with no `publishedAt <= proposal time` check. Harmless live, but any replay or backtest of
   the debate would leak later news. The same applies to lessons if debates are ever replayed (TA's `as_of` filter).
5. **No explicit "no news" vs "news unavailable" distinction** in what our model agents receive. An empty
   `verifiedNews` list can mean the feeds were down or that nothing happened.
6. **No instrument identity line for the model.** Debaters get `symbol` only (for example `ITC`). A 4B model benefits from
   "ITC Ltd, FMCG/cigarettes/hotels, NSE". We already keep names and aliases in `integrations/claims/claims.py`
   (`COMPANIES`).
7. **Small consistency risk in `ta_decide.decide`.** A day's decisions file keeps the `configVersion` of its first write;
   if `SETTINGS` change and the same day is resumed, new decisions are made under new settings but recorded under the old
   version.
8. **Two scorings of the same member.** TA's internal memory scores decisions over 5 sessions from the first close
   against `^NSEI`; our backend scores the same calls over a 7-day horizon from the next open against cash, and
   reflections use the equal-weight basket. Not wrong, but the member's internal lessons and its official record can
   disagree.

**Ideas we could adopt (our own design)**

| Idea | Why | Expected benefit | Effort |
|---|---|---|---|
| Govern the TA member's memory: either set `memory_log_path` off during shadow evaluation, or include a hash of the memory file in each decision record and in the release identity | A member must not change behaviour without a visible identity change | Shadow record measures a fixed member; drift becomes auditable | Small (a few lines in `ta_decide.py` and `ta_bot.identity`) |
| Sequential debate: bear speaks first, bull sees the bear's argument (with an explicit "no opposing argument yet" marker for the opener) | Rebuttal is the point of a debate | Better arguments for the same number of model calls (still 2 per proposal) | Small (`debate.py`) |
| Bounded "own track record on this share" block for debaters: the last few verified reflections for this bot and share, plus a short cross-share block | Use the verified lessons we already produce | Debaters can say "this bot's last three longs on X lost" from verified facts | Small to medium (read lessons via API, filter, cap length) |
| Point-in-time guard on every model context: only items with `publishedAt` before the decision time, and only lessons resolved before it | Makes any future replay of model agents honest | Prevents silent lookahead if we ever backtest the debate or panel | Small |
| Coverage flag in contexts: "feeds healthy, no headlines" vs "feeds unavailable" | The 4B model cannot tell silence from an outage | Fewer confident arguments built on a data gap | Small (feed health already exists in `world-news.mjs coverage`) |
| Identity line per share from the existing `COMPANIES` table | Anchors a small model to the right company | Fewer wrong-company arguments | Very small |
| Count TA's structured-output misses (its "retrying once as free text" warnings) per run in `ta_decide.py`'s record | With the default capability profile and no forced `tool_choice`, a 4B model may skip the schema tool, doubling judge calls | Shows whether the member is paying for two calls per judge on CPU, and whether a capability override is worth testing | Small |
| Record the TA member's REVIEW rate and per-rating hit rate in its fitness view | TA's backtest summary shows unscored counts separately | Shows whether the 4B model is producing parseable decisions at all | Small |

**Ideas not worth adopting**

- **A model-based risk debate (aggressive, conservative, neutral) with authority.** Our deterministic `signal-risk-v2`
  review is the correct place for risk; a 4B model on CPU would add three slow calls per proposal with no verifiable
  gain. At most it could run in shadow like the scenario panel.
- **Model-written reflections.** Our deterministic, independently rebuilt reflections are stricter.
- **The anti-Hold judge instruction for our own agents.** It raises trade count; with a 30 bps cost bar and tax drag,
  inaction is often the right answer. Keep it only where TA uses it, and let fitness judge.
- **LangGraph and SQLite checkpointing in our desk.** Our runs are short, file-resumable and audited; adding the framework
  would add dependencies without a clear benefit.
- **Social sentiment (StockTwits, Reddit) and prediction markets.** US-centric, not point-in-time, and not approved sources
  for us.

### A6. What could not be verified (TradingAgents)

- Vendor modules (`dataflows/vendors/*`), including how the verified snapshot is built and whether every vendor honours
  the clamped dates.
- How llama.cpp actually behaves with TA's structured calls. Verified in `llm_clients/openai_client.py` and
  `llm_clients/capabilities.py`: the `openai_compatible` provider uses `LocalCompatibleChatOpenAI`; an unknown model id
  (ours) gets the default capability profile, whose preferred structured method is `function_calling`; for this
  provider `tool_choice` is deliberately not sent (many local servers reject it). So the schema is offered as a tool but
  the model is not forced to call it. Not verified: whether our 4B model calls it reliably. When it answers in plain
  text instead, `structured.py` treats that as a miss and makes a second, free-text call, and the rating then comes from
  `rating.py`. That costs an extra slow call per judge and may produce `REVIEW`. No `<think>` stripping is done for
  local reasoning models. Our run logs (TA's warnings "retrying once as free text") would show how often this happens.
- `graph/checkpointer.py`, `graph/propagation.py`, `agents/schemas.py` render functions, bear researcher, aggressive and
  neutral debaters, fundamentals analyst, CLI, `report_html.py`, `reporting.py` (not read; assumed symmetric where noted).
- README claims not checked in code: Docker/enterprise setup, the CLI experience, the HTML report format.

---

## Part B. FinnewsHunter (DemonDamon/FinnewsHunter)

### B1. What it is

- A Chinese A-share financial news platform: crawlers for 10 Chinese finance sites, LLM news analysis, a bull/bear/manager
  debate per stock, a knowledge-graph keyword builder, and an "alpha mining" module that generates factor formulas.
  Built on the AgenticX framework, FastAPI, Celery, PostgreSQL, Redis and Milvus, with a React frontend.
- License: Apache-2.0 per the LICENSE file and sidebar. The README's license section says it "follows the AgenticX
  license" without naming one, and the alpha-mining README credits AlphaGPT without stating that project's license.
  Treat it as Apache-2.0 for the main code, with those two caveats.
- Studied: branch `main` at commit `eb13a7f` (2026-07-05). The `legacy_v1` folder (the original version) was also read.

### B2. Architecture and flow (files read)

| File | Role |
|---|---|
| `backend/app/core/celery_app.py` | Beat schedule: one real-time crawl task per source every minute |
| `backend/app/tasks/crawl_tasks.py` | Real-time, cold-start, targeted-stock crawls and knowledge-graph build |
| `backend/app/tools/crawler_base.py`, `sina_crawler.py`, `text_cleaner.py` | Fetching, content extraction, Chinese text cleaning |
| `backend/app/services/analysis_service.py`, `embedding_service.py`, `llm_service.py` | News analysis persistence, embeddings, model access |
| `backend/app/agents/news_analyst.py` | Per-article sentiment analysis |
| `backend/app/agents/orchestrator.py`, `debate_agents.py`, `search_analyst.py`, `data_collector_v2.py` | Debate modes and in-debate data requests |
| `backend/app/config/debate_modes.yaml` | Mode definitions and limits |
| `backend/app/knowledge/knowledge_extractor.py` | Company facts and search keywords |
| `backend/app/agents/quantitative_agent.py` | Factor mining plus LLM strategy text |
| `backend/app/alpha_mining/README.md`, `dsl/ops.py`, `vm/factor_vm.py`, `model/trainer.py`, `backtest/evaluator.py`, `features/sentiment.py` | Factor DSL, stack VM, RL trainer, evaluator, sentiment features |
| `legacy_v1/README_OLD.md`, `legacy_v1/Text_Analysis/text_mining.py` | Original price-labelled news classifier |

Flow: Celery beat triggers `realtime_crawl_task` per source every minute. The task is gated by a Redis "last crawl" time
per source, crawls page 1, keeps items published within the retention window, drops items without a publish time,
skips URLs already in the `News` table, and stores the rest. Analysis is not triggered by the crawl; it runs when a user
or API call asks `AnalysisService.analyze_news` for one news id, which calls the news analyst, stores an `Analysis` row,
updates the news sentiment score and embeds the article into Milvus in a background task. Stock debates are started on
demand through `DebateOrchestrator` in one of three modes.

### B3. Key mechanisms, as implemented

**Crawling (`crawl_tasks.py`, `crawler_base.py`, `sina_crawler.py`).** Fixed User-Agent, fixed delay after each fetch,
three retries with short backoff (503 is not retried), several fallbacks for Chinese encodings, article body found by
known container class names with ad/share/comment blocks removed, and a minimum length. Stock codes come from site
markup (for Sina, span ids such as `stock_sh600519`), not from text, with no validation against a stock list. Publish
times are parsed as naive datetimes with no timezone. A stock-relevance filter on URL and title falls back to the
unfiltered list when it would remove everything. Deduplication is exact URL only (within a list page and against the
database); no title or content similarity is used anywhere in the crawl path.

**Targeted stock crawl (`crawl_tasks.py`, `knowledge_extractor.py`).** For one stock it builds "core" keywords (name,
name without the ST prefix, numeric and exchange-prefixed codes) and "extension" keywords (full name, industry, up to
three business phrases, chairman or general manager name), issues up to five search queries, keeps results whose title
or snippet contains a core keyword (relaxed to the numeric code when results are scarce), fetches full pages for the
first 15, and tops up from Baidu News and Sogou when fewer than 5 remain. Existing articles get the stock code appended,
so one article can belong to several stocks. Then a knowledge-graph build is queued.

**News analysis (`news_analyst.py`).** One model call per article with a Markdown report template (summary,
sentiment label and score in -1..+1, key-information table, short/medium/long-term impact, rating). Parsing is regex
over the free text. A label found anywhere in the text can win over the real one; a missing score defaults to +0.5 or
-0.5 from the label; confidence is almost always the default 0.5 because the prompt never asks for it; the score range
is not enforced. On parse failure the defaults are neutral, 0.0 and 0.5, so a failure looks the same as a neutral
article.

**Debate (`orchestrator.py`, `debate_agents.py`, `debate_modes.yaml`).**
- Parallel mode: bull and bear analyse independently and concurrently; the investment manager decides.
- Real-time debate mode: optional data collection, a manager opening, then up to 5 rounds of bull then bear (bear sees
  the bull's current turn, bull sees the bear's previous turn, each through the last 4 history entries cut to 300
  characters), a total time limit of 600 seconds checked only at round start, and, from round 2, a manager check that may
  either declare "ready to decide" (ends the debate early) or ask for more data. Full transcripts go to the manager.
- In-debate data requests: debaters may write `[SEARCH: "query" source:...]` tags. `search_analyst.py` extracts them
  with a regex, runs all requests concurrently against AkShare (keyword-routed to indicators, fund flow, quote or K-line),
  BochaAI web search, a browser search of Baidu/Sogou and the local news store, formats a plain-text summary without a
  model, and appends it to the shared context. An unknown source silently becomes "all". No cache, no dedup, no cap on
  tags per speech. Before the decision, if fewer than two supplements happened, `smart_data_supplement` asks the model
  what data both sides lack and runs those searches.
- Verdict: the manager writes free text with a five-label Chinese rating; `_extract_rating` returns the first label
  found by substring in a fixed order and defaults to "neutral". Because the prompt lists all five labels, an echoed
  scale can produce the wrong rating, and a parse failure is indistinguishable from a neutral call.
- Every step emits a `DebateEvent` (phase, agent, round, timestamp) to callbacks and to the returned trajectory.

**Model access (`llm_service.py`).** Bailian (DashScope) plus OpenAI-compatible endpoints for OpenAI, DeepSeek, Kimi and
Zhipu. No JSON mode or schema; JSON is pulled out of text with a greedy brace regex, with neutral fallbacks.

**Embeddings (`embedding_service.py`).** DashScope embeddings cached in Redis by model and MD5 of the text for 7 days
(the code reads the cache with the full text but writes it with the truncated text, so long articles miss the cache).
Not used for deduplication in the files read.

**Alpha mining (`alpha_mining/*`).** Factors are token sequences in postfix order over features (return, volatility,
volume change, turnover, optionally sentiment and news count) and operators (arithmetic, delay, delta, moving mean and
std, gate, max, min). `factor_vm.py` checks stack depth before execution and replaces NaN and infinities after each
operator. Time-series operators in `dsl/ops.py` use trailing windows with zero padding (no future data), but one
operator (`_op_jump`) and the evaluator's z-score use full-series statistics, which is lookahead. `trainer.py` is plain
REINFORCE with a batch-mean baseline; invalid formulas and constant factors get fixed penalties; the best formula is
selected on the same data used for training. `evaluator.py` lags positions one period, charges a flat cost on average
turnover, reports Sortino, Sharpe, IC, rank IC, drawdown and turnover, and the reward is Sortino minus turnover and
drawdown penalties. There is no held-out split, no walk-forward and no multiple-testing correction.
`quantitative_agent.py` samples 20 formulas from an untrained generator and silently uses synthetic data when no market
data is given; `features/sentiment.py` still returns mock data from its database path.

**Legacy price-labelled classifier (`legacy_v1/Text_Analysis/text_mining.py`).** Each article was linked to stocks by
matching tokens against company names, then labelled good, bad or neutral by whether the close N trading days after
publication was above or below the close on the first trading day on or after publication (no threshold), and an SVM or
random forest was trained on topic-model features with a random 80/20 split (not time-ordered).

### B4. Research ideas worth knowing

1. **Manager-controlled early stop** (`orchestrator.py`): from round 2 the judge can end the debate when it is ready.
2. **Data requests inside a debate** (`search_analyst.py`, `debate_agents.py`): agents name the missing data, a separate
   component fetches it, and the result goes into the shared context.
3. **"What data are both sides missing?" step before the verdict** (`search_analyst.smart_data_supplement`).
4. **Core vs extension keywords for company relevance** (`knowledge_extractor.generate_search_keywords`,
   `crawl_tasks.targeted_stock_crawl_task`): require a core identifier, use extensions only in combination.
5. **Per-source crawl gate** (`crawl_tasks.realtime_crawl_task`): skip a fetch when the last one is younger than the
   source's interval.
6. **Label news by the later price move** (`legacy_v1/Text_Analysis/text_mining.py`): an outcome-based way to ask whether
   a kind of news carries information.
7. **Stack-depth validation of generated formulas before execution** (`alpha_mining/vm/factor_vm.py`).
8. **Reward shaped by turnover and drawdown penalties** (`alpha_mining/backtest/evaluator.py`).
9. **Cautionary examples**: free-text parsing with neutral defaults (`news_analyst.py`, `debate_agents.py`), in-sample
   best-of-many selection (`trainer.py`), full-sample normalisation (`evaluator.py`, `features/sentiment.py`), naive
   timestamps (`sina_crawler.py`).

### B5. Comparison with our system

**What we already do equivalently (or better)**

- News collection: our feed reader (`integrations/publisher-feeds/feed-parser.mjs`) rejects duplicate entries and
  enforces HTTPS and approved origins; `scripts/world-news.mjs` clusters stories across publishers by URL and title
  Jaccard. FinnewsHunter has only exact-URL dedup.
- Company relevance: `integrations/claims/claims.py` matches names and aliases with word boundaries and "not followed by"
  exclusions for shared words. That is stricter than substring keyword matching.
- Sentiment and claims: our model output is schema-constrained, every claim needs an exact quote found in the text, and
  a deterministic fact-checker recomputes corroboration with syndicated copies counted as one origin. FinnewsHunter
  parses free text with regexes and silent neutral defaults.
- Outcome-based check of news value: our link study (`chains.py`, reported in `live_knowledge.py` as
  "link-carries-information") plays the role of the legacy price labelling, with a proper test.
- Factor research: our idea grammar with Bonferroni, random baseline and walk-forward (`rnd_ideas.py`, `rnd_scout.py`,
  `research_checks.py`) addresses exactly the overfitting that the alpha-mining module ignores.
- Audit trail: our audited hash chain covers what `DebateEvent` trajectories record.

**Gaps in our system**

1. No rebuttal round in `debate.py` (same gap as in Part A).
2. No way for a model agent to say "I need this data" and receive it. Our debaters get a fixed context.
3. No judge step that states what evidence is missing before the review. The deterministic review sizes down on an
   evidenced objection, but nothing records "decided without X".

**Ideas we could adopt (our own design)**

| Idea | Why | Expected benefit | Effort |
|---|---|---|---|
| A schema field `missingData` in each debater's answer: an enum of data kinds we can fetch deterministically (recent closes for a longer window, verified claims about the share, regime detail, the bot's own past calls), filled in only from our own verified stores on a second pass | Gives the small model a safe version of FinnewsHunter's data requests: no free-form search, no web | Arguments that ask for data get it; repeated requests show what our context lacks | Medium |
| Record "what was missing" per debate and count it in the management review | Turns data gaps into development tasks | Owner sees which data would most improve arguments | Small, once the field exists |
| Per-source fetch gate keyed on last successful fetch time | Avoids hammering feeds if the cycle runs more often | Politeness and fewer failures | Very small; check whether `pollIntervalMinutes` is already enforced per source |

**Ideas not worth adopting**

- **Free web search during a debate** (BochaAI, Baidu, Sogou). Unapproved sources and unverifiable text would enter the
  context, against our evidence rules.
- **RL formula generation** (`alpha_mining`). CPU-only, and without held-out evaluation it manufactures overfit factors;
  our enumerated grammar with multiple-testing control is the safer design.
- **Per-article free-text sentiment scores.** Our claim extraction with exact quotes is more checkable than a -1..+1
  score per article.
- **Five-round debates.** On a 4B CPU model each round costs minutes; one sequential exchange captures most of the value.
- **Embedding store (Milvus) for news.** Heavy infrastructure for 8 shares; Jaccard clustering is adequate at our scale.

### B6. What could not be verified (FinnewsHunter)

- The nine other crawlers, `interactive_crawler.py`, `bochaai_search.py`, `api/v1/*` routes, `storage/*` (Milvus),
  `knowledge/graph_service.py`, `parallel_search.py`, `data_collector.py` (v1), `QuickAnalystAgent`, the frontend and the
  deploy files.
- README claims not checked in code: WebSocket push and trace visualisation, Neo4j graph retrieval, ACE framework
  integration, "strategy playbook" and "decision evaluation" (listed as planned), the frontend features.
- Whether any path deduplicates news by content or embedding similarity (none found in the files read).
- The full `alpha_mining/dsl/vocab.py`, `model/alpha_generator.py`, `features/market.py` and `tools/alpha_mining_tool.py`.

---

## Summary of priorities for us

1. Put the TA member's internal memory under governance (off during shadow, or hashed into its identity).
2. Make `debate.py` sequential with a rebuttal and an explicit "no opponent yet" marker (same call count).
3. Feed debaters a bounded, verified "this bot on this share" track record from the reflections we already verify.
4. Add point-in-time filters (headlines and lessons before the decision time) to every model context.
5. Tell model agents whether an empty news list means "quiet" or "feeds down".
6. Add a one-line company identity per share from the existing `COMPANIES` table.
7. Consider a schema-bound `missingData` field that is answered only from our own verified stores.
