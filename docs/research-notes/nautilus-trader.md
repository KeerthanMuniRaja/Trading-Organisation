# Research note: NautilusTrader (nautechsystems/nautilus_trader)

Studied 2026-10-21. Read-only web reading, nothing cloned, downloaded or installed. No code is copied here; mechanisms are described in our own words. Short identifiers and file paths are quoted only so they can be found again.

## 1. What it is

- **What:** an open-source, event-driven trading platform. The same core runs research backtests, "sandbox" (real-time data with simulated execution) and live trading against real venues.
- **License:** LGPL-3.0, as stated in the task brief; the repository has a `LICENSE` file, which I did not re-read. We do not copy code.
- **Branch and version studied:** `develop`, about 21,900 commits. The repository front page says the v2 line is at release-candidate stage (`2.0.0rcN` wheels), while the stable PyPI release is still 1.x.
- **Rust core:** in v2 the core is Rust (`crates/`). Python is a thin layer: `python/nautilus_trader/` wraps a compiled extension built by `crates/pyo3`. The old Cython paths under `nautilus_trader/` (for example `nautilus_trader/risk`) no longer exist on `develop`; they return 404.
- **Repo signals:** the root holds `AGENTS.md`, `CLAUDE.md`, `AI_POLICY.md` and `MIGRATION_V2.md`, so the project is actively developed with AI agents and is in the middle of a major migration.

### Sources read (32)

All paths are on branch `develop`.

**Rust source (18 files):**
1. `crates/risk/src/engine/mod.rs`: RiskEngine
2. `crates/risk/src/engine/config.rs`: RiskEngineConfig
3. `crates/common/src/throttler.rs`: Throttler
4. `crates/model/src/orders/mod.rs`: OrderStatus transition table and OrderCore apply
5. `crates/model/src/position.rs`: Position
6. `crates/common/src/msgbus/core.rs`: MessageBus
7. `crates/execution/src/engine/mod.rs`: ExecutionEngine
8. `crates/execution/src/reconciliation/orders.rs`: report-to-event reconciliation
9. `crates/live/src/execution/manager.rs`: ExecutionManager (live reconciliation, in-flight checks)
10. `crates/live/src/execution/submission.rs`: submission recovery policy types
11. `crates/execution/src/models/fill.rs`: fill models
12. `crates/execution/src/models/latency.rs`: latency model
13. `crates/execution/src/matching_engine/mod.rs`: OrderMatchingEngine
14. `crates/backtest/src/exchange.rs`: SimulatedExchange
15. `crates/backtest/src/engine.rs`: BacktestEngine
16. `crates/system/src/kernel.rs`: NautilusKernel
17. `crates/portfolio/src/portfolio.rs`: Portfolio
18. `crates/portfolio/src/manager.rs`: AccountsManager

**Concept docs (14 files):**
19. `docs/concepts/architecture.md`
20. `docs/concepts/message_bus.md`
21. `docs/concepts/event_sourcing.md`
22. `docs/concepts/cache.md`
23. `docs/concepts/execution/index.md`
24. `docs/concepts/execution/reconciliation.md`
25. `docs/concepts/execution/policies.md`
26. `docs/concepts/accounting.md`
27. `docs/concepts/dst.md`
28. `docs/concepts/live.md`
29. `docs/concepts/backtesting/fill-prices-and-matching.md`
30. `docs/concepts/backtesting/bar-execution.md`
31. `docs/concepts/orders/index.md`
32. `docs/developer_guide/design_principles.md`

**How these were read:** each file was fetched as raw text and then read through a summarising fetch tool. Many source files are very large (100k to 360k characters), so for several only the first 100k characters were read. Section 6 lists which parts were not seen.

In this note:
- **[code]** marks something read in source.
- **[doc]** marks something only stated in documentation.

## 2. Architecture

### One kernel, three environments

`crates/system/src/kernel.rs` builds one `NautilusKernel` that owns all of these:
- the clock
- an optional event store
- the cache (with an optional database backing)
- the message bus
- the portfolio
- the risk engine
- the execution engine
- an order emulator
- the data engine
- the trader, which holds the strategies and actors

**[code]** Construction order:
1. Clock, chosen by environment through a clock factory.
2. Event store.
3. Cache.
4. Message bus.
5. Portfolio.
6. Risk engine.
7. Execution engine.
8. Order emulator.
9. Data engine.
10. Message handlers.
11. Trader.

**[code]** Environment differences:
- The `Environment` value (Backtest, Sandbox, Live) changes only a few things in the kernel: which clock is used (virtual or real time), how the trader is constructed, and the paths used by the event store and the streaming writer.
- `crates/backtest/src/engine.rs` builds the same kernel and swaps only the edge adapters: `BacktestDataClient`, `BacktestExecutionClient` and `SimulatedExchange` replace the live venue clients.
- It also swaps the asynchronous command senders for synchronous ones.

**[doc]** `architecture.md` and `design_principles.md`:
- They say backtest, sandbox and live share core components, "but shared code does not guarantee identical outcomes."
- Live inputs and latency can make results differ from a backtest.
- The project does not promise parity. It promises the same risk, execution, portfolio and order code.

### Threading

**[doc]** `architecture.md`:
- Single-threaded core: the bus, strategy logic, risk checks, execution coordination and cache all run on one thread.
- Network, adapters, logging and persistence run on background threads or a Tokio runtime. They hand events to the core through channels.
- The design is compared to the LMAX architecture.

**[code]** The kernel and engines use single-thread shared ownership (`Rc<RefCell<…>>`), which is consistent with the docs.

### Order flow

