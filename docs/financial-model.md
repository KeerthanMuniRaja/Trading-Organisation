# Financial model

> [Current implementation, validation and limits](current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

All values in the API are integer **paise encoded as strings**. TypeScript uses `bigint` for money. The database stores signed, balanced double-entry postings. This version models internal accounts; it does not connect to SBI, a broker, an exchange or a blockchain wallet.

## Contributions and protected profit

An owner contribution of ₹10,000 produces Wallet 1 = ₹10,000 and Wallet 2 = ₹0. It is posted against `PRINCIPAL`, never `PNL`. Subsequent deposits follow the same rule.

Let `P` be cumulative realised net profit after realised trading results, trading fees and recorded operating expenses. Let `A` be the full profit base already allocated, including pending allocations. Newly eligible profit is:

```text
Q = max(0, P - A)
```

An allocation reserves 40% for Wallet 2 and leaves 60% in Wallet 1. Pending protection is subtracted from available capital immediately, before its internal paper transfer is confirmed. Confirmation transfers the same protected amount once. Retrying either step cannot create another entitlement to the same profit.

The current rounding policy allocates only complete blocks of five paise, making the 60/40 division exact. A one-to-four-paise remainder stays eligible for the next allocation. This is an explicit prototype policy, not an assumed bank settlement rule. Allocation also requires flat positions and no outstanding reserved orders; a future live settlement policy will need asset-specific availability and reconciliation.

| Event | Cumulative P | Allocated A | New eligible Q | Additional Wallet 2 share |
| --- | ---: | ---: | ---: | ---: |
| Owner contributes ₹10,000 | ₹0 | ₹0 | ₹0 | ₹0 |
| Realise ₹1,000 net; allocate | ₹1,000 | ₹1,000 after allocation | ₹1,000 before allocation | ₹400 |
| Subsequently lose ₹300 | ₹700 | ₹1,000 | ₹0 | ₹0 |
| Recover ₹200 | ₹900 | ₹1,000 | ₹0 | ₹0 |
| Gain a further ₹300; allocate | ₹1,200 | ₹1,200 after allocation | ₹200 before allocation | ₹80 |

Neither owner transfers nor additional deposits reset P or A. Moving protected money back to Wallet 1 does not convert it into new profit. Withdrawals are tracked separately. Unrealised appreciation never creates distributable profit. Trading fees are expensed on fills; position cost basis is released as shares are sold. Operational expenses require owner authorisation in this release.

## Permissions

- A trader identity is bound to one bot and can spend only free Wallet 1 capital within current limits. Shared reservations prevent two bots from spending the same funds.
- The dedicated treasury role can allocate eligible profit and confirm the prescribed W1-to-W2 transfer. It cannot spend Wallet 2, change 60/40, make arbitrary transfers or withdraw to SBI.
- The owner can contribute, transfer W1↔W2, or record withdrawals from either wallet to SBI. Each command requires a short-lived signature bound to the exact action, amount and destination.
- There is no bot API for changing roles, ratio, limits or credentials. Backend configuration and code remain owner-administered.

The treasury service necessarily has a narrow ability to **credit** Wallet 2; trading/research agents have no Wallet 2 access. This implements protected automatic distribution without giving a trading bot authority over the protected balance.

## Accounting safeguards and limits

Source references prevent duplicate deposits/fills/allocations under different request keys. A reused idempotency key with different input is rejected. Database constraints reject an unbalanced journal and triggers forbid updates or deletions of journal entries. Owner transfers cannot consume reserved funds. Holdings and reserved orders enforce organisation and per-bot limits again at fill time.

There is no automatic bank top-up, borrowing, margin, short selling, or spend to a target balance. Wallet 1 is an upper bound on operational capital, not an instruction to consume everything. Profit retention does not automatically increase bot budgets.

This ledger assumes one base currency and synthetic settlement. Tax accruals, broker-specific settlement, corporate actions, FX, funding costs, externally verified deposit/fill receipts, custody reconciliation and reversals require further design before live use. P/A history must be backed up with journals and pending obligations together; restoring only wallet totals would be unsafe.

<!-- documentation-navigation -->
[Documentation index](documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
