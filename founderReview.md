# Founder review: what needs you, and the decisions waiting (updated 23 October 2026)

This file lists everything only the founder can do or decide. Everything else, the agents and development can do by
themselves. Each item says what it is, why it matters, the recommendation and where the evidence is. Tick items off by
answering in a session ("decision 3: yes"). This file is updated as items close.

**Where things stand (23 Oct).**
- **Trading:** paper only, and two bots.
  - `momentum-rules` (release v2, ₹5,000 budget) holds HDFC Bank, Axis Bank and ICICI Bank. It is at −₹134 (−2.7%),
    0.9 points behind simply holding the 8 shares.
  - `trend-bot` (₹1,000 budget) is +₹48 overall, and 1.8 points ahead of the basket since 16 Oct.
- **Backend:** one full live cycle ran on 22 Oct, with all 35 steps done. Migrations 052–054 are applied. The backend
  was stopped again afterwards.
- **Model:** Qwen 3.5-4B passes **7 of 8** evaluation tasks. R&D invention and the allocator wait on B10 and B11. It
  is installed but not yet switched on in the cycle (step A5).
- **Research:** on 10 years of data, no strategy beats simply holding the 8 shares after costs and tax. The most
  consistent lead is quarterly momentum: all 4 neighbouring settings also beat the basket, but it is not proven (p 0.10).
  - [Research notes and gap analysis](docs/research-notes/README.md)
  - [Roadmap to proven skill](docs/skill-roadmap.md)
- **Code:** everything is pushed. `main` holds all the work; `dev` is the working branch.
- **Data:** everything is in the private data repository, with a verified backup taken on 23 Oct.

---

## Part 0: your first three days on the new machine, without Claude

Follow [STARTUP.md](STARTUP.md) for every command. Keep a notes file as you go, `.local/owner-notes.txt`, with the date, what you did, and anything odd:
the exact message and which step. It is never committed to the code repository, and the weekly data export carries it
to your private data repository, where Claude can read it later.

**Day 1 (best on a Saturday): move to the new machine and switch on.** Markets are closed, so nothing trades.
1. Set up the new machine: STARTUP.md section 1, steps 1–8. Finish only when `verify` says ALL CHECKS PASSED and
   `preflight` says READY.
2. Run Part A below, A3 to A12, in order:
   - Take the decisions you are sure about now: brakes (A4b, the suggested file is fine) and the model (A5).
   - On your own machine the supervisor can be registered as a scheduled task (A7).
3. Optional but useful:
   - copy [`docs/policies/events-example.json`](docs/policies/events-example.json) to `.local/events.json` and put in
     the real results, RBI, Budget and FOMC dates you know ([events calendar](docs/events-calendar.md));
   - create `.local/nse-holidays.json` from NSE's holiday circular (A9).
4. Check: `npm run status` should show Backend up, Supervisor alive and no failed steps.

**Day 2 (Sunday, or the next evening): let it run, and decide.** The supervisor polls news every 30 minutes, on any day.
1. `npm run status`: the supervisor should be alive, and its next job the readiness check of the next trading day at 09:00.
2. Read Part B and write your answers in your notes. The five that unblock the most work: **B1, B3, B4, B6 and the
   limits (B26)**. "All recommended" is a valid answer.
3. Optional (B14, the biggest data lever): download NSE's NIFTY 50 reconstitution notices and write the monthly member
   lists into `.local/trading-desk/datasets/nifty50-membership.json` (format in
   [research methods](docs/research-methods.md)).

**Day 3 (the first trading day on the new machine).**
1. Around 09:00 the readiness check runs by itself. `npm run readiness` shows it.
2. After 16:05 the cycle runs by itself, with the model if A5 is on. That takes 30–60 minutes.
3. Read `.local/digests/<today>.md`:
   - "Needs you" first;
   - then "Can you trust this digest?": it should say "Yes", or tell you what to check;
   - then answer `npm run agenda`.
4. That evening, with the backend stopped: run the backup and the data export (A13), then push `.local/data-repo`.

**When you come back to Claude:** say "Read founderReview.md Part 0 and my notes", and paste your notes and your
decisions. Development continues from there.

---