**[doc]** `execution/index.md`, with the order flow partly confirmed in code:
1. The strategy creates an order.
2. If the order is emulated, it is held by `OrderEmulator`; if it uses an execution algorithm, it goes to the `ExecAlgorithm`.
3. `RiskEngine` checks it.
4. `ExecutionEngine` routes it.
5. The `ExecutionClient` (the adapter) sends it to the venue.

Venue events (accepted, filled, canceled and so on) come back through the `ExecutionEngine`. It applies each event to the cached order, updates positions, sends account updates to the Portfolio, and publishes on topics that strategies subscribe to.

### Lifecycle and process model

**[doc]** `architecture.md`:
- **Component states:** each component has a finite state machine. Stable states are PRE_INITIALIZED, READY, RUNNING, STOPPED, DEGRADED, FAULTED and DISPOSED; there are also transitional states such as STARTING and STOPPING.
- **One node per process:** running two nodes concurrently in one process is unsupported.
- **Crash-only:** release builds abort on panic, an external supervisor restarts the process, and restart uses the normal startup path.

### Live startup order

**[doc]** `live.md`, matching the kernel module comments **[code]**:
1. Restore cached state.
2. Connect data clients.
3. Connect execution clients.
4. Run startup reconciliation.
5. Only then start strategies.

Any failure aborts startup.

## 3. Key mechanisms as implemented

### 3.1 Risk engine: pre-trade checks and trading states

All of 3.1 is **[code]** from `crates/risk/src/engine/mod.rs` and `config.rs`.

**Submit path checks.** The first failure stops processing.
1. **Bypass:** if `bypass` is set, the order goes straight to execution with no checks, no throttling and no trading-state gate.
2. **Order in cache:** if the order is missing, the engine only logs an error. No event is produced, which is a silent path.
3. **Reduce-only:** a reduce-only order must name an existing position and must not increase it (`ReduceOnlyWouldIncreasePosition`).
4. **Instrument:** the instrument must exist.
5. **Order fields:** price and trigger-price precision against the instrument, positive price unless negatives are allowed, quantity precision, instrument minimum and maximum quantity, and a GTD order must have an expiry time in the future.
6. **Account-level risk**, with orders grouped by account:
   - Per-order notional cap, per instrument (`max_notional_per_order`).
   - A market order needs a reference price, taken from the quote, then the last trade, then the last bar. If none exists the order is denied (`MarketPriceUnavailable`); it is never priced at zero.
   - The instrument's minimum and maximum notional.
   - For cash accounts, the notional must fit within the free balance (`NotionalExceedsFreeBalance`). This is checked cumulatively across the orders in the batch (`CumulativeNotionalExceedsFreeBalance`). Reducing orders skip the balance check.
   - For margin accounts, initial margin against free balance, also checked cumulatively.
   - Sells against a cash account are checked against free base-asset balance (`check_asset_balance`).
7. **Execution gateway:** the trading state is applied last.

**Trading states:**

| State | New orders | Order lists | Modifications | Cancels and queries |
|---|---|---|---|---|
| ACTIVE | Sent on through the submit throttler | Sent on | Sent on through the modify throttler | Allowed |
| REDUCING | Only a reduce-only order that targets a known open position on the opposite side, for the same account, and does not exceed that position (`is_reducing_submission`). Others are denied with `TradingStateReducing` | All denied | All rejected, even reducing ones | Allowed |
| HALTED | Denied (`TradingHalted`) | Denied | Rejected | Allowed |

- The halt gate is evaluated after the field checks. A malformed order is therefore denied for its real reason, not as "halted".
- **What changes the state:** `set_trading_state` stores the new state, publishes a `TradingStateChanged` event with a snapshot of the risk configuration, and logs it. The portions read contain **no automatic state change** (no drawdown, daily-loss or exposure trigger). The state is changed from outside the engine.
- **Runtime limit changes:** `set_max_notional_per_order` changes a limit at runtime and only logs it; no event is published.

**Denials are events, not errors:**
- A failed submit check produces an `OrderDenied` event, which becomes part of that order's history.
- A failed modify check produces `OrderModifyRejected`.
- The denial helper acts only on orders that have not yet been sent (status Initialized or Released).

**Throttling** (`crates/common/src/throttler.rs`):
- **Defaults:** submit and modify rate limits default to 100 per second each.
- **How it counts:** the throttler is a sliding window over the timestamps of recent sends.
- **Buffered mode:** excess messages are queued, and a timer drains them first-in first-out once the window slides.
- **Drop mode:** excess messages go to a drop handler.
- **What the risk engine uses:** drop mode. Over-limit submits become `OrderDenied` with reason `RateLimitExceeded`; over-limit modifies are rejected. Nothing is queued.
- **Batch modifications:** these use an all-or-nothing reservation of the whole batch.

### 3.2 Order state machine

All of 3.2 is **[code]** from `crates/model/src/orders/mod.rs`, with **[doc]** support from `orders/index.md`.

**Statuses (14), in four groups:**
- **Local, not yet at the venue:** INITIALIZED, EMULATED, RELEASED.
- **In flight, waiting for the venue:** SUBMITTED, PENDING_UPDATE, PENDING_CANCEL.
- **Open:** ACCEPTED, TRIGGERED, PARTIALLY_FILLED, plus the two PENDING states.
- **Terminal:** DENIED, REJECTED, CANCELED, EXPIRED, FILLED, VOIDED.

The docs warn: test for "finished" with `is_closed`, never with "not open", because some statuses are neither.

**Transition table:**
- One function maps each pair (current status, incoming event) to the next status. Any pair not listed is an `InvalidStateTransition` error.
- The new status is computed before anything changes, so an illegal event leaves the order untouched.
- The execution engine then drops that event with a warning, or with a debug log if the order is already closed (`crates/execution/src/engine/mod.rs`).

