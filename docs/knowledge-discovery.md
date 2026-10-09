# Discovering reusable bot knowledge

Bots can now search the organisation's reviewed lessons before requesting a cross-bot transfer. This applies the reusable-memory idea from Hermes and the retrieval idea from Ruflo to our existing evidence and review model. The search itself is original backend code, not an installed vector/agent plugin.

`POST /v1/learning/knowledge/discover` accepts:

```json
{"botId":"student","query":"fees slippage drawdown","limit":5}
```

Owner, researcher and evaluator roles may call it. The recipient must exist and not be retired. Results contain only other bots' verified lessons with currently verified evidence, an approved source and a nonfuture publication date. Retired authors' lessons remain discoverable when their support is still valid. Own lessons, unreviewed lessons and revoked support are excluded.

The query is at most 200 characters and yields 1–12 distinct Unicode letter/number terms of at least three characters. Ranking counts distinct case-insensitive substring matches in lesson content, then orders by lesson creation time and UUID. Results include matched terms, author state, reviewer, evidence/source IDs and available article provenance. Relevance is a search score, not confidence, trust or fitness. There are no embeddings, semantic reasoning, stemming or corroboration claims. Up to 20 results are returned, with a truncation flag and up to five `suggestedLessonIds` compatible with the transfer endpoint.

From Command Prompt:

```cmd
npm.cmd run worker:knowledge -- discover --bot-id student --query "fees slippage drawdown"
```

Discovery calls only the backend. It needs no model endpoint and does not consume an inference ticket. Use selected returned lesson IDs with the existing knowledge-request/proposal workflow; that request independently checks current support, freezes context, observes policy/halt and consumes the shared model budget. The discovery result does not grant permission to infer, accept a transfer, graduate a bot or trade.

The read remains available during a halt for inspection. It is a current-state view, not historical backtest retrieval. Newly reviewed knowledge cannot be assumed to have existed at its underlying article's publication time. Finding several related lessons does not establish independent corroboration.

## Discover and prepare a learning proposal

The existing Hermes worker now supports one combined operation:

```cmd
npm.cmd run worker:knowledge -- discover-learn --bot-id student --query "fees slippage drawdown" --task "Apply the cost lesson to a fresh portfolio comparison" --request-key student-costs-001
```

It discovers up to five lessons, validates their IDs against the returned cross-bot records, and saves the selection before requesting inference. The existing knowledge worker then obtains a backend-budgeted ticket, checks the configured/pinned Hermes model profile, revalidates evidence support and proposes a plan. Independent transfer review and fresh-task assessment remain separate steps. This does not graduate a bot, change fitness, create a department or execute trades.

The local journal under `integrations/hermes/.state/discovered-learning` binds a request key to the backend, credential hash, bot, query and task. Reuse the same key and unchanged inputs to recover; do not change credentials or delete journals to recover a possibly completed inference. A per-key lock prevents concurrent use of the same local journal. Once selected, lessons are not rediscovered on a retry. The nested proposal journal replays submissions without repeating inference; uncertain model outcomes still stop for reconciliation.

If discovery finds nothing, the worker saves `no-matching-lessons` without loading model settings. That outcome remains fixed for this key. Use a new key for a deliberately new search after additional lessons become available. If selected support is withdrawn, the existing backend checks stop the proposal; the worker does not silently replace the lesson selection. Completed outcomes are historical receipts, not proof that their supporting evidence remains valid today.

No model runtime was activated during development. With matches, actual use still requires an enabled owner development policy, configured model endpoint and verified Hermes checkout. This is one finite attempt; it does not start a persistent organisation loop. Journals are local trusted state with process-recovery protection, not distributed leases or a claim of power-loss durability.

Combined-worker validation: **20 Python tests passed**, including six new cases for empty results, frozen selection, changed identities, lost-acknowledgement recovery through the real proposal journal, malformed selections, withdrawn support and invalid acknowledgements (the malformed-selection cases are grouped within one test). These tests use stand-in model/backend responses; they do not demonstrate actual model learning.

Validation: TypeScript build passed; the eight-test bot-knowledge backend suite passed, including retrieval ordering, retired-author preservation, HTTP roles, revoked support and transfer revalidation. Fourteen Python tests passed across knowledge, source-learning, workflow and discovery CLI tests. No real model inference or upstream runtime was activated. Rebuild/restart to expose the route; no new migration is required.

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 7 October 2026; historical records retain their original scope.
