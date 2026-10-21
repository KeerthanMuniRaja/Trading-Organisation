# Startup guide

A short guide to setting up, running and checking the organisation backend. The details are in the linked docs; every
endpoint's full rules are in [docs/api.md](docs/api.md).

## What it is

A paper-trading organisation for 8 NSE shares. Bots propose trades; a deterministic review sizes or rejects them; paper
orders fill at verified prices; every result is scored and audited. It is paper only: no real money and no broker.

| Part | Where | Why |
| --- | --- | --- |
| Backend API (NestJS + embedded Postgres) | `backend/`, data in `.data/paper` | The official record: ledger, proposals, reviews, orders, audit chain |
| Research desk (Python) | `integrations/trading-desk/` | Prices, regime, R&D scout, scoring, knowledge index |
| Daily cycle | `scripts/organisation-cycle.mjs` | Runs every daily step in order, resumable |
| Local model (optional) | `.local/models/` (Qwen 3.5-4B) | Claims, debate, scenario panel, R&D ideas |

## 1. First-time setup (new machine)

1. Clone the code repository (`Trading-Organisation`) and the private data repository (`trading-organisation-data`).
2. Copy the data repository's `local/` folder to `.local/`, and each `state/<name>/` folder to
   `integrations/<name>/.state/`.
3. Put back your safe copies of `.env`, `.local/credentials.json` and `.local/owner-signing-key.pem`.
4. Install the software:
   - Node.js: `npm ci --ignore-scripts`, then `npm run build`.
   - Python 3.12: `python -m venv .local/replay-venv`, then
     `.local\replay-venv\Scripts\python.exe -m pip install -r integrations/trading-desk/requirements-replay.lock`.
   - The model, only if you use it: see [docs/local-model.md](docs/local-model.md).
5. Restore the newest backup into an empty folder:
   `node scripts/backup.mjs restore .local/backups/<newest> .data/paper`
6. Rebuild the knowledge index: `npm run knowledge -- build`
7. Check everything: `npm run preflight`. It reads only, and says READY or NOT READY, with the command for each gap.

## 2. Every day

| When | Command | Why |
| --- | --- | --- |
| Start | `npm start` | Runs the API on `http://127.0.0.1:3000` (paper mode only) |
| After 16:00 IST | `npm run cycle` (add `-- --with-model` to use the model) | Prices, news, regime, research, reviews, execution at the next open, scoring, digest |
| Or automatically | `npm run supervisor` | Readiness at 09:00, the cycle at 16:05, a Friday backup, and catch-up after sleep |
| Read | `.local/digests/<day>.md` | "Needs you" comes first, then "Can you trust this digest?" |
| Decide | `npm run agenda` | Management recommendations, births and departments waiting for you |
| Weekly | `npm run backup -- create` (API stopped), then `npm run export-data -- --write`, then commit and push `.local/data-repo` | Keeps the private data repository current |

## 3. Useful commands

| Command | Why |
| --- | --- |
| `npm run status` | One-screen health: backend, supervisor, regime, research and knowledge. Works while the backend is down |
| `npm run readiness` | The morning check: is everything ready to trade today? |
| `npm run autonomy` / `-- set <file> --reason "..."` | Standing approvals: what the agents may do by themselves |
| `npm run protections` / `-- set <file> --reason "..."` | Loss brakes: pause new buys after losses, and lift by themselves |
| `npm run world -- probe \| enable <ids> --yes` | World news sources |
| `npm run members -- apply <member> --yes` | Model members: TradingAgents and the debaters |
| `npm run verify -- --quick` | The full check gate: tests, build and secret scan |
| `npm run scan:secrets` | Run before every push |

## 4. Who calls the API (roles)

Each request carries `Authorization: Bearer <token>` from `PRINCIPALS_JSON` in `.env`. Every write also needs an
`Idempotency-Key`, so a retry never acts twice.

| Role | Does |
| --- | --- |
| owner | Decides: money, limits, policies, bots, releases. Money moves also need the owner signature |
| evaluator | Checks: reviews proposals, verifies evidence, scores calls, runs cycles |
| researcher | Collects and proposes: evidence, lessons, research work |
| trader | One per bot: proposes, executes its reviewed trades, places paper orders |
| market | Publishes approved price quotes |
| treasury / coordinator | Profit allocation, and worker coordination |