**Edge cases the table allows on purpose:**
- **Fills while a cancel or modify is pending:** the order stays PENDING_CANCEL or PENDING_UPDATE after a partial fill.
- **Late fills after CANCELED or EXPIRED:** these are accepted, because a venue can report a fill that crossed with the cancel. A partial late fill keeps the terminal status.
- **Rejected cancel or modify:** the order returns to the status it had before the request.
- **Fill voids:** a later venue correction (`FillVoided`) can move a FILLED order to VOIDED, or reopen it to ACCEPTED or PARTIALLY_FILLED.
- **Reconciliation:** an `Updated` event flagged as reconciliation can mark an order FILLED.
- **Overfills:** a cumulative fill above the order quantity is recorded as an overfill. The status becomes FILLED.

**Event-sourced orders:**
- Every order keeps its full ordered list of events, starting with `OrderInitialized`.
- The current status and fill totals are derived from that list, and an order can be rebuilt from its events.
- After a fill void, derived fill state is recomputed from history rather than adjusted by subtraction.

**Duplicate protection:**
- A fill with a `trade_id` already seen on that order is rejected (`DuplicateFill`), unless it carries a new price. In that case it is a "price restatement": the average price is recomputed and no quantity is added.
- Positions keep their own set of trade ids, so the same trade cannot add quantity twice (`crates/model/src/position.rs`).

### 3.3 Execution engine and positions

All of 3.3 is **[code]** from `crates/execution/src/engine/mod.rs` and `crates/model/src/position.rs`.

**Command routing.** The client is chosen by these rules, in order:
1. An explicit client id on the command.
2. The issuer of the account.
3. A venue routing map.
4. The default client.

If no client is found, the order is denied (`NoExecutionClient`).

**Guards before sending:**
- A submit for an order that is no longer INITIALIZED or RELEASED is skipped.
- A submit for an order already marked as sent is skipped.
- If the adapter call itself fails, the order is denied (`SubmitFailed`).

**Position identity (OMS type):**
- NETTING gives one position per instrument and strategy, with id `{instrument}-{strategy}`.
- HEDGING allows several positions, each with a generated id.

**Position updates:** each fill opens, updates, flips or reopens a position.
- A flip splits the fill: the first part closes the old position and the rest opens a new one.
- Realised PnL starts from the commission (when it is in the settlement currency) and adds PnL on the closing part of each fill.
- Unrealised PnL is computed from a supplied last price.

**Snapshots:** order and position state snapshots can be published on timers, and also persisted when the cache has a database backing.

### 3.4 Reconciliation (live)

Sources: `crates/execution/src/reconciliation/orders.rs` and `crates/live/src/execution/manager.rs` **[code]**; `execution/reconciliation.md` and `execution/policies.md` **[doc]**.

**Principles [doc]:**
- **The venue's report wins.** Local order state is event-sourced, and venue reports are used to align it.
- **"Missing reports do not mean flat."** A position is treated as flat only when the venue explicitly says so. A failed query, an empty response or a venue without position data is not evidence of a flat position.
- **Every command ends in one of three outcomes:**
  - Definitive local failure: the command was never sent (denied or rejected locally).
  - Definitive venue result: the venue confirmed acceptance, update, cancellation or rejection.
  - Unknown: the command may have reached the venue. The order stays in flight (SUBMITTED, PENDING_UPDATE or PENDING_CANCEL) until stream updates, queries or reconciliation give evidence.
- **Disconnects decide nothing.** A disconnect, timeout or transport error after sending usually leaves the outcome unknown.
- **No blind retries.** Submit, modify and cancel commands are generally sent once and never retried blindly; only read-only requests are retried. A cancel-all repeat could cancel an order placed in between. Only venue-side idempotency (a stable client order id with duplicate detection) makes other repeats safe.
- **The order is saved before it is sent.** The order and its client order id are written to the cache before the adapter call. That write is asynchronous, so a crash in the gap can only be recovered if the venue later reports the order.

**Startup reconciliation [code + doc]** (`reconcile_execution_mass_status`). Steps:
1. Fetch order, fill and position reports from the venue and remove duplicates.
2. Publish the raw reports on topics before changing any state.
3. For each order report:
   - Skip orders already in sync.
   - Reconcile known orders.
   - Create "external" orders for unknown ones. These are assigned to a strategy that has claimed the instrument, otherwise to a strategy called `EXTERNAL`.
4. Infer missing fills. An inferred fill gets a deterministic trade id built from the order's facts. Its price comes from the venue's average price, then the report price, then the order price. For partial gaps, the price is back-solved from the cumulative averages.
5. Compare net positions to the venue within a quantity tolerance. If they still differ and `generate_missing_orders` is on (the default), add synthetic market orders tagged `RECONCILIATION`.
6. Validate the position reports. **Unresolved position reports block startup:** strategies never start on a state that does not match the venue.

**Continuous reconciliation [code]** (`ExecutionManager`):
- **In-flight checks:** each sent order is tracked with its send time and a retry count. After `inflight_threshold_ms` the order is queried. After `inflight_max_retries` it is resolved locally: SUBMITTED becomes REJECTED with reason `INFLIGHT_TIMEOUT`, and PENDING_CANCEL or PENDING_UPDATE becomes CANCELED.
- **Retention policy:** `RetainUnresolved` (or a client that requires retention) keeps the order open instead of resolving it, because "exhaustion does not establish a venue outcome." A `SubmissionRecoveryExhausted` diagnostic is published and the order status is left unchanged (`crates/live/src/execution/submission.rs`).
- **Open-order polling:** the manager polls the venue for open orders.
  - It skips orders with recent local activity (`open_check_threshold_ms`), so it does not "fix" an order that is mid-update.
  - Before declaring an order missing, it asks the venue about that single order.
  - The number of single-order queries per cycle is capped.
