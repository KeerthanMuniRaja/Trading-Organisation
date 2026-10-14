# Evidence-backed claims (migrations 029–030)

Claims are small, checkable statements drawn from one evidence snapshot, such as "Reliance quarterly profit rose 12%", each with an exact supporting quote. They turn article-sized evidence into units that bots can use and that can be corroborated across sources. This is the backend half of DATA-02 in the [remaining-work assessment](remaining-work-assessment.md). The Python pipeline in [integrations/claims](../integrations/claims/README.md) drafts and pre-checks claims.

**Audit, 14 October 2026.** The automated pipeline (`autolearn.py`) does **not** yet post its claims here. It keeps them in local files and uses its own looser corroboration (the same share and event type within 72 hours), which this document's own review found unsound. Until it uses the backend's fact keys, it no longer verifies loosely corroborated news automatically: such items wait for a person, unless the owner sets `looseCorroborationVerifies: true` in its configuration. The backend rules below apply to every caller of these routes.

## Rules the backend enforces

| Rule | Enforced as |
| --- | --- |
| The quote is really in the evidence | The quote must appear in the stored evidence text after normalising typographic quotes, dashes and spacing. A fabricated quote returns 400. |
| Dates are plausible | A `reported-fact` cannot be dated after its evidence was published. |
| Only live evidence | The evidence's source must be approved, and its status `unverified` or `verified`. Claims on rejected or revoked evidence are refused. |
| No duplicates | The same quote and symbols on the same evidence returns the existing claim (`duplicate: true`). |
| Independent review | The reviewer must differ from both the claim author and the evidence author. |
| Acceptance needs proof | `accepted` requires verified evidence from an approved source. `rejected` is always allowed. Each claim is reviewed once. |
| History is permanent | `evidence_claims` and `evidence_claim_reviews` are append-only (update and delete raise). A correction is a new claim. |
| Revocation propagates | A claim is `usable` only while it is accepted, its evidence is verified and its source is approved. Revoking either removes usability immediately. |
| Halt | Proposals are refused while the system is halted. |
| Comparable facts (030) | An optional **fact key** names the figure and period, for example `metric: "net profit"` and `period: "Q3 FY25"`, stored canonically as `net profit` and `Q3FY25`. Metric and period come together. A `reportedChangePct` needs a fact key, and **its number must be written in the quote** as digits, so a claim cannot invent its figure. |

Every proposal and review is audited, and the audit chain notifies the owner's inbox.

## API

All routes are `POST`. Mutations require an `Idempotency-Key`.

| Route | Roles | Body |
| --- | --- | --- |
| `/v1/evidence/claims` | researcher | `{evidenceId, statement (≤240), quote (20–300), symbols (1–3), eventType, direction, eventDate (YYYY-MM-DD or null), certainty}`, plus optional `metric` (≤60), `period` (≤40) and `reportedChangePct` (−1000 to 1000) |
| `/v1/evidence/claims/reviews` | owner, evaluator | `{claimId, decision: accepted\|rejected, reason (≤300)}` |
| `/v1/evidence/claims/query` | owner, researcher, evaluator | optional `{evidenceId, symbol, status: pending\|accepted\|rejected, limit ≤100}` |
| `/v1/evidence/claims/corroboration` | owner, researcher, evaluator | `{symbol, eventType?}` |

**Field values:**
- `eventType`: earnings, guidance, order-or-contract, regulatory-or-legal, management, corporate-action, deal-or-investment, rating-or-target, macro-or-sector, or other.
- `direction`: positive, negative, neutral or unclear.
- `certainty`: reported-fact, company-statement, forecast, opinion or rumour.

**How corroboration is computed:** it uses only usable claims for the symbol **that carry a fact key**. Each cluster is one fact: the same event type, metric and period. Claims without a fact key are counted as `unmatchedClaims` and never corroborate anything. Two positive earnings stories about different figures or periods are therefore not "the same news".
- **Independent origins:** distinct sources count separately, but near-identical quotes (syndicated copies) count once.
- **Status:**
  - `contradicted` when two reported figures for the same fact disagree: their signs differ, or they differ by more than 1 point or 10%, whichever is larger.
  - `corroborated` when 2 or more independent origins agree.
  - `single-source` otherwise.
- **Price opinions:** the claims' price-direction opinions are listed as `priceOpinions` for information only. Opposite opinions about the same reported figure are not a contradiction.
- **What it means:** corroboration measures independent agreement about the same figure, not truth. Whether a paraphrased `statement` follows from its quote is still for the reviewer to judge.

The first version (029 only) grouped claims by event type within 72 hours and treated opposite price opinions as contradictions. The October 2026 code review showed both were unsound, which is why 030 introduced fact keys.

## Verification

`backend/test/evidence-claims.test.ts` covers:
- fabricated and typographically different quotes, impossible dates, duplicates, extra fields, roles, halt and withdrawn sources;
- independent review, acceptance only on verified evidence, single review, append-only history, revocation removing usability, and audit-chain validity;
- fact keys:
  - canonical keys, metric and period required together, and a change needing a fact key;
  - the reported figure required in the quote (`112` is not `12`; `1,250` matches 1250);
  - the threshold for figures that disagree;
- corroboration:
  - syndicated copies counting as one origin;
  - an independent report of the same figure corroborating despite an opposite price opinion;
  - a different period as a separate fact, and claims without a fact key reported as unmatched;
  - a materially different figure for the same fact being a contradiction;
- routes registered and guarded by role over HTTP.