## 5. Endpoints (all under `/v1`)

| Area | Main endpoints | What for |
| --- | --- | --- |
| Health | `GET /health` (public) | Is the API up? Always says paper mode |
| Owner | `POST /owner/digest`, `GET /organisation/agenda`, `GET /organisation/report`, `POST /owner/transactions`, `POST /owner/challenges` | The daily summary, decisions waiting, the report, and signed money moves |
| Operations | `GET /operations`, `POST /operations/control`, `POST /incidents`, `POST /incidents/resolutions` | Halt or resume new risk; a critical incident halts automatically |
| Audit | `GET /audit`, `GET /audit/integrity` | The hash-chained history, and its integrity check |
| Treasury | `GET /treasury`, `GET /treasury/ledger`, `POST /treasury/allocations`, `POST /treasury/confirmations` | Balances, the double-entry ledger, profit allocation |
| Trading | `POST /trading/signals`, `/challenges`, `/reviews`, `/executions`, `/outcomes`, `/lapses`, `/query` | Propose, challenge, review (rules `signal-risk-v3`), execute, score and look up calls |
| Paper | `POST /market/quotes`, `POST /paper/orders`, `/fills`, `/cancellations`, `/refusals/query`, `GET /paper/positions`, `/performance`, `/marks` | Quotes, orders and fills, refused orders, positions and P&L |
| Protections | `POST /protections/policy`, `POST /protections/status` | Self-expiring loss brakes, and who is paused |
| Autonomy | `GET /autonomy`, `POST /autonomy/policy`, `POST /autonomy/apply` | Standing approvals, and carrying them out each cycle |
| Management | `POST /management/reviews`, `GET /management/recommendations`, `POST /management/decisions` | The daily review of every bot; you decide |
| Bots | `GET/POST /bots`, `/bots/suspensions`, `/bots/budgets`, `/bots/births/*`, `/bots/fitness/*`, `/bots/scorecards`, `/bots/retirements` | Create, pause, fund, birth, fitness, scorecards, retirement |
| Releases | `POST /releases`, `/releases/evaluations`, `/releases/stages`, `/releases/qualifications`, `/releases/rollbacks`, `/releases/check`, `/releases/view` | Exact code versions a bot may trade with; canaries and rollbacks |
| Evidence | `POST /sources`, `/evidence`, `/evidence/reviews`, `/evidence/revocations`, `/evidence/triage`, `/evidence/claims/*`, `/sources/reliability` | News and data come in, are triaged and verified, and claims are fact-checked |
| Knowledge | `GET /knowledge`, `POST /knowledge/as-of`, `POST /lessons`, `/lessons/reviews` | What was known when, and verified lessons |
| Corporate actions | `GET/POST /corporate-actions`, `POST /corporate-actions/dividends` | Splits, bonuses and dividends applied to positions |
| Compute | `POST /compute/budgets`, `/compute/allowance`, `/compute/usage` | Model-token budgets per department |
| Organisation | `/departments/*`, `/hackathons/*`, `/lifecycle/*`, `/dispatch/*` | Departments, contests, bot lifecycle, research dispatch |
| Learning and academy | `/learning/*`, `/skills/*`, `/development/*`, `/experiments`, `/jobs/*`, `/portfolio/*`, `/workers/*` | Learning workflows, exams, experiments and worker sessions |
| Alerts | `POST /alerts/query`, `/alerts/cycles`, `/alerts/deliveries`, `/alerts/acknowledgments` | Alert rules, delivery and acknowledgement |

## 6. Safety rules built in

- **Paper only:** `APP_MODE` must be `paper`. There is no broker connection.
- **Limits come from `.env`:** max order, exposure and realised loss. The digest shows the limits the backend actually
  loaded.
- **New buys stop** on a halt, at the loss limit, while a bot is suspended, or while a loss brake holds. **Exits are
  always allowed.**
- **History cannot be edited.** The audit trail, ledger and decisions are append-only.
- **Never commit** `.env`, `.local/` or `.data/`. The secret scan blocks them.

More detail: [founderReview.md](founderReview.md) (your checklist and decisions), [KT.md](KT.md) (knowledge transfer)
and [docs/documentation-index.md](docs/documentation-index.md).
