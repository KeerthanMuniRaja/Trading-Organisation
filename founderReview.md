# Founder review: what needs you, and the decisions waiting (21 October 2026)

This file lists everything only the founder can do or decide. Everything else, the agents and development can do by
themselves. Each item says what it is, why it matters, the recommendation and where the evidence is. Tick items off by
answering in a session ("decision 3: yes"). This file is updated as items close.

**Where things stand.**
- **Trading:** paper only. One live bot (`momentum-rules`, release v2) has a ₹5,000 budget and holds HDFC Bank ×2, Axis
  Bank ×1 and ICICI Bank ×1, at about −₹102 after fees on 20 Oct.
- **Backend:** stopped since 20 Oct.
- **Model:** the local model (Qwen 3.5-4B) is installed but not switched on, so 8 agent roles are idle.
- **Research:** on 10 years of data, no strategy beats simply holding the 8 shares after costs and tax.
  - [Research notes and gap analysis](docs/research-notes/README.md)
  - [Roadmap to proven skill](docs/skill-roadmap.md)

---

## Part A: the switch-on (planned for Saturday 24 Oct), in order

| # | Step | Command | Why |
| --- | --- | --- | --- |
| A1 | **Check everything** | `npm run preflight` | Read-only. It says READY or NOT READY and gives the command for every gap |
| A2 | **Backup first** (backend stopped) | `npm run backup -- create` | Migration 052 (standing approvals) applies on the next start; a backup makes it reversible |
| A3 | **Start the backend** | `npm start` | Nothing runs while it is down |
| A4 | **Apply the starter policy** | `npm run autonomy -- set docs/policies/autonomy-starter.json --reason "Starter: protect, repair, roll back"` | The agents may suspend losing bots, roll back failing releases and trial same-rule fixes by themselves. No money moves by itself ([autonomy](docs/autonomy.md#the-starter-policy)) |
| A5 | **Turn on the model** | Add `MODEL_AUTOSTART=qwen3.5-4b-q4km` to `.env` | Switches on the claim analyst, learning, R&D invention, the debate desk, the scenario panel, TradingAgents and playbook drafts |
| A6 | **Set up the model members** (after A5) | `npm run members -- apply tradingagents --yes` and `npm run members -- apply debaters --yes`, then restart the backend | Gives TradingAgents and the bull/bear debaters their identities and credentials. They start in shadow |
| A7 | **Keep the organisation running** | `npm run supervisor`, or once: `pwsh -File scripts\install-supervisor-task.ps1` | Readiness at 09:00 IST, the cycle at 16:05 IST and a Friday backup, with catch-up if the laptop slept. **Check your IT policy before registering a scheduled task on the office laptop** |
| A8 | **An alert channel** | `ALERT_WEBHOOK_URL=` in `.env` (an ntfy topic works) | Alerts go only to a local file today |
| A9 | **NSE holiday file** | Copy this year's dates from NSE's circular into `.local/nse-holidays.json` | Otherwise holidays look like missing data |
| A10 | **World news sources** (optional) | `npm run world -- probe --all`, then `npm run world -- enable <ids> --yes` | Adds central banks, regulators and publishers from the US, Europe, the UK and China ([world news](docs/world-news.md)) |
| A11 | **A research source for R&D births** (optional) | Register and approve a source, then set `RND_SOURCE` in `.env` | Lets a passing idea become a birth proposal |
| A12 | **Check the result** | `npm run status` and `npm run readiness` | Health, supervisor heartbeat, regime, research and world lines |

**Days after the switch-on:** read the digest in `.local/digests/<day>.md` ("Needs you" comes first). Answer the agenda
with `npm run agenda`.

---

## Part B: decisions waiting for you

### Money and trading

| # | Decision | Options | Recommendation | Evidence |
| --- | --- | --- | --- | --- |
| B1 | **The live momentum bot** | (a) keep it monthly on ₹5,000; (b) make a yearly-rebalanced release; (c) stop it | **(b), or (a) as a pure experiment.** After tax over 10 years: monthly 9.8%, yearly 11.2%, basket 12.55%. Neither beats holding | [roadmap](docs/skill-roadmap.md) |
| B2 | **The basket as the default home for money** | Bots get budget only by beating holding the 8 shares after tax on their live record | **Yes.** It is the honest benchmark, and no strategy beats it yet | [roadmap](docs/skill-roadmap.md) |
| B3 | **Self-expiring loss brakes** | Pause a bot after a daily, weekly or monthly loss or a losing streak; the pause lifts by itself; exits stay allowed | **Yes.** Top-ranked gap. Suggested starting thresholds: pause at 2% of budget lost in a day, 5% in a week or 8% in a month, and for one session after 2 losing exits in a row | [gap analysis A1](docs/research-notes/README.md) |
| B4 | **Unrealised-loss protection and horizon exits** | A portfolio drawdown halt on marked value; optional trailing stops; close or renew a position when its horizon passes | **Yes to the drawdown halt and horizon renewal;** stops optional | [gap analysis A2](docs/research-notes/README.md) |
| B5 | **The regime as a sizing input** | Today the regime is advice only. Option: size new buys down at HIGH or SEVERE | **Not yet.** First test "regime v2" (matching the original specification) and a re-entry signal | [market regime](docs/market-regime.md) |

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
| B23 | **Merge `dev` into `main`** with a pull request | `main` was last merged on 20 Oct |

---

## Part C: done by the agents without you (for your information)

These are cheap fixes from the gap analysis. They need no decision, and development does them next:
- an as-of filter on the debate context;
- counting the scenario panel's silent fallbacks;
- model-evaluation improvements (an exit code, baseline regression, judge fingerprints);
- keeping evaluation rows out of training data;
- a freshness check on the regime;
- a real bull-answers-bear debate;
- the bot's own record in debates;
- "data missing" markers;
- recording refused orders;
- run manifests;
- a limits banner in the digest;
- a digest self-check;
- statistical guards (deflated Sharpe, a turnover-matched random baseline, crisis windows);
- regime v2 for comparison.

## Part D: things you should know

- **The system tells the truth, including bad news.** It found no proven edge, corrected its own earlier over-optimistic
  numbers on 21 Oct, and labels everything paper, unverified, inferred or seen history.
- **Reference projects:**
  - **FinceptTerminal** may only be run for non-business use under its licence. We take ideas only.
  - **MiroFish and backtesting.py** are AGPL. We took ideas, never code.
- **The office laptop:** nothing is downloaded, installed, run in the background or pushed without your OK, except
  what you have authorised (pushes to `dev` when asked).
