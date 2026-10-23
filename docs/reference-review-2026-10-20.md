# Reference review, 20 October 2026: TradingAgents, FinceptTerminal, and how we compare

The owner asked two things: check that everything we have built matches our idea, and review two open-source projects for anything worth adding. This page records the comparison and what was adopted.

## Our idea, and where the system stands

**The idea:** an organisation of AI and rule-based agents that research, debate, decide and paper-trade like a firm, and develop themselves. The owner approves and oversees.

| Part of the idea | Status on 20 October |
| --- | --- |
| Agents propose, others challenge, a fixed review decides, execution and scoring are automatic | **Built and running.** One working bot (`momentum-rules`) trades live paper. Challenges exist, but no bot challenges yet |
| Management of staff: watch, suspend, fund, retire | **Built** (management review, every cycle) |
| Owner only approves and oversees | **Built:** owner agenda plus standing approvals. **No policy is set yet**, so every decision still waits for the owner |
| Growth by evidence: R&D finds ideas, new bots are born | **Built.** No idea passes yet; the best is the live momentum rule (p = 0.027 against a Bonferroni bar of 0.0038) |
| Self-improvement and self-repair | **Built:** trials, live promotion and rollback, same-rule code fixes. All are owner opt-in |
| Learning from news and results | **Partly.** News fact-checking, claims and learning workflows are built; **the model is off**, so no claims are drafted and no lessons learned from news yet |
| Running without a person | **Built but not installed:** the supervisor runs the day; installing it is the owner's choice |
| Money rules (60/40, wallets, owner-only withdrawals) | **Built and tested;** paper only |

**What doesn't match yet:**
- **No thinking bots:** with the model off, the only trader is one rule bot.
- **Owner workload:** with no standing-approval policy, the owner still decides everything by hand.
- **Narrow data:** prices and three news feeds only. There are no fundamentals, filings or macro data.

## TradingAgents (TauricResearch, Apache-2.0)

A LangGraph framework that simulates a trading firm:
- **Analysts:** fundamentals, sentiment (news and social), news and macro, technical.
- **Debate:** bull and bear researchers argue in configurable rounds.
- **Decide:** a trader proposes, a risk team stress-tests, and a portfolio manager approves or rejects.
- **Learn:** each settled decision is scored on raw and benchmark-relative (alpha) return and turned into a one-paragraph reflection that later decisions read.
- **Supporting pieces:** point-in-time data, a vendor fallback chain, checkpoints, and backtests scored on alpha.
- **Models:** it supports local OpenAI-compatible servers (llama.cpp), and Yahoo tickers such as `RELIANCE.NS`.

| Their piece | Ours | Verdict |
| --- | --- | --- |
| Analyst team | Trading desk analysts (trend, news, Kronos forecast), claim analyst | Similar; we lack fundamentals and social data |
| Bull/bear debate | Proposal challenges (`oppose`, `support-with-caveat`), scored by challenger record | **We have the mechanism, but nobody debates.** Adopt: model-backed bull and bear challengers |
| Trader | Bots propose with thesis, invalidation, horizon and target weight | Equivalent |
| Risk team | Deterministic review (`signal-risk-v2`): limits, budgets, sizing, objections | Ours is stricter (code, not a model) |
| Portfolio manager approves | Review, then standing approvals, then owner agenda | Ours is governed by policy and audited |
| Reflection on settled decisions, alpha vs benchmark | Outcome scoring (vs cash) and live fitness | **Adopt:** automatic, factual post-trade lessons with basket-relative alpha |
| Point-in-time data | Settled bars only, as-of knowledge view, verified price evidence | Equivalent |
| Vendor fallback chain | Single market-data source (Yahoo) | Owner decision (licences); noted |
| Checkpoints, resumable runs | Cycle journal resumes; idempotent commands | Equivalent |

**Reused as a dependency (owner's direction, 20 October: "instead of developing from scratch we can use it").** TradingAgents now runs as **one governed member** ([integrations/tradingagents](../integrations/tradingagents/README.md)):
- **Pinned:** the exact commit `e8f5503`, installed only into its own environment.
- **Decides:** weekly with our local model.
- **Proposes:** in shadow first, earning its first release on 20 scored shadow calls. It trades only through our review, release gate, scoring and money rules.
- **To start:** the install itself is a download and waits for the owner's approval.

## FinceptTerminal (Fincept, AGPL-3.0)

A native C++/Qt desktop terminal with embedded Python. It offers analytics (DCF, VaR, Sharpe, QuantLib), 37 AI agents, more than 100 data connectors (FRED, IMF, World Bank and others), a paper-trading engine and broker integrations. The page doesn't mention NSE support.

**Verdict:** we can't embed it, and shouldn't copy its code. It is a desktop app in another stack, and AGPL would bind our project if we distributed or served a modified copy. Ideas only:
- **Adopt:** standard risk metrics on our paper equity (volatility, Sharpe, 95% one-day VaR, worst fall), so the owner can oversee risk at a glance.
- **Note for later:** free macro data (FRED, World Bank) as research context. That's a new data source, so it's the owner's decision.

## Adopted on 20 October

1. **Post-trade reflections** (TradingAgents' memory). Every scored proposal becomes a factual lesson for its bot: what it did, what happened, and its alpha against the basket. The researcher proposes it; the evaluator recomputes it independently before verifying.
2. **Risk metrics** (Fincept's analytics). Each bot's paper equity curve gets volatility, Sharpe, 95% VaR and its worst fall, in the benchmark view and the owner digest.
3. **Debate desk** (TradingAgents' bull and bear). With the model on, a bull and a bear challenger argue every proposal before review, through our existing challenge route, citing verified evidence. Their records are scored like any bot's.
