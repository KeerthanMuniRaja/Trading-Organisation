# Research note: MiroFish, FinceptTerminal and Soup

Studied on 2026-10-21. We read the source code, not only the README.
We copied no code. MiroFish and FinceptTerminal are AGPL-3.0, and FinceptTerminal also needs a paid licence for business use. Soup is Apache-2.0. Every idea here is described in our own words. Short identifiers and file paths are named only so the reader can find the original.

**How the code was read.**
- We used read-only web fetches of github.com folder pages and raw.githubusercontent.com files. Nothing was cloned, downloaded or installed.
- A summarising model stood between us and each raw file. The numbers below are as those summaries reported them.
- We checked these points again directly:
  - the three licences;
  - Soup's `data/formats.py` (format detection);
  - Soup's `utils/ship_verdict.py` (the ship decision);
  - Soup's `eval/gate.py` (the eval gate).
- **Labels used throughout:**
  - **[code]**: seen in source code.
  - **[README]**: a claim made only in the README or docs.
  - **[unverified]**: we could not check it.

The parts of our own system we compare against:
- `integrations/trading-desk/scenario_panel.py`
- `integrations/trading-desk/debate.py`
- `integrations/trading-desk/live_knowledge.py`
- `integrations/model-eval/model_eval.py`
- `integrations/model-eval/build_dataset.py`
- `scripts/status.mjs`
- `scripts/daily-digest.mjs`

These run on the local Qwen3.5-4B model, on CPU, under llama.cpp, with JSON answers forced into a schema.

---

## A. MiroFish (github.com/666ghj/MiroFish)

### A1. What it is, licence, date studied
- **What it is:** a "swarm" simulator that tries to predict how events play out.
  - The user uploads documents and types a free-text "simulation requirement".
  - MiroFish builds a knowledge graph from the documents and turns the graph's entities into social-media personas.
  - It runs a Twitter-like and a Reddit-like platform side by side on CAMEL-AI's OASIS.
  - A ReportAgent then writes a "future prediction report". The user can also chat with the agents or with the ReportAgent.
- **Licence:** AGPL-3.0 [code: `LICENSE`].
- **Activity:** default branch `main`. The latest commits (2026-09 and 2026-10) only update a star-history image, so the core code looks stable or dormant.
- **Stack:** a Flask backend (Python 3.11–3.12) and a Vue frontend.
- **What it needs:**
  - Any LLM service that speaks the OpenAI protocol. The README recommends qwen-plus and warns that the cost is high.
  - **Zep Cloud, which is mandatory.** `backend/app/config.py` refuses a custom Zep address.
- **Claims in the README with no support in the code:**
  - "precisely deduce future trajectories", and "automatic parsing of prediction requirements".
  - There are no benchmarks or accuracy figures anywhere in the repo.

### A2. Architecture (all files below were read)

**Services, `backend/app/services/`:**

| File | What it does |
|---|---|
| `ontology_generator.py` | entity and relation types designed for the question |
| `text_processor.py` | splits and preprocesses the text |
| `graph_builder.py` | builds the Zep graph |
| `zep_entity_reader.py` | reads entities and their context back from Zep |
| `oasis_profile_generator.py` | turns entities into personas |
| `simulation_config_generator.py` | time, events and per-agent behaviour numbers |
| `simulation_manager.py` | runs preparation |
| `simulation_runner.py` | starts and watches the simulation subprocess |
| `simulation_ipc.py` | file mailboxes for "interview" commands |
| `zep_graph_memory_updater.py` | writes simulated actions back into the graph |
| `report_agent.py` | the ReportAgent |
| `zep_tools.py` | the ReportAgent's tools |

**Other backend files:**
- `backend/app/utils/llm_client.py` and `backend/app/config.py`.
- API routes: `backend/app/api/graph.py`, `simulation.py`, `report.py`.
- The simulation subprocess: `backend/scripts/run_parallel_simulation.py`.

**Frontend:** a five-step wizard in `frontend/src/components/`: `Step1GraphBuild`, `Step2EnvSetup`, `Step3Simulation`, `Step4Report`, `Step5Interaction`, plus `GraphPanel` and `HistoryDatabase`. Only Step2 and Step3 were read.

**Tests, `backend/tests/` (18 files):** they cover data contracts and robustness — JSON parsing, the ontology, profile normalisation, Zep paging, retries, the ingestion barrier, and cleaning of tool results. **None of them measures prediction quality.**

**Saved state, all as files:**
- Per simulation, `uploads/simulations/sim_<hex>/` holds:
  - state files and the config;
  - the persona profiles;
  - `actions.jsonl` for each platform;
  - the OASIS SQLite trace;
  - the IPC folders.
- Per report, `report_<hex>/` holds:
  - the outline, a progress file and each section;
  - the full report;
  - the agent log.

### A3. Key mechanisms as implemented [code]

1. **The requirement is never parsed.** It is stored with the project and pasted word for word into the prompts that design the ontology, generate the config and write the report. No code extracts a target, a time horizon or an outcome from it.

2. **Ontology** (`OntologyGenerator.generate`, temperature 0.3, 2 attempts):
   - The LLM designs exactly 10 entity types: 8 specific ones plus the catch-alls Person and Organization.
   - It also designs 6–10 relation types, each with source and target types, and 1–3 attributes per type.
   - Entity types must be actors that can post or react; abstract concepts are banned.
   - Long input is cut down to about 50,000 characters:
     - split into 8,000-character chunks;
     - keep at most 60 evenly spaced chunks;
     - keep the head and tail of each chunk;
     - shrink the budget by 15% per pass until it fits.
   - Afterwards, names are normalised, duplicates are removed, relations whose endpoints don't exist are dropped, and the catch-all types are forced in.

3. **Graph build** (`graph_builder.py`):
   - **The "GraphRAG" is Zep Cloud's.** The local code only:
     - splits the text into chunks of about 500 characters with 50 overlapping;
     - turns the ontology into Zep entity and edge classes at runtime;
     - sends the chunks to Zep as "episodes" in batches.
   - Entity extraction, embeddings and retrieval all happen inside Zep.
   - **Writes are idempotent.** Each write first records an operation id derived from its content. After an unclear failure the code looks the batch up instead of sending it again. Writes are never retried blindly, to avoid duplicate facts.

4. **Personas** (`zep_entity_reader.py`, `oasis_profile_generator.py`):
   - Every graph node with a custom type becomes one agent.
   - Its context comes from two Zep searches (30 edges and 20 nodes, merged by rank), capped at 3,000 characters.
   - There are two prompt styles:
     - **people:** a short bio plus a persona of about 2,000 characters covering background, personality type, posting habits, stance and role;
     - **institutions:** an "official account" voice.
   - **Failure handling:** 3 attempts, lowering the temperature each time, then repair of a cut-off JSON answer, then a regex fallback, then a fixed template per entity type.
   - Personas are generated in parallel, and the file is saved after each one so the interface can show progress.

5. **Simulation config** (`simulation_config_generator.py`), in four LLM stages, each with a rule-based fallback:
   - **Time:**
     - 72 simulated hours by default;
     - 5–20 agents active per hour;
     - activity multipliers by Beijing hour (night ×0.05, evening ×1.5).
   - **Events:** hot topics, a "narrative direction" and the opening posts.
   - **Per agent, in batches of 15:** these numbers are kept *separate from the persona text*:
     - an activity level from 0 to 1;
     - posts and comments per hour;
     - active hours and response delay;
     - a sentiment bias from −1 to 1;
     - a stance (supportive, opposing, neutral or observer);
     - an influence weight.
   - **Opening posts** are assigned to real agents by type, then by an alias table, then to the most influential agent.
   - **Platform settings:** recency, popularity and relevance weights, a virality threshold and an echo-chamber strength are written into the config. We could not confirm that the runner passes them to OASIS.

