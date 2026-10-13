# Departments: registry, proposals and owner decisions

Implements the core of **ORG-01** from the [remaining-work assessment](remaining-work-assessment.md): a department registry with mandate, lead and budget, plus evidence-based proposals to open and close departments.

Code: [`backend/src/departments.ts`](../backend/src/departments.ts). Migration: [`035_departments.sql`](../db/migrations/035_departments.sql). Tests: [`backend/test/departments.test.ts`](../backend/test/departments.test.ts).

## Model

A **department** is a charter with:
- an id;
- a name;
- a mandate;
- an optional lead;
- an owner-set **budget ceiling** for the sum of its members' budgets;
- a status: active or closed.

**Members** are the bots whose existing `department` label equals the department's id, so no second membership system can drift from it. Labels used by bots but not yet registered are listed as `unregisteredLabels`.

## Who may do what

| Action | Route | Who | Rules |
| --- | --- | --- | --- |
| Propose opening or closing | `POST /v1/departments/proposals` | researcher or evaluator bots | Must cite 1–10 verified pieces of evidence from approved sources, such as an opportunity or a record of failure. Opening needs a name and mandate. Duplicate proposals return the original. |
| Decide | `POST /v1/departments/decisions` | **owner only** | Approving an opening requires the budget ceiling. Approving a closure is refused while any member holds a paper position or a reserved order, so closing never strands risk. Each proposal is decided once. |
| Appoint a lead | `POST /v1/departments/leads` | **owner only** | The lead must be a member and not retired. |
| View | `GET /v1/departments` | owner, researcher, evaluator | Shows each department's members, latest fitness verdicts, budget use (with `overBudget` when members' budgets exceed the ceiling), combined paper P&L, and pending proposals |

**History and audit:**
- Proposals, cited evidence and decisions are append-only.
- Every change to a department is audited.
- A closed department can be reopened through a new approved proposal with a fresh charter.

## What it does not do

- **It moves no money.** Budgets are ceilings, and bots never set or change them.
- **Over-budget departments are only reported.** They are flagged for the owner, never resolved automatically.
- **Membership changes stay with bot creation and lifecycle.**

Still open in ORG-01:
- shared workload;
- interfaces between departments;
- merge proposals;
- bounded justified replicas.
