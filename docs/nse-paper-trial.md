# NSE live-data paper diagnostic

Chosen first instrument: NSE:RELIANCE. Duration: 30 minutes. Initial simulated capital: ₹10,000.
This standalone diagnostic does not touch Nexus wallets, qualify bots, use an AI model, or submit broker orders.
It prepares the data/execution experiment before connecting a qualified organisation strategy.

## Setup

Use a Zerodha Kite Connect account with access to market quotes. Account creation, any subscription and interactive login are owner steps. The agent has not purchased or activated anything.
Follow the official [authentication documentation](https://kite.trade/docs/connect/v3/user/) to obtain an access token; never paste credentials into chat or commit them.
Create the ignored file `.env.market` in the Nexus root, locally:

```dotenv
KITE_API_KEY=your_api_key
KITE_ACCESS_TOKEN=your_access_token
```

The runner only calls the fixed HTTPS `/quote` endpoint. These broker credentials may have broader account permissions: this is not a claim that Kite issues a read-only token. Keep them out of agent prompts and other workers. No API secret is needed by the runner. Renew expired tokens through the provider's login flow.

In Command Prompt, from the Nexus directory:

```bat
npm run paper:nse -- --check
npm run paper:nse
```

`--check` fetches a quote without simulating a trade. The trial polls every five seconds with a 30-minute monotonic deadline. Start during regular NSE hours (09:15–15:30 IST, weekdays). This initial adapter excludes special sessions; its clock check is not an exchange holiday calendar. Holiday/closed-market data must still pass freshness and depth checks. No background schedule is installed.

## Interpretation

Kite [full quotes](https://kite.trade/docs/connect/v3/market-quotes/) provide exchange timestamps and bid/ask depth. The adapter rejects missing, stale (>10 seconds), future (>2 seconds), repeated/backward timestamps and invalid depth. It never manufactures spreads from last traded prices. Three consecutive rejected/failed observations or an authentication error stop the trial.

The deterministic baseline waits for 12 observations, buys one share after a 0.1% midpoint increase with spread at most 0.2%, and caps each purchase including costs at 20% of initial capital. It exits on a 0.5% cost-based loss, 0.8% gain, five-minute holding period, or session end with a fresh quote. At most ten round trips; no leverage or shorting. It halts further entries after cumulative realised losses reach ₹100. Gaps can exceed that threshold; it is not a guaranteed maximum loss.

Fills use the ask for buys and bid for sells, five basis points adverse slippage and illustrative ten basis points costs per side. These are test assumptions, not actual Indian brokerage/tax calculations. A holiday, interruption or lost feed can leave a simulated position open: the report records it without inventing a closing price. Unrealised P&L uses the last accepted quote and includes its timestamp.

Reports and accepted/rejected observations are saved in `.local/nse-paper/<run>/`. They contain no credentials. A thirty-minute diagnostic cannot establish strategy profitability or AI learning. It may place zero simulated trades. Remaining integration work includes authenticated quote ingestion into the backend with an approved source, qualified bot/evidence routing, a maintained market calendar, realistic cost schedules and longer out-of-sample evaluation.
