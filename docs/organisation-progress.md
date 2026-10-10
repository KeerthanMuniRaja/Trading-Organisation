# Organisation backend progress

Current planning estimate: **about 6/10 against the full organisation vision**. This is a qualitative estimate, not a measured completion percentage, production-readiness score or prediction of trading accuracy. The existing backend has considerably more implemented structure than proven autonomous capability.

| Area | Implemented foundation | Significant remaining work |
| --- | --- | --- |
| Governance and finances | Roles, owner controls, ledger, paper risk checks, audit history and incidents | Deployment validation, operational recovery exercises, eventual authorised custody integration |
| Bot lifecycle | School/college progression, reviewed evidence, managed admission and retirement, preserved knowledge | Role-specific fitness, demonstrated novelty, resource-linked growth and controlled department creation |
| Learning and knowledge | Source intake, reviews, transfer plans, synthetic assessments, incident lessons and assignments, graph provenance | Factual claim equivalence, incident-specific mastery, causal improvement and real-model qualification |
| Research and trading | Paper trading, replay, desk roles, forecasting/fitness and newer daily research modules | Independent validation of new modules, point-in-time datasets, longer forward evaluation and production execution |
| Organisation automation | Bounded workers, budgets, finite cycles, reconciliation, freshness receipts | Durable scheduling, shared-state concurrency, recovery, automatic task/recipient selection and delivery of owner alerts |

Most remaining effort is making these parts operate together reliably and proving their results. Passing a synthetic assessment is not proof of profitable trading; a reviewed lesson is not a trained model; local process separation is not security isolation.

This development step adds a finite, read-only headline reconciliation worker. Tests cover bounded cycles, observing external revocation, no inference, no backend mutations, failure invalidation and lock cleanup. It has not been launched for persistent operation.

Next organisational priorities: common worker/state coordination, conservative fact-verification gates, then a bounded end-to-end demonstration of collection → reviewed lesson → bot assignment → inference → independent assessment → retained feedback, with actual cost and failure records.
