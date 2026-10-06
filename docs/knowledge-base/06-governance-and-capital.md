# Governance and Capital

> [Current implementation, validation and limits](../current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

[Home](README.md) · [Incident template](templates/incident-review.md) · [Owner report](templates/owner-report.md)

## Status

This is a proposed constitution incorporating the owner's agreed financial requirements. The [wallet and treasury policy](12-wallet-and-treasury.md) now defines contributions, 60/40 profit allocation, access boundaries, and management controls. It supersedes the earlier blanket deferral of wallet design.

Custody, timing, detailed cost treatment, numerical limits, and implementation remain open. This file records the original governance design; a paper backend now implements a subset described in [the financial model](../financial-model.md). Writing or accepting this document does not enable account access, spending, or live trading.

## Owner authority

The owner controls administrative access, capital allocations, enabled markets, live-operation permission, and constitutional changes. Bots operate under scoped service permissions.

Routine actions may eventually occur automatically within approved boundaries. Exceptions and authority changes require owner authorisation. The system should enforce these limits through software and account configuration, not solely through prompts.

## Capital boundary

- Use only funds explicitly allocated to the organisation.
- No automatic bank top-ups, credit, or borrowing.
- Keep an organisation-wide ledger of balances, positions, liabilities, reservations, fees, and transfers.
- Reserve capacity before placing orders; update reservations using confirmed venue state.
- Include pending orders and execution costs when assessing remaining capacity.
- Avoid allocating the same balance independently to several bots.
- Treat idle cash as an acceptable position; do not require full investment.
- Retain 60% of newly eligible realised net profit in Wallet 1 and allocate 40% to protected Wallet 2.
- Keep the original contribution, later contributions, earnings, losses, and owner transfers distinct in the ledger.
- Do not spend pending distribution funds or automatically retrieve money from Wallet 2.
- Require transaction-specific owner authorisation for wallet transfers and withdrawals to the original SBI account.
- Use retained profit only within approved operating and departmental budgets; it is not a spending target.

The capital allocation, maximum exposure, maximum acceptable loss, and total operating-expense budget are different controls. They need separate definitions. A stop rule does not guarantee a precise maximum loss in a discontinuous or unavailable market.

A later decision is required on leverage, shorting, derivatives, flash loans, custody, exchanges, and broker permissions. None is assumed approved.

## Decision and execution controls

Qualified strategy proposals must pass current policy, instrument, liquidity, capital, and permission checks. Portfolio weights are proposals; actual orders must also satisfy available balances, lot sizes, minimum order sizes, fees, and venue constraints.

Missing acknowledgement is an unknown order state, not proof of failure. Reconcile before retrying to avoid duplicate exposure. Unresolved state should restrict new risk under a predefined policy.

Emergency behaviour should distinguish stopping new orders, cancelling outstanding orders, and reducing existing positions. Automatic liquidation is not always the safest action; the applicable response must be defined and tested.

## Incident court

The court is an evidence-based review process, not a majority vote about guilt.

1. **Contain:** restrict affected activity using established emergency rules.
2. **Preserve:** retain original observations, configurations, permissions, decisions, orders, and venue responses.
3. **Reconstruct:** establish the timeline and what each component could know at the time.
4. **Investigate:** separate market uncertainty, data problems, modelling error, software failure, policy violation, and unclear requirements.
5. **Challenge:** use reviewers independent of the affected bot and record conflicting findings.
6. **Correct:** propose a scoped remedy, lesson, test, and responsible role.
7. **Verify:** reproduce the failure where possible and test the remedy for side effects.
8. **Requalify:** restore permissions only under the applicable qualification process.
9. **Distribute:** share verified lessons with relevant departments and notify the owner.

Possible outcomes include no fault found, improved monitoring, corrected data, retraining, restricted permissions, rollback, or retirement of a version. Ordinary trading losses should not automatically become disciplinary cases.

## Evidence integrity and separation of powers

Candidates cannot rewrite their own historical records, relax their examination bar, or approve additional authority. Corrections append to the record and identify what they supersede.

External articles, source code, and messages are research inputs, not instructions to alter operating permissions. Credentials should be isolated from research memory.

## Owner visibility

Reports should state current equity and exposure, net performance and costs, actions and rejected opportunities, important disagreements, incidents, model changes, and decisions requiring owner input.

Every result should be labelled historical simulation, paper operation, or live activity. Report cadence and alert thresholds remain open; no scheduled reporting service has been created.

## Autonomy without authority expansion

Once operating policies are defined and authorised, routine spawning, training, research, and recovery may proceed within them. Bots cannot change the constitution, evaluator, effective permission boundary, or resource ceiling to improve their own prospects.

Department creation, expansion limits, retention rules, and promotion authority need explicit policies. Until such a policy authorises an action, it remains a proposal for the owner.

The ability to create candidate bots must not imply unlimited recursion or resource consumption. Record parentage, purpose, budget, maximum scope, and responsible supervisor.

## Retirement preserves accountability

Removing a bot from active service is different from erasing its evidence. Decommission the runtime, revoke its permissions, and reconcile unfinished work only after the transfer and verification process is satisfied. Preserve required audit history and supported lessons under the eventual retention policy.

Harmful, incorrect, or obsolete material should be labelled, corrected, restricted, or excluded from active retrieval. "No knowledge goes to waste" means preserving useful learning and evidence, not treating all stored content as true.

See [recovery and notifications](10-autonomous-recovery-and-notifications.md) and [bot retirement](11-research-development-and-bot-lifecycle.md).

## Financial control cannot evolve itself

The profit-distribution ratio, recipient, permission boundary, accounting history, and spending limits cannot be altered by trading, research, reward, or recovery logic. Corrections require linked ledger entries and authorised handling. Unknown external transaction outcomes require reconciliation before retry.

The incident court can recommend a financial-control correction but cannot give an affected bot permission to approve it. See [financial scenarios](13-financial-scenarios.md) for proposed validation cases.

<!-- documentation-navigation -->
[Documentation index](../documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