6. **Run** (`simulation_runner.py` starts `scripts/run_parallel_simulation.py`):
   - Both platforms run at the same time, each limited to 30 parallel LLM requests.
   - **Number of rounds:** hours × 60 ÷ minutes per round.
     - The defaults disagree: 60 minutes per round in the config, 30 in the runner and the interface.
     - The interface recommends about 40 rounds.
   - **Each round:**
     - draw a target number of agents;
     - scale it by the hour's multiplier;
     - candidates are agents active at that hour that pass a random draw against their activity level;
     - each sampled agent's own model picks one action from the platform's list.
   - Opening posts are forced in round 0.
   - **Scheduled mid-run events are not implemented.** The config lists them, but only the opening posts are used.
   - **Logging:** actions are read back from the OASIS trace table, given post and author context, and appended to `actions.jsonl`. A monitor reads those logs every 2 seconds.

7. **Memory feedback** (`zep_graph_memory_updater.py`):
   - Each successful action becomes one dated sentence ("[time][platform round N] Name: …"), sent to Zep in small batches by a worker thread.
   - Zep extracts new facts from the simulated discussion and marks superseded facts as expired.
   - While this is still being written, a report request is refused (HTTP 409).

8. **Interviews** (`simulation_ipc.py`):
   - After the run, the platforms stay alive. One JSON command file per request is checked every 0.5 seconds.
   - An interview is a forced action sent to a live agent, and its answer is read back from the trace table.
   - Timeouts: 60 seconds for one interview, 120 for a batch.

9. **ReportAgent** (`report_agent.py`, `zep_tools.py`):
   - **Before starting:** it requires a finished simulation, no memory still being written, and a built graph.
   - **Outline:** 2–5 sections, built from graph statistics and sample facts.
   - **Each section is written in a ReACT loop:**
     - at most 5 iterations;
     - **at least 3 and at most 5 tool calls**;
     - tool calls are written as `<tool_call>` text blocks, and only the first one in a turn runs.
   - **Guards:**
     - a "Final Answer" before 3 tool calls is rejected;
     - a turn with both a tool call and an answer is rejected, then cut back to the tool call;
     - fake `<tool_result>` blocks are removed;
     - calls over the limit are refused;
     - when iterations run out, one final answer is forced.
   - **Tools:**
     - `insight_forge`: the LLM splits the question into up to 5 sub-questions, searches for each, and merges the facts and relation chains;
     - `panorama_search`: splits facts into current and historical (expired), each with its validity window;
     - `quick_search`: a hybrid search with reranking;
     - `interview_agents`: the LLM picks up to 5 agents and writes 3–5 questions, both platforms are asked, and the answers are summarised.
   - **There is no fact-check or evaluation step.** `MAX_REFLECTION_ROUNDS` is defined but never used.

10. **LLM client** (`utils/llm_client.py`):
    - Asks for JSON output. If the provider rejects that, it retries once without it.
    - Removes `<think>` blocks and code fences.
    - Treats a cut-off answer as an error and never repairs a cut-off JSON answer here.
    - Sets no explicit timeout.

### A4. Research ideas worth knowing
1. **Question-shaped types with catch-alls** (`ontology_generator.py`): the type system is designed for each question, and catch-all types make sure nothing is lost.
2. **Cast drawn from the material** (`zep_entity_reader.py`, `oasis_profile_generator.py`): the agents are whoever the documents mention, not a fixed panel. People and institutions speak in different voices.
3. **Behaviour numbers separate from the persona** (`simulation_config_generator.py`): the persona says *who* the agent is. Structured numbers say *how often* it acts, *when*, with what *bias* and how much *influence*.
4. **Random activation by time of day** (`run_parallel_simulation.py`): not every agent speaks every round, which is closer to real participation.
5. **Dated memory feedback** (`zep_graph_memory_updater.py`, `panorama_search`): simulated actions go back into the graph as dated facts, and current facts are kept apart from expired ones.
6. **Interviews after the run** (`simulation_ipc.py`, `interview_agents`): the analyst can ask an agent why it acted as it did.
7. **Minimum evidence before writing** (`report_agent.py`): at least 3 retrievals, early answers refused, invented tool results removed.
8. **Operational hygiene:**
   - an idempotent write journal instead of retries (`graph_builder.py`);
   - a barrier before reporting;
   - progress kept in files;
   - a rule-based fallback at every LLM stage.

### A5. Comparison with our system

**Our equivalents**
- **`scenario_panel.py`** is our small version of "rehearse a story from several perspectives":
  - 5 fixed personas;
  - one schema-bound call per persona per story;
  - a 3-of-5 quorum;
  - the organisation's market regime given as background (from `live_knowledge.briefing`).
- **`debate.py`** is our version of the ReportAgent's "argue only from what was retrieved". Ours is stricter: the schema allows only the proposal's verified evidence ids, and the backend checks them again.
- **`live_knowledge.py` (`briefing`)** is a small, fixed-size, deterministic version of their retrieval tools. It is given as background, never as evidence.
- **Where we are clearly ahead: we measure outcomes.**
  - After 5 sessions, `scenario_panel.score` judges the panel and each persona against the equal-weight basket, with a sign test.
  - A persona needs at least 20 calls before it can be considered as a member.
  - MiroFish never checks whether a prediction came true.

