# Scenario panel (SCENARIO-01)

The panel lets several market participants rehearse the day's biggest world stories. Each persona says how the shares a
story reaches may move over the next week. The panel works in **shadow**: it never proposes or trades. It gets scored like
any member, so the organisation learns whether this way of thinking adds anything.

The idea comes from [MiroFish](https://github.com/666ghj/MiroFish), where many agents with their own perspective rehearse how
a story plays out. None of MiroFish is used:
- its code is AGPL-3.0;
- it needs a large cloud model and the Zep Cloud memory service;
- it publishes no evidence of accuracy.

This is the small, testable version, running on the local model.

## How it works

1. **Stories.** The cycle groups the news into world stories (`world-stories`). The panel takes the two strongest that reach
   a share, either by naming it or through a world driver ([world news](world-news.md)).
2. **Panel.** Five fixed personas each answer once per story, for each linked share: up, down or flat over about five
   sessions, against the market, with a short reason. The answer is bound to a schema. Headlines are treated as untrusted
   data.

   | Persona | Thinks about |
   | --- | --- |
   | foreign-investor | the dollar, US rates, global risk, India against other emerging markets |
   | domestic-fund | earnings and valuations over quarters, steady SIP inflows |
   | retail-trader | headlines, momentum, what is trending |
   | central-bank-watcher | the RBI, the Fed, inflation, liquidity |
   | sector-analyst | each named company's business and costs |

3. **The panel's call.** A direction that at least 3 of the 5 agree on. Split views are no call. A persona whose answer
   fails counts as no view.
4. **Record.** Every call, with each persona's answer and reason, is appended to
   `.local/trading-desk/scenario/calls.jsonl`. The panel runs once a day.

## How it is judged

`scenario_panel.py score` needs no model. After 5 sessions, each up or down call is right if the share beat the
equal-weight basket (for up) or trailed it (for down). The panel and **each persona** get their own record, with the same
sign test and minimum number of calls the bots face. This shows which perspective, if any, reads the news well.

The digest's World news section shows the record. Only a record that beats chance over at least 20 calls makes the case
for turning the panel, or one persona, into a real member. That decision is the owner's, and the member would then earn a
release like any other.

## Running it

The cycle runs the panel only with the model on (`npm run cycle -- --with-model`, or the supervisor with `MODEL_AUTOSTART`).
Scoring runs every cycle. Each run costs at most 10 model calls (2 stories × 5 personas).

```
.local\replay-venv\Scripts\python.exe integrations\trading-desk\scenario_panel.py run      (model needed)
.local\replay-venv\Scripts\python.exe integrations\trading-desk\scenario_panel.py score
```