- **Fill deduplication:** a recent-fills map keyed by (account, instrument, trade id) prevents applying the same fill twice across the stream and the polling paths.
- **Position checks:** position mismatches have their own retry counters per instrument and account. A failed venue query means those positions are skipped, not treated as flat.

**Provenance [doc + code]:**
- Terminal states reached by reconciliation or by local policy carry `reconciliation=true`.
- Locally resolved states use synthetic reasons such as `INFLIGHT_TIMEOUT` or `NOT_FOUND_AT_VENUE`.
- Policy text: "A local terminal state is not venue confirmation."

**Graceful shutdown [doc]** (`live.md`):
- Shutdown keeps listening for venue evidence during a short window.
- It then returns an error that lists any client order ids still unresolved, so the operator reconciles them before restarting.

### 3.5 Message bus and cache

**Message bus [code]** (`crates/common/src/msgbus/core.rs`):
- **Three patterns:**
  - Topic publish/subscribe, with `*` and `?` wildcards; wildcards can span dots.
  - Point-to-point endpoints: one address, one handler.
  - Request/response, with response handlers stored by correlation id.
- **Topic cache:** the first publish to a topic scans all subscriptions and caches the sorted matches. Later publishes reuse that list.
- **Delivery order:** higher priority first. Equal priorities are ordered by pattern and then by handler id, so the order is stable.
- **[doc] Delivery:** in-process delivery is synchronous. A failing handler does not stop the other handlers. Messages are immutable.
- **[doc] External streaming:** an optional external backing (Redis) streams messages out. When its queue is full it **drops** messages, and the docs say outright that it is not a durable store.
- **[code] No sequence numbers:** the bus itself has no sequence numbers.

**Cache [doc]** (`cache.md`):
- **Contents:** in-memory instruments, orders, positions and accounts, with indexes by venue, strategy, instrument and side. Market data is held in bounded per-instrument histories (10,000 items by default).
- **Persistence:** an optional database backing (Redis or Postgres) restores orders, positions and accounts on restart, before clients connect and before reconciliation runs.
- **Flushing:** writes can be buffered. "Always dispose the node", or buffered writes may be lost.
- **Purging:** live nodes can purge closed orders and positions on timers.

**Event store [doc]** (`event_sourcing.md`, crate `crates/event_store`):
- **What it records:** every state-affecting message at the bus boundary (commands, order, position and account events, raw venue reports, timer firings), in a per-run append-only file.
- **Entry format:** each entry has a sequence number and a hash.
- **Run manifest:** binary hash, schema version, configuration hash, random seed and run status (Running, Ended, CrashedRecovered or Quarantined).
- **On boot:** a run left "Running" is sealed as crashed-recovered, or quarantined if its hashes or sequence do not check out.
- **Cache vs event store:** the docs describe the cache as "a write-through projection, not the source of truth", answering "what is true now", while the event store answers "how did we get here".
- **Live restart:** this still uses "snapshot plus reconcile". The event store is not yet the live recovery path.

### 3.6 Determinism

**Backtest [code]** (`crates/backtest/src/engine.rs`):
- **Clocks and logging:** virtual clocks everywhere, and logging timestamps taken from the simulated clock.
- **Data order:** all data streams are merged by `ts_init`.
- **Timer timing:** timers due before a data point fire before it; timers at the same timestamp fire after the data has been delivered.
- **Settling:** command queues are drained and venues settled until nothing is pending.
- **Callback limit:** callback draining has a fixed budget per step.
- **Comparable result:** `get_canonical_result` produces a result that leaves out host, wall-clock and random identity data, so two runs can be compared exactly.

**Randomness [code]** (`fill.rs`): fill models take an optional seed; with a seed the random sequence repeats exactly.

**Deterministic simulation testing [doc]** (`dst.md`):
- The Rust async runtime can be swapped for madsim, a seeded deterministic scheduler, so a seed replays the same task interleavings.
- Raw clock and random-number calls are banned by lint rules and a CI hook.
- Hash maps are replaced by insertion-ordered maps wherever iteration order is visible.
- The docs are explicit about the limits: the guarantee holds only for the same binary, configuration and platform. Python strategies, adapters end to end and logging are not covered.

### 3.7 Backtest simulation: fills, latency, matching

**Simulated exchange [code]** (`crates/backtest/src/exchange.rs`):
- One `OrderMatchingEngine` per instrument.
- **Latency:** with a latency model, every command is given an arrival time (send time plus the insert, update or delete latency). Commands wait in a queue ordered by arrival time (with a counter to break ties) and are processed only when the simulated clock reaches that time.
- **Account types:** cash or margin. Cash accounts refuse futures and perpetual contracts.

**Latency model [code]** (`latency.rs`):
- Only a static model exists: a base latency plus per-operation latencies, in nanoseconds.
- It has no random jitter.

**Fill models [code]** (`fill.rs`):
- **Probabilities:** each model has two settings, the chance that a resting limit order fills when touched (`prob_fill_on_limit`) and the chance of one tick of slippage (`prob_slippage`).
- **Synthetic depth:** most variants build a synthetic order book to fill against:
  - best price with unlimited size;
  - one tick worse;
  - two or three tiers of size;
  - size-aware;
  - limited by a "competition" factor;
  - a share of recent volume;
  - thinner during low-liquidity hours.

