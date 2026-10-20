# World news (NEWS-02)

The organisation reads more than the Indian press. Central banks, regulators and publishers in the US, Europe, the UK and China,
plus a world wire, are in a catalogue. The owner enables them one by one. The cycle then:
- collects every enabled feed;
- groups the day's items into **stories across countries**;
- links each story to the eight shares, either directly by name or through a reviewed **world driver**.

Everything here is unverified press. It feeds attention, triage and the digest. A bot can use an item as evidence only after
the normal independent review.

Ideas taken from two Apache-2.0 projects, without their code:
- From [a-stock-data](https://github.com/simonlin1212/a-stock-data):
  - rank sources with official bodies first;
  - keep a fallback route for a blocked source.
- From [FinnewsHunter](https://github.com/DemonDamon/FinnewsHunter):
  - deduplicate by link;
  - group one story across outlets;
  - filter by stock keyword.

Their crawlers, debate agents and vector stores were not taken. We already have a debate desk, and we only read feeds that
publishers offer for it.

## The catalogue

`integrations/publisher-feeds/world-sources.json` lists each source with:
- country;
- tier: 1 for an official body, 2 for a publisher;
- topics;
- feed;
- the source id it will have;
- a backup, if there is one;
- the day it was last checked.

| Country | Sources |
| --- | --- |
| India | Economic Times, Mint and BusinessLine (enabled since 13 Oct); RBI and SEBI (tier 1) |
| US | Federal Reserve, SEC (tier 1) |
| Euro area / UK | ECB, Bank of England (tier 1) |
| China | South China Morning Post: business and China, each the other's backup |
| World | Al Jazeera |

Some feeds that were checked are not listed, and `notListed` says why. Some fail the organisation's strict reader:
- the Bank of Japan has no summaries;
- the EIA has dates without a year;
- Nikkei Asia uses RSS 1.0 without dates.

Others could not be read at all: BBC, CNBC, MarketWatch and others. The reader's rules are never weakened to admit a source.

## Owner commands

```
npm run world -- list                        every source and its state: off, not-run, working, stale, failing
npm run world -- probe us-fed eu-ecb         read the feeds now with the cycle's own reader; nothing is stored
npm run world -- enable us-fed eu-ecb --yes  probe, then register and approve the source, then write .local/feed-<id>.json
npm run world -- coverage                    which countries have a working feed; a broken feed names its backup
npm run world -- stories --hours 48          group the items collected in the window into stories
```

`enable` needs the backend running and the owner credential. It registers a source only if the probe accepted at least
one item. The next `npm run cycle` collects it like the Indian feeds.

## Stories

Items from the feed runs in the window are deduplicated by link. Items whose titles share most of their words (Jaccard 0.5 or
more) become one story. A syndicated copy counts once per publisher. Each story records:
- its countries, and whether it is **cross-border**;
- the publishers that carried it;
- **direct shares**: shares it names, using the same rules as triage;
- **drivers**: the impact links whose keywords it mentions, and the shares they reach.

Stories that reach a share come first; within those, stories with more countries and more publishers rank higher. The cycle
step `world-stories` writes `.local/world/latest.json`. The digest shows the stories that reach a share under
**World news**.

## World drivers

`integrations/trading-desk/impact_links.json` now has world drivers alongside the Indian ones. Each carries a `region`.

| Driver | Region | Reaches |
| --- | --- | --- |
| us-fed-rates | US | the four banks, Infosys |
| global-central-banks | World | all eight |
| us-tech-demand | US | Infosys |
| energy-geopolitics | World | Reliance |
| china-economy | China | Reliance, NTPC |
| global-coal | World | NTPC |
| global-trade | World | Reliance, Infosys, ITC |
| global-risk | World | all eight |

As before, every link is **inferred**. It says "may affect", never the direction. `chains.py study` tests whether a link
carries information, and `chains.py expand` labels inferred headlines `[inferred link: <driver>]`.

### The organisation tests its own links

Every collected headline is kept in `.local/world/headline-history.json`. This covers every source and country, and every
day since collection began. The step `world-stories` writes it, in the desk's headline format.

The next cycle step, `link-study`, runs `chains.py study` on that history. For each driver, it asks whether the linked
shares move further than usual against the basket in the 5 sessions after the driver's news. Each driver gets one of
three verdicts:
- carries information;
- no detectable effect;
- not enough events yet.

The digest and `npm run status` show how many links carry information. Each headline needs 5 later sessions before it can be
judged, so the first verdicts appear about a week after collection starts. The study only measures. Changing or removing a
link is still an edit to the reviewed links file.

## Triage scope-v2

Relevance triage (`backend/src/evidence-triage.ts`) adds world terms, recorded as `world:<term>`:
- Federal Reserve, FOMC, Treasury yields;
- ECB, Bank of England, Bank of Japan, PBOC;
- OPEC, Brent, oil prices, Strait of Hormuz, Red Sea;
- Wall Street, Nasdaq, S&P 500;
- recession, trade war, tariffs, yuan, coal prices.

So news from abroad that can reach the shares is no longer set aside as out of scope. Items already triaged keep their
`scope-v1` decision.

## Backups and failures

A failing feed already fails its cycle step loudly, and three failed cycles in a row escalate. In addition:
- `coverage` reads each feed's own checkpoint;
- the digest lists, under **Needs you**, each feed that is failing or stale (not read for 3 days), and its backup when the
  backup is off (for example `enable its backup: npm run world -- enable cn-scmp-china --yes`).

Enabling a backup is the owner's decision. It is never done automatically, because a new source needs approval.
