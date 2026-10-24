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
| Results days carry gap risk; RBI and Fed days; Infosys earns in dollars; Reliance is several businesses; ex-dividend is not a loss; past winners mislead | unverified | No check yet. Shown as experience, clearly labelled |

**The contradicted lesson is the point of the design.** General market wisdom (the "momentum crash") didn't hold on
our 8 large caps in the few months we have. The organisation trusts its own evidence over any mentor.

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
