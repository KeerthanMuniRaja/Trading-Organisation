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

## When an idea passes

The step only screens until the owner names an approved research source. To let it propose, set `RND_SOURCE` (for example `desk-research`), optionally with `RND_DEPARTMENT` (default `desk`), in `.env`. The source must be registered and approved once by the owner (`POST /v1/sources`). Then a passing idea that no bot serves yet goes through the organisation like any proposal:

1. **Report:** the researcher reports its result as evidence (`dataset`).
2. **Check:** the evaluator, a different identity, recomputes the catalogue itself for the same months. It verifies the evidence only if the stored text matches its own result exactly, and rejects it otherwise.
3. **Propose:** the researcher proposes the new bot's birth (`rnd-<idea>`), citing that verified evidence.
4. **Decide:** the owner decides on the [owner agenda](management.md).

**Not built yet.** Once an approved R&D bot is born, two pieces are still missing:
- the step that registers its release and fitness;
- a runner that turns its rule into monthly proposals, like `rule_bot.py` does for momentum.

They are deliberately left until the first idea passes. `rule_bot.py` is not reused for this, because changing it would change the live bot's code fingerprint and stop its release.

## Honesty

All of this history has been seen while designing the catalogue, so passing is a screen, not proof. The catalogue is fixed and fingerprinted. Adding ideas is a new catalogue version, and the extra ideas raise the bar for every idea in it.

## Verification

`integrations/trading-desk/test_rnd_scout.py` covers:
- every idea being reported, with only robust skill passing on synthetic data with two persistent winners;
- the sign test values;
- costs counting against turnover;
- a result reproducing exactly for the months it names;
- a passing idea becoming evidence, an independent content-bound verification and a birth proposal;
- served or already-proposed ideas being skipped;
- the evaluator rejecting an inflated result.