**GAPS (they have it, we don't)**
1. **Story-specific cast.** Our five personas are the same for every story.
2. **Interaction.** Our personas answer independently and never see each other's view.
3. **Weighted voices.** Our quorum counts every persona equally, whatever its record.
4. **Dated facts.** `live_knowledge` overwrites itself, so there is no "valid from / replaced on" history.
5. **Asking a persona why** after a wrong call.
6. **Counting fallbacks.** In `ask_panel`, a persona that fails quietly becomes "flat", and the number of failures is not reported.

**Ideas to adopt in our own design** (sized for Qwen 4B on CPU)

| Idea | Why / benefit | Effort |
|---|---|---|
| Up to 2 **story-specific extra personas** per story, chosen by one schema call from a fixed list of roles (e.g. regulator, supplier, foreign fund), in shadow and scored separately | Views that fit the story, with their worth measured before it counts | ~1 day, 2–3 extra calls per story |
| **Two-round deliberation**: each persona sees the anonymised round-1 calls and may keep or change its call; score "first instinct" and "after discussion" separately | Tests whether interaction helps at all, which MiroFish never measured | ~1 day, doubles the calls |
| **Earned weights**: weight each persona's vote by its own shadow record (e.g. a smoothed right/wrong ratio), shown next to the plain 3-of-5 | Their "influence weight", but learned from outcomes instead of assigned by an LLM | ~0.5 day, no extra calls |
| **Interview a persona after a wrong call**: show it its reason and the actual move, ask what it missed, store the answer as a reflection (`reflections.py` / `playbook_drafts.py`) | Lessons, and labelled training data | ~1 day |
| **Valid-from and replaced-on dates** on `live_knowledge` facts; the briefing shows only current facts, the history is kept | No silent loss of past facts; supports auditing | ~0.5 day |
| **Count fallbacks** (failed personas) in the panel's record and show them on Operations | A silent "flat" can hide a broken model | ~2 hours |
| **Minimum evidence for the debaters**: when verified evidence exists, cite one item or say why none applies | Fewer arguments with no support | ~2 hours |

**Ideas not worth adopting**
- **Zep Cloud and its GraphRAG.** It is a mandatory external cloud service, which conflicts with our local-only, office-laptop rules. Its extraction cannot be inspected, and an ontology is overkill for 8 shares.
- **The full OASIS social simulation.** It means thousands of model calls per run, which is hours to days on a CPU 4B model. Likes and reposts have no clear link to price direction.
- **ReACT with `<tool_call>` text tags.** It is brittle on a 4B model; they needed many guards. If we ever add tools, the tool choice should be an enum in the schema.
- **Personas of about 2,000 characters.** They cost a lot of context and showed no benefit.
- **Long narrative "prediction reports" that are never scored.**

### A6. What we could not verify
- **Files not read in full:**
  - the per-platform simulation scripts and `action_logger.py`;
  - `utils/file_parser.py`, so the chunk unit is probably characters but not confirmed;
  - the Step1, Step4 and Step5 screens.
- **Whether the platform weights and echo-chamber settings ever reach OASIS.** The runner did not appear to pass them.
- **How Zep extracts facts and marks them expired.** It is a closed service.
- **Inconsistencies in their code:** the per-round default (60 vs 30 minutes), two different peak-hour lists, unused constants (`MAX_REFLECTION_ROUNDS`), and a local search fallback that is never called.
- **Any evidence of prediction accuracy.** There is none in the repo.

---

## B. FinceptTerminal (github.com/Fincept-Corporation/FinceptTerminal)

### B1. What it is, licence, date studied
- **What it is:** a native desktop financial terminal in the style of Bloomberg.
  - Written in C++20 with Qt6.
  - An embedded Python 3.11 runs the analytics, data and agent scripts.
  - The old Tauri/React version has been replaced; the code now lives under `fincept-qt/`.
- **Activity:** latest release v4.5.1, latest commits dated 2026-10-13.
- **Licence (`LICENSE`, checked directly):** AGPL-3.0 with extra terms, and **dual-licensed**.
  - The AGPL option covers only individual, non-business use.
  - Business or internal company use, hosted or SaaS offerings, and forks that replace Fincept's APIs need a paid Fincept Commercial License (`docs/COMMERCIAL_LICENSE.md`).
- **Consequence for us:** ideas only. We must not run their code in the organisation, which also fits our office-laptop rule.
- **Editions:** the open build has upgrade prompts, and the README describes a paid Enterprise edition.

### B2. Architecture (file paths)
- **`fincept-qt/src/app/`: the window.**
  - `WindowFrame_Setup.cpp`, `WindowFrame_Layout.cpp`;
  - `DockScreenRouter*.cpp` (routes screens);
  - `ScreenSmokeTest.cpp` (not read).
- **`src/screens/`:** 57 screen folders.
- **`src/ui/`: interface pieces.**
  - `navigation/`: `ToolBar.cpp`, `FKeyBar.cpp` (the tab bar), `StatusBar.cpp`;
  - `command/`: `CommandParser.cpp`, a command palette and suggestion index;
  - `theme/`, `widgets/`, `notifications/`.
- **`src/datahub/`: one shared publish/subscribe data layer.** Files: `DataHub.h`, `Producer.h`, `TopicPolicy.h`.
- **`src/services/`: 47 folders**, including agents, alpha_arena, backtesting, connectors, llm, news, portfolio and notifications.
- **`src/python/PythonRunner`:** runs Python scripts as separate processes, at most 3 at a time.
  - **The script contract:** a function name and arguments go in; JSON comes back on stdout; logs go to stderr; large inputs go on stdin (confirmed in `base_provider.py`).
- **`fincept-qt/scripts/`: the Python side.**
  - more than 60 data connector scripts;
  - `Analytics/` (20 folders, including `backtesting/` with one adapter per engine and a shared `base/`);
  - wrappers for pyportfolioopt, skfolio, ffn and quantstats;
  - `agents/`: `finagent_core`, `TraderInvestorsAgent`, and economic and geopolitics agents.

### B3. Key mechanisms as implemented [code]

**Screen organisation** (in detail, for our dashboard)

- **Screen registry** (`WindowFrame_Setup.cpp`):
  - 52 screens are registered, and each is built only the first time it is opened.
  - Comments group them as "core" (dashboard, markets, crypto trading, news, watchlist), "deferred", and information or legal pages.
- **Docking:**
  - Panels dock in the main window and can be torn off into a new window from their right-click menu.
  - The layout is saved about half a second after any change.
- **Layout save and restore** (`WindowFrame_Layout.cpp`):
  - The layout carries a version number. It records the dock arrangement, the focused panel, focus mode, each panel's type, its link group and its own state.
  - On restore, the active panel is built first, then visible panels, then the rest.
- **Tab bar** (`FKeyBar.cpp`, which despite its name binds no F-keys). 15 fixed tabs:
  DASHBOARD, MARKETS, CRYPTO, EQUITY, PORTFOLIO, NEWS, AI CHAT, BACKTEST, ALGO, NODES, CODE, QUANT LAB, QUANTLIB, SETTINGS, PROFILE.
  Only buttons that changed are redrawn.
- **Menus** (`ToolBar.cpp`):
  - **File:** windows, layouts (new, open, save, import, export), Refresh All.
  - **Navigate**, in groups:
    - Markets & Data: economics, government data, Asian markets, relationship map;
    - Trading & Portfolio: equity trading, Alpha Arena, prediction markets, derivatives, F&O, watchlist;
    - Crypto;
    - Research & Intelligence: equity research, M&A, alternatives, geopolitics, maritime;
    - Tools: agent config, agent workbench, MCP servers, data mapping, data sources, report builder, notes.
  - **View:**
    - component browser (Ctrl+K), fullscreen (F11), focus mode (F10), always on top;
    - float a panel;
    - **"Quick Switch" saved workspaces per job:** Trading, Research, Portfolio, Markets, News, Economics & Data, Geopolitics, AI & Quant, Tools;
    - refresh (F5), screenshot.
  - **Right side of the toolbar:** command bar, a LIVE dot, pinned symbol chips, a clock (ticks only while visible), user, credits, plan badge, chat (F9), logout.
  - Lower-priority items **hide progressively** as the window narrows (at 1200, 800 and 650 pixels).
- **Command bar** (`CommandParser.cpp`):
  - A single word is first looked up as a command; if none matches, it is treated as a ticker.
  - Otherwise the parser takes the longest matching multi-word command, then aliases.
  - Arguments fill named slots with defaults, and `?` shows help.
  - There is no "did you mean" in the parser.
- **Status bar** (`StatusBar.cpp`):
  - version and "OPEN SOURCE";
  - market labels (EQ, FX, CM, FI, CR);
  - temporary chips, e.g. one that appears only while Python setup runs or after it fails, and retries on click;
  - the active symbol in its link-group colour;
  - READY or BUSY.
- **Theme:** shared colour tokens. Every widget restyles when the theme changes and retranslates when the language changes.

**Data refresh, DataHub** (`DataHub.h`, `TopicPolicy.h`, `Producer.h`)
- **Topics and producers:** data lives under named topics (e.g. `market:quote:<SYM>`, `agent:error:*`).
  - Each producer declares which topics it owns and how many requests per second it may make.
  - On every refresh it must either publish a value or report an error.
- **Refresh rules, set per topic:**
  - **Freshness:** a value counts as fresh for 30 seconds by default.
  - **Throttle:** at most one refresh every 5 seconds.
  - **Timeout:** 30 seconds, so a stuck source cannot block a topic for ever.
  - **Push mode:** a separate mode that merges bursts.
  - **Throw-away topics:** discard a topic's data when nobody is watching.
  - **Pause while hidden:** stop updating the screen while the window is hidden. Comments say to use it only for fast streams, never for portfolio or news.
- **Scheduler:**
  - Checks every second and merges requests that arrive within about 100 ms.
  - A forced refresh skips the throttle but never the source's rate limit.
- **Stale data:**
  - A new subscriber gets the cached value immediately if it is fresh.
  - There are separate calls for "fresh value only", "last value whatever its age" and "how old is it". The header says screens **should show how old the data is**.
  - **On an error, the last good value is kept** and an error signal is raised.
  - A statistics call (subscribers, publish and error counts, last error per topic) feeds an inspector screen.

**Dashboard** (`screens/dashboard/DashboardScreen.cpp`, `widgets/BaseWidget.cpp`)
- **Layout:**
  - a toolbar (add tile, templates, Market Pulse toggle, save, refresh, LIVE badge);
  - a scrolling ticker;
  - a tile grid with a "Market Pulse" column on the right, about 3 to 1;
  - a status line with the tile count and connectivity, and pop-up notifications.
- **Every tile has the same frame:**
  - title, loading label, refresh, close, and optional settings;
  - loading, progress and error overlays;
  - **a 20-second watchdog**: show what has arrived so far, or a calm "click refresh" message;
  - hidden tiles stop listening for data;
  - double-click a symbol to open it; right-click offers research, trade, news, backtest or watchlist.
  - **There is no "last updated" label on tiles.**
- **Saving the layout:**
  - The layout is saved after a short delay; visible tiles are built first.
  - **If the saved layout cannot be read, the default layout is shown read-only and saving is refused**, so the stored layout is never overwritten.
  - The default template is `portfolio_manager`.
- **About 35 tile types:**
  - Markets: indices, FX, commodities, crypto, movers, heatmap.
  - News and events: news, calendar, geopolitics, sentiment, prediction markets.
  - Portfolio and trading: portfolio summary, performance, today's P&L, positions, holdings, margin, risk metrics, order book, screener, watchlist.
  - Other: notes, files, and **AgentErrors**: agent errors, newest first, with no severity and not saved.
- **RiskMetrics tile:** VIX with fixed bands (below 15 low, below 20 normal, below 30 elevated, below 40 high stress, 40 and above extreme fear).

**Portfolio and risk** (`services/portfolio/PortfolioService_Metrics.cpp`, `screens/portfolio/views/RiskManagementView.cpp`, `PortfolioScreen_Layout.cpp`)
- **Returns:**
  - Time-weighted return from daily values (up to 365 days), with deposits and withdrawals removed.
  - Daily moves below −90% or above +100% are dropped as bad data, and counted.
- **Minimum data:** 5 periods for return and drawdown, 20 for the other statistics. A return is annualised only for windows of 182 days or more.
- **Statistics:**
  - volatility, Sharpe, Sortino, maximum drawdown;
  - historical 95% VaR and CVaR in money;
  - beta and Jensen's alpha against a benchmark chosen by currency (**NIFTY 50 for rupees**);
  - concentration in the top 3 holdings.
- **Risk score from 0 to 100:** volatility 30 points, concentration 25, drawdown 25, beta 20.
- **Risk view, three tabs:**
  - **Overview:** VaR and CVaR; volatility labelled forward-looking or realised; concentration of the top 1, 3 and 5 holdings (red above 30% and 60%).
  - **Stress Test:** 8 fixed scenarios (2008, COVID, dot-com, rates +3%, 1987, inflation, geopolitical, currency), each a fixed shock per asset class, with equities scaled by beta.
  - **Risk Contribution:** each holding's share of total risk; a holding is flagged when its risk share is more than 5 points above its weight.
  - These are display thresholds only; there is no limits system.
- **Portfolio screen:**
  - a summary strip, then a heatmap, performance chart and sector panel;
  - a filterable positions table and a collapsible transaction history;
  - a slide-in order panel and an AI/agent insights overlay;
  - a button that sends the holdings to the backtest screen.

**Backtesting** (`scripts/Analytics/backtesting/base/base_provider.py`, `advanced_metrics.py`)
- **`base_provider.py`: one shared interface over several engines** (backtesting.py, bt, vectorbt, zipline and others).
  - Every engine returns the same result shape: statistics, trades (with why each closed), an equity and drawdown curve, and totals for fees and slippage.
  - **Every result carries an assumptions block:** engine, trade timing, costs, data source, a survivorship note, risk-free rate.
  - **A list of requested settings the engine ignored.**
  - **It refuses to fall back to fake (random) prices** unless the request explicitly allows it.
- **`advanced_metrics.py`:**
  - VaR and CVaR at 95% and 99%, Ulcer index, Omega, tail ratio, skew and kurtosis;
  - a monthly returns grid, rolling Sharpe and volatility, tracking error, information ratio.
  - **There are no significance tests.**

**News** (`src/services/news/`)
- **Story grouping** (`NewsClusterService.cpp`):
  - Headlines are grouped by word overlap within 24 hours.
  - Each group records the best source tier, the **number of distinct sources**, a lead article, sentiment by majority vote, and a **speed**: rising, stable or falling (the last 2 hours against earlier).
- **Signals** (`NewsSignalDetector.cpp`), simple rules with no model:
  - **volume spike:** at least 3 times the previous hour and at least 5 articles;
  - **triangulation:** 3 or more different sources report the same story;
  - keyword spikes.
- **Sentiment** (`NewsNlpService.cpp`): done by a Python script whose method we could not see. Results are cached per article and recomputed only when the text changes; after a failure it waits 1 minute.

**Connectors** (`services/connectors/ConnectorCatalog.cpp`)
- A JSON catalogue of connectors. Each entry has a category, region, script, commands, required keys and a docs link.
- **A `broken` flag with a reason** marks connectors known not to work.
- Key status per connector: not needed, unknown, ready, partial or missing.

**AI agents** (`scripts/agents/finagent_core/core_agent.py`, `persona_registry.py`, `TraderInvestorsAgent/configs/agent_definitions.json`, `modules/guardrails_module.py`, `modules/evaluation_module.py`)
- **Agent framework:**
  - Built on the Agno library, with a provider fallback list and tools from a registry and MCP servers.
  - Tool loops are capped at 10 steps.
  - The terminal toolkit has a dry-run mode and a separate token for destructive actions.
- **Personas:** 11 investor personas (Buffett, Graham, Lynch, Munger, Klarman, Marks and others), defined as **data**.
  - Each has long instructions, number thresholds and a **typed answer with fields specific to its style**, e.g. Graham's margin of safety, Lynch's PEG ratio.
  - Up to 8 are kept loaded, and the least recently used is dropped.
- **Guardrails:** injection patterns, personal-data redaction, a 10% position limit, a prohibited-symbol list.
  - **They only report problems.** The hook into the agent library returns an empty setting, so they are not actually attached.
- **Evaluation:** direction and price accuracy, speed, cost, a model-as-judge.
  - **It is kept only in memory**, and nothing acts on the results.

**Alpha Arena** (`src/services/alpha_arena/ArenaEngine.cpp`, `ArenaRisk.cpp`, `ArenaPrompts.cpp`): several AI models compete, each trading its own account.
- **Each round:**
  - Rounds run every 1 to 60 minutes.
  - A market snapshot is taken and saved.
  - Each model gets the market, its account and its last 5 decisions.
- **Discipline:**
  - an unreadable answer gets **one repair attempt**, then counts as an error;
  - **a circuit breaker per model** stops a model that keeps failing;
  - every proposed action is risk-checked, and rejected actions are saved with the reason;
  - answers that arrive after a run has stopped are ignored;
  - in live mode, approved actions wait in a **human approval queue** that is saved to disk.
- **Risk checks** (`ArenaRisk.cpp`): the position limit counts **the total position including earlier additions**, so it cannot be dodged in small steps. Trades are accepted or refused, never resized.
- **Prompts** (`ArenaPrompts.cpp`):
  - Time comes from the snapshot, not the clock, so the same inputs always give the same prompt.
  - Missing indicators are written as "unavailable", never as zero.
  - The model's earlier unreadable answers are shown back to it as errors.
- **Controls:** halt, resume, flatten one model, flatten everything.

**Action Center** (`screens/action_center/PendingOrdersPanel.cpp`): a queue of orders waiting for a human.
- **Queue:** filters by account and status; counters for pending, approved, rejected, buy and sell.
- **Expiry:** each order has a time limit with a live countdown, turns amber near the end, and is **rejected automatically at zero**.
- **Approving:** the order is reloaded first, then the confirmation dialog opens with Cancel as the default.
- **Rejecting:** needs a reason.
- **Bulk approval:** says how many orders are already past their time limit.
- **Kill switch:** you must type KILL.

### B4. Research ideas worth knowing
1. **Refresh rules per data topic plus "keep the last good value and show its age"** (`TopicPolicy.h`, `DataHub.h`).
2. **An assumptions block and an ignored-settings list on every backtest result; refuse fake data** (`base_provider.py`).
3. **Arena discipline:** one repair attempt, a circuit breaker per model, late answers ignored, rejections saved with reasons, prompts that don't depend on the clock, "unavailable" instead of zero (`ArenaEngine.cpp`, `ArenaPrompts.cpp`).
4. **A position limit that counts what is already held** (`ArenaRisk.cpp`).
5. **Approvals that expire** (countdown, automatic rejection), **reloaded before approving**, Cancel as default, a typed kill switch (`PendingOrdersPanel.cpp`).
6. **Personas as data with typed answers specific to their style** (`agent_definitions.json`).
7. **News triangulation (3 or more distinct sources) and story speed** (`NewsSignalDetector.cpp`, `NewsClusterService.cpp`).
8. **Risk score and each holding's share of risk; fixed stress scenarios** (`PortfolioService_Metrics.cpp`, `RiskManagementView.cpp`).
9. **A connector catalogue that marks broken connectors with a reason** (`ConnectorCatalog.cpp`).
10. **Uniform tiles with a loading watchdog; read-only when the saved layout cannot be read** (`BaseWidget.cpp`, `DashboardScreen.cpp`).
11. **Saved workspaces per job; a command bar that accepts a bare ticker** (`ToolBar.cpp`, `CommandParser.cpp`).

### B5. Comparison with our system

**Our equivalents**
- **Investor personas:** our `scenario_panel.py`. We score each persona against outcomes; they don't.
- **Bull/bear debate:** a README claim only on their side (`scripts/agno_trading/core/debate_orchestrator.py` returned 404). Our `debate.py` runs it, with citations limited to verified evidence, and the debaters are scored.
- **Alpha Arena:** close to our members, tournament and release gate.
- **Action Center:** close to our owner approvals and standing policies.
- **Guardrails and evaluation:** theirs only report; ours are enforced — untrusted headlines are treated as data, answers are schema-bound, the backend re-checks, and `model_eval.py` has a gate.
- **News clustering:** close to our `world-news.mjs` stories and driver links.
- **Risk view:** partly covered by our `risk_monitor.py` and `market_regime.py`.

**GAPS**
1. **No data age in our owner views.** `status.mjs` and `daily-digest.mjs` show values but not how old they are, and we have no rule to keep the last good value after a failed refresh.
2. **No circuit breaker per model agent and no rule to ignore late answers.** A failed persona quietly becomes "flat" (`scenario_panel.ask_panel`).
3. **No assumptions block on our research and backtest results** (costs, timing, data source, survivorship, ignored settings).
4. **Owner approvals don't expire** and are not re-checked at the moment of approval.
5. **No per-holding risk share, no stress table and no single risk number** for the owner.
6. **No count of distinct sources per story** (we have only 3 approved RSS sources, so this would be "how many of our 3").
7. **No catalogue of data sources with a broken reason** for the owner (`data_steward.py` covers part of this).

**Ideas to adopt in our own design**

| Idea | Why / benefit | Effort |
|---|---|---|
| An `asOf` field on every JSON our scripts write, with the age shown in `status.mjs` and the dashboard; keep the last good file on failure | Stale data stops looking live | Low |
| One repair attempt, then a **circuit breaker per model agent** in the shared model client (`claims.model_client`); counts shown on Operations | The 4B CPU model sometimes fails; a broken agent is stopped and visible | Low–medium |
| An **assumptions block** on every research and walk-forward result | Honest research cards; evidence for the release gate | Low |
| **Approvals that expire**, and a re-check when approved | Nothing stale gets approved | Medium (backend) |
| **Confirm** that our Rs 5,000 order limit counts the existing holding plus the new order (a test) | Stops a limit being dodged in small steps | Low |
| **Stress table and each holding's share of risk** for the 8 shares, on Money | One clear risk picture for the owner | Medium |
| **Source count per story**, used in the driver-link tests | Triangulated stories are probably more reliable | Low |
| **Persona definitions as versioned data**, fingerprinted in `model_eval.PROMPT_VERSIONS` | Persona changes become traceable | Low |

**Not worth adopting**
- The C++/Qt docking shell with 50+ screens; a local web page built from our JSON is enough.
- 40+ cloud model providers, MCP everywhere, voice: against our local-model plan.
- 100+ data connectors: we deliberately keep 3 approved sources plus market data.
- Their guardrail and evaluation modules: ours are stricter.
- The VIX tile with US high-beta shares (not NSE); upgrade prompts.

### B6. Lessons for our dashboard
Their pattern:
- about 15 fixed tabs plus a grouped menu of about 30 more screens;
- saved workspaces per job and a global command bar;
- a dashboard of uniform tiles;
- a thin status bar with temporary chips.

We should copy how they **organise** information, not their size. One default layout, not editable, served locally.

1. **Home** (their Dashboard, Market Pulse and status bar)
   - Uniform tiles: title, value, **data age**, state (loading, ok, stale, error), and a link to the detail tab.
   - A right-hand column: market regime, halts, and items waiting for the owner.
   - A thin bottom strip: backend up/down, model up/down, NEW RISK HALTED, next scheduled runs. These lines already exist in `status.mjs` `render`.
   - If a state file cannot be read, show the last good one marked stale, never a blank page (like their read-only fallback).
2. **Decisions** (their Action Center)
   - A queue with pending, approved, rejected and all, plus counters.
   - **A countdown and automatic expiry** per item.
   - Full context in the confirmation, with Cancel as the default; a reason required to reject.
   - Bulk approval only after a summary of what it includes.
   - A typed "halt new risk" switch.
   - A history of decisions with their reasons.
3. **Members** (their Alpha Arena and agent config)
   - One row per member: status (active, halted by circuit breaker, suspended), consecutive failures, last decision and reason, risk rejections with reasons, equity curve, and record (right/wrong and p-value from `fitness`).
   - The scenario personas and the debaters are listed too, with their shadow records.
4. **Trading** (their portfolio main view)
   - A summary strip, a filterable positions table, today's orders and fills, and a collapsible transaction log.
   - Clicking a share opens its news and research.
5. **Money** (their risk management and performance views)
   - NAV and time-weighted return with flows removed.
   - Volatility labelled realised; Sharpe and Sortino; maximum drawdown; 1-day VaR and CVaR.
   - Top-1 and top-3 concentration with thresholds; the stress table; each holding's share of risk.
   - Budget and limit use; tax and costs to date.
   - **Hide a statistic until there are at least 20 periods of data.**
6. **Research** (their Backtest, Quant Lab and QuantStats)
   - Research cards from `live_knowledge`, each with its assumptions block.
   - A monthly returns grid; rolling Sharpe and volatility.
   - Keep our p-values and Bonferroni bar; they have no significance tests.
7. **Knowledge & News** (their News and Geopolitics screens)
   - Story groups showing the distinct-source count, whether a story is speeding up, the linked shares, and whether our fact-checker verified it.
   - The scenario panel's call and later score per story.
   - Playbook lessons.
8. **Operations** (their data inspector, data sources, AgentErrors tile and setup chip)
   - Per data feed: last success, age, error count, last error, broken reason.
   - Model server health and latency (p50 and p90 from `model_eval`).
   - Agent errors **saved and with severity**, unlike theirs.
   - Cycle steps with next run times; temporary chips only for running or failed jobs.

**Across all tabs**
- A search box that accepts a share symbol or a tab name.
- Colour tokens with light and dark themes.
- Fast updates paused when the tab is hidden; slow data (portfolio, news) never paused.
- Lower-priority header items hidden on narrow screens rather than wrapped.

### B7. What we could not verify
- **Debate and other agents:**
  - The debate orchestrator file returned 404.
  - The "37 agents" total and the economic, geopolitical, deepagents and rdagents internals are README claims only.
- **Analytics methods:**
  - how news sentiment is computed;
  - how forward-looking VaR is computed (`portfolio_metrics.py`).
- **Interface details:**
  - the dashboard templates;
  - the command palette and suggestions;
  - the real F-key bindings;
  - what drives the status bar market labels and READY/BUSY;
  - the Arena answer parser and leaderboard screen.
- **Other code:**
  - the individual backtest engine adapters;
  - where Action Center orders come from.
- **Counts:**
  - the connector and broker counts are README claims;
  - folder listings were cut short, so all counts are minimums.

---

## C. Soup (github.com/MakazhanAlpamys/Soup)

### C1. What it is, licence, date studied
- **What it is:** `soup-cli` 0.76.0, a large command-line tool for fine-tuning and evaluating LLMs.
  - It wraps TRL, PEFT and transformers; the code lives in `src/soup_cli/`.
  - The newest commits are dated 2026-10-20.
- **Licence:** Apache-2.0 (`pyproject.toml`).
- **Python:** 3.10–3.12. Our `.local/replay-venv` is 3.12, so it fits.
- **Install:**
  - The core install is light (typer, rich, pydantic, huggingface-hub).
  - The `[train]` extra adds torch ≥ 2.6, transformers ≥ 5.16.1 and < 6, peft ≥ 0.20, trl ≥ 0.29 and < 1, and bitsandbytes ≥ 0.41.
  - Other extras: `[serve]`, `[serve-fast]` (vLLM), `[eval]` (lm-eval), `[mlx]`.

**Files read**, under `src/soup_cli/` unless noted:
- Project and docs: `pyproject.toml`, `README.md`, `docs/commands.md`.
- Data:
  - `data/formats.py` (checked directly), `data/validator.py`, `data/loader.py`;
  - `data/sft_format.py`, `data/chat_templates.py`.
- Config: `config/schema.py` (partly), `config/unknown_keys.py`.
- Trainers: `trainer/sft.py`, `trainer/dpo.py`, `trainer/grpo.py`, `trainer/rewards.py`.
- Evaluation:
  - `eval/gate.py` (checked directly), `eval/gate_suites.py`, `eval/custom.py`, `eval/judge.py`;
  - `utils/ship_verdict.py` (checked directly).
- Commands:
  - `commands/ship.py`, `commands/eval.py`, `commands/_eval_v0550.py`, `commands/lock.py`;
  - `commands/diagnose.py`, `commands/export.py`, `commands/serve.py`, `commands/train.py` (partly).
- Utilities:
  - `utils/gpu.py`, `utils/quant_menu.py`;
  - `utils/diagnose/report.py`, `utils/diagnose/format.py`, `utils/diagnose/mode_collapse.py`.

### C2. Architecture [code]

**Config: `SoupConfig` in `config/schema.py`**
- **Top-level fields:** `base`, `task`, `modality`, `backend`, `data`, `training`, `output`, `experiment_name`, `eval`, `advise`.
- **23 tasks:** sft, dpo, grpo, ppo, reward_model, kto, orpo, simpo, ipo, bco, preference, pretrain, embedding, prm, tts, classifier, reranker, cross_encoder, distill, unlearn, moe_lora_routing, online_dpo, asr.
- **Backends:** transformers, unsloth, mlx.

**`DataConfig`**
- `format`: 20 values, including `auto`.
- `val_split`: from 0 to 0.5, default 0.1.
- `max_length`: default 2048.
- `chat_template`: overrides the model's template.
- `train_on_responses_only`: default true.
- `train`: one file, or a list of at least 2 files that are mixed together.

**`TrainingConfig`**
- Defaults: 3 epochs, learning rate 2e-5, batch size "auto".
- Quantisation: 4-bit by default; also 8-bit, none, gptq, awq, hqq and others.
- LoRA: r 64 and alpha 16 by default; r 0 means full fine-tuning. Options include DoRA, rsLoRA, PiSSA and LoftQ.

**Eval gate during training (`EvalGateConfig`)**
- Fields: `suite`, `every_n_epochs`, `regression_threshold`, `baseline`, and `on_regression` (stop, warn or continue).
- Switched on with `soup train --gate`.

**Unknown config keys (`config/unknown_keys.py`)**
- They get up to two "did you mean" suggestions.
- The plan was to warn in 0.74 and refuse from 0.75, so 0.76 should refuse them.

**Training:** one wrapper per task builds the matching TRL trainer (`trainer/*.py`).

### C3. Key mechanisms as implemented

**Data format detection** (`data/formats.py`, checked directly)
- It samples the first 100 rows. Each row takes the first format whose required keys are all present, in this order:
  alpaca → llava → sharegpt4v → kto → dpo → embedding → tool-calling → audio → asr → sharegpt → chatml → plaintext.
- If the sampled rows disagree, detection fails and asks for `data.format`. The exception: a simpler and a richer format of the same family can be merged when the richer converter gives identical output.

Required keys per format:

| Format | Required keys |
|---|---|
| alpaca | instruction, output |
| kto | prompt, completion, label |
| dpo | prompt, chosen, rejected |
| tool-calling | messages, tools |
| sharegpt | conversations |
| chatml | messages |
| plaintext | text |

- **dpo:**
  - `prompt` may be text or a list of messages. A message needs only a non-empty `role` string, so a system message is accepted.
  - `chosen` and `rejected` may be text (each becomes one assistant turn) or non-empty lists of messages, but both must be the same kind.
  - Null values are refused.
  - **Other keys are not read**, so extra keys are tolerated.
- **chatml:** messages pass through unchanged, and a system role is allowed.

**Validation** (`data/validator.py`)
- It counts exact duplicates, rows the converter would drop (showing the first 3 reasons), nulls, and samples under 10 characters.
- It estimates lengths as characters ÷ 4.
- It does not flag extra keys and does not parse JSON-text answers.

**Loading** (`data/loader.py`)
- The train/validation split is positional: **the end of the file becomes validation.**
- Columns the task does not need are dropped.

**SFT** (`trainer/sft.py`, `data/sft_format.py`)
- By default the loss is computed on assistant turns only.
- A chat template is required, from the tokenizer or the config.
- Bundled templates: chatml, qwen/qwen2.5, phi4, llama3, mistral, gemma3, deepseek-r1.
- **There is no qwen3 template and no special handling of thinking blocks.**

**DPO** (`trainer/dpo.py`)
- Rows go to TRL's DPOTrainer. With LoRA, the reference model is the frozen base.
- `dpo_beta` sets beta, with an optional beta schedule.

**GRPO** (`trainer/grpo.py`, `trainer/rewards.py`)
- **Built-in rewards:**
  - `accuracy`;
  - `format` (checks for a think block);
  - `verifiable`, with three domains:
    - math: numeric tolerance;
    - code: run in a best-effort sandbox;
    - json_schema: partial credit for required fields with the right type, taken from a `schema` column.
- **Custom rewards:**
  - A Python file with `reward_fn(completions, **kwargs)` gets the row's other columns.
  - It runs without a sandbox, with a warning.
- On CPU, GRPO is labelled experimental.

**Eval gate** (`eval/gate.py`, `soup eval gate`; checked directly)
- **The suite** is `evals/gate.yaml`: a list of named tasks, each with a type and a threshold.
- **Task types:**
  - **custom:** a JSONL file scored as exact, contains, answer, regex or semantic.
  - **judge:** a judge model (Ollama, https or localhost) grades the answers on a rubric, rescaled to 0–1.
  - **benchmark:** a registered suite such as `mini_mmlu`.
- **Baselines** come from the registry or from a file stamped with the Soup version and **scorer revision**. A mismatched stamp only warns.
- **Regression:** a task regresses when it drops more than `regression_threshold` (default **0.05** absolute) below the baseline for the same task name.
- **Pass rules:** a task passes if it meets its threshold *and* has not regressed. A task that raises an error gets no score, so it fails. The gate passes only if every task passes.

**Ship decision** (`commands/ship.py`, `utils/ship_verdict.py`, `decide_ship`; checked directly)
- **Leg 1, task win:** the tuned model must **strictly beat the base model** on the target task, by more than the task's noise floor if one was measured. There are three modes:
  - metric;
  - judge score;
  - pairwise: a judge win rate tested against 0.5, with the answer order swapped to remove position bias.
- **Leg 2, no regression:** no general benchmark measured in both runs may drop by more than the larger of 0.05 and its own noise floor. A floor can widen the tolerance but never tighten it, and `floor_exceeds_threshold` reports when a floor is wider than the threshold.
- **SHIP needs all three:**
  - leg 1 passes;
  - at least one benchmark was compared;
  - nothing regressed.
- **Failure codes, in order of precedence:** missing baseline, task win, regression.
- **Noise floor** (`compute_noise_floor`): the unchanged base model is run several times, and the floor is the spread (max − min) of its scores.
- **Offline replay:** `--evidence` takes a JSON of precomputed scores and gives a verdict without a GPU.
  - Fields: task (mode, base, tuned), benchmarks, noise floor, provenance, numerics.
  - Unknown keys are rejected, and a config-hash mismatch is refused.
  - `--emit-evidence` writes this file.
- **Exit codes:** 0 ship, 2 don't ship, 3 usage error, 1 runtime error (from the docs; we did not read the constant values).

**Bundled general suites** (`eval/gate_suites.py`)
- `mini_mmlu`, `mini_arithmetic` and `mini_common_sense`, each about 40 items.
- `mini_tool_call`, `mini_format_json`, `mini_safety`, `mini_over_refusal`.
- Answers are capped at 256 new tokens. The scorer revision number and a fingerprint detect silent scorer changes.

**Custom eval** (`eval/custom.py`)
- Rows are `{prompt, expected?, category?, scoring?}`.
- It runs a local transformers pipeline with greedy decoding and up to 512 tokens, **once per prompt**.
- **Prompts are sent as raw strings, without the chat template.**

**Other eval commands** (`commands/_eval_v0550.py`)
- `soup eval against`: a paired bootstrap of two runs (1,000 resamples by default), reporting the mean difference and a confidence interval.
- `discover`: a held-out canary set.
- `lock`: a checksummed suite.
- `gate-install`: a git pre-push hook.

**Diagnose** (`commands/diagnose.py`, `utils/diagnose/*`)
- **Seven probes:** forgetting, refusal, format, mode collapse, memorisation, contamination, citation.
  - **format:** the share of valid JSON, regex matches or valid tool calls.
  - **mode collapse:** the variety across 4 samples of the same prompt.
- **One set of bands for every probe:** OK at 0.85 or above, MINOR at 0.60 or above, MAJOR below.
- The overall result is the **worst probe**, and **NOT_RUN ranks worse than MINOR**.
- It runs live on CPU or CUDA, or from an evidence file.

**soup.lock** (`commands/lock.py`)
- **Pinned:** Soup version, base model, base model SHA, dataset SHA, an environment hash, a combined hash, and the creation time. The SHAs are entered by the operator.
- **`check`:** reports drift in the five content fields. A change of Soup version alone is only a note.

**GGUF export** (`commands/export.py`)
- An adapter is first merged into the base model in fp16 on CPU.
- **Finding llama.cpp:** `--llama-cpp`, then `LLAMA_CPP_PATH`, then `~/.soup/llama.cpp`. If none is found, it is **cloned automatically at the pinned tag `b5270`**.
- It installs gguf, sentencepiece and protobuf unless `--no-install-deps` is given.
- **Quantisation types:** q4_0, q4_k_m (default), q5_k_m, q8_0, f16, f32. Anything other than f16/f32 is converted to f16 first, then quantised with `llama-quantize`.
- No GPU is needed.

**Serving** (`commands/serve.py`)
- **Backends:** transformers (default), vllm, sglang, mii.
- **Endpoints:** OpenAI-style `/v1/chat/completions`, plus `/v1/messages`, `/v1/models`, `/health` and `/metrics`.
- Binds to 127.0.0.1 by default.
- **JSON-constrained output needs outlines or lm-format-enforcer.** Without them it **silently runs unconstrained**.
- No GGUF serving was found.

**CPU support** (`utils/gpu.py`, `commands/train.py`)
- **Device order:** CUDA, then MPS, then MLX, then CPU.
- **On CPU:**
  - `resolve_quantization` turns 4-bit and 8-bit off with a warning, because bitsandbytes needs a GPU;
  - training runs in float32, with no mixed precision and batch size 1.
- The README calls CPU training "experimental, very slow".

### C4. Research ideas worth knowing
1. **A two-leg ship decision:** a candidate must beat the current model on the task *and* must not regress on general skills (`utils/ship_verdict.py`).
2. **Noise floor:** a difference counts only if it is larger than the current model's own run-to-run spread (`compute_noise_floor`).
3. **Stamped baselines and scorer fingerprints:** a "regression" cannot come from a silently changed scorer (`eval/gate.py`, `eval/gate_suites.py`).
4. **Offline replay of a verdict from an evidence file with provenance** (`commands/ship.py`).
5. **A safety suite paired with an over-refusal suite** (`eval/gate_suites.py`).
6. **"Worst probe wins", and a probe that did not run counts as worse than a minor problem** (`utils/diagnose/report.py`).
7. **Unknown config keys refused, with did-you-mean suggestions** (`config/unknown_keys.py`).
8. **One exit-code scheme for every gate**, so a gate can be used from CI and git hooks.
9. **A paired bootstrap confidence interval for "is B better than A"** (`commands/_eval_v0550.py`).
10. **GRPO rewards that read the row's own columns**, so a reward can check against row-specific facts (`trainer/rewards.py`).

### C5. Comparison with our system

**Our equivalents**

| Ours | Soup |
|---|---|
| `model_eval.py` gate: validity ≥ 0.9, correctness ≥ 0.8, consistency ≥ 0.7 per task; SHIP / DON'T SHIP | `eval gate` + `ship` |
| `model_eval.lock()`: the model the server reports, the pinned GGUF sha256 from `config/local-model.lock.json`, prompt versions, cases fingerprint | `soup.lock` + ship provenance (Soup does not version prompts: a point for us) |
| `build_dataset.py` labels: good → `sft.jsonl`, fixable → `preference.jsonl`, bad → discarded, scenario/allocator → awaiting outcome | sft / dpo / kto formats |

**Concrete compatibility check of our data formats**

**`<task>/sft.jsonl`** — rows are `{messages: [system, user, assistant]}`, and the assistant content is a JSON string.
- **It loads as-is, detected as `chatml`.** It has `messages` and none of the alpaca, kto, dpo or tools keys.
- The system role is allowed. A JSON string is ordinary text to Soup, and the loss falls only on the assistant's JSON.
- **Operational changes needed (not format changes):**
  1. **Our files are split per task** (`claims/sft.jsonl`, `debate/sft.jsonl`, …). Pass them as a `data.train` list or join them. Never mix sft and preference rows in one file: detection would fail because the formats disagree.
  2. **Shuffle the rows before training.** The validation split is the end of the file, and our rows are ordered by task and source, so validation would otherwise be one task only.
  3. **Raise `data.max_length` above 2048.** Claims prompts contain the full news text, and the R&D prompt contains the grammar and the lessons. Check token lengths first with `soup data` validation.
  4. **There is no qwen3 template in Soup**, so it would use Qwen3.5's own tokenizer template. Check how that template treats think blocks and which tokens get loss (Soup's data doctor with its loss-mask view) before any run. We could not read `data/loss_mask.py`.

