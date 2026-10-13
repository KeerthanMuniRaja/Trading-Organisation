# Source reliability

Part of **KG-01** (source dependence) in the [remaining-work assessment](remaining-work-assessment.md). Code: [`backend/src/source-reliability.ts`](../backend/src/source-reliability.ts). Tests: `backend/test/source-reliability.test.ts`.

Approval says a source *may* be used. Reliability says how its output has **actually held up**. `POST /v1/sources/reliability` (owner, evaluator, researcher; optional `{minDecided}`) builds each source's record only from independent reviews of what it published:

| Part | Meaning |
| --- | --- |
| Evidence verified, rejected, revoked, pending | Reviewers' decisions on its items. A revocation is a verified item later withdrawn or contradicted. |
| Claims accepted and rejected | Decisions on quoted claims drawn from its items |
| Median arrival | Minutes from publication to receipt (timeliness) |
| `score` | `(verified + accepted claims + 1) / (decided + 2)`, where decided counts revocations **twice**. A new source starts at 0.5, and only evidence moves it. |

**Flags and alerts.** A source with at least 10 independent decisions and a score below 0.4 is flagged *low reliability*. An approved one raises the `source-low-reliability` warning alert, which resolves when its record improves or its approval is withdrawn.

The record informs reviewers and the owner's approval decisions. It never approves, revokes or reweights a source automatically.
