# Vibe-Trading research integration

Added 8 October 2026: [research practice adaptation](../../docs/vibe-research-practice.md) supplies bounded opposing-case and validation guidance to the existing knowledge/capability model prompts. This is prompt reuse, not model-weight transfer or an activated upstream swarm.

Status: one-shot read-only MCP collector, offline news-result adapter, explicit evidence submission and a resumable collect-to-submission cycle. No Vibe-Trading runtime is installed or activated by this integration.

The adapter consumes the decoded JSON returned by upstream `get_stock_news`, rather than an MCP transport envelope. It reuses our source importer and its retry keys. Backend source approval, independent evidence review and lesson review remain authoritative. A local mapping does not approve a source in the backend.

## Usage from Command Prompt

### Run one complete research intake cycle

After configuring the already-running upstream server and approved publisher mappings as described below:

```cmd
npm.cmd run worker:news:vibe -- collector.json query.json sources.json .local/news-cycle-001
```

This command deliberately submits valid observations using the single researcher credential in `.env`. It collects once, saves artifacts, then calls the existing evidence importer. It does not approve evidence, create lessons or invoke a model. Run the same command with the same directory and inputs to recover an interrupted submission. Use a new directory for a genuinely new collection.

Each cycle binds the query, collector configuration, source mappings, backend origin and a hash of the credential. Changed inputs or credentials cannot resume an existing cycle. Manifest and outcome files do not contain credentials. Collection output sits in `collection/`; `outcome.json` records `awaiting-review`, `blocked` or `no-news`. The recorded outcome is historical and does not poll subsequent evidence-review decisions.

If an acknowledgement is lost, the cycle reuses saved news and existing importer idempotency keys. Some earlier rows may already have been accepted. If fetching was interrupted before `complete.json`, it stops for inspection instead of silently fetching different news. An empty result or any rejected row causes no submission. Successful outcomes are reused without new network requests.

`cycle.lock` prevents concurrent use of the same directory. A process crash can leave this lock behind: confirm the worker has stopped before manually removing that exact lock. There is no automatic stale-lock takeover. Distinct cycle directories are independent and do not share a collector rate limit; backend source quotas still apply. Local artifacts must remain under trusted operator control; hashes detect accidental changes, not an attacker who can rewrite both artifacts and hashes. The receipt uses a synced temporary file and rename; full machine/power-loss durability is not claimed.

The worker is finite: one collection of at most 25 articles and one sequential submission batch, then it exits. No persistent scheduler is started.

### Collect from an already-running Vibe-Trading server

Copy `config/vibe-news.example.json` to an operator-managed configuration and set `enabled` to `true` only after preparing a reviewed Vibe-Trading runtime. This repository does not install or launch it. The expected upstream interface is Streamable HTTP `/mcp` on a literal loopback address; legacy `/sse`, remote hosts, credentials in URLs and redirects are refused. Keep upstream shell tools disabled.

Example `query.json`:

```json
{"scope":"stock","code":"AAPL.US","limit":5}
```

With the source mapping below already prepared:

```cmd
npm.cmd run sources:collect:vibe -- collector.json query.json sources.json .local/news-run-001
```

The output directory must be new and its parent must exist. A successful collection writes `news.json`, `collection.json`, `prepared.json` and finally `complete.json`. Missing `complete.json` means collection/preparation was incomplete; partial files are retained for diagnosis. Existing directories are never overwritten. Use saved `news.json` with the preparation/submission commands below; rerunning submission does not refetch changing upstream news.

The client initializes one MCP session, declares no client capabilities, calls only `get_stock_news` once and attempts session deletion. It supports JSON and bounded SSE responses, including progress notifications. It does not execute server requests, accept a tool name from input, perform automatic retries, load model credentials or use backend credentials. A collection deadline is at most 30 seconds, followed by at most 2 seconds for cleanup. Response bodies are capped at 300,000 bytes and SSE events at 100. Session deletion failure is reported; disconnecting cannot guarantee an upstream provider operation was cancelled.

The handshake requires protocol `2025-03-26`, tool support and the reported name `Vibe-Trading`. Server identity/version are self-reported, not cryptographic attestation of a pinned installation. Other protocol versions, MCP batching and multiple-content-block tool results currently fail closed. News results must match the requested symbol, market, provider, scope and row limit.