**`<task>/preference.jsonl`** — rows are `{prompt: [system, user], reasons: [...], chosen: [assistant], rejected: [assistant]}`.
- **It loads as-is, detected as `dpo`** (the message-list form; checked directly in `formats.py`).
  - The system message inside `prompt` is accepted.
  - `chosen` and `rejected` are both lists, which is allowed.
  - **The extra `reasons` key is ignored.**
- **It can be used with the dpo, orpo, simpo or ipo tasks.**
- **A content warning, not a format problem.** Our `chosen` is the `rejected` answer with the failing items removed or one field fixed (e.g. bad claims dropped, `evidenceId` set to null, `decidedBy` set to owner). The pair differs only in what was removed, so DPO may learn "say less" or "cite nothing" rather than "be right".
  - Mitigation: keep the pairs where the fix *changes* a field, not only those where it deletes items.
  - Also add SFT rows of good answers that do contain claims and citations.
  - Use Soup's preference-data lint as a second check.

**Things that would not work as-is**
- **KTO:** we write no `{prompt, completion, label}` rows yet. Our "bad" answers are currently thrown away and would make natural `label: false` rows.
- **GRPO with our checks as rewards:** this would need a custom `reward_fn` file that calls our own `claims.verify` and the other judges. Possible later, but GPU-bound.

