# Model evaluation suite and training data (MODEL-EVAL-01, MODEL-DATA-01)

The owner asked whether Soup ([repo](https://github.com/MakazhanAlpamys/Soup), [site](https://trysoup.dev/)) could replace
our model. Soup is not a model: it is an Apache-2.0 **fine-tuning** toolkit. It trains an existing model (such as our
Qwen 3.5-4B) on our own examples, gates the result with ship/don't-ship evaluations and exports GGUF for llama.cpp.

Its training needs an NVIDIA GPU. This laptop has Intel Iris Xe graphics and 15.7 GB of RAM, and Soup calls CPU training
experimental. We also have no training data yet. So the first step was to **measure** the current model on every job the
organisation gives it, and to start **collecting labelled data**.

## The suite (`integrations/model-eval/model_eval.py`)

It tests every model task with its **real production prompt and schema**, imported from the code that uses them:

| Task | Prompt from | What is checked |
| --- | --- | --- |
| claims | `integrations/claims/claims.py` | The fact-checker's own checks (quote in text, company named, figure in quote); the expected figure; no claim from an injected instruction |
| debate | `debate.py` | A valid argument; citations only from the proposal's verified evidence, even when the thesis tries to inject another |
| scenario | `scenario_panel.py` | Valid up/down/flat per linked share |
| rnd | `rnd_ideas.py` | Valid idea specifications; no copy of a catalogue idea |
| playbook | `playbook_drafts.py` | A money or limits fix is the owner's; the pattern matches the failure |
| allocator | `ai_allocator.py` | Valid weights for eight anonymous shares |

Each case runs twice, plus a **reworded or reordered variant** of the same facts.

**What is measured:**

| Measure | Meaning |
| --- | --- |
| Validity | The schema and the task's validator pass |
| Reliability | Errors by kind, and latency p50, p90 and max |
| Consistency | The same decision across repeats and the variant |
| Correctness | The case's expectations, where it states any |

**The gate:** validity ≥ 90%, correctness ≥ 80% and consistency ≥ 70% give SHIP, per task and overall. The report locks
what was tested: the model, its pinned file, every prompt version and a fingerprint of the cases. Any future model,
including a Soup fine-tune, must pass the same suite.

```
npm run model:local -- serve qwen3.5-4b-q4km      (in another terminal)
.local\replay-venv\Scripts\python.exe integrations\model-eval\model_eval.py [--tasks claims,debate] [--repeats 2]
```

## First run: Qwen 3.5-4B Q4_K_M on the laptop CPU, 21 Oct 2026

The run made 37 calls in about 25 minutes. Every one was answered, and every answer was valid.

| Task | Valid | Correct | Consistent | p50 / max seconds | Verdict |
| --- | --- | --- | --- | --- | --- |
| claims | 100% | 100% | 100% | 9 / 92 | SHIP |
| debate | 100% | 100% | 50% | 39 / 49 | DON'T SHIP |
| scenario | 100% | — | 75% | 18 / 31 | SHIP |
| rnd | 100% | 100% | 0% | 124 / 158 | DON'T SHIP |
| playbook | 100% | 67% | 100% | 19 / 21 | DON'T SHIP |
| allocator | 100% | — | 0% | 54 / 63 | DON'T SHIP |

What the details show:
- **Repeats are fully deterministic.** The identical question always got the identical answer (temperature 0). Every
  "inconsistency" comes from **rewording or reordering** the input:
  - **debate:** whether it cites the evidence changed with a reworded thesis;
  - **rnd:** different ideas when the results list was reversed;
  - **allocator:** two weights moved by 5 points when the shares' order was reversed, a small order bias;
  - **scenario:** the retail-trader persona said "down" for the rate hike but "flat" when it was reworded.
- **Safety held everywhere:**
  - no claim came from the injected instruction;
  - no forbidden evidence was cited;
  - the model put the money-limit fix with the owner every time.
- **The playbook's misses were its search pattern,** which did not match the error text in 2 of 3 answers. The
  playbook's own safeguard replaces such a pattern.
- **Claims are strong:** the right figure from the right quote, nothing from the off-topic text, and nothing from the
  injection.

**How to read it.** The model is reliable and safe on format and guardrails. It is **sensitive to wording and order**,
which matters most for the allocator (its weights should not depend on the order of the shares) and less for invention,
where variety is expected. The consistency bar may need to differ by task: the owner decides. A fine-tune with
preference pairs could target exactly this weakness.

## The week's new model work, tested on the real model, 23 Oct 2026

Eight tasks now, all with their production prompts:
- **New tasks:** `headline` (the headline reader) and `reflect` (a persona's lesson after a wrong call).
- **New scenario case:** `scenario-second-round`, for round 2 of the panel.

Run on Qwen 3.5-4B Q4_K_M, laptop CPU, 2 repeats plus reworded variants:

| Task | Verdict | Valid | Correct | Consistent | Typical answer |
| --- | --- | --- | --- | --- | --- |
| scenario (incl. the second round) | SHIP | 100% | (no fixed answer) | 83% | 22 s |
| reflect | SHIP | 100% | 100% (ignored an injected "BUY BUY BUY") | - | 14 s |
| headline, prompt v1 | DON'T SHIP | 100% | 71% | 100% | 22 s |
| headline, prompt v2 | **SHIP** | 100% | 100% | 100% | 14 s |

**What v2 fixed:** v1 read a "market buzz" stake-sale headline correctly as a rumour with an unclear direction, but filed
it under `management`, because the prompt never said what each event type covers. v2 names each event in a few words.
The model also ignored an instruction planted inside a weather headline, both times.

The training-data builder now recognises and labels both new tasks.

## Where the model stands, 23 Oct 2026 (Qwen 3.5-4B, laptop CPU)

**6 of 8 tasks pass** (against 2 of 6 on 21 Oct). *Corrected 27 Oct: this line said 7 of 8, but the table below
has six SHIPs and two DON'T SHIPs.*

| Task | 21 Oct | 23 Oct | What changed |
| --- | --- | --- | --- |
| claims | SHIP | SHIP | - |
| scenario | SHIP | SHIP (83% consistent) | - |
| headline (new) | - | SHIP | prompt v2: each event type defined |
| reflect (new) | - | SHIP | - |
| debate | DON'T SHIP (50% consistent) | **SHIP (100%)** | an exact citation rule: cite only when the argument uses a fact stated in that evidence |
| playbook | DON'T SHIP (67% correct) | **SHIP (100%)** | the model copies a phrase from the failure text, and the code escapes it (`playbook_drafts.literal`). The model had copied "limit (MAX_ORDER_PAISE)" exactly; our code then read the brackets as regex symbols |
| R&D invention | DON'T SHIP (0% consistent) | DON'T SHIP | owner decision B10: variety is expected when inventing ideas |
| allocator | DON'T SHIP (0% consistent) | DON'T SHIP | owner decision B11: a fixed share order needs a new forward test |

**A lesson about small models:** one extra sentence in the debate instructions, about the new events calendar, flipped
its citations again (50% consistent). The calendar now explains itself inside the data, and the instructions stay as
tested.

**The structural fix, done the same day (MODEL-04):**
- **Context:** debaters now see an excerpt of each verified evidence item. Before, they saw only its id, so a citation
  was a guess.
- **A quote to cite:** to cite, a debater copies a phrase from the excerpt (`evidenceQuote`). The code keeps the
  citation only when that phrase is in the evidence; otherwise the argument stands without it (`citationDropped`).
- **Derived citations:** when a debater uses a fact but forgets to cite it, the code derives the citation from the
  argument's own words (`citationDerived`). That needs a shared run of at least 20 characters and 3 words, so generic
  phrases never count. An explicit grounded citation always wins, and a false quote is never rescued.
- **On Qwen 3.5-4B:** debate SHIP, 100% valid, correct and consistent over 3 repeats and the reworded variant.
  - The bear cites the narrowing net interest margin with an exact quote.
  - In the reworded case the same citation is derived from its argument.
  - The bull ignored an injected fake evidence id.

## Training data from our own work (`build_dataset.py`)

**The source.** Every production model call is now recorded locally in `.local/model-calls/<day>.jsonl` by the shared
model client: the prompt, the input, the answer or error, and the time, never a key. `MODEL_CALL_JOURNAL=off` turns it
off. Evaluation runs keep their own records.

**What the builder does.** It labels every answer with the organisation's own checks and writes, per task, to
`.local/training-data/`:
- `sft.jsonl`: answers that passed every check, as chat messages;
- `preference.jsonl`: a failed answer (rejected) paired with the same answer corrected by the check (chosen), in the
  prompt/chosen/rejected form preference trainers read;
- `manifest.json`: counts and a fingerprint.

Scenario and allocator answers are opinions about the future. They wait until their calls are scored. Rows from the
evaluation come from invented fixtures, so keep them for testing, not training.

## Next, the owner's decisions

1. **Per-task consistency bars:** for example, keep 70% for the allocator and debate, and relax it for invention.
2. **Order-robustness fixes in our own prompts:** for example, the allocator could present the shares in a fixed order,
   which removes that bias at no cost.
3. **A Soup fine-tune:** only once production data has accumulated, on a GPU the owner approves, and only if it beats this
   suite.
