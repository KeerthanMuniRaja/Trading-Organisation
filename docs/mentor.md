# The mentor programme (MENTOR-01)

The owner asked Claude to act as the organisation's mentor: to give the agents an experienced finance person's knowledge,
so they reason better. The design keeps three rules:
1. **Lessons are read, never trained on.** The agents read the lessons at decision time. The organisation's model learns
   permanently only from its **own decisions and their real outcomes**. Training a model on Claude's outputs is
   restricted by Anthropic's terms, and reality is the better teacher anyway.
2. **Our data overrules the mentor.** Every lesson that can be checked is checked on our own prices, every day. A lesson
   the data contradicts is kept, marked `contradicted`, and never shown to an agent.
3. **Background, never evidence.** Lessons help reasoning. They can never be cited to justify a trade.

## How it works

| Piece | Where | What it does |
| --- | --- | --- |
| The curriculum | `integrations/trading-desk/knowledge/mentor-curriculum.json` | Each lesson: what it teaches, when it applies (shares, events, regimes, methods) and which check proves it |
| The checks | `mentor.py refresh`, cycle step `mentor-refresh` | Runs each check on today's data. Writes `.local/trading-desk/knowledge/mentor.json`, with each lesson `checked`, `contradicted` or `unverified`, plus its numbers |
| The selection | `mentor.notes_for(symbol, events, regime, method)` | At most 3 lessons that fit one decision, most specific first |
| The organisation's own lessons (MENTOR-02) | `organisation_lessons.py`, cycle step `organisation-lessons` | Turns the newest [factor lab](factor-lab.md) and R&D scout reports into lessons in the same format, written by the organisation, not the mentor, to `.local/trading-desk/knowledge/organisation-lessons.json`. `notes_for` reads them beside the mentor's. A lesson about a method (for example momentum) reaches only a member that uses it: the debate passes the member's method (`mentor.method_of`) |
| Who reads them | The debate desk (`mentorNotes`), the scenario panel (market-wide, at most 2) | As data that explains itself, never as new instructions |
| The exams | `integrations/model-eval/cases.json`, for example `exam-bank-concentration` | Checks that the model actually uses a lesson. Here, a bear must point out bank concentration |

## The first curriculum, checked on our data (27 Oct 2026)

| Lesson | Status | Our data says |
| --- | --- | --- |
| Four of our eight shares are banks | **checked** | The banks' daily moves correlate 0.47 with each other, against 0.26 with the other shares |
| ITC and NTPC usually fall less | **checked** | Betas: ITC 0.72, NTPC 0.90; the banks average 1.09 |
| Trading costs decide small edges | **checked** | 0.15% one way, so about 0.3% for a full round trip |
| After SEVERE distribution days, falls are deeper | **checked** | Average worst fall −3.58%, against −2.03% after NORMAL days |
| **Momentum fails when a fall turns into a rebound** | **contradicted** | On our 8 shares, momentum did *better* in the 6 months after a deep fall: +1.19% a month against the basket. It is not shown to the agents |
| RBI and Fed days; Infosys earns in dollars; Reliance is several businesses; ex-dividend is not a loss; past winners mislead | unverified | No check yet. Shown as experience, clearly labelled |

**Curriculum v2 (the same evening): ten more lessons, six checked on our data.**

| Lesson | Status | Our data says |
| --- | --- | --- |
| Small positions pay a fixed charge on every sale | **checked** | Selling a third of a Rs 5,000 budget pays Rs 15.93 depository charge: 0.96% of the sale, against 0.15% percentage costs |
| Big moves come in clusters | **checked** | The size of one day's basket move correlates 0.27 with the next day's |
| Below the 200-day average, falls run deeper | **checked** | Next 20 sessions' worst fall −3.3% below the average (398 days) against −2.43% above |
| Several shares are safer than one, if they differ | **checked** | The 8-share basket swings 0.61 times as much as the average single share |
| A loss needs a bigger gain to recover | **checked** | The basket's worst fall was −42.4%, which needed +73.7%; 515 sessions below a previous peak |
| Start from the base rate | **checked** | A month rose by more than the 0.3% round-trip cost 55.6% of the time |
| Patience is taxed less; results come in seasons; most news is already in the price; size a position by what you can lose | unverified | Experience and tax rules, shown labelled |