**Matching [code + doc]** (`matching_engine/mod.rs`, `fill-prices-and-matching.md`, `bar-execution.md`):
- **The historical book is never changed by simulated fills.** Unless `liquidity_consumption` is on, the same displayed size can fill several simulated orders.
- **L1 market orders:** these fill at the touch. The remainder fills one tick worse, limited by `price_protection_points`.
- **Bars:** each bar becomes four synthetic quotes, Open, High, Low, Close. An optional adaptive rule visits the extreme nearer the open first, which the docs call "a deterministic heuristic", not a reconstruction. Volume is split across the four points.
- **Bar timestamps:** `ts_init` must be the bar **close**; an open-stamped bar must be shifted by its interval. The docs name using the current bar's open in `on_bar` as look-ahead.
- **Next-bar-open:** there is **no** native "fill at the next bar's open" mode.
- **Queue position:** by default the queue position at a price level is not modelled. It can be enabled when book and trade data are available.

### 3.8 Accounting and portfolio

Sources: `crates/portfolio/src/manager.rs` and `portfolio.rs` **[code]**; `accounting.md` **[doc]**.

**Balances:**
- Every balance has total, locked and free, with the invariant total = locked + free.
- Cash accounts lock notional for pending buys and the base quantity for pending sells. Reduce-only orders lock nothing.
- **Locks are recomputed, not adjusted:** for each instrument, the locks are rebuilt from all open orders (leaves quantity times limit or trigger price). Running totals are not added to and subtracted from.

**Fills and failures:**
- A fill moves realised PnL minus commission into the balance, converting currencies when needed.
- A cash account that would go negative raises an error. On failure the manager restores the balances as they were before the change.

**Prices and valuation:**
- **Mark-to-market order:** the mark price if configured, then the side-appropriate bid or ask, then the last trade, then the last bar close.
- **Missing price:** exposure and unrealised PnL return "unavailable", never zero. Unpriced instruments are tracked and listed (`missing_price_instruments`), and snapshots carry stale and unpriced flags.
- **Equity curve:** sampled at UTC midnight, at shutdown and, optionally, at an interval while positions are open.

## 4. Research ideas worth knowing

1. **Status as a transition table.** One function lists every legal (status, event) pair. Illegal events are refused before anything changes, and the order keeps its full event list.
   - Source: `crates/model/src/orders/mod.rs`
2. **Denial is a recorded outcome.** A risk refusal becomes an `OrderDenied` event in the order's history with a reason code, not just an error message.
   - Sources: `crates/risk/src/engine/mod.rs`, `docs/concepts/execution/index.md`
3. **Graded trading states (ACTIVE, REDUCING, HALTED).** REDUCING is precise: a new order must reduce a specific known position and must not exceed it. Cancels are always allowed.
   - Source: `crates/risk/src/engine/mod.rs`
4. **Three possible outcomes for every command.** Each command ends as a definitive local failure, a definitive venue result, or unknown. Unknown is a real, long-lived state.
   - Source: `docs/concepts/execution/policies.md`
5. **"Missing reports do not mean flat."** Absence of evidence is never turned into a confirmed state. Timeouts lead to *local* resolutions marked `reconciliation=true` with synthetic reasons.
   - Sources: `docs/concepts/execution/reconciliation.md`, `crates/live/src/execution/manager.rs`
6. **Fail-closed startup.** Strategies do not start until local state matches the venue's explicit position reports.
   - Source: `docs/concepts/execution/reconciliation.md`
7. **Inferred fills with deterministic ids.** When fills are missing, the gap is booked as an inferred fill whose id is built from the order's facts. A second reconciliation therefore cannot book it twice.
   - Source: `crates/execution/src/reconciliation/orders.rs`
8. **Recency guards.** Reconciliation leaves alone an order or position that was touched locally within the last N milliseconds.
   - Source: `crates/live/src/execution/manager.rs`
9. **Trade-id deduplication at two levels**, order and position, plus a short-lived "recent fills" map across the streaming and polling paths.
   - Sources: `crates/model/src/orders/mod.rs`, `crates/model/src/position.rs`, `crates/live/src/execution/manager.rs`
10. **Persist before transport; never blindly retry a venue command.**
    - Source: `docs/concepts/execution/policies.md`
11. **Same kernel, swapped edges.** The backtest uses the real risk, execution, portfolio and cache code; only the data client, execution client and exchange are simulated.
    - Sources: `crates/backtest/src/engine.rs`, `crates/system/src/kernel.rs`
12. **Latency as arrival time.** Commands become effective at send time plus latency, ordered in a queue.
    - Sources: `crates/backtest/src/exchange.rs`, `crates/execution/src/models/latency.rs`
13. **Bar-execution honesty.** The bar timestamp must be its close, the intrabar path is a stated heuristic, and the docs say plainly what is look-ahead.
    - Source: `docs/concepts/backtesting/bar-execution.md`
14. **Unpriced is not zero.** Valuation queries return "unavailable" and list the unpriced instruments.
    - Source: `crates/portfolio/src/portfolio.rs`
15. **Run manifest.** Each run records binary hash, configuration hash, seed and status, and a crashed run is sealed as crashed-recovered or quarantined on the next boot.
    - Sources: `docs/concepts/event_sourcing.md`, `crates/system/src/kernel.rs`
16. **Canonical result.** A backtest result with wall-clock and host-specific data removed, so two runs can be compared byte for byte.
    - Source: `crates/backtest/src/engine.rs`
17. **Seeded randomness and an enforced determinism convention**, checked by lint rules and a CI hook.
    - Source: `docs/concepts/dst.md`
18. **Design principles written as policy.** For example: "prioritizes data integrity over availability"; "Missing evidence must not become a confirmed outcome just because a timeout or retry limit expires"; bounded queues with defined behaviour when the budget runs out.
    - Source: `docs/developer_guide/design_principles.md`
