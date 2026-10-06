# Financial Scenarios and Acceptance Criteria

> Documentation refreshed for v0.1.21 (5 October 2026). [Current implementation, validation and limits](../current-status.md). Dated milestones and design proposals retain their original scope.

[Home](README.md) · [Wallet policy](12-wallet-and-treasury.md) · [Reconciliation template](templates/financial-reconciliation.md)

Status: design examples and proposed acceptance criteria. These are not results from a running financial application. Account providers, settlement behaviour, and implementation tests remain unvalidated.

## Worked loss-and-recovery example

Assumptions: INR reporting, all positions closed, required settlement complete, all configured costs already reflected in each result, no owner transfers after the deposit, and each eligible allocation completed immediately.

| Event | Cumulative net profit P | Profit base A after allocation | New eligible profit Q | Wallet 1 after completed transfer | Wallet 2 |
|---|---:|---:|---:|---:|---:|
| Owner deposits INR 10,000 | 0 | 0 | 0 | 10,000 | 0 |
| Earn INR 1,000 net | 1,000 | 1,000 | 1,000 | 10,600 | 400 |
| Lose INR 700 net | 300 | 1,000 | 0 | 9,900 | 400 |
| Recover INR 700 net | 1,000 | 1,000 | 0 | 10,600 | 400 |
| Earn another INR 500 net | 1,500 | 1,500 | 500 | 10,900 | 600 |

Loss recovery does not qualify as new profit until P exceeds A. The system never retrieves money from Wallet 2 automatically.

## Owner transfers preserve history

Starting from the final row above, the owner moves INR 200 from Wallet 2 to Wallet 1. Confirmed balances become INR 11,100 and INR 400. P and A both remain INR 1,500.

If the owner then contributes INR 2,000 from SBI, Wallet 1 becomes INR 13,100. P and A remain unchanged. A contribution cannot manufacture a new profit distribution.

For this closed-position example only:

```text
Wallet 1 + Wallet 2 = net external contributions + cumulative net profit
```

This is a reconciliation check, not the method for calculating profit. When positions, liabilities, or transfers in transit exist, the full balance sheet must include them.

## Proposed acceptance scenarios

| ID | Situation | Expected behaviour |
|---|---|---|
| F-01 | Initial deposit confirmed. | Entire amount credited to Wallet 1; Wallet 2 remains zero; P and A unchanged. |
| F-02 | Same deposit notification delivered twice. | One credit, with both deliveries linked to the original source event. |
| F-03 | Position rises without sale or other qualifying realisation. | No increase in realised distribution eligibility. Unrealised result stays separate. |
| F-04 | Net loss precedes the first gain. | Distribution remains zero until cumulative P becomes positive. |
| F-05 | Loss follows an earlier allocation, then is recovered. | No new allocation until cumulative P exceeds A. |
| F-06 | Verified P rises, but no allocation is committed before a loss. | Recalculate Q using the current P. Do not invent a historical allocation at the earlier peak. |
| F-07 | Two workers attempt to allocate the same profit. | One durable allocation and one corresponding Wallet 2 obligation. |
| F-08 | Process crashes after ledger commitment but before sending. | Resume the existing transfer; A and the reserved 40% are not duplicated or discarded. |
| F-09 | Provider executes transfer but acknowledgment is lost. | Mark outcome unknown, reconcile, and avoid a second payment. |
| F-10 | Transfer fails or remains pending. | Keep the obligation and restrict its reserved funds; notify under policy. No confirmed Wallet 2 credit without evidence. |
| F-11 | Multiple bots request the same available money. | Reservations are enforced globally; approvals cannot exceed shared capacity. |
| F-12 | Owner transfers money between wallets or withdraws it. | Require transaction approval and funds checks; preserve P, A, and origin records. |
| F-13 | New money is deposited after losses. | Contribution cannot erase losses or reset A. |
| F-14 | Bot requests Wallet 2 access, SBI withdrawal, a new ratio, or greater limits. | Deny outside the model's control and record the attempt. |
| F-15 | Owner-approved transfer details are changed or its approval is replayed. | Reject; new transaction details require a new valid approval. |
| F-16 | Realised profit exists but funds are unsettled or committed elsewhere. | Defer allocation/transfer as applicable; never borrow protected funds. |
| F-17 | Material open-position losses or unresolved reconciliation discrepancy. | Apply the predetermined distribution hold and loss-response policy. No rule invented by the affected bot. |
| F-18 | A fee is delivered twice, or late costs correct earlier P/L. | Deduplicate source events; append legitimate corrections once. Preserve earlier allocation history and investigate any over-allocation. |
| F-19 | Tiny amounts produce fractional paise in the split. | Apply a documented policy that conserves value and prevents repeated-rounding exploitation. This policy is not yet selected. |
| F-20 | Model update, recovery procedure, or bot reproduction occurs. | Financial authority, A, ledger evidence, fixed ratio, and spending limits survive unchanged. |
| F-21 | Wallet 2 shares a collateral pool or spend credential with Wallet 1. | Fail protection review; choose a compatible custody arrangement before enabling funds. |
| F-22 | Department requests expansion because retained profit exists. | Require incremental-value evidence and an approved budget; the retained share is not automatic spending authority. |

## Release evidence to collect later

For each case, capture the starting ledger, actor and permissions, policy version, input events, expected result, observed result, provider evidence, restart/retry behaviour, final reconciliation, and owner-notification state.

Include adverse and concurrent cases before any live connection. Record failures as well as successes. The [financial reconciliation template](templates/financial-reconciliation.md) can be used for paper exercises first.
