# ADR: Community-board meeting coverage for Brooklyn CB5 and Queens CB7

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-24 |
| Scope | Community-board meeting source inventory and materialized meeting index |

## Decision

Route Brooklyn Community Board 5 through its publisher's public Google Calendar
iCalendar feed and the existing `google_calendar_v1` adapter. Route Queens
Community Board 7 through its NYC-hosted meetings page and the existing
`nyc_official_calendar_v1` adapter.

Queens CB7 publishes the next meeting as an explicit date in prose but does not
publish a clock time. The adapter therefore emits a date-only event with
`start_at: null`; it does not infer a time from the board's recurring cadence.
Both rows remain source-observed and unjoined until an exact City Record join is
available.

## Consequences

The source inventory and receipts remain the authority for the two URLs and
adapter choices. Rebuilding `community_board_meeting_index.json` adds only
publisher-observed records and preserves the existing meeting-object contract.