19. **Rate limits that deny instead of queue,** so late orders are never sent silently after conditions have changed.
    - Sources: `crates/common/src/throttler.rs`, `crates/risk/src/engine/mod.rs`
20. **Queue-pressure signals.** Live channels are unbounded; an optional queue monitor publishes Backlogged or Slow states, and the application must react.
    - Source: `docs/concepts/live.md`

## 5. Comparison with our system

Our files compared:
- `backend/src/paper.ts`
- `backend/src/trade-signals.ts`
- `backend/src/operations.ts`
- `backend/src/database.ts`
- `scripts/intraday-monitor.mjs`
- `integrations/trading-desk/daily.py`, `desk.py` and `portfolio_daily.py`, our research simulators

### 5.1 Equivalents

| NautilusTrader | Ours | Notes |
|---|---|---|
| RiskEngine pre-trade checks | `paper.ts` `reserve`, which checks again at `fill` | Ours covers per-order cap (`maxOrder`), shared free capital, organisation exposure, bot budget, realised-loss limit, verified evidence, fresh approved quote, and sell ≤ unreserved position. Theirs has no exposure or loss-limit checks in the risk engine; on those points **we are stricter**. |
| HALTED / REDUCING | `system_lock.halted` (critical incident or owner) and per-bot suspension (`isSuspended`) | Our "halt" blocks buys only; sells and cancels still pass. That is their **REDUCING**, applied to the whole organisation, so we have no true HALTED. Per-bot suspension is a per-bot REDUCING. |
| `TradingStateChanged` event | `operations.control.changed` and `incident.opened` audit events | Equivalent. Ours is hash-chained. |
| Automatic state change | Intraday monitor kill switch opens a critical incident, which halts new risk; the owner resumes (`operations.ts` `control` refuses to resume while a critical incident is open) | They have no automatic trigger in the risk engine. **We are ahead.** |
| Order event list | Orders row updated in place (`reserved`, then `filled` or `cancelled`), plus `audit_events` (`paper.order.reserved`, `paper.order.filled`, `paper.order.cancelled`) | Our history lives in the audit chain, not per order. |
| Locked / free balances, locks rebuilt from open orders | `reserved_paise` on reserved orders, summed live in queries; `available()` from treasury | Same idea: our locks are always derived from open reservations, never a running counter. Good. |
| Persist before transport; resume rather than retry | `trade-signals.ts` `execute`: one order per proposal (`signal_id` link). A retry finds and resumes the same order and can never trade twice. All commands go through `db.command` idempotency keys with input fingerprints. | Strong equivalent. Our idempotency is *stronger* than theirs inside our own boundary. |
| Event store with hash per entry | `audit_events` hash chain plus `verifyAudit` | Ours chains every entry to the previous one, which shows tampering; theirs hashes each entry separately and says it has "no tamper evidence yet". |
| Bar timestamps and look-ahead rules | `paper.ts` `evidencePrice`: an end-of-day price must be observed *after* the review ("no hindsight"); research simulators fill at the next open | Ours is explicit and enforced, and we use the next-open fill mode they lack. |
| Recorded inputs for replay | Intraday monitor records accepted quotes to `.local/intraday/<live|replay>/<day>/quotes.jsonl`; pure `Monitor` core | Same idea as the bus-boundary capture, at a much smaller scale. |
| Crash-only with an external supervisor | `scripts/supervisor.mjs`; migrations at startup with checksum guard | Similar in spirit. |
| Unpriced is not zero | Monitor ignores bad prints and crossed quotes; `value()` falls back to yesterday's close when a symbol has no fresh quote | Partly. The fallback silently assumes "no move" instead of flagging the symbol as unpriced. |

### 5.2 Gaps

The most important gaps appear when we add a live intraday feed and a real broker.

**G1. No "unknown outcome" state.**
- Our order statuses are `reserved`, `filled` and `cancelled`, and a fill is applied inside the same database transaction as the decision. That works only because we *are* the venue.
- With a broker, a submit can time out after reaching the exchange. We need a SUBMITTED state (sent, outcome unknown) and evidence-based resolution, with no resubmit on timeout.
- This is the single biggest design change a live broker will force.

**G2. No transition table and no per-order event list.**
- Status rules are scattered across the `requireThat` checks in `paper.ts`. For example, `cancel` refuses only `filled`, so cancelling an already-cancelled order rewrites it silently.
- A live broker brings partial fills, fills after a cancel request, rejections after acceptance, broker-side expiry at session end (DAY orders), and late fills after a cancel. Without one explicit table these will be handled ad hoc.

**G3. Denials leave no trace on the order path.**
- `requireThat` throws, the transaction rolls back, and neither the command row nor an audit event is stored.
- Refusals at the proposal-review stage are recorded with reasons (`trade-signals.ts` review), but direct order refusals (limit hit, halted, suspended) are visible only in the HTTP response.
- Nautilus records each refusal as an order event with a reason code. For the agents' learning loop and owner oversight, refusals are data.

**G4. No reconciliation.**
- There is no startup alignment with a broker's orders, trades and holdings, no "external order" concept (for example a manual trade in the broker app, or a corporate-action adjustment by the depository), and no fail-closed rule.
- Rule to adopt: do not let bots trade until the broker holdings match ours.

**G5. No fill deduplication by broker trade id.**
- Our `fills` table keys on our own uuid. With a broker feed plus polling, the same trade arrives twice.
- We need a unique broker trade id per order, and partial-fill accumulation (one order, many fills).

**G6. No rate limiting toward an external system.**
- Indian brokers enforce order-rate limits. The Nautilus pattern of denying (not queueing) excess orders, with a reason code, is the safe default.