**The contradicted lesson is the point of the design.** General market wisdom (the "momentum crash") didn't hold on
our 8 large caps in the few months we have. The organisation trusts its own evidence over any mentor.

## Curriculum v3: trading tips tested on ~480 shares (28 Oct 2026, MENTOR-03)

Eight shares are too few to judge a tip about how shares behave. These four run on the research universe
(`mentor_broad.py`, the NIFTY 500 files, 10 years). Every return is against the market average that day, and a claim
must stand out from noise (a t-statistic of at least 2), not just be larger.

| Lesson | Status | Our data says |
| --- | --- | --- |
| A big one-day move says little about the next week | **checked** | After 22,937 jumps of 5%+ against the market, the next 5 sessions averaged +0.01%. After 9,961 drops of 5%+: −0.23%. A big drop is not a bargain by itself |
| Buying near a 52-week low showed no edge | **checked** | Near the low: −0.21% against the market over the next month (3,031 cases), others −0.02% (t 1.0: no clear difference). Survivorship flatters the lows |
| Much of the gain came around the turn of the month | **checked** | The last session of a month and the first three of the next: +0.253% a day against +0.055% (t 3.4). 19% of the days, 53% of the gain |
| A fixed 10% stop cuts the worst losses but costs return | **checked** | 45,524 three-month holdings: the worst 5% lost 13.3% with the stop against 22.9% held, but the average fell from +7.16% to +5.64%. 41% were stopped out, and 58% of those were higher three months later |

**Curriculum v4 (the same day): four more lessons get checks.** 17 of 25 are now checked, and none contradicted:

| Lesson | Status | Our data says |
| --- | --- | --- |
| Momentum fails when a fall turns into a rebound | **unverified** (was *contradicted* on 8 shares) | On ~480 shares, in the 6 months after a 10%+ three-month market fall, momentum's top fifth did −0.63% a month against +1.0% otherwise. That is the lesson's direction, but t is 1.7: not proven. 8 shares were too few to contradict it |
| Results season | **checked**, reworded | Results weeks are only slightly more stock-specific (2.2% against 2.15% daily spread, t 2.9). The lesson now says the real risk is each company's own results day |
| Patience is taxed less | **checked** | Our basket grew 15.25% a year: 12.2% after tax sold every year, 14.09% held and taxed once at the long-term rate |
| Past winners mislead | **checked** | Picking each year's best idea so far: 31 months ahead of the basket, 39 behind, −0.118% a month, out of sample |

**29 Oct 2026: results days get a check (`results_day_moves`).** The organisation now keeps its own results calendar from the press ([events calendar](events-calendar.md), NEWS-07):
- **What it measures:** for each reported results day, the share's move against the market over that day and the next session, since results often come after the close. That is compared with the share's own usual two-session move over the year before.
- **The rule:** the lesson holds when the median results-day move is at least 1.5 times the usual. It is judged only from 30 cases; until then it stays unverified and says how many it has.
- **First reading:** 15 cases, with a median move of 2.0 times the usual. That points the lesson's way, but it is not judged yet.

The first wording of the 52-week-low lesson ("shares kept lagging") was not supported once noise was tested, so it
now claims only what the data shows: no edge in buying there.

## Training on reality

The organisation's model learns from its own answers, marked by what really happened (MODEL-DATA-02):
1. The debate desk logs each argument it uses (`.local/trading-desk/debate-log.jsonl`) with a fingerprint of what the
   model saw (`userHash`).
2. Once the call is scored, `outcome_labels.py` (cycle step `outcome-labels`) marks the argument right or wrong: a bear
   who opposed a call that turned out wrong was right, a bull who supported it was not.
3. `build_dataset.py` writes those answers to `<task>/outcome-kto.jsonl` as desirable or undesirable examples, ready for
   a later fine-tune.

No Claude output is ever a training target. A fine-tune is worth trying only after a few hundred labelled arguments.

## Adding a lesson

1. Add it to the curriculum with `appliesTo` and, if possible, a `test`: a function in `mentor.py`'s `CHECKS` that
   returns a text and whether the data agrees.
2. Add an exam case if an agent should visibly use it.
3. Run `mentor.py refresh` and the evaluation suite.
