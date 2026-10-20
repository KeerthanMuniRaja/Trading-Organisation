# Historical NSE research replay

This experiment downloads RELIANCE.NS five-minute bars through the open-source [yfinance](https://github.com/ranaroussi/yfinance) library. No broker login is required. It is a historical replay with simulated money, not live monitoring, AI model training, or organisation bot qualification. Yahoo data remains subject to its provider terms; this adapter is for personal research, not a production data licence.

## Run in Command Prompt

All commands are run from the Nexus directory. Dependencies are isolated in `.local/replay-venv`; there are no global installs, persistent services or bank connections.

```bat
integrations\skfolio\.venv\Scripts\python.exe -m venv .local\replay-venv
.local\replay-venv\Scripts\python.exe -m pip install --disable-pip-version-check --no-cache-dir -r integrations\market-replay\requirements.lock.txt
npm run paper:replay -- --download --end 2026-10-08
```

`--end` is exclusive. This example requests the preceding seven calendar days, omitting the current, potentially incomplete day. Without `--end`, the runner uses today's date in IST. Yahoo may reject, rate-limit or return no data; errors do not trigger a fabricated-data fallback. The launcher limits execution to 90 seconds and passes no model, broker or organisation credentials to Python. Local Yahoo timezone/cookie cache resides under `.local/market-replay-cache`.

Successful output includes `.local/market-replay/<run>/dataset.json`, `report.json` and a pending `experience.json` learning packet. Repeat offline with:

```bat
npm run paper:replay -- --input .local\market-replay\RUN_DIRECTORY\dataset.json
.local\replay-venv\Scripts\python.exe -m unittest discover -s integrations/market-replay -p test_*.py
```

Replace RUN_DIRECTORY with the generated directory name. The report includes a SHA-256 hash of its canonical dataset snapshot, decisions, simulated fills, an equity curve, realised and unrealised P&L, and maximum drawdown. Saved local files are ignored by Git. The direct yfinance version is pinned; `requirements.lock.txt`, when present, records resolved transitive versions for repeat installation.

## Simulation rules and limits

Start with ₹10,000 simulated capital. Buy one share when the last three closes exceed the twelve-bar average by 0.1%; sell after six observed holding bars or the shorter average drops below the longer average. Signals use completed bars and can fill only at the **next observed bar's open**, under an explicit liquidity assumption. Overnight gaps are possible and priced at the next actual open. No intrabar execution or real bid/ask spread is inferred from candles.

Every fill assumes five basis points adverse slippage and ten basis points illustrative fees. These are not actual brokerage or statutory taxes. Each purchase including fees is capped at 20% of starting capital. At most ten round trips; stop further entries at ₹100 cumulative realised loss. Price gaps may exceed that loss threshold. New buy signals require positive volume in the completed signal bar. Missing bars are not interpolated. Corporate actions cause rejection until an adjustment-aware simulator is implemented.

Version `fixed-momentum-baseline-v2` removes the earlier execution-bar volume condition: its eventual volume was not known at its opening price. Fills now make an explicit unverified-liquidity assumption. Changing execution-bar volume cannot change a pending opening fill. This does not prove the opening price could actually accommodate an order.

The final position is marked using the last close and estimated exit costs, not force-sold at a price known before the decision. Unfilled final signals remain unfilled. Data is checked for INR, timezone, regular weekday session timestamps, ordered bars, OHLC consistency and valid volume. Provider floats are rounded to integer paise. Synthetic fixtures are labelled explicitly and used only in software tests.

This fixed baseline is not fitted or selected on the downloaded sample. A short single-stock replay cannot validate profitability or the organisation's self-learning. Next steps are cost calibration, independent holdout evaluation, calendar/corporate-action support, and routing verified research evidence into the existing academy and knowledge workflows without bypassing their gates.

## First observed run — 8 October 2026 IST

Public-data retrieval succeeded for the seven-calendar-day window ending before 8 October. The snapshot contained 292 bars. The fixed baseline made 20 simulated fills (10 round trips), with realised net P&L of **−₹9.82**, ending equity **₹9,990.18**, no open position, and maximum marked drawdown approximately **0.235%**. These figures include the illustrative costs above and are not returns from actual trades.

The local run directory is `20261007T184619741734Z` (UTC). Dataset SHA-256: `bacaf5361359f1596a1914d79cb758b2144e07307aefe94171258da13db59d17`. Six offline regression tests passed. No model was trained and no organisation bot was promoted by this diagnostic.

These first-run figures are historical v1 evidence. The current simulator is v2; old reports must be rerun from their preserved dataset before creating a current experience packet. Existing reports are not rewritten.

## Reproducible experience packets

Each new replay records the dataset and simulator SHA-256 fingerprints. Before emitting an experience packet, the verifier recomputes the report and checks its complete canonical representation. It rejects modified scores, changed data, extra report fields and a different simulator fingerprint. Existing experience packets are never silently overwritten.

```bat
npm run paper:replay -- --review-run .local\market-replay\RUN_DIRECTORY
```

The packet contains scoped numerical findings, evidence graph nodes/edges, limitations and review questions. It preserves losing outcomes as well as profitable ones. The detailed graph is a local artifact. It has status `pending-independent-review`: recomputation uses the same simulator and therefore is not independent methodological validation. No model training, bot promotion, fitness changes or wallet operations occur. The importer below connects its compact factual evidence and lesson to the existing backend evidence/lesson graph; it does not import arbitrary local graph nodes or approve them.

Ten regression tests cover replay accounting, timing, allocation, corporate-action rejection, tamper detection, graph consistency and immutable review output.

The v2 offline rerun in `20261007T185442659553Z` produced 20 fills, **−₹6.14** realised net P&L, no open position and approximately **0.2374%** maximum marked drawdown. Its pending experience packet was recomputed successfully a second time without mutation. The changed result follows the execution-volume timing correction, not model learning or strategy tuning.

## Import into the organisation's review workflow

Prerequisites: a running backend, an **owner-approved internal research source** and an existing active student bot. This is locally computed research, not analysis published by Yahoo; use an internal research source ID, not a publisher source merely because it supplied prices. Configure the existing `.env` with `API_URL` and exactly one researcher in `PRINCIPALS_JSON`. Never paste tokens into chat. The importer selects only that researcher's token; its Python verifier receives no backend credentials.

From Command Prompt:

```bat
npm run learning:replay -- evidence .local\market-replay\RUN_DIRECTORY INTERNAL_SOURCE_ID
```

Before any API call, the importer recomputes the report, verifies the stored experience packet and prepares a bounded factual evidence body. The body distinguishes the dataset provider from local analysis and contains the dataset/report/simulator fingerprints. A local `evidence-submission-SOURCE_ID.json` freezes the submission timestamp for retries. Publication time denotes this research submission, not the dates of the market bars.

The backend receives `/v1/evidence` and returns an evidence UUID. This remains **unverified**. An independent owner/evaluator must review that evidence using the existing `/v1/evidence/reviews` endpoint; the importer has no review operation. After verification:

```bat
npm run learning:replay -- lesson .local\market-replay\RUN_DIRECTORY INTERNAL_SOURCE_ID BOT_ID
```

This replays the same evidence submission and proposes a narrow factual lesson via `/v1/lessons`. A separate `/v1/lessons/reviews` decision is still required. Only then can the existing knowledge retrieval include it. Backend review confirms a reviewer decision, not external truth or general strategy skill. A revoked source or evidence removes supported lessons from usable knowledge. An idempotent historical receipt is not current permission.

The importer uses stable idempotency keys, rejects redirects and unsafe API origins, and never calls source approval, bot creation, curriculum, promotion, trading or money endpoints. After a lost response, rerun the identical command. Do not edit its saved submission to force another attempt. No source is auto-created and no persistent policy is enabled.

Verification: eleven Python cases cover the simulator, packet and export; four Node cases cover retry safety, credential boundaries, sequencing and a real HTTP backend in a fresh in-memory database. The HTTP case verifies that evidence must be independently approved, lessons remain invisible until reviewed, retries reuse IDs, source revocation removes knowledge, and the bot remains in school.

```bat
npm run build
npm run test:replay-import
```
