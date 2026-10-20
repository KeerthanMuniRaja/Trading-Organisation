# R&D scout: how the organisation finds new specialists

The research department keeps testing strategy ideas and proposes a new bot only where the evidence shows real skill. This is how the organisation is meant to grow: by evidence, not by adding bots.

## What it does every cycle

The cycle step `rnd-scout` (no model) scores a fixed, pre-registered catalogue of 13 monthly allocation rules for the eight shares (`rnd-catalog-v1`):

| Family | Ideas |
| --- | --- |
| Momentum | The 2, 3 or 4 strongest shares over 3, 6 or 12 months (9 ideas) |
| Risk | Inverse 60-day volatility, and the 3 calmest shares |
| Trend | Equal weights while the universe is above its 200-day average, else cash |
| Reversal | The 3 weakest shares over the last month |

Each month, a rule's return, net of 0.15% on every unit of weight traded, is compared with the equal-weight basket's. An idea **passes** only if all three hold:
1. **Enough evidence:** at least 20 months differ from the basket.
2. **Significant after correcting for the number of ideas:** it was ahead in significantly more months than it was behind, at p < 0.05 ÷ 13. Picking the best of many rules on the same history always finds lucky ones, so the bar rises with every idea tried.
3. **Stable:** it was ahead in both halves of the history.

Every idea's result, losers included, is saved in `.local/trading-desk/rnd/scout-<month>.json`, so the number of ideas tried stays visible.

## The result on 20 October 2026

Months 2022-12 to 2026-09 (46 months). **No idea passes.**

| Idea | Months ahead / behind | p | Passes |
| --- | --- | ---: | --- |
| Momentum 6 months, top 3 | 30 / 16 | 0.027 | No (needs < 0.0038) |
| Momentum 6 months, top 2 | 27 / 19 | 0.151 | No |
| Momentum 12 months, top 2 | 26 / 20 | 0.231 | No |
| All others | — | ≥ 0.23 | No |

The best idea is the one the live rule bot `momentum-rules` already runs. Its edge is suggestive but not proven once all the ideas tried are counted, which is why live paper fitness is its real test. The scout re-tests every cycle, so a robust idea will surface as data accumulates.

## R&D invents its own ideas (`rnd_ideas.py`)

The fixed catalogue is only the start: the research department proposes new ideas itself.
- **Specifications, not code.** An idea is a spec in a fixed grammar:
  - momentum: 1–12 months, top 1–5;
  - low volatility: a 20–120-day window, top 1–5;
  - reversal: 5–63 days, bottom 1–5.

  Each can add a trend filter (cash while the universe is below its 200-day average). A valid spec maps onto audited rule builders, so nothing unreviewed ever executes.
- **Who invents.**
  - **With the model:** the cycle runs the scout with `--invent model` (cycle `--with-model`). The local model answers in a schema confined to the grammar and states why it proposes each idea; the answer is validated again before anything is stored.
  - **Without the model:** `--invent explorer` proposes close variants of the three best ideas. It never runs on its own; you choose it.
- **Bounded and permanent.** At most 3 new ideas a calendar month, and duplicates of any earlier idea are refused. Every idea is appended to `.local/trading-desk/rnd/ideas.jsonl` with who proposed it and when, and is never removed.
- **The bar rises with every idea.** The scout tests the catalogue and every ledger idea together, at p < 0.05 ÷ the number of ideas ever tried. Inventing more ideas makes passing harder, never easier, so luck can't be mined. The ledger is part of the scout's fingerprint.
- **The same road to trading.** A passing invented idea becomes verified evidence and a birth proposal. With standing approvals, it can go on to a release, qualification, a starting budget and monthly trading through `rnd_bot.py`, which runs ledger ideas exactly like catalogue ones.

## When an idea passes

The step only screens until the owner names an approved research source. To let it propose, set `RND_SOURCE` (for example `desk-research`), optionally with `RND_DEPARTMENT` (default `desk`), in `.env`. The source must be registered and approved once by the owner (`POST /v1/sources`). Then a passing idea that no bot serves yet goes through the organisation like any proposal:

1. **Report:** the researcher reports its result as evidence (`dataset`).
2. **Check:** the evaluator, a different identity, recomputes the catalogue itself for the same months. It verifies the evidence only if the stored text matches its own result exactly, and rejects it otherwise.
3. **Propose:** the researcher proposes the new bot's birth (`rnd-<idea>`), citing that verified evidence.
4. **Decide:** the owner decides on the [owner agenda](management.md).

## After the birth: onboarding and trading (`rnd_bot.py`, cycle step `rnd-bots`)

1. **Onboard.** For a born `rnd-*` bot with no release of its exact identity, the researcher registers a release. It carries the model `rules:<idea>`, the rule's version and the fingerprint of the code that runs it. The evaluator then recomputes the scout and files the idea's screening record as a fitness report against the basket (seen data, net of costs), and evaluates the release on it.
2. **Owner, on the agenda.** You activate the release, qualify the bot, and set its budget (the agenda's `budget` item for a qualified bot with zero budget). You also give it a trader credential, once: `npm run bot-credential -- --bot <id> --yes`, then restart the backend.
3. **Trade.** Every cycle, each R&D bot in paper first checks `POST /v1/releases/check` with its exact identity. Once a month it turns its rule's target weights into evidence: reported by the researcher, verified on an exact match by the evaluator. It proposes exits first, and entries once the exits have settled, exactly like the rule bot. Its proposals then go through the same review, challenges, execution, scoring and live fitness as any bot.

`rule_bot.py` is not reused for this: changing it would change the live bot's code fingerprint and stop its release. `rnd_bot.py` only imports its helpers.

## Honesty

All of this history has been seen while designing the catalogue, so passing is a screen, not proof. The catalogue is fixed and fingerprinted. Adding ideas is a new catalogue version, and the extra ideas raise the bar for every idea in it.

## Verification

`integrations/trading-desk/test_rnd_bot.py` covers:
- onboarding once, with the researcher registering and the evaluator judging;
- identity following the code and the rule;
- trading only while the release is authorised and with its own credential;
- exits before entries, and one decision a month.

`integrations/trading-desk/test_rnd_scout.py` covers:
- every idea being reported, with only robust skill passing on synthetic data with two persistent winners;
- the sign test values;
- costs counting against turnover;
- a result reproducing exactly for the months it names;
- a passing idea becoming evidence, an independent content-bound verification and a birth proposal;
- served or already-proposed ideas being skipped;
- the evaluator rejecting an inflated result.