**G7. Halt is only "reduce".**
- There is no state that also blocks sells. Example: a broken price feed during a crash, where selling at a bad print is itself a risk.
- In Nautilus, REDUCING also requires a reducing order to match a known position and not exceed it. Our sell check already does that, through the "Insufficient unreserved position" check.

**G8. Backtest and live are different code.**
- `daily.py`, `desk.py` and `portfolio_daily.py` each implement their own fill and cost rules: 5 bps slippage plus fees and the depository charge in `daily.py`, a flat 30 bps round trip in `desk.py`.
- `paper.ts` applies `slippageBps` and `feeBps` from the backend config, and its limits (`maxOrder`, exposure, budget, loss) do not exist in the simulators.
- A strategy that passes research can be refused or sized differently in paper trading.
- Nautilus's core idea is the opposite: the same risk, execution and accounting code everywhere, with only the edges simulated.

**G9. No canonical run record for cycles and backtests.**
- There is no manifest per daily cycle or research run (code version, configuration hash, data hash, seed, status), and no crashed-run sealing.
- The audit chain records *what happened*, but not *which build and configuration* produced it.

**G10. Time is read directly.**
- `paper.ts` calls `Date.now()` for quote freshness and proposal expiry. A replay of a live day through the backend cannot run on simulated time.
- The intraday `Monitor` is already pure (time comes in with each quote), which is good.

**G11. Feed-pressure and unpriced visibility.**
- The monitor has `feed-stale`, but nothing measures lag (receive time minus quote time) or backlog.
- When a live feed is added, a slow consumer will silently act on old prices unless lag is measured and acted on.

### 5.3 Ideas to adopt in our own design

**A1. Explicit order transition table and order event log.**
- **What:** one small module that lists the allowed transitions (reserved, submitted, accepted, partially_filled, filled, cancel_requested, cancelled, rejected, expired, denied), plus an append-only `order_events` table. The current status is checked against the table before any change.
- **Why:** this addresses G1, G2 and G5. It is a prerequisite for a broker.
- **Benefit:** illegal changes become impossible, the history of each order is readable without filtering the audit chain, and it is ready for partial and late fills.
- **Effort:** M. A migration plus a refactor of `paper.ts`. Existing statuses map directly onto the new ones.

**A2. Record denials.**
- **What:** when a reservation is refused, write a refusal row with a reason code in a *separate* small transaction, after the failed one rolls back.
- **Why:** this addresses G3, and supports agent learning and owner oversight.
- **Benefit:** we can count "limit hit", "halted" and "suspended" refusals per bot, which shows when limits are binding and when bots misbehave.
- **Effort:** S.

**A3. A three-way outcome rule for broker commands.**
- **What:** a written policy, adopted before the broker integration: a definitive local failure, a definitive broker result, or unknown.
  - Unknown orders stay in flight and are resolved only by broker evidence, or after N timed-out queries.
  - When resolved locally, the order is marked as a local resolution with a synthetic reason. Such a resolution is never booked as a broker confirmation.
  - Submits and cancel-alls are never retried blindly; reads may be.
  - Every order carries our own client order id, which the broker must echo back.
- **Why:** this addresses G1. It fits our evidence culture: "missing evidence is not an outcome".
- **Benefit:** no double orders, no phantom fills.
- **Effort:** S for the policy and docs, M when implemented with the broker.

**A4. Fail-closed startup reconciliation.**
- **What:** before the daily cycle or an intraday session may create risk, fetch broker holdings, open orders and today's trades, and compare them with our positions and orders.
  - On a mismatch, open a critical incident; this reuses our existing halt.
  - Trades unknown to us become "external" records that need owner review.
  - Absence of a holdings report is never treated as zero holdings.
- **Why:** this addresses G4.
- **Benefit:** the organisation can never trade on a wrong picture of its own book.
- **Effort:** M. It needs the broker adapter, but the comparison and incident logic can be written and tested now against a fake broker report.

**A5. Unique broker trade ids with partial fills.**
- **What:** `fills` gets a unique (order, external trade id) key. An order's filled quantity is the sum of its fills, so one order can have many fills.
- **Why:** this addresses G5.
- **Benefit:** stream and polling duplicates become harmless.
- **Effort:** S–M. Do it with A1.

**A6. A third control state, "frozen".**
- **What:** keep today's halt and rename it in docs and the UI as "reduce-only". Add a stricter "frozen" state that blocks all new orders, including sells; cancels are still allowed.
- **When:** the owner sets it. Optionally the monitor sets it automatically on feed-stale combined with kill-switch conditions, so we never sell into a bad print.
- **Why:** this addresses G7.
- **Benefit:** a clear owner vocabulary and a safe action during data incidents.
- **Effort:** S.

**A7. Shared execution and cost specification for research and paper.**
- **What:** move slippage, fees, the depository charge, the next-open fill rule and the order limits into one versioned specification file read by both `paper.ts` (through config) and the Python simulators.
- **Parity test:** feed one recorded day through both and compare fill price, fee and quantity.
- **Why:** this addresses G8.
- **Benefit:** research results become predictive of paper behaviour, and a rule change cannot drift silently.
- **Effort:** M.
- **Larger alternative (L, not now):** run research backtests through the backend paper engine itself, with an injected clock, to get Nautilus-style "same code" parity.

**A8. Run manifest per cycle, session and backtest.**
- **What:** record the git commit, configuration hash, input data hashes, seed (if any), start and end, and status (running, ended, crashed). On start, any run still marked "running" is sealed as crashed and raised to the owner.
- **Why:** this addresses G9.
- **Benefit:** any result can be traced to the exact code and inputs, and crashes become visible instead of silent.
- **Effort:** S.

