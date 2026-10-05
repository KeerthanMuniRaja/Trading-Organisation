# Vibe-Trading research integration

Status: offline news-result adapter and explicit evidence submission. No Vibe-Trading runtime is installed or activated by this integration.

The adapter consumes the decoded JSON returned by upstream `get_stock_news`, rather than an MCP transport envelope. It reuses our source importer and its retry keys. Backend source approval, independent evidence review and lesson review remain authoritative. A local mapping does not approve a source in the backend.

## Usage from Command Prompt

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

Retain our organisation's lifecycle, graduation, knowledge acceptance, permissions and two-wallet ledger as backend authority. Swarm reports are research proposals; they do not authorise orders or bot promotion. Indian-market news, runtime transport, pinned dependency acquisition, live provenance capture and end-to-end provider validation remain pending.

## Upstream review, 2026-10-06

Inspected the README, packaging metadata, licence/NOTICE, MCP server, investment-committee and quant-desk presets, and stock-news implementation. This was a targeted review, not a full security audit. Sources were read from mutable `main`; pin and verify an exact revision before installing or vendoring runtime code.

- [Stock-news implementation](https://github.com/HKUDS/Vibe-Trading/blob/main/agent/src/tools/stock_news_tool.py)
- [MCP tool interface](https://github.com/HKUDS/Vibe-Trading/blob/main/agent/mcp_server.py)
- [Investment committee](https://github.com/HKUDS/Vibe-Trading/blob/main/agent/src/swarm/presets/investment_committee.yaml)
- [Quant strategy desk](https://github.com/HKUDS/Vibe-Trading/blob/main/agent/src/swarm/presets/quant_strategy_desk.yaml)
- [MIT licence](https://github.com/HKUDS/Vibe-Trading/blob/main/LICENSE) and [component notices](https://github.com/HKUDS/Vibe-Trading/blob/main/NOTICE)

The adapter is original glue code; no upstream source was vendored. Future copying must preserve applicable copyright/licence notices, including component-specific notices such as Qlib's Apache-2.0 attribution.

## Validation

On 2026-10-06, the adapter, submission wrapper and existing importer passed 11 tests using Command Prompt. Submission tests use an injected HTTP transport; this does not verify a running backend or upstream provider. No PowerShell scripts were run for this increment.

```cmd
node --test integrations/vibe-trading/news-adapter.test.mjs scripts/import-vibe-news.test.mjs scripts/import-observations.test.mjs
```
