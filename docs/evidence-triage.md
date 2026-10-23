# Relevance triage: setting aside news that cannot affect the portfolio (KNOW-02)

The news feeds bring in every story the approved publishers carry. Many are about companies and topics outside the eight tracked shares, but each waits for a review that needs the model. The backlog grows, the `evidence-backlog` alert fires every day, and reviewers (or a future model) spend time on stories that cannot matter.

Triage applies **fixed, versioned rules in the backend** to every waiting news item or article. Nobody chooses the result and no model is needed.

| Decision | When | Effect |
| --- | --- | --- |
| `in-scope` | The text names a tracked share (with its usual names, such as *State Bank of India*, *SBI* or *Reliance Industries*), or a market-wide driver (Nifty, Sensex, RBI, repo rate, inflation, rupee, FII flows, SEBI, crude oil, and similar) | Stays in the review queue, with what it matched (`scope`) |
| `out-of-scope` | Nothing matched | Set aside: left out of the review queue (unless `includeOutOfScope: true`), the backlog alert and the digest backlog. The digest counts it as `setAside`. |

**Rules of the decision:**
- **Not a verdict.** An out-of-scope item is **not rejected**: nobody judged it false, and it can still be reviewed normally.
- **Matching.** Names in capitals (SBI, ITC, RBI) match only in capitals; other names ignore case. Every term must be a whole word.
- **Record.** Each item is triaged once. The decision is append-only and records the rules version that made it. The current version is `scope-v2`, which adds world drivers such as the Federal Reserve, OPEC, Nasdaq and tariffs, recorded as `world:<term>` ([world news](world-news.md)). Items triaged earlier keep their `scope-v1` decision.
- **Changing the list.** The term list is in [`backend/src/evidence-triage.ts`](../backend/src/evidence-triage.ts). Changing it should change the version.

`POST /v1/evidence/triage` (evaluator or owner) triages everything waiting, up to 1000 items per run. The organisation cycle runs it as the step `news-triage`, right after the news feeds.

Code: [`backend/src/evidence-triage.ts`](../backend/src/evidence-triage.ts). Migration: [`048_evidence_triage.sql`](../db/migrations/048_evidence_triage.sql). Tests: [`backend/test/evidence-triage.test.ts`](../backend/test/evidence-triage.test.ts).
