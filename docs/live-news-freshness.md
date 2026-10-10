# Live news freshness

The automatic claims exporter writes `verified-headlines.json` plus `verified-headlines.json.receipt.json` after successful backend reconciliation. The receipt binds the exact output bytes with SHA-256 and expires five minutes after reconciliation **started**, so long-running reconciliation does not extend freshness.

Before attempting export or lesson fact-checking, the prior receipt is removed. Reconciliation failure leaves no usable receipt. A receipt is written last; interruption between headline publication and receipt publication cannot make a new file eligible to the live reader.

`integrations/trading-desk/live.py --news PATH` now requires this receipt on every poll for any supplied news file. Missing, malformed, future-dated, expired, oversized or mismatched files produce no news. The previous valid copy is never retained after a read failure. The desk continues its other paper-analysis roles and logs news errors; this is not a halt of paper trading.

The live reader accepts at most 5 MB of headlines and 4 KB of receipt metadata. Receipt lifetime is fixed at five minutes. Reusing a receipt with different content or extending its expiry fails validation. A hash is not a signature: a process with filesystem write access can forge both files. This is freshness and consistency checking, not independent identity verification or OS isolation.

## Operational consequences

- Deploy the updated exporter and live reader together. Existing live `--news` files without receipts will be excluded. The next successful export produces a receipt automatically.
- Reconcile frequently enough for the intended live-news coverage. An hourly learning cycle supplies only a short eligible window; after expiry the live desk uses no news until a new export. This change does not start a scheduler or consume model credits.
- A revocation after reconciliation may remain unseen until the next poll/export or receipt expiry. The reader checks at poll time, not continuously during model inference. Instant revocation remains future work.
- Historical replay (`desk.py` and `batch.py`) still accepts owner-supplied headline lists under its existing contract. This freshness receipt applies to the live reader; it does not make replay inputs point-in-time safe or prove factual correctness.

Verified with offline fixtures: valid receipts, expiry boundaries, future timestamps, tampered content, extended lifetime, missing receipts, invalid files, exporter failure and live/replay execution parity.

## Finite reconciliation worker

`integrations/claims/refresh_headlines.py` refreshes existing reviewed claims without extracting news or calling a model. It permits only `POST /v1/evidence/status`; the researcher credential is selected from local configuration. Other backend writes are explicitly refused by its API wrapper. This is application-level endpoint restriction, not a new restricted backend credential or OS sandbox.

From the project directory in Command Prompt:

```bat
.local\replay-venv\Scripts\python.exe integrations\claims\refresh_headlines.py --config .local\claims\autolearn.json --cycles 30 --interval-seconds 120
```

The configuration and reviewed claim state must already exist. Defaults are one cycle and a two-minute interval. Bounds are 1–120 cycles and 60–240 seconds between cycles. Network time is additional; receipt expiry still starts before reconciliation. Failure stops the worker, invalidates the receipt and produces exit code 1. `headline-refresh-status.json` records the latest cycle outcome without credentials. No scheduler, service, inference process or trading session is started automatically.

An exclusive `headline-refresh.lock` prevents two refresh workers from using the same state. A crash may leave that lock; confirm the process stopped before removing it. The lock does not cover all legacy autolearn state writers: avoid concurrent learning/export processes against the same directory until shared state locking is implemented. This worker refreshes backend eligibility, not the news corpus; newly collected articles still need the normal learning/review workflow.
