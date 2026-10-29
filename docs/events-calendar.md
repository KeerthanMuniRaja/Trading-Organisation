# Events calendar (NEWS-05)

The organisation should never decide blind to results day or a policy meeting, so you keep a short calendar file by
hand. No source is fetched. The idea comes from the catalyst calendar in Anthropic's financial plugins (gap 30).

## The file: `.local/events.json`

Copy [`docs/policies/events-example.json`](policies/events-example.json) to `.local/events.json` and keep it current:

```json
{"events": [
  {"date": "2026-11-05", "kind": "results", "symbols": ["SBIN"], "title": "SBI quarterly results"},
  {"date": "2026-12-04", "kind": "rbi-policy", "title": "RBI monetary policy decision"}
]}
```

- **Kinds:** `results`, `rbi-policy`, `budget`, `fomc`, `macro-data`, `holiday`, `other`.
- **Shares:** leave `symbols` out for an event that concerns the whole market.
- **Invalid entries** (a bad date, an unknown kind, a share we don't track) are skipped and counted, never guessed.
- **Sources for the dates:**
  - results dates from the companies' exchange filings;
  - RBI and Budget dates from their announcements;
  - FOMC from the Federal Reserve's calendar.

## Results days from the press (NEWS-07, 28 Oct 2026)

You don't have to keep the results dates yourself. Every cycle, `results_calendar.py` (step `results-calendar`) reads
the headlines the approved feeds bring in, by fixed rules (no model, no network):
- **What counts:** a headline counts only when a results word comes just before the date it gives, for the companies
  it names. Examples: "4 banking stocks to declare results on Oct 17", "Q2 Results Today Live: …", and "board meeting
  on November 7 to consider Q2 results".
- **What never counts:** dividend record dates, splits, bonuses, IPOs, election results, and dates too far from the
  headline (more than a week before it, or two months after).
- **Rescheduling:** when a later headline gives a new date within 20 days for the same share, the later one wins.
- **Keeping:** the list builds up in `.local/world/results-calendar.json` and keeps each date for 400 days. The headline
  history holds only the newest 500 items, so this file is what keeps older dates.

The desk shares' dates join the calendar marked `source: press`, with the publisher and "not the exchange filing" in
the title:
- **Your entries win:** a results entry of yours for the same share within 20 days replaces the press one.
- **Without your file:** the status reads `press-reported results days only (no owner calendar): other dates unknown`.
  An empty list then means "none reported", never "nothing scheduled", and policy dates stay unknown until you add them.
- **The mentor's results-day lesson** now reaches the debate whenever a press results date is upcoming.
- **Policy days (29 Oct 2026):** the same reader finds RBI and Fed decision days.
  - **What counts:** the headline must name the decider, with a decision word (meeting, decision, policy, outcome) just
    before the date. For example: "US Fed meeting October 2026 today" or "RBI MPC meeting on December 4".
  - **What doesn't:** minutes, speeches and testimony before the date.
  - **How they appear:** as market-wide events (`rbi-policy`, `fomc`) that every share sees, titled "not the official
    calendar".
  - **Your entries win:** your entry for the same decider within 20 days replaces the press one.
  - **First one found:** the Fed decision of 28 Oct.
- **The results-day lesson is now measured** (`results_day_moves` in the [mentor](mentor.md)): each results day's move
  is compared with the share's usual move. The lesson is judged from 30 cases.

## Who uses it

| Reader | What it sees |
| --- | --- |
| The debate desk | The share's own events and market-wide ones within the proposal's horizon (at least 10 days), marked as background, never as evidence. `dataStatus.eventsCalendar` says `available` or `no calendar`, so a missing file is never read as "nothing scheduled" |
| The scenario panel | Market-wide events in the week its calls are judged on |
| The digest | "Coming up (next 7 days, from your events calendar)" |
