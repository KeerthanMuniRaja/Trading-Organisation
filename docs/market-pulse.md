# Market pulse (AWARE-01)

Who is moving and why, and what the big players are doing. The pulse reads every headline the approved news feeds
bring in, across all NIFTY 500 names, by fixed rules: no model and no network.

```
npm run pulse                    (the last 7 days; add -- --days 14 for two weeks)
npm run status                   (one line: "Pulse")
```

It writes `.local/world/market-pulse.json`. The daily cycle rebuilds it in its `market-pulse` step, after the news is
grouped into stories.

## What it finds

| Part | Example headline | What is kept |
| --- | --- | --- |
| **Movers** | "KEI Industries shares tumble 8% despite Q2 profit rising 29%, revenue up 39%" | The company, down 8%, and the press's reason (the clause after *as, after, amid, on, despite …*). A period is kept when stated: YTD, in 6 months, against the IPO price |
| **Big players** | "Promoter sells 2% stake in Bandhan Bank for ₹1,200 crore" | Who (promoter, FII/FPI, mutual fund or LIC, insider, a known investor, a bulk or block deal), buy, sell, mixed or pledge, the company, and the amount nearest to who acted |
| **Flows** | "₹4 lakh crore rally, ₹6,500 crore FII buying" | Market-wide FII, FPI or DII buying or selling: here FII buy ₹6,500 crore, not the rally's ₹4 lakh crore |
| **Our shares** | (prices) | Each desk share's last session against the basket, measured in its own daily swings over 60 sessions. A move of 2 swings or more with no news about the share in the two days before is flagged **unexplained** |

## What it refuses to count

- **Profit is not a share move.** "KEI Industries Q2 profit jumps 29%" is left out: the shares must be what moved.
- **A forecast is not a move.** "Vodafone Idea shares *can* soar 143% in a bull case" is left out.
- **Another company is not ours.** "Cyient DLM" is not Cyient Ltd, and "SBI Life" and "SBI Mutual Fund" are not State
  Bank of India. Names are case-sensitive, so "Indian bank stocks" is not Indian Bank.
- **An investigation is not a trade.** "Insider leak probe" is not insider trading activity.
- **A big-player item about a company outside the NIFTY 500** is kept but unlinked: it is still what the big players
  are doing.

## Who uses it

- **The debate:** for the share under debate, its reported moves, big-player items and last-session move, cut at the
  proposal's time, so a replay never sees later news (`marketPulse` in the context).
- **The owner:** `npm run status` and `npm run pulse`.

## Limits

- It is the press's account: unverified, context only, never evidence and never a trading signal by itself. The
  fact-checker verifies claims separately ([claims](../integrations/claims/README.md)).
- Only what the three approved feeds report. Exchange filings (bulk and block deals, insider trades, promoter pledges),
  FII and DII daily flows and shareholding changes come from NSE and BSE. They need an approved source (founder review
  B15); NSE and BSE restrict automated scraping, so they are not fetched.
- Headlines only, not article bodies; rules, not understanding. A misread headline is possible. The tests list the
  cases it gets right ([test_market_pulse.py](../integrations/trading-desk/test_market_pulse.py)).
