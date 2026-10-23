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

## Who uses it

| Reader | What it sees |
| --- | --- |
| The debate desk | The share's own events and market-wide ones within the proposal's horizon (at least 10 days), marked as background, never as evidence. `dataStatus.eventsCalendar` says `available` or `no calendar`, so a missing file is never read as "nothing scheduled" |
| The scenario panel | Market-wide events in the week its calls are judged on |
| The digest | "Coming up (next 7 days, from your events calendar)" |
