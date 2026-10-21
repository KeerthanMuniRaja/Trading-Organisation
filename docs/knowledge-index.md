# Knowledge index: stored, connected, searchable, point-in-time (KNOW-06)

The organisation collects a lot: news from every enabled feed, world stories, reviewed impact links and how they test, the
news catalogue, a market regime for every session, R&D results, method cards, the problem playbook and the scenario panel's
calls. Before 21 Oct 2026 these sat in separate files that nothing connected. The **knowledge index** rebuilds one local
SQLite database from them in every cycle (`.local/knowledge/index.sqlite`, step `knowledge-index`).

## What it connects

| Node | From |
| --- | --- |
| share | the 8 desk shares |
| source | the world news catalogue (country, tier) |
| driver | the reviewed impact links, with the link study's verdict |
| item | every collected news item (unverified press), one per link |
| story | every day's world stories |
| regime | the regime of every session since 2017 (the regime study's history, plus each day's file) |
| idea | the latest R&D screen of each universe |
| method, problem | method cards and the problem playbook |
| call | the scenario panel's calls |

| Edge | Meaning |
| --- | --- |
| item → names → share | The fact-checker's own alias rules (so "SBI Life" is not State Bank of India) |
| item → mentions → driver | The impact links' keywords |
| item → from → source | Which feed it came from |
| story → groups → item | The items grouped into the story |
| story → names → share | Shares the story names |
| story → via → driver | Drivers the story mentions |
| driver → may-affect → share | **Inferred**, with the link study's verdict |
| call → on → share | The share a panel call is about |
| call → rehearses → story | The story the panel rehearsed |

Full-text search (SQLite FTS5) covers every title and text.

## Retrieval is point-in-time

`dossier(share, as_of)` returns only what was known by `as_of`:
- items published by then that name the share;
- items that reach it through a driver, with the driver and its verdict, listed once even when several drivers lead
  there;
- stories, the regime in force and panel calls up to that date.

A replay of a past day never sees the future. The dossier is labelled **unverified**. Collected press and inferred links
are background, never evidence: only fact-checked, reviewed evidence can be cited.

**The debate desk uses it.** Each debater gets a compact `pressDossier` as of the proposal's own time, labelled unverified
and not citable. Its `dataStatus` says when the index is unavailable.

## Commands

```
npm run knowledge -- build                                 rebuild (the cycle does this daily)
npm run knowledge -- search "repo rate" [--kind item]      find anything, newest first
npm run knowledge -- about HDFCBANK [--as-of 2026-10-19T10:30:00Z]   what we knew about a share, and when
npm run knowledge -- stats
```

`npm run status` shows a Knowledge line with the counts. On 21 Oct 2026 the index held 2,692 records:
- 279 news items, 30 stories and 17 drivers;
- 2,272 session regimes;
- 40 R&D ideas, 23 method cards and 11 playbook entries.

These are linked by 526 connections.

## Rules

- **Read-only and deterministic.** A rebuild comes from the files, nothing is fetched, and the database is replaced in
  one step.
- **Never a source of authority.** Decisions still rest on verified evidence and the deterministic review.
