# Research and Decisions

> [Current implementation, validation and limits](../current-status.md) is the current status index (v0.1.32). Dated milestones and design proposals retain their original scope.

[Home](README.md) · [Knowledge graph](03-knowledge-graph.md) · [Decision template](templates/decision-record.md)

## Separate observation, explanation, and action

An observed event does not establish its cause. A plausible explanation does not automatically justify a trade. Every decision should preserve these distinctions and describe what remains unknown.

For example, a large blockchain transfer may represent custody movement, collateral management, a purchase, or another purpose. A reported institutional holding may describe an earlier point in time and omit other exposures.

US Form 13F reports illustrate this limitation: quarter-end holdings can be reported up to 45 days later, and short positions are not included. This is a US example, not an assumption about the first market we will trade. [SEC guidance](https://www.sec.gov/rules-regulations/staff-guidance/frequently-asked-questions-about-form-13f).

Standard Ethereum transactions are public and pseudonymous; observable activity does not by itself reveal ownership or motive. [Ethereum privacy documentation](https://ethereum.org/privacy/ethereum/).

## Proposed decision process

1. **Observe:** collect the event, its source, units, and relevant timestamps.
2. **Verify:** check freshness, original-source provenance, data integrity, and conflicting reports.
3. **Explain:** develop multiple hypotheses, including an ordinary explanation and an explanation that would invalidate the opportunity.
4. **Challenge:** independent reviewers assess evidence gaps and source/model dependence.
5. **Compare scenarios:** evaluate plausible favourable, adverse, and operational outcomes.
6. **Assess economics:** include applicable fees, spread, slippage, gas, funding, inventory, and operating costs.
7. **Constrain:** apply qualification, portfolio, capital, liquidity, and execution requirements.
8. **Act or wait:** record the action, expiration, invalidation signals, and conditions for reconsideration.
9. **Reconcile and review:** compare venue outcomes and later evidence with the decision record.

The system cannot consider every possible future. Scenario selection should be explicit and proportionate to risk, time horizon, and available information.

## Hypothetical case: price surge and large transfers

| Explanation | Evidence to investigate | What might weaken it |
|---|---|---|
| Improved business or network prospects | Original announcements, measurable adoption, sustained activity. | No primary evidence or activity inconsistent with the story. |
| Broad market movement | Sector/market returns and common exposures. | The asset moves independently without an identified reason. |
| Inventory or custody movement | Transaction semantics and reliably attributed service addresses. | Events do not match the proposed operational explanation. |
| Speculative enthusiasm | Narrative growth, turnover, concentration, and reversal behaviour. | Durable fundamentals explain the change better. |
| Coordinated promotion | Original promotional claims, source dependence, misleading statements, and trading context. | Independent substantiation or inadequate evidence of coordination. |

Enthusiasm alone does not prove manipulation. Misleading promotion can support pump-and-dump schemes, so evidence verification matters. [Investor.gov explanation](https://www.investor.gov/protect-your-investments/fraud/types-fraud/pump-and-dump-schemes).

## Past, present, and future

Historical comparisons must use information available at the historical decision time. Preserve publication delays and revisions, not only event dates. Avoid selecting only memorable winners or using repeatedly inspected test periods as unseen evidence.

Present observations need freshness checks and explicit handling of unavailable data.

Future assessments should contain scenarios, a defined horizon, uncertainty, and invalidation conditions. They should not be recorded as established facts.

## Strategy families

News-driven or fundamental strategies reason about future value and market response. Arbitrage evaluates executable price differences and execution conditions. Market making manages quotations, inventory, and fill risk. These families require different data, tests, timing, and failure policies.

A quoted price gap is insufficient for an arbitrage decision. The system needs executable size, costs, available inventory, settlement assumptions, and a plan for an incomplete pair of trades.

## Efficiency

Event-triggered investigation, shared data collection, caching, and escalation based on uncertainty can reduce duplicated work. Candidate improvements should be evaluated against both decision quality and their latency/compute cost.

Slow research and incident review should not sit inside every fast order path. Approved rules handle time-sensitive actions; significant changes return to evaluation.

## Continuous information research

The owner specifically prioritises day-to-day news, magazines, articles, trusted internet material, business and sales developments, company affairs, and surrounding economic events.

Proposed workflow:

1. Collect permitted material with source, publication, retrieval, and revision information.
2. Deduplicate repeated coverage and group reports about the same event.
3. Extract attributable claims; distinguish reporting, opinion, forecasts, and promotion.
4. Cross-check consequential claims against original filings, announcements, or independent evidence where available.
5. Map affected companies, sectors, supply chains, customers, and plausible transmission mechanisms.
6. Propose a pattern or hypothesis with a horizon, alternative explanations, and invalidation conditions.
7. Evaluate whether the pattern adds information beyond existing signals and costs.
8. Submit qualified proposals to the decision process; no pattern automatically becomes a buy/sell instruction.

Retain supporting and contradicting findings. Information access and reuse must respect source terms; the knowledge system can retain citations and derived records where retaining full text is inappropriate.

Reading more sources does not automatically improve decisions. Track source dependence, timeliness, incremental predictive value, and research cost. A surprising pattern is a candidate for testing, not proof of causation.

Daily research can reveal a capability gap for a [new bot or hackathon challenge](11-research-development-and-bot-lifecycle.md). New observations should reach the research queue without directly changing deployed model weights or live policies.

<!-- documentation-navigation -->
[Documentation index](../documentation-index.md) · Documentation reconciled for v0.1.32 on 6 October 2026; historical records retain their original scope.
