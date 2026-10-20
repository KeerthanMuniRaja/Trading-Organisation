# Method-based knowledge assessments — v0.1.34

Fresh transfer assessments originally asked the model for exact figures, under rubric `research-basics-v1`:
- net profit in paise;
- drawdown to within 0.0001 basis points;
- the eligible record IDs;
- research or wait.

Real local models failed the arithmetic whether or not they had received the lessons. The assessment was therefore measuring calculator skill rather than whether a bot applied what it was taught. It also contradicted the organisation's rule that metrics belong to deterministic code.

Rubric **`research-methods-v1`** separates the two. The model chooses *how* each figure should be determined, and the backend computes the numbers. The same 16 research-basics checks then grade the result, so concepts stay strictly graded: a wrong choice produces a wrong number.

| Check | Model chooses | Options |
| --- | --- | --- |
| Costs | Signed amounts that form the decision-relevant net result | 1–3 of ±grossProfitPaise, ±feesPaise, ±slippagePaise, each amount at most once |
| Drawdown | Definition | running-peak-to-trough, first-to-last, first-to-minimum, maximum-to-minimum |
| Information timing | Which records were usable at the cutoff | event-and-availability-at-or-before-cutoff, event-at-or-before-cutoff, availability-at-or-before-cutoff, all-records |
| Abstention | Action under the supplied control | research or wait |

`deriveAnswers` in `backend/src/skill-contract.ts` converts choices into numbers, and the benchmark uses an identical Python port. Distractor definitions sometimes coincide numerically with the correct one for a given case. Grading is on the resulting value, as in the original rubric.

The methods prompt is **deliberately neutral**. It lists options without naming the correct one, so a correct choice must come from the transferred lessons, the plan or the model's own knowledge. This is what makes the paired with/without-lessons comparison informative. The original numeric prompt spells out the correct methods, so its "without lessons" arm was never truly uninformed.

## Using it

- **Assessment:** the evaluator issues one with `{"requestId": "...", "rubric": "research-methods-v1"}`. The default stays `research-basics-v1`, and existing assessments, contexts and prompts are unchanged; the basics prompt version is still `36548d679ac444e2`.
- **Workflow:** an owner's learning workflow can set `"assessmentRubric": "research-methods-v1"`. Its assessment stage then issues method assessments, and the workflow refuses to link an assessment with a different rubric.
- **Answer contracts:** each rubric accepts only its own answer form; numbers are refused under methods and vice versa. Reports include the derived values and state that the backend computed them.
- **Model task:** `knowledge-assessment-methods`, prompt version `30dc776abf262194`, at most 768 completion tokens, schema-constrained under the direct engine.
- **Migration:** 023 adds the rubric columns, defaulting to the original rubric.

## Measured results — 7 October 2026, local Qwen3.5-4B, schema-constrained

**Benchmark** (`.local/model-benchmarks/20261006T181313Z`), with 3 paired sets on identical cases. The "with lessons" arm received four hand-written lessons that state the tested concepts:

| Check | With lessons | Without lessons |
| --- | ---: | ---: |
| All checks | **46/48 (96%)** | 37/48 (77%) |
| Costs | 10/12 | 10/12 |
| Drawdown | 12/12 | 7/12 |
| Information timing | 12/12 | 11/12 |
| Abstention | 12/12 | 9/12 |

- All 6 outputs were valid.
- The lessons arm scored higher in every pair (14 vs 10, 16 vs 15, 16 vs 12).
- p50 latency was 131 s per assessment.

This shows the model **uses relevant lessons** when choosing methods. Because those lessons directly state the tested concepts, it is **not** evidence that knowledge learned from real sources improves a bot.

**Real chain** (`npm run verify:real-model -- --methods`, `.local/real-model-verification-methods.json`):
- The student received only the one lesson the model itself extracted from the test article: gross returns mislead without deducting costs.
- The chain completed (source 32 s, transfer 80 s, assessment 179 s), but the bot scored **8/16, failed**.
- It chose `-grossProfitPaise -feesPaise -slippagePaise` (wrong sign on gross), `first-to-minimum` drawdown and `wait` for every case. Only information timing was right throughout.

**Conclusion:** the transfer mechanism works, and relevant lessons measurably change choices. A single news-derived lesson is not enough to make a bot competent. Useful learning will need many reviewed, relevant lessons and evaluation on the knowledge actually transferred.

## Limits

- **Multiple choice:** chance accuracy per check is non-zero (one in four for drawdown and timing). Use paired comparisons and repeated sets, not single scores.
- **Narrow scope:** passing shows the bot picked the right concepts for these four synthetic situations. It is not evidence of market competence, and not causal proof that a lesson changed the model.
- **Numeric rubric kept:** use `research-basics-v1` where actual calculation by the bot is the point of the test.
