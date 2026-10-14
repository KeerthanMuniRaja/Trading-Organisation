# Trade signals: structured proposals, deterministic risk review, scored outcomes

Implements **DECISION-01** from the [remaining-work assessment](remaining-work-assessment.md): structured proposals with share, horizon, evidence, uncertainty, expiry and invalidation, a deterministic risk review, and explicit no-action outcomes. Each proposal can be replayed from its evidence to an accepted or rejected order intent.

The model only fills in proposals, so swapping in a stronger model changes nothing here. Its calls flow through the same review, sizing and scoring.

Code: [`backend/src/trade-signals.ts`](../backend/src/trade-signals.ts). Migration: [`032_trade_signals.sql`](../db/migrations/032_trade_signals.sql). Tests: [`backend/test/trade-signals.test.ts`](../backend/test/trade-signals.test.ts).

## The three steps

| Step | Route | Who | What happens |
| --- | --- | --- | --- |
| Propose | `POST /v1/trading/signals` | A bot-bound `trader` or `researcher` credential, only for its own bot | `enter-long`, `exit` or `no-action`, with horizon (1–365 days), conviction, optional probability (1–99%), thesis, invalidation and an expiry no later than the horizon. Trade proposals must cite verified evidence from approved sources. An explicit `no-action` call needs neither, so "nothing to do" is recorded rather than silent. |
| Review | `POST /v1/trading/signals/reviews` | `evaluator` (risk officer) or owner; never the proposer | Code alone decides the outcome; the caller cannot choose it. See the rules below. |
| Score | `POST /v1/trading/signals/outcomes` | `evaluator` or owner, independent of the proposer | Only after the horizon has passed, with a verified price record. The backend computes the move from the review's reference price and whether the call was right. |

`POST /v1/trading/signals/query` lists signals with their reviews and outcomes, plus a **track record** per bot:
- accuracy overall and by conviction;
- mean Brier score where probabilities were stated. 0 is perfect; always saying 50% earns 0.25.

Traders see only their own bot's record.

## Risk review rules (`signal-risk-v1`)

Each review records one of four outcomes:
- **expired:** the proposal's expiry passed before review;
- **acknowledged:** a `no-action` call;
- **rejected:** with every reason recorded;
- **accepted:** with a computed size.

A proposal is rejected for any of these:
- `system-halted`;
- `bot-not-qualified-for-paper-trading`;
- `evidence-no-longer-verified`;
- `no-fresh-approved-quote` (older than 60 seconds);
- `stated-probability-below-even`, for a long;
- `realised-loss-limit-reached`;
- `size-below-one-share`, together with the limit that bound it;
- `no-unreserved-position`, for an exit.

How accepted trades are sized:
- **Longs** take the tightest of four limits: order limit, the bot's remaining budget, available capital, and remaining organisation exposure. That is scaled by conviction (high 100%, medium 50%, low 25%) and divided by the ask, including slippage and fees. The reason names the binding limit, such as `sized-by-available-capital`.
- **A stated `targetWeightPct`** (migration 033) caps a long at that share of the bot's budget in the instrument, counting what the bot already holds or has reserved there. The reason then reads `sized-by-target-weight`.
- **Exits** sell the bot's whole unreserved position.

An accepted review is an **order intent**, not an order.

**Execution (PAPER-01, migration 042).** The proposing bot executes the intent with `POST /v1/trading/signals/executions` and `{signalId}`, using its own trader credential.
- **One order, permanently linked.** The intent becomes exactly one paper order and fill, linked to the proposal: proposal → order → fill → realised P&L for sells. This goes through the paper engine, which re-checks limits, quote freshness, qualification and evidence at that moment.
- **Retries resume; they never double-trade.** Every idempotency key derives from the signal, so a retry after a lost answer or a failed fill resumes the same order.
- **A failed fill keeps its reservation.** With a stale price, the same call succeeds once fresh quotes arrive. If the price moved beyond the reservation, cancel the order and re-propose.
- **Visibility.** The signal query shows each signal's execution.

**Lapses (PAPER-03, migration 045).** An accepted proposal that expires without being executed can never be executed later. But if its execution stopped after reserving (a crash, or a fill refused because the price moved beyond the reservation), that reservation would otherwise hold the bot's budget and the shared capital forever.
- **The sweep.** `POST /v1/trading/signals/lapses` with `{asOf}` (evaluator or owner) closes every such proposal: it cancels the stranded reservation and records the lapse once, append-only and audited.
- **What is skipped.** Proposals still live are untouched. So is one whose fill already happened.
- **Visibility.** The query shows `lapse` with the amount released.
- **Automatic.** The end-of-day trader runs the sweep every day (step `LAPSE`).

## End-of-day execution at verified prices (no live feed needed)

The paper engine normally fills at a live approved quote no older than 60 seconds. Without a paid real-time feed, no such quote exists. Faking freshness, by labelling yesterday's close as "now", would be dishonest. A daily or monthly organisation can instead trade **end of day**, the way the backtests already do:

