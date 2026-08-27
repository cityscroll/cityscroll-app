# ADR: Calendar occurrence projection

| Field | Value |
| --- | --- |
| Status | Accepted |
| Scope | CalendarOccurrence contract and feed consumer boundary |
| Blocks | Later zoning, procurement, and exam calendar producers |

## Decision

Calendar output is built from a presentation-neutral `CalendarOccurrence`, not
directly from a search result. The contract is normalized by
[`site/calendar_occurrence.mjs`](../../site/calendar_occurrence.mjs) and carries:

`uid`, `scope_ref`, `object_ref`, `kind`, `title`, `starts_at` or `date`,
`ends_at`, `timezone`, `status`, `location`, `description`, `canonical_url`,
`source`, `provenance`, `observed_at`, and, when the source publishes them,
`lifecycle`, `sequence`, and `last_modified`.

`kind` is one of `event`, `deadline`, `window_open`, `window_close`, or
`milestone`. `status` is one of `scheduled`, `cancelled`, or `completed`.
The source lifecycle is `published`, `scheduled`, `rescheduled`, or
`cancelled`. A reschedule keeps the same `uid`, carries the updated time, and
increments `sequence`; a cancellation keeps the same identity and serializes
as `STATUS:CANCELLED`. `last_modified` is emitted as `LAST-MODIFIED` when a
source timestamp is available. The feed has one VEVENT per UID, selecting the
newest published revision at the consumer boundary so an old time cannot
remain beside its replacement.
Timed values use `starts_at`; publisher date-only values use `date`. A date-only
occurrence may use a date-only `ends_at` for an exclusive all-day end.

## Boundary

Domain producers call `calendarOccurrencesForRecord()` or
`projectCalendarOccurrences()`. They choose the semantic civic date and may
emit zero occurrences. Publication fields such as `start_date` and
`published_at` are never candidates. `worker/src/feed.mjs` passes producer
output to `icsFeed()`. The serializer only formats occurrences, retains the
existing `@crol-list` UID namespace, and never chooses a row timestamp.

The old `feedItems()` and `icsFeed({ items })` inputs remain compatible for
existing consumers. That compatibility shim converts only the legacy
`eventDate` field; new callers should pass `icsFeed({ occurrences })` so the
consumer receives a complete projection.

## Coverage

`calendarizationCoverage()` reports calendarization independently from source
ingestion: records matching the scope, records with meaningful future time,
records with occurrences, emitted occurrence count, exact-time occurrences,
date-only occurrences, and records withheld for ambiguous dates. A publication-
only record therefore contributes to the matched-scope denominator but emits no
calendar item.

Fixtures and focused proof live in
[`test/calendar_occurrence.test.mjs`](../../test/calendar_occurrence.test.mjs)
and `test/fixtures/calendar-occurrences/cases.json`.