## Part A: the switch-on (on the new machine), in order

On the new machine, A1 and A2 are already covered by STARTUP.md section 1: the preflight, and the restore of the 23 Oct
backup.

| # | Step | Command | Why |
| --- | --- | --- | --- |
| A1 | **Check everything** | `npm run preflight` | Read-only. It says READY or NOT READY and gives the command for every gap |
| A2 | **Backup first** (backend stopped) | `npm run backup -- create` | Migrations 052 (standing approvals), 053 (refused orders) and 054 (loss brakes) apply on the next start. A backup makes them reversible, and the preflight wants a backup newer than 054 |
| A3 | **Start the backend** | `npm start` | Nothing runs while it is down |
| A4 | **Apply the starter policy** | `npm run autonomy -- set docs/policies/autonomy-starter.json --reason "Starter: protect, repair, roll back"` | The agents may suspend losing bots, roll back failing releases and trial same-rule fixes by themselves. No money moves by itself ([autonomy](docs/autonomy.md#the-starter-policy)) |
| A4b | **Set the loss brakes** (decision B3) | `npm run protections -- set docs/policies/protections-suggested.json --reason "Founder thresholds"` | Built and switched off. Until you set them, losses never pause a bot. Suggested (revised 27 Oct after the 2020 replay): a 3% fall in value in a day or 6% in a week. Only new buys pause, each pause lifts by itself, and exits stay allowed ([protections](docs/protections.md)) |
| A4c | **Check the limits banner** | Read "Can you trust this digest?" in the first digest | It shows the limits the running backend actually loaded, and says by name when a setting differs (the stale `MAX_ORDER` problem) |
| A5 | **Turn on the model** | Add `MODEL_AUTOSTART=qwen3.5-4b-q4km` to `.env` | Switches on the claim analyst, learning, R&D invention, the debate desk, the scenario panel, TradingAgents and playbook drafts |
| A6 | **Set up the model members** (after A5) | `npm run members -- apply tradingagents --yes` and `npm run members -- apply debaters --yes`, then restart the backend | Gives TradingAgents and the bull/bear debaters their identities and credentials. They start in shadow |
| A7 | **Keep the organisation running** | `npm run supervisor`, or once: `pwsh -File scripts\install-supervisor-task.ps1` | Readiness at 09:00 IST, the cycle at 16:05 IST, a Friday backup, and news every 30 minutes on any day, with catch-up if the machine slept. While the supervisor runs, let it start the backend; don't also run `npm start`. On an office laptop, check your IT policy before registering a scheduled task |
| A8 | **An alert channel** | `ALERT_WEBHOOK_URL=` in `.env` (an ntfy topic works) | Alerts go only to a local file today |
| A9 | **NSE holiday file** | Copy this year's dates from NSE's circular into `.local/nse-holidays.json` | Otherwise holidays look like missing data |
| A10 | **World news sources** (optional) | `npm run world -- probe --all`, then `npm run world -- enable <ids> --yes` | Adds central banks, regulators and publishers from the US, Europe, the UK and China ([world news](docs/world-news.md)) |
| A11 | **A research source for R&D births** (optional) | Register and approve a source, then set `RND_SOURCE` in `.env` | Lets a passing idea become a birth proposal |
| A12 | **Check the result** | `npm run status` and `npm run readiness` | Health, supervisor heartbeat, regime, research and world lines |
| A13 | **Weekly: back up and export the data** | `npm run backup -- create` (backend stopped), `npm run export-data -- --write`, then commit and push `.local/data-repo` | Keeps the private data repository [trading-organisation-data](https://github.com/KeerthanMuniRaja/trading-organisation-data) current, so you can continue on any machine ([data export](docs/data-export.md)). First export done on 21 Oct |
| A14 | **Keep a safe copy of your secrets** (once, and after changes) | Copy `.env`, `.local/credentials.json` and `.local/owner-signing-key.pem` to a password manager or an encrypted pen drive | They are deliberately in neither repository. Without them, a new machine cannot act as the owner |

**Days after the switch-on:** read the digest in `.local/digests/<day>.md` ("Needs you" comes first). Answer the agenda
with `npm run agenda`.

---

## Part B: decisions waiting for you

### Money and trading

| # | Decision | Options | Recommendation | Evidence |
| --- | --- | --- | --- | --- |
| B1 | **The live momentum bot** | (a) keep it monthly on ₹5,000; (b) make a yearly-rebalanced release; (c) stop it | **(b), or (a) as a pure experiment.** After tax over 10 years: monthly 9.8%, yearly 11.2%, basket 12.55%. Neither beats holding | [roadmap](docs/skill-roadmap.md) |
| B2 | **The basket as the default home for money** | Bots get budget only by beating holding the 8 shares after tax on their live record | **Yes.** It is the honest benchmark, and no strategy beats it yet | [roadmap](docs/skill-roadmap.md) |
| B3 | **Self-expiring loss brakes: the thresholds** | The mechanism is **built and off** (21 Oct, migration 054). You choose the numbers, or `{}` for none, with one command (step A4b) | **Yes, the suggested file, revised 27 Oct:** measured on value (open positions included), pause at a 3% fall in a day or 6% in a week; no monthly window, no losing-streak brake. In the 2020 crash replay the first suggestion (realised losses, with a monthly window) made the bot −15.0% against −6.7% with these, −7.5% with none, and −20.6% for the basket: it tripped on the April rebalance and kept the bot out of the rebound | [protections](docs/protections.md) |
| B4 | **Unrealised-loss protection and horizon exits** | A portfolio drawdown halt on marked value; optional trailing stops; close or renew a position when its horizon passes | **Yes to the drawdown halt and horizon renewal;** stops optional | [gap analysis A2](docs/research-notes/README.md) |
| B26 | **The organisation exposure limit** | Today it equals the order limit (₹5,000). momentum-rules holds about ₹4,139, so trend-bot can barely use its ₹1,000 budget, and we learn little from it | **Raise it, for example `MAX_EXPOSURE_PAISE=1000000` (₹10,000) in `.env`,** then restart the backend. The digest's limits banner shows the loaded value | Found in the 22 Oct run |
| B27 | **The lifetime realised-loss limit** | `MAX_REALISED_LOSS_PAISE` counts the organisation's net realised loss over its **whole life**; at the limit every new buy stops until you raise it. Today it is ₹1,000 | **Raise it to ₹2,500 (`MAX_REALISED_LOSS_PAISE=250000`) if you apply the charter.** The 2020 crash alone used ₹947 of ₹1,000, so a year unattended would freeze. The charter's stop (₹2,000, open losses included) then fires first, and this hard limit sits above it | [charter](docs/charter.md), 2020 replay |
| B5 | **The regime as a sizing input** | Today the regime is advice only. Option: size new buys down at HIGH or SEVERE | **Not yet.** Regime v2 (closer to the original specification) was tested on 21 Oct: it warns of falls less sharply than v1 and calls SEVERE on 42% of days. A re-entry signal is still untested | [market regime](docs/market-regime.md) |

### Research and scoring

| # | Decision | Options | Recommendation | Evidence |
| --- | --- | --- | --- | --- |
| B6 | **A neutral band in call scoring** | Moves within about ±0.5% count as neither right nor wrong. Today an exit is "right" on any fall, even 0.05% | **Yes** (a new scoring version; earlier scores keep their version) | [gap analysis §2](docs/research-notes/README.md) |
| B7 | **Risk as a pass criterion** | Let an idea pass on a better Sharpe and a smaller fall, at the same strict bar | **Keep it report-only for now.** No idea would pass on risk either | [research methods](docs/research-methods.md) |
| B8 | **7 NIFTY 50 shares kept back** for one-day moves over 20% (research only) | Confirm each real move, so the share joins research | Confirm the real ones: Bajaj Finance, Bajaj Finserv and Shriram Finance (COVID crash, 23 Mar 2020), Adani Ports (election-results day, 4 Jun 2024), Adani Enterprises (several days, including the Hindenburg crash). **Do not confirm** Tata Motors PV −40% on 14 Oct 2025 (likely its demerger, an adjustment rather than a move). **Check** Trent −33% on 1 Jan 2026 (unexplained) | [research methods](docs/research-methods.md) |

### The model and its members

| # | Decision | Options | Recommendation | Evidence |
| --- | --- | --- | --- | --- |
| B9 | **The TradingAgents member's memory file** | It writes its own memory, which steers later decisions but is not part of its locked release | **Turn it off while the member is in shadow,** and lock it into the release later | [TradingAgents note](docs/research-notes/tradingagents-and-finnewshunter.md) |
| B10 | **Model gate: per-task consistency bars** | The current model is 100% valid and safe but sensitive to wording or order | **Keep 70% for the allocator and debate; relax it for R&D invention,** where variety is expected | [model evaluation](docs/model-eval.md) |
| B11 | **The allocator's order bias** | List shares in a fixed order (a prompt change means a new forward test) | **Yes,** when the allocator is switched on | [model evaluation](docs/model-eval.md) |
| B12 | **A Soup fine-tune** | Needs an NVIDIA GPU (cloud: Kaggle or Colab) and weeks of production data | **Later,** once data has built up; it must beat our evaluation suite | [model evaluation](docs/model-eval.md) |

### Data and sources (approvals)

| # | Approval | Why | Note |
| --- | --- | --- | --- |
| B13 | **Confirm the data terms:** Yahoo prices and publisher RSS headlines for personal paper research | Our only price and news sources | Publisher terms could not be read automatically |
| B14 | **Point-in-time index membership** (NIFTY 200/500 as they were each month) | The biggest lever for proving any skill. Today's members over past years flatter every result | NSE reconstitution press releases (manual download) or a paid dataset |
| B15 | **A fundamentals and filings data provider** | Results against expectations, promoter trades, flows: where the model can genuinely help | Most likely paid. NSE and BSE pages restrict scraping |
| B16 | **A second price source** (NSE bhavcopy) and a catalyst calendar (results, RBI, Budget, FOMC) | Cross-checks prices; knows what is scheduled | Manual or approved download |

### Real-time testing

| # | Decision | Options | Note |
| --- | --- | --- | --- |
| B17 | **A broker for a live price feed** | Zerodha Kite Connect (adapter exists), Upstox, Angel One SmartAPI or Dhan | Needs an account there and a daily login token. The intraday monitor is built and tested on replays ([intraday monitor](docs/intraday-monitor.md)) |
| B18 | **Office-laptop approval** to run a broker API through the session and a scheduled task | Your IT policy | — |

### The frontend (discussion so far: 8 tabs)

| # | Question | Options |
| --- | --- | --- |
| B19 | **Tabs** | 8 (Home, Decisions, Members, Trading, Money, Research, Knowledge & News, Operations), 6 (merged) or 9 (with an AI Model tab) |
| B20 | **Where it runs** | Laptop only, or phone too (exposing it needs care; phone alerts via ntfy may be enough) |
| B21 | **Can it act?** | View-only, or accept, decline and suspend with confirmation (money stays signed) |
| B22 | **Look** | Dark or light; dense like a terminal, or simple like a dashboard |

### Repository

| # | Decision | Note |
| --- | --- | --- |
| B23 | ~~Merge `dev` into `main`~~ **Done 23 Oct** (pull request #2, then again before the move) | Your commits now count on GitHub on the days you made them |
| B25 | **The code repository is public** | Trading-Organisation can be read by anyone, including this file, your portfolio size and the docs. It holds no secrets (a secret scan runs before every push), and the data is in the private repository. **Recommendation: make it private** (GitHub → Settings → Danger zone → Change visibility), unless you want it public. The public results page `trading-desk-results` is separate and unaffected |

### Running all the time

| # | Decision | Options | Note |
| --- | --- | --- | --- |
| B24 | **A machine that stays on** (for 24/7 news collection, overnight model work and, later, intraday) | A home mini PC (16 GB RAM, 6–8 cores, 256 GB SSD, about ₹12–20k), an old personal laptop with 16 GB RAM, or a free cloud computer (the data would leave your premises) | Until then, run once a day after the close (about an hour). The supervisor catches up on what it missed. Development of a 24/7 service mode can start without this decision |

---

## Part C: done by the agents without you (for your information)

These are fixes from the gap analysis that need no decision.

**Done on 21 Oct** (see the [project log](docs/project-log/2026-10-21.md)):
- **The debate:**
  - it sees only news and prices from before the call;
  - it is a real debate, where the bull answers the bear;
  - it sees the bot's own record, "data missing" markers and a press dossier from the knowledge index.
- **The scenario panel:** a voice that fails is counted, never treated as flat.
- **The model gate:** it fails missing tasks, flags regressions against a baseline, fingerprints its judges and exits
  non-zero on DON'T SHIP.
- **Training data:** evaluation answers never enter it.
- **The regime:** it is marked when stale or incomplete. Regime v2 was compared, and v1 stays.
- **The knowledge index:** news, stories, drivers, regimes, ideas, method cards, problems and panel calls are connected
  and searchable point-in-time ([knowledge index](docs/knowledge-index.md)).
- **Statistical guards:** a deflated Sharpe ratio, a turnover-matched random baseline, years ahead, twice the costs and
  India's crisis windows. Nothing beats luck: the best is 0.31, against a bar of 0.95.
- **Run manifests:** the code, switches and prices behind every cycle run.
- **The digest:** a self-check, "Can you trust this digest?".
- **The review scorecard:** whether the risk review turns down worse calls than it takes, by reason and by regime. It
  needs live calls to say anything.

**Done later on 21 Oct:**
- **Refused orders** are recorded (migration 053). A refused reserve or fill is kept after its rollback, once per
  request, and the digest counts them.
- **Limits banner:** the digest shows the limits the running backend loaded, and warns by name when a setting differs.
- **More self-checks:** the digest checks its own arithmetic and flags cycle runs that never finished.
- **Review scorecard:** it now also shows the regime when each call ended, and the worst and best price while each buy
  was held.
- **Loss brakes:** the mechanism is built and switched off; only the thresholds wait on you (B3, step A4b). The review
  rules are now `signal-risk-v3`, which is identical to v2 until brakes are set.

**Done 22–23 Oct** (see the [project log](docs/project-log/2026-10-21.md)):
- **News all day:** the supervisor polls news every 30 minutes, on any day.
- **Research:**
  - the follow-through-day re-entry signal (no edge);
  - a shuffled-history test (no idea shows that its timing matters);
  - a plateau report (quarterly momentum sits on a plateau);
  - point-in-time NIFTY 50 research, once you provide the membership file (B14).
- **Agents:**
  - a circuit breaker for failing model steps;
  - a headline reader;
  - a weighted, two-round scenario panel with persona lessons;
  - TradingAgents readability counts;
  - an events calendar for the debate, the panel and the digest.
- **Debate citations are now grounded:** a citation counts only when its quote is found in the evidence, or the code
  derives it from the argument's own words.
- **Model:** **7 of 8 tasks pass** on Qwen 3.5-4B ([model evaluation](docs/model-eval.md)).
- **The first live run (22 Oct):** clean. It found and fixed a missing basket comparison for trend-bot.

**Done 27 Oct: fast-forward replay** ([replay](docs/replay.md)). The real system, run over a past stretch of
trading days in an isolated copy. Three months of 2025 replayed with no failures in 46 minutes, and the rule bot again
trailed the basket (+6.6% against +8.6%). You can run it yourself: `node scripts/replay-org.mjs prepare`, then
`run --from <date> --to <date>`.

**Still to do, no decision needed:**
- the NSE bhavcopy price cross-check, which stays off until you approve the source (B16).

## Part D: things you should know

- **The system tells the truth, including bad news.** It found no proven edge, corrected its own earlier over-optimistic
  numbers on 21 Oct, and labels everything paper, unverified, inferred or seen history.
- **Reference projects:** on your instruction (21 Oct), useful code may be taken from them for this personal project,
  with a one-line source note. Because the code repository is public, making it private (B25) avoids any licence
  question for the copyleft ones (FinceptTerminal, MiroFish, backtesting.py, freqtrade).
- **The office laptop:** nothing is downloaded, installed, run in the background or pushed without your OK, except
  what you have authorised (pushes to `dev` when asked).
- **The new machine:** once you switch on there, run the organisation there only. Don't run it on the office laptop as well.
