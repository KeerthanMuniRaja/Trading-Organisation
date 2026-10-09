# Wallet and Treasury Policy

> [Current implementation, validation and limits](../current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

[Home](README.md) · [Governance](06-governance-and-capital.md) · [Financial scenarios](13-financial-scenarios.md) · [Reconciliation template](templates/financial-reconciliation.md)

## Status and authority

The owner supplied the two-wallet requirements and accepted the management refinements discussed afterward. These are agreed design requirements. The bookkeeping and state-transition mechanisms below are implementation proposals for review and testing.

This supersedes the earlier blanket deferral of wallet design. Custody, provider capabilities, detailed costs, taxes, numerical limits, and distribution timing remain open. Agreement to this document does not authorise account connections, live trading, bank transfers, spending, or deployments.

## Initial capital and subsequent contributions

The owner manually deposits funds from the original SBI bank account. Credit 100% of the confirmed deposited amount to Wallet 1. Wallet 2 begins at INR 0. Never split an initial deposit under the profit-sharing rule.

Later owner contributions also enter Wallet 1 and remain distinguishable from earnings. A pending or unconfirmed deposit is not spendable. Record initial capital, later contributions, and their source references separately; never infer profit from an increase in wallet balance.

Wallet 1 capital remains exposed to authorised trading losses. Recording the original contribution does not guarantee its value remains intact.

## Wallet roles and permissions

| Actor | Allowed | Excluded |
|---|---|---|
| Trading and research bots | Propose and perform authorised work using Wallet 1 capacity through controlled services. | Wallet 2 access; SBI withdrawals or top-ups; changing ratios, budgets, limits, or permissions. |
| Capital-control service | Check permissions, reserve Wallet 1 funds, enforce organisation-wide limits, and reconcile reservations. | Granting itself more authority or treating every bot as having the entire wallet available. |
| Profit-distribution service | Apply the fixed calculation and arrange the exact eligible 40% transfer from Wallet 1 to the configured Wallet 2 destination. | Spending or withdrawing from Wallet 2; SBI withdrawals; choosing a different recipient or ratio. |
| Owner | Transfer Wallet 1 to Wallet 2 or vice versa; withdraw available funds from either wallet to the original SBI account. | Bypassing actual settlement, balances, or already committed obligations. |

The profit-distribution service is deterministic financial infrastructure, separate from self-improving bots. Receiving funds in Wallet 2 does not require granting bots Wallet 2 spending credentials. The actual provider must support the required authority separation.

All owner transfers require strong authentication, transaction-specific approval, and ledger records. Show the amount, source, destination, and any fee before approval. Bind authorisation to those details, expire it, and prevent reuse. Administrative changes require a separate owner-controlled policy process; bots cannot initiate their own privilege expansion.

## Fixed profit allocation

Split newly eligible verified realised net profit as follows:

- 60% remains in Wallet 1 for authorised operations.
- 40% is allocated to Wallet 2 and protected from bots.
- Neither contribution principal nor unrealised gains enter this calculation.
- Previous realised losses and configured costs must be recovered before new profit becomes eligible.
- Amounts already allocated must never be allocated a second time.

The retained 60% is available capital, not a requirement to spend or create bots. Each department still needs a budget and measurable purpose. An expansion decision must demonstrate incremental value and affordable ongoing costs.

## Cumulative calculation

Proposed variables, measured consistently in the reporting currency:

```text
P = cumulative verified realised net profit:
    realised gains minus realised losses minus configured costs

A = cumulative profit base already committed to the 60/40 allocation,
    counting the full base, not only the Wallet 2 share

Q = max(0, P - A)
```

Both P and A start at zero. P may become negative. A is not reset by losses, new bots, restarts, calendar periods, owner contributions, withdrawals, or wallet transfers.

When an eligible allocation of Q is committed, record the retained 60% and the Wallet 2 obligation of 40%, then increase A by Q in the same durable ledger transaction. The profit is already in the financial result: retaining 60% must not create another cash credit.

A tracks committed allocations, not the highest intraday estimate of P. If no allocation was committed, later losses reduce the still-unallocated amount. An uncertain payment does not permit A to be reset or a fresh allocation to be created.

This adapts the high-water-mark idea of not charging or allocating the same profit again after loss recovery; it is our proposed distribution rule, not a performance fee. [CFA Institute reference](https://rpc.cfainstitute.org/sites/default/files/-/media/documents/book/rf-publication/2018/rf-v2018-n1-1.pdf)

## Net profit and costs

Define eligible income, realised gain recognition, cost basis, and valuation policy before implementation. Reconcile accounting records against authoritative trade confirmations and account statements. Realised results, cash movement, and settlement are distinct records. [Account-statement reference](https://www.investor.gov/better-understanding-your-brokerage-account-statement)

The cost policy must address trading charges, funding or network costs where relevant, and model, data, compute, infrastructure, and research expenses. Count each cost once: an operating expense paid from retained cash must not be deducted again if it is already included in P.

Which costs are included, their recognition timing, income such as dividends, tax provisions, and multi-currency treatment remain open. Bots cannot redefine costs to inflate performance. Unfinalised charges or uncertain accounting can block distribution.

## Settlement and availability

Distribute only after the required reconciliation and settlement checks, with sufficient free funds and all existing obligations covered.

Within Wallet 1, track available funds, order reservations, operating commitments, pending distribution amounts, and configured reserves. These are ledger categories, not a split of the initial deposit or extra wallets. They must not overlap or cause the same obligation to be deducted twice.

An allocation's pending 40% becomes unavailable to bots immediately. Until a real transfer is confirmed, report it as a reserved amount payable to Wallet 2, not confirmed Wallet 2 cash.

Unrealised gains cannot increase Q. Material unrealised losses, open obligations, or unresolved balances can delay distribution under the risk policy even when Q is positive. Define those conditions before implementation; this does not change the 60/40 ratio.

For an initial prototype, prefer deferring an allocation if the full required transfer cannot safely be funded. Partial allocation rules need separate specification.

## Durable allocation and transfer

Proposed sequence:

1. Reconcile the relevant fills, costs, balances, and settlement state.
2. Check P, A, risk conditions, current policy version, and available funds.
3. In one ledger transaction, create a unique allocation ID, record Q and both shares, reserve the 40%, and advance A.
4. Submit the transfer using the same stable identifier where the provider supports it.
5. Record provider references and distinguish pending, confirmed, failed, and unknown outcomes.
6. Reconcile the provider's actual state before any retry.
7. Confirm the Wallet 2 balance only when supported by authoritative evidence.

Concurrent workers must not commit the same profit base twice. A transfer retry resumes the same obligation. If the provider cannot safely deduplicate or reveal an uncertain outcome, hold and escalate rather than assume it failed.

After commitment, new losses do not erase a pending obligation. Funding or reconciliation problems become incidents; no automatic debit from Wallet 2 is allowed. Corrections use linked ledger entries and an authorised resolution, never silent history edits.

## Owner transfers and protection

Owner transfers between wallets do not change P or A. Withdrawals to SBI and fresh deposits also do not constitute profit or loss. Preserve the origin of funds, including when original capital is manually moved to Wallet 2.

Moving funds from Wallet 2 back to Wallet 1 makes that amount available for authorised use after settlement and checks. It does not restore a lost profit allowance or count as a new earning.

Wallet 2 needs enforceable custody and credential separation. Dashboard labels alone are insufficient. Bot permissions and collateral arrangements must not make Wallet 2 available to finance losses in Wallet 1. There are no automated bank top-ups or Wallet 2 rescue transfers.

The actual broker, bank, exchange, or on-chain arrangement remains undecided. Some venues may impose payout routes incompatible with direct Wallet 1-to-Wallet 2 transfers. Establish feasibility before choosing or promising an implementation.

Server-side permission checks and transaction-bound authorisation are required independently of model instructions. [OWASP transaction-authorisation guidance](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html)

## Accounting, limits, and owner visibility

Use a double-entry ledger with traceable source events and linked corrections. Preserve deposits, transfers, cost basis, fills, fees, allocation bases, obligations, confirmations, and owner approvals. Store money in exact units with a documented rounding rule; floating-point approximations must not create or lose funds. Rounding policy remains open.

Track gross and net performance separately from account balances. Set independent controls for trade exposure, total exposure, loss response, operating costs, departmental budgets, and growth. Numerical thresholds and emergency actions remain open.

Owner reporting should show capital contributed, cumulative realised net P/L, unrealised P/L, the allocated profit base A, newly eligible profit, available and reserved Wallet 1 funds, pending Wallet 2 transfers, confirmed Wallet 2 funds, costs, exposures, and unresolved incidents.

Self-improvement and recovery cannot modify this policy, the ledger history, ratio, destination, permissions, or spending limits. Approval of financial principles does not itself provide production credentials or operating budgets.

<!-- documentation-navigation -->
[Documentation index](../documentation-index.md) · Documentation reconciled for v0.1.32 on 7 October 2026; historical records retain their original scope.