This increment collects once and persists evidence candidates. It does not start a recurring worker, approve sources, verify article truth, submit observations or invoke an LLM.

### Prepare and submit saved results

Create `sources.json` using existing backend source IDs and exact publisher origins:

```json
{"sources":[{"origin":"https://publisher.example","sourceId":"registered-source-id"}]}
```

Save the upstream tool's JSON result as `news.json`. Inspect the conversion without network calls or credentials:

```cmd
node scripts/import-vibe-news.mjs prepare news.json sources.json
```

After reviewing the result, explicitly submit with the existing researcher credential configuration:

```cmd
node --env-file=.env scripts/import-vibe-news.mjs submit news.json sources.json
```

Submission refuses any rejected row, an empty batch, or more than 25 accepted observations. Preparation reports individual rejection indexes. Files are bounded to 256 KiB for news and 64 KiB for mappings. Backend submission can acknowledge some rows before a network failure; rerunning unchanged inputs uses the existing idempotency keys.

Keep the input result and preparation output as provenance artifacts. `rawHash` hashes the parsed result's JSON serialization, not the original file bytes. This metadata is returned to the caller, not stored as additional backend columns. The backend retains its existing observation hashes and collector-submitted provenance.

Snippets are explicitly labelled and never treated as full articles. Missing snippets are rejected. Yahoo's inspected implementation emits UTC dates without a timezone suffix; this adapter restores that suffix. Unzoned Eastmoney dates are rejected rather than assigned an assumed timezone. Other accepted timestamps must explicitly use UTC `Z`. Provider failures, unknown provider/market combinations, unapproved publisher origins, malformed/future dates and credential-bearing URLs are rejected. Provenance is a collector claim, not proof of a genuine upstream fetch.

## Reuse direction

Use Vibe-Trading's data tools and specialised research workflows behind our bounded worker interfaces. The inspected investment committee separates bullish research, bearish research, risk review and a final synthesis. Adapt that structure to our evidence and review contracts. Its default shell/file tools and model budgets need separate assessment before runtime use.

Retain our organisation's lifecycle, graduation, knowledge acceptance, permissions and two-wallet ledger as backend authority. Swarm reports are research proposals; they do not authorise orders or bot promotion. Indian-market news, pinned dependency acquisition, actual upstream transport validation, automatic scheduling and end-to-end provider validation remain pending.

## Upstream review, 2026-10-06

Inspected the README, packaging metadata, licence/NOTICE, MCP server, investment-committee and quant-desk presets, and stock-news implementation. This was a targeted review, not a full security audit. Sources were read from mutable `main`; pin and verify an exact revision before installing or vendoring runtime code.

- [Stock-news implementation](https://github.com/HKUDS/Vibe-Trading/blob/main/agent/src/tools/stock_news_tool.py)
- [MCP tool interface](https://github.com/HKUDS/Vibe-Trading/blob/main/agent/mcp_server.py)
- [Investment committee](https://github.com/HKUDS/Vibe-Trading/blob/main/agent/src/swarm/presets/investment_committee.yaml)
- [Quant strategy desk](https://github.com/HKUDS/Vibe-Trading/blob/main/agent/src/swarm/presets/quant_strategy_desk.yaml)
- [MIT licence](https://github.com/HKUDS/Vibe-Trading/blob/main/LICENSE) and [component notices](https://github.com/HKUDS/Vibe-Trading/blob/main/NOTICE)

The adapter is original glue code; no upstream source was vendored. Future copying must preserve applicable copyright/licence notices, including component-specific notices such as Qlib's Apache-2.0 attribution.

## Validation

On 2026-10-06, 31 tests passed using Command Prompt: adapter validation, submission wrapper, existing importer, JSON/SSE HTTP handshakes, scope binding, timeout/cleanup, redirect rejection, response bounds, saved collection artifacts, completed-cycle reuse, lost-acknowledgement recovery, changed bindings, blocked/empty outcomes, interrupted collection, altered snapshots and concurrent-cycle exclusion. Collector tests use real loopback HTTP with a fixture server; submission tests use an injected HTTP transport. This does not verify a running backend or upstream provider. No PowerShell scripts were run for this increment.

```cmd
npm.cmd run test:vibe
```

<!-- documentation-navigation -->
[Documentation index](../../docs/documentation-index.md) · Documentation reconciled for v0.1.32 on 7 October 2026; historical records retain their original scope.