**Our eval gate compared with Soup's**

**What Soup has and we lack (GAPS)**
1. **No comparison with the current model.** Our gate uses fixed thresholds only, so a fine-tune can pass while being *worse* than today's Qwen3.5-4B. Soup requires a strict task win over the base plus no drop > 0.05 against a stored baseline.
2. **No noise floor.** We run 2 repeats but never measure the current model's own spread, so we cannot say whether a difference is real.
3. **No general or behaviour regression suite** (JSON format, over-refusal, forgetting) outside our six tasks.
4. **The judging code is not versioned.** `PROMPT_VERSIONS` covers prompts and schemas, but a change to `judge()` or `claims.verify` would shift scores silently. Soup stamps a scorer revision and fingerprint.
5. **Contamination risk.** `build_dataset.py` includes rows from evaluation runs (`.local/model-eval/*/results.jsonl`) in `sft.jsonl` and `preference.jsonl`. A model trained on them would later be graded on its own training cases. Today only the manifest's note warns about this.
6. **No exit code for automation.** `model_eval.py main` prints DON'T SHIP but always exits 0.
7. **A "not run" result is not treated as a failure.** A task with no cases simply drops out of `summarise`, while the overall verdict needs only that the tasks present pass. Soup's diagnose ranks NOT_RUN worse than MINOR, and its gate fails a task that errors.