**A9. Injected clock in the backend.**
- **What:** route the `Date.now()` calls in `paper.ts` and `trade-signals.ts` through a clock object. The real clock is used by default; a replay clock is used in rehearsal tests.
- **Why:** this addresses G10.
- **Benefit:** deterministic replays of whole days through the real backend, which makes tests stronger.
- **Effort:** S–M.

**A10. Feed lag and unpriced flags in the monitor.**
- **What:**
  - Add a `feed-lag` rule (receive time minus quote time above a threshold).
  - In live mode, refuse to act on a quote older than N seconds.
  - Mark positions with no fresh quote as "unpriced" in the snapshot instead of silently using yesterday's close.
- **Why:** this addresses G11, and the "unpriced is not zero" idea.
- **Benefit:** the kill switch cannot be fooled by a frozen feed.
- **Effort:** S.

**A11. Broker-facing rate limit that denies, not queues.**
- **What:** a sliding-window limit per broker client. An over-limit order is denied with a recorded reason (A2) and never queued.
- **Why:** this addresses G6.
- **Benefit:** no late orders sent after conditions change, and the broker's limits are respected.
- **Effort:** S. Needed only with a broker.

**A12. Recency guard in reconciliation.**
- **What:** when reconciliation (A4) runs during a session, skip orders and positions touched in the last few seconds.
- **Why:** it avoids "correcting" state that is mid-update.
- **Effort:** S, as part of A4.

**Suggested order:**
1. Now, independent of the broker: A2, A6, A8, A10.
2. Before writing any broker code: A1, A3, A5, A9.
3. With the broker adapter: A4, A11, A12.
4. When research and paper are next touched: A7.

### 5.4 Ideas not worth adopting, and why

- **The Rust core, single-threaded message bus, Redis streaming and event store with run files.** We have 8 shares, end-of-day decisions and one database. Postgres transactions plus our hash-chained audit already give ordering, durability and tamper evidence. A bus would add moving parts without solving a problem we have.
- **L2/L3 order-book simulation, queue-position modelling, liquidity consumption, synthetic-depth fill models and probabilistic limit fills.** We trade liquid NSE large-caps at the next open in small size. A fixed slippage in basis points plus our existing liquidity cap (PAPER-05) is the right level of detail. These models need tick or book data we do not have.
- **Latency model.** It is irrelevant for end-of-day fills at the next open. It may become relevant only if intraday execution is added.
- **Margin models, HEDGING positions, contingent orders (OTO, OCO, OUO), order emulation, trailing stops and own order books.** We are cash-only and long-only, with one position per bot and symbol. Each of these adds states and failure modes we do not need.
- **Multi-venue routing.** We will have one broker.
- **Deterministic simulation testing with madsim.** That level of determinism tooling is aimed at async network code. Injecting the clock (A9) and keeping pure cores (as `Monitor` already is) gives us most of the benefit at a fraction of the cost.
- **Inferred fills with back-solved prices and synthetic reconciliation orders.** Inventing trades to make positions match is risky for an organisation whose principle is verified evidence. Our version should *stop and ask the owner* (a critical incident) rather than generate synthetic orders. Keep the fail-closed half of the idea and drop the auto-repair half.
- **Throttler buffered mode.** Queueing orders to send later is the wrong default for trading. Only the deny mode is worth copying.

## 6. What I could not verify

**Partly read files:**
- Several large source files were only read in part, so statements about their later sections come from docs or call sites, not from code:
  - `crates/model/src/orders/mod.rs`: first 100k of about 235k characters.
  - `crates/live/src/execution/manager.rs`: 100k of 294k; the bodies of `reconcile_position_report` and `create_order_fill` were not seen.
  - `crates/execution/src/matching_engine/mod.rs`: 100k of 303k; the market-order fill routine, where `prob_fill_on_limit` and slippage are applied, the `iterate` trigger logic and the reduce-only and price-limit rejections were not seen.
  - `crates/portfolio/src/portfolio.rs`: 100k of 170k; the bodies of `update_quote_tick`, `update_order`, `get_price` and `update_account` were not seen.
  - `crates/model/src/position.rs`: 100k of 357k.
  - `crates/backtest/src/engine.rs`: 100k of 164k.
  - `crates/execution/src/engine/mod.rs`: about 200k of 210k.
- The files were read through a summarising fetch tool, not line by line, so fine details such as exact orderings inside long functions could be slightly off.

**What triggers REDUCING or HALTED.** In the portions of the risk engine read, nothing calls `set_trading_state` automatically. I could not confirm whether any other component, or the Python layer, sets it, for example on drawdown. The docs (`execution/index.md`) also do not say how the state is changed.

**Default values I could not see:** `inflight_threshold_ms`, `inflight_max_retries`, `open_check_threshold_ms` and the other continuous-reconciliation settings are not on the pages read; the docs point to a configuration guide.

**Backtest/live parity in practice.** The code shows the same kernel and engines being built. Whether results actually match, and how often live diverges, is not something code reading can verify; the docs themselves say it is not guaranteed.

**Event store as live recovery.** The docs say live restart still uses snapshot plus reconcile, and that the event store's capture headers are "incomplete". I did not read the `crates/event_store` source.

**Python facades and adapters.** Not read: `python/nautilus_trader/*`, any broker adapter, or Indian-market adapters (I did not check whether any exist). The DST claims (`dst.md`) are documentation only; I did not read the CI hooks or lint configuration.

**License text.** LGPL-3.0 is taken from the task brief; I saw the `LICENSE` file in the listing but did not re-read it.

**Exact commit.** The develop-branch commit hash and date of the snapshot read were not visible on the pages fetched. The note reflects `develop` as served on 2026-10-21.