1. **Review at a verified close.** `POST /v1/trading/signals/reviews` may include `priceEvidence {evidenceId, pricePaise, observedAt}` when no fresh quote exists. The evidence must be verified, from an approved source, state `NSE:<share> … <price> paise`, and be at most 7 days old. Sizing and the reference price use it, and the review records `priced-from-verified-close`.
2. **Fill at a verified later price.** `POST /v1/trading/signals/executions` may include `priceEvidence` for the next session's open. It must be observed **after the review that accepted the trade**, so it can never be chosen with hindsight. The paper engine re-checks that evidence itself, then applies the same slippage, fees, limits, journals and positions as a live fill.

The prices come from the steward-checked daily data. One identity reports them as evidence and an independent one verifies them, as the signal scorer already does. Existing calls without `priceEvidence` behave exactly as before.

**The end-of-day trader** ([`integrations/trading-desk/eod_trader.py`](../integrations/trading-desk/eod_trader.py)) runs as the cycle step `eod-trading`, after market data and news and before scoring.

| Step | What happens |
| --- | --- |
| **Lapse** | Accepted proposals that expired unexecuted are closed and any stranded reservation released (see Lapses above). |
| **Mark** | Every share's latest settled close is reported, verified and recorded as its valuation mark ([verified marks](paper-performance.md#verified-end-of-day-marks-paper-02-migration-044)), so open positions show real P&L. |
| **Review** | Proposals awaiting review (`pending: 'unreviewed'`) are priced at the latest settled close. The price reporter (researcher) submits it, the price checker (evaluator) verifies an exact match, and the evaluator reviews at that price. |
| **Execute** | Accepted, unexecuted proposals (`pending: 'unexecuted'`) take the first session **open strictly after the review**, reported and verified the same way. The proposing bot then executes with its own bot-bound trader credential. |

**When a proposal waits instead.** It is reported as waiting, and nothing is guessed, when:
- its next open is not in the data yet;
- its bot has no credential configured;
- the price would be older than 7 days.

`scripts/eod-loop.test.mjs` proves it end to end against the real backend. Today's proposal is reviewed at the verified close and waits for tomorrow's open. An earlier-accepted proposal fills at the verified next open. A second run repeats nothing.

## Independent challengers (SPECIALIST-01, migration 041)

Before a proposal is reviewed, **another bot** may challenge it with `POST /v1/trading/signals/challenges` (trader or researcher bot credential):
- the stance is `oppose` or `support-with-caveat`;
- it states an argument and can cite verified evidence;
- each bot may challenge once, never its own proposal, and only before the review.

Rules `signal-risk-v2`:
- An **opposing challenge with verified evidence** sizes a high-conviction long as medium, and records `evidenced-objection-sized-as-medium`.
- Unevidenced objections stay visible but change nothing.

**Scoring challengers.** The query shows each signal's challenges and a `challengerRecord`:
- an opposition is right when the proposer's call turned out wrong;
- a supported-with-caveat challenge is right when it turned out right.

So challengers must earn their place like any other bot.

**From the desk.** The trading desk supplies challengers naturally. `signals_bridge.dissent()` turns every analyst whose view opposed the manager's buy or sell into an `oppose` challenge, in its own words and under its own bot identity.

## The rule bot: a model-free member

Without the local model running, no bot proposes anything, so the whole pipeline sits idle. [`integrations/trading-desk/rule_bot.py`](../integrations/trading-desk/rule_bot.py) is an organisation member that needs no model. It runs the best rule from the studies, **top-3 momentum**: hold the three shares with the strongest 126-session (about 6-month) return, in equal thirds, and rebalance monthly.

| Step | What happens |
| --- | --- |
| **Rank** | From the steward-checked daily cache, settled bars only. Shares with less than 126 sessions of history are left out. |
| **Cite** | The price reporter (researcher) submits the full ranking, with its closes and a combined dataset fingerprint. The price checker (evaluator) verifies only an exact match. |
| **Propose** | With the bot's own trader credential: `exit` for holdings that left the top 3, then `enter-long` with `targetWeightPct` 33 for top-3 shares not held. Horizon 30 days, expiry 7 days, model `rules:top3-momentum-6m`, prompt version = the rule's fingerprint, so release control applies unchanged. |
| **Once a month** | If the bot already proposed this calendar month, it does nothing. If it already holds the top 3, it proposes and cites nothing. `--dry-run` shows the plan without sending anything. |

**Why conviction is `high`.** Medium conviction halves each long's headroom, so the third one-third slot would be starved by the remaining budget. The backtest held three equal thirds. The target weight remains the real cap, and an evidenced objection from another bot still sizes the trade as medium.

**What it is not.** The rule is pure *relative* momentum, exactly as studied (`portfolio_daily.top_momentum`): it always holds three shares, even in a falling market. Its record is mixed, and all of it is on data already seen:

| Period (after costs) | Top-3 momentum | Hold all 8 shares |
| --- | --- | --- |
| Oct 2021 – Oct 2024 | 22.1% a year | 21.2% a year |
| Oct 2024 – Oct 2025 | +0.7% | −2.0% |
| Oct 2025 – Oct 2026 | **−11.5%**, worst fall 22.6% | −11.0%, worst fall 16.9% |

Gross of costs, it was ahead of the basket in 32 of 50 months (p ≈ 0.03) but behind on average in broad downtrends. Its paper record on new months is the real test, and its fitness and scorecard judge it like any other bot.

**Running it.** It runs as the cycle step `rule-bot`, before `eod-trading`, so its proposals are reviewed in the same run and filled at the next open. The step is skipped until the owner has:
1. created the bot;
2. bound a trader credential to it;
3. registered and evaluated a release, then qualified the bot (`POST /v1/releases/qualifications`);
4. set `RULE_BOT_ID`.

`scripts/rule-bot-loop.test.mjs` proves the path end to end: the bot proposes the top 3 with verified evidence, the end-of-day trader accepts all three sized by target weight, and a second run in the same month proposes nothing.

## The model allocator in the daily cycle

When the local model is switched on, its allocator proposes like any other member. This is the path a stronger model plugs into later, unchanged.

1. **Decide** (`model-allocator-decide`, only with `--with-model`). `ai_allocator.py forward` asks the model for the month's weights in its **pre-registered** forward test, at most 2 calls per run. The model sees anonymised facts only: no names, no dates.
2. **Propose** ([`model_allocator.py`](../integrations/trading-desk/model_allocator.py), `model-allocator-propose`, no model needed). Once per decided month, while the decision is at most 7 days old:
   - **Report.** The researcher reports the exact facts the model saw, with the shares named, as evidence.
   - **Check.** The evaluator recomputes them from the steward-checked data and verifies only an exact match. If they no longer match, nothing is proposed. So the model's **inputs** are proven true, not just its output recorded.
   - **Propose.** Material weight changes become proposals (`signals_bridge.from_allocator`: `enter-long` with `targetWeightPct`, or `exit`), sent with the allocator bot's own credential and stamped with the run's model and prompt version.
   - **What is skipped.** Failed months, stale months and months already proposed propose nothing.

**Switching it on (owner):**
1. Register the forward test: `ai_allocator.py register --name <run>`, with the model server running.
2. Create the allocator bot, bind a trader credential to it, register and evaluate a release for its model and prompt version, then qualify it (as for the rule bot).
3. Set `MODEL_ALLOCATOR_RUN` and `MODEL_ALLOCATOR_BOT`.
4. Run the cycle with `npm run cycle -- --with-model`.

## Closing the loop automatically: the signal scorer

[`integrations/trading-desk/signal_scorer.py`](../integrations/trading-desk/signal_scorer.py) runs in the organisation cycle (step `score-signals`). It finds every reviewed proposal whose horizon has passed and that has no outcome. For each one it takes **two identities**:

| Step | Identity | What happens |
| --- | --- | --- |
| 1 | The **price reporter** (researcher) | Submits the closing price of the first session at or after the horizon as evidence. The price comes from the steward-checked daily cache and is attributed to the owner-approved source `market-yahoo-daily`. A bar counts only once its session closed at least 30 minutes ago. |
| 2 | The **price checker** (evaluator) | Re-reads that bar itself. It verifies the evidence only if the stored text matches exactly (content-bound review), then records the outcome. |

The backend then scores the call. That fills the bot's track record and its challengers' records, which in turn feed fitness, releases and alerts. Scoring the same proposal twice is not possible.

`scripts/signal-loop.test.mjs` proves the whole path end to end: the real compiled backend with test credentials, plus the real Python scorer.

## Scoring rule

Every bot is scored the same way:
- a long is right only if the move beats the 30 bps round-trip cost;
- an exit is right if the price then fell;
- a no-action call is right if no profitable long was missed (move ≤ 30 bps).

## Guarantees (tested)

- Proposals, evidence links, reviews and outcomes are append-only (`reject_history_mutation`), and every step is audited.
- A bot cannot propose for another bot.
- The proposer cannot review or score its own signal.
- An unverified citation is refused.
- A proposal cannot outlive its horizon.
- A track record is descriptive: promotion, retirement and budgets remain owner and lifecycle decisions. Bot fitness (`/v1/bots/fitness`) remains the significance test.

## Connections

- **Desk and allocator bots:** [`integrations/trading-desk/signals_bridge.py`](../integrations/trading-desk/signals_bridge.py) turns their decisions into proposals.
  - **A monthly allocation:** a weight raised by 3 or more points becomes `enter-long` with that weight as `targetWeightPct`; a weight cut to zero becomes `exit`.
  - **A desk meeting:** buy, sell and hold become `enter-long`, `exit` and `no-action`. Conviction and invalidation come from the strongest analyst who agrees.
  - **Sending:** each proposal goes with the credential bound to its own bot. Proposals expire within days, so only current decisions can be sent; replays are dry-run only.
- **Outcome evidence:** comes from approved daily-close records once a market data source is approved (MARKET-01).