**What we have and Soup lacks**
- **Consistency:** repeats plus a reordered variant, with the same decision required. Soup's mode-collapse probe rewards variety, the opposite goal for our decision tasks.
- **Domain correctness from our production validators**, including prompt-injection cases.
- **Errors by kind** (timeout, incomplete, invalid JSON, server down) and latency p50/p90/max.
- **Testing the model exactly as deployed:** the quantised GGUF under llama.cpp, with schema-constrained JSON and the real production prompts imported from code.
  - Soup's eval commands take only a local Hugging Face model path; none takes a server address.
  - Soup's quantisation check refuses `.gguf` files.
  - Soup's custom eval sends prompts without the chat template.
  - Its judge can call a local OpenAI-compatible server (a "server" provider with an API base), but only to *grade* answers, not as the model being tested.
  - **So Soup cannot run our suite. Our suite should stay the final ship gate.**

**Ideas to adopt in our own design**

| Idea | Why / benefit | Effort |
|---|---|---|
| (a) **Baseline + drop rule** in `summarise`: store the current model's report as the baseline; a candidate fails a task if it drops more than max(0.05, noise floor) on validity, correctness or consistency, and must be at least as good overall | Stops a worse model shipping | Low |
| (b) **Noise floor**: run the current model 3 times and record each metric's spread | Real differences vs luck | Low (CPU time only) |
| (c) **Judge fingerprint** in the lock (a hash of the source of `judge` and the validators it calls) | Score changes traceable to code changes | Low |
| (d) **`source` field on every row plus a hard rule in `build_dataset.py`**: evaluation-sourced rows never go into a training file (or go to a separate test file) | No contamination; Soup ignores extra keys, so it stays compatible | Low |
| (e) **Non-zero exit code on DON'T SHIP** (e.g. 2, like Soup) | Usable from the cycle, release gate and hooks | Trivial |
| (f) **A missing or empty task counts as a failure** in the overall verdict | A task that never ran can't make the headline read SHIP | Trivial |
| (g) **KTO export** from good/bad labels | Uses the data we throw away | Low |
| (h) Optional: **write Soup's evidence JSON** from our report, for a second offline verdict | Cross-check with a standard tool | Medium, optional |
| (i) Later: **our deterministic checks as GRPO rewards** | Trains directly on checks we trust | Needs a GPU |

