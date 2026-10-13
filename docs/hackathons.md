# Hackathons: the organisation's R&D contests

Implements the core of **RD-01** from the [remaining-work assessment](remaining-work-assessment.md): challenges, entries, concealed evaluation, independent judges and negative-result extraction.

Code: [`backend/src/hackathons.ts`](../backend/src/hackathons.ts). Migration: [`036_hackathons.sql`](../db/migrations/036_hackathons.sql). Tests: [`backend/test/hackathons.test.ts`](../backend/test/hackathons.test.ts).

## Lifecycle

| Stage | Route | Who | Rules |
| --- | --- | --- | --- |
| Create | `POST /v1/hackathons` | owner | Sets the question, metric (and whether higher is better), baseline, entry deadline, entries per bot (1–10) and the **evaluation window**. The response publishes a commitment hash of the window. |
| Enter | `POST /v1/hackathons/entries` | bot-bound trader or researcher, for its own bot | Must be before the deadline and within the entry limit. Each entry is a versioned JSON specification. Resubmitting the same spec returns the original, and submitting another bot's spec is refused. |
| Close entries | `POST /v1/hackathons/judging` | owner, after the deadline | Reveals the window and its salt. `commitVerified` proves it matches the hash published at creation. |
| Judge | `POST /v1/hackathons/results` | evaluator or owner, never the entry's author | Records the score and baseline score with verified evidence. The backend decides whether the entry beat the baseline. Each entry is judged once. |
| Findings | `POST /v1/hackathons/findings` | owner, evaluator, researcher | Positive, **negative** or next-step findings, optionally with evidence. At least one is required before closing, so every contest teaches something. |
| Finish | `POST /v1/hackathons/closures` | owner | Only when every entry is judged and a finding exists |
| View | `POST /v1/hackathons/view` | all bot roles | Shows a leaderboard ranked by the metric and the outcome: the best entry that beat the baseline, or "no entry beat the baseline (a negative result)". While entries are open, the window is concealed from everyone but the owner, and traders see only their own entries. |

## Guarantees (tested)

- **History cannot be rewritten.** Entries, results and findings are append-only, and every stage is audited.
- **The evaluation window cannot be changed after creation**, because its hash commitment is published at creation.
- **Entries are each bot's own work.** No bot can enter for another, copy another's specification, or judge its own entry.
- **Results are recommendations only.** Nothing is promoted, funded or deployed automatically.

## How it fits

The trading desk's Python tournament (`integrations/trading-desk/tournament.py`) and forward tests can be run as entries, with their reports submitted as verified evidence for judging. The [regime study](../integrations/trading-desk/README.md) suggests a first contest: *which monthly rule beats holding the basket after costs over the next six months?*

Still open in RD-01:
- recurring scheduling;
- team entries;
- cost budgets per contest;
- automatic incubation proposals from winners.
