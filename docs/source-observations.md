# External source observations — v0.1.25

This is the ingestion boundary for news, articles and filings. A collector submits a bounded text snapshot; the backend retains its publisher, article URL, title, publication time, first backend observation time and snapshot hash. It does not fetch the URL or attest that the publisher actually served the submitted text. Treat the text as untrusted data, never executable instructions.

## Workflow

1. The owner registers an approved publisher using the existing `POST /v1/sources` route. An observation's HTTPS origin must exactly match the registered source URL's origin (including any nonstandard port). Paths may differ; subdomains require their own registered source.
2. A researcher or market principal posts one observation to `POST /v1/sources/observations`, with an `Idempotency-Key`. Only `sourceId`, `url`, `title`, `kind`, `content` and `publishedAt` are accepted. Supported kinds are `news`, `article` and `filing`. Content is limited to 4,000 characters and title to 300. URLs cannot contain credentials or fragments. Publication times cannot be future-dated.
3. The backend creates unverified evidence and an immutable observation atomically. It supplies the observation time; callers cannot backdate it. The snapshot hash covers all six fields in a versioned envelope. This differs from legacy evidence's content-only hash. Identical snapshots deduplicate across callers. A changed article body or metadata creates a separate unverified revision and does not silently replace or revoke the earlier version.
4. An independent owner/evaluator reviews the evidence through `POST /v1/evidence/reviews`. Acceptance is a review decision, not automatic source authentication or proof of truth. The original author cannot review their own evidence. Duplicates do not change authorship.
5. Researchers can propose lessons supported by accepted evidence. Lessons still require their own independent review before cross-bot transfer. Transfer context carries article provenance and timestamps. The bot graph connects evidence to its source observation using `observed-as`.

Source/evidence revocation uses the existing revocation API. History remains available, but its current usability becomes false and dependent transfers fail their support checks. The organisation halt blocks new ingestion. At most 100 new observations per approved source are accepted in a rolling 24-hour window. Duplicate snapshots do not consume another slot. These limits apply to this intake route, not legacy evidence submissions.

## Bounded batch import

Create a JSON file containing 1–25 observations (maximum file size 256 KiB):

```json
[
  {
    "sourceId": "publisher-id",
    "url": "https://example.org/news/story",
    "title": "Article title",
    "kind": "news",
    "content": "The authorised excerpt or source text to review.",
    "publishedAt": "2026-10-01T09:00:00Z"
  }
]
```

Use an already approved publisher and its actual origin; the example is not a configured source. From the project directory, with the backend running and the existing `.env` containing exactly one researcher principal:

```cmd
npm run sources:import -- observations.json
```

The command submits sequentially, refuses API redirects and stops on the first unacknowledged item. It sends credentials only to the configured backend origin, never to article URLs. Rerun the unchanged file after an interrupted response: deterministic idempotency keys prevent a second ingestion. Previously acknowledged operations replay their historical response, so query current state before treating evidence as usable. The importer does not approve evidence, extract lessons, start a model or run a persistent process.

## Review query

`POST /v1/sources/observations/query` accepts `{ "sourceId": "publisher-id" }` plus an optional `status` of `unverified`, `verified`, `rejected` or `revoked`. Owner, researcher and evaluator roles can read up to 50 newest observations, with a `truncated` flag. There is no pagination yet. Each row includes source content, author, reviewer and current usability.

## Organisation review inbox

`POST /v1/sources/observations/review-queue` is available to owners and evaluators. Its strict body supports optional `sourceId`, `after` (an observation evidence UUID), `limit` (1–50, default 20) and `includeBlocked` (default false). It returns pending source observations across publishers, oldest first, with `nextCursor`. Pass that cursor as `after` to continue; a reviewed cursor remains valid. Ordering uses the original database timestamp and evidence UUID, preserving timestamp precision. The queue is a current view, not a frozen snapshot; start a fresh scan to revisit records whose source approval changed behind the cursor.

Default results exclude the caller's own evidence, withdrawn sources and future publication dates. `includeBlocked: true` exposes them with `blockers` and `ready_for_review: false` for inspection. Queue readiness is not evidence verification, a truth score or permission to bypass the review API. Rejected, revoked and verified evidence is excluded. Legacy evidence without a source-observation record is outside this inbox.

From Command Prompt with exactly one configured evaluator credential:

```cmd
npm.cmd run review:news
npm.cmd run review:news -- queue-query.json
```

Example query file:

```json
{"limit":20,"includeBlocked":true}
```

This command reads one page and does not submit any review decision. After checking provenance and corroboration, use the existing evidence-review route, followed by the separate source-to-lesson workflow. Self-review is still rejected by the backend. Rebuild and restart to expose the new route; no additional database migration is required.

## Remaining work

Version 0.1.28 adds bounded [RSS/Atom feed retrieval](publisher-feeds.md) with checkpoints and crash-safe resubmission. Publisher-specific parsing, full-article retrieval and corroboration remain unfinished. Version 0.1.26 adds a separate [article-to-lesson model proposal and independent review path](source-learning.md), with production Hermes inference still unqualified; direct benchmark results are recorded separately in [model selection](model-selection.md). Multiple copies of a claim are not independent corroboration. Observation/publication timestamps provide provenance; current graph and knowledge APIs remain current-context tools, not historical backtest selection APIs. An old publication date must not be used to pretend recently observed content was available in an earlier experiment.

No trading decision, bot fitness change, promotion, deployment or wallet operation follows ingestion. Rebuild and restart the backend to apply migration 019. Previously applied migrations remain unchanged.

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