**Not worth adopting now**
- Soup's own transformers server: not better than llama.cpp on CPU, and it can silently drop the JSON constraint.
- vLLM, the cloud and deployment machinery, and the large recipe catalogue.
- lm-eval general benchmarks: heavy, and not about our jobs.
- GGUF export with the auto-cloned llama.cpp `b5270`, which probably predates Qwen3.5 (unverified). If we ever export, point `--llama-cpp` at the llama.cpp build we already run and pass `--no-install-deps`. Ask the owner before any install, per the office-laptop rule.

**Is fine-tuning Qwen3.5-4B on this CPU laptop with Soup realistic? No.**
- On CPU, 4-bit is forced off and training runs in float32 at batch size 1. The weights alone are about 16 GB, before activations and optimiser state.
- Our estimate (unmeasured) is minutes per step for prompts of about 2,000 tokens, if the RAM suffices at all.
- **The realistic route:** train on a GPU (rented or Colab), export a GGUF, then run *our* `model_eval.py` against that GGUF under llama.cpp. That conflicts with the "cloud only after profit" plan, so it waits for the owner.
- **Until then:** the useful work is data quality and eval gate improvements (a)–(g), which need no GPU.

### C6. What we could not verify
- The numeric values of the exit-code constants (2 and 3 come from the docs).
- The defaults for `eval against` (alpha and threshold).
- Whether transformers 5.16 and TRL 0.29 support the Qwen3.5 architecture, and whether llama.cpp `b5270` can convert it.
- How the Qwen3.5 template interacts with assistant-only loss masking and think blocks (`data/loss_mask.py` not read).
- Whether bitsandbytes imports on Windows with CPU-only torch, and whether Soup officially supports Windows.
- Real CPU step times.
- The number of bundled suites: the docs say 8, we found 7 names in the code.
- The on-disk format of `soup.lock`.
- `config/schema.py` (about 400 KB) and `commands/train.py` were read only in part.

---

## D. Shortlist across the three repos (our own design work, in rough order of value)
1. **Eval gate:** a baseline-drop rule plus a noise floor, a judge fingerprint, a non-zero exit code, and "not run counts as failed" (Soup).
2. **Training data:** a hard split so evaluation rows never reach training files, and checking the "deletion-only" preference pairs (Soup).
3. **Data age and the last good value** everywhere in owner views (Fincept DataHub).
4. **A circuit breaker per model agent and counted fallbacks** (Fincept Arena; MiroFish fallbacks; our panel's silent "flat").
5. **Approvals that expire**, with a re-check at approval time (Fincept Action Center).
6. **An assumptions block** on every research and backtest result (Fincept backtesting base).
7. **Scenario panel experiments, all in shadow and scored:** earned vote weights, two-round deliberation, story-specific personas, and interviews after a wrong call (MiroFish).
8. **The dashboard layout of section B6**, plus a stress table and each holding's share of risk on Money (Fincept).
