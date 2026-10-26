# Roadmap to proven skill (20 October 2026)

> **Corrected 21 Oct 2026.** A review of backtesting.py and vectorbt's source found defects in our scout:
> - decisions bought at their own close;
> - drift was not costed;
> - the first purchase was taxed as a sale;
> - proof time used a t-test.
>
> All are fixed ([research notes](research-notes/README.md)), and the numbers below have been re-run:
> - **Basket:** 12.55% after tax.
> - **Momentum 6m top 3:** 9.8% monthly, 10.9% quarterly, **11.2% yearly**. The yearly version trails the basket and
>   does not match it.
> - **Best idea's proof time:** about 490 years.
>
> The conclusions stand.

The owner asked how the organisation could come to make money **by skill**: beat holding the eight shares equally,
after costs, by enough to be sure it is not luck. This page records the evidence, what was built, and the plan with the
data it needs. Each data item needs the owner's approval.

## What our own evidence says

Seen history, 8 desk shares, 106 months:

| Finding | Number |
| --- | --- |
| Ideas tried | 20 (bar 0.0025, after the two slower-rebalance ideas of 21 Oct); none passes on return or on risk |
| Picking the best past idea each year | −0.35% a month out of sample |
| Holding the basket | 13.6% a year, **12.5% after an approximate tax** |
| The live bot's rule (momentum 6m top 3) | 12.8% a year, **9.8% after tax**, 52% of the portfolio traded each month |
| Best idea after tax | reversal 1m bottom 3, 12.1%: still below the basket |
| Time to prove the best idea at the bar | about **640 years** |

**Why it is so hard here.** Eight similar shares and one decision a month give about 12 weakly independent data points a
year. A real edge of +0.3% a month in a record that swings about 3% a month needs roughly 600 months to prove. Monthly
rebalancing then pays short-term tax every year, which a buyer-and-holder defers and pays at the lower long-term rate.

## What was built (`research_checks.py`, every scout run)

- **Proof time** (`monthsToProve`, `yearsToProve`): how long a record like each idea's would take to prove at the bar,
  with 80% power.
- **Turnover and after-tax growth** (`turnoverPctPerMonth`, `afterTaxCagrPct`). Each year the sold share pays short-term
  tax (20%) on that year's gain, and the rest pays long-term tax (12.5%) at the end. The basket pays long-term tax once.
  This is an approximation: it ignores the ₹1.25 lakh exemption, cess and lot-level holding periods.
- **The `combo` family**: momentum, calm and consistency ranks combined (`combo-6m-60d-top3`). It does not help on these
  large caps.
- **Digest and agents**: the digest's Research section shows the best after-tax idea against the basket. The agents'
  briefing now carries the tax-and-turnover lesson.

## The plan, by expected value

1. **A broad, point-in-time universe: the NIFTY 200 or NIFTY 500 as members actually were each month.** Factor effects
   such as momentum and low volatility show up across hundreds of shares, as NSE's own factor indices do, not across
   eight. With 30 of 200 shares held, each month carries far more independent information, so proof times fall sharply.
   Small capital can use mid-caps that large funds cannot.
   - *Data needed:* each index's membership history. NSE publishes reconstitutions as press releases, usually twice a
     year, and its site terms restrict automated download, so the files would be downloaded by hand or bought.
   - *Data needed:* daily prices for every past member, including those that later left the index.
   - *Started 27 Oct 2026:* today's NIFTY 500 members with 10 years of prices, and the [factor lab](factor-lab.md)
     that tests cross-sectional patterns on them (still survivorship-biased until the membership history arrives).
2. **Slower, tax-aware rules: built on 21 Oct 2026.** Every R&D family now takes `rebalance`: 1, 3, 6 or 12 months. The
   decision is taken at the start of each quarter, half-year or year and then held. A yearly rule is assumed to sell lots
   only after 12 months, so they pay long-term tax. Two pre-registered ideas test the live bot's own rule traded less
   often:

   | Momentum 6m top 3, 8 shares | Turnover a month | Before tax | After tax |
   | --- | --- | --- | --- |
   | Monthly (the live bot) | 52% | 12.8% | 9.8% |
   | Quarterly | 27% | 13.6% | 10.7% |
   | Yearly | 10.5% | 14.0% | 12.3% |
   | Holding the basket | — | 13.6% | 12.5% |

   Trading once a year recovers most of the tax and cost loss, but it still only matches the basket after tax, so it is
   not an edge. Moving the live bot to yearly rebalancing would be a new release, and that is the owner's decision.
3. **Fundamental and event data, where information is digested slowly**:
   - results against expectations (post-earnings drift);
   - earnings quality and revisions;
   - promoter and insider trades, bulk and block deals;
   - FII and DII flows.

   The model is useful here for reading filings and earnings-call text carefully, not for reacting faster than others.
   *Data needed:* an owner-approved provider, most likely a paid fundamentals and corporate-filings feed. NSE and BSE
   pages restrict scraping.
4. **More uncorrelated strategies, each small.** Several weak, different members, each judged on its own record, give
   more independent evidence than one bot. The organisation is already built for this: births, releases, budgets and
   live fitness.
5. **The basket as the default home for money.** Members earn a budget only by beating it after tax on their live,
   pre-registered record. If none ever does, the money still tracks the market, minus very little.

## Honest expectation

On 8 large caps with price data only, proven skill is out of reach in any useful time. With a point-in-time broad
universe, slower tax-aware rules and better data, the chance becomes real but remains uncertain. The organisation will
not claim an edge it has not proven.
