# Precise-watch matching fixtures

Regression fixtures for the versioned watch text expression
(`site/watch_text_query.mjs`, wire name `text_query`).

- `procurement_titles_snapshot.json` — frozen title projection of 378 NYC City
  Record procurement notice rows (340 with titles), retained from the public
  resident procurement snapshot generated 2026-09-09. The exact-ID regression
  cases for terms, exclusions, grouped alternatives, AND-of-groups (expected
  empty), phrases, and whole-token matching are asserted against these rows.
- `rat_inspection_meeting.json` — one retained public-hearing row
  (20260803009) used as the whole-token positive control.

All request IDs and titles are public records (original records at
`https://a856-cityrecord.nyc.gov/RequestDetail/{request_id}`). Counts describe
the retained snapshot only; rolling production gates must assert population
properties instead of requiring these records to stay in a publisher window.

`acceptance.md` maps each acceptance item to the delivered path and the exact
ID sets asserted by the tests.
