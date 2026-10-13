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

An accepted review is an **order intent**, not an order. The bot still reserves it through `POST /v1/paper/orders`, which re-checks every limit at that moment.

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
