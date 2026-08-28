# Calendar and ICS contract

This document characterizes the calendar behavior already shipped by CityScroll. It is a
compatibility boundary for later calendar work: this milestone documents the existing behavior
and does not add a calendar scope or change an emitted event.

## Authoritative-function map

| Concern | Authoritative code | Current responsibility |
| --- | --- | --- |
| Legacy feed scope parsing | `worker/src/lib/feed.mjs:parseFeedQuery` | Converts `lens`, whitespace-split/capped `q`, `agency`, `min`, `name`, and `kind` into the filter shape used by `sanitize()`. |
| Feed route and scope admission | `worker/src/feed.mjs:handleFeed` | Accepts GET `/feed.{xml,json,ics}`, validates the six feed lenses, sanitizes the parsed filter, and sends it to `compileSub()`. |
| Canonical scope normalization and route serialization | `site/scope_v0.mjs:normalizeScope`, `scopeFromRouteHash`, `routeHashFromScope`, `scopeFromWatch`, `watchFromScope` | Owns the version-0 civic scope and the modern Browse/Following route wire. The feed’s legacy query parser does not consume the full scope-v0 shape. |
| Following scope parsing/serialization | `site/following_view.mjs:watchFromFollowingParams`, `followingUrlFromWatch`; `site/watch_templates.mjs:normalizeFilter` | Reads the JSON `filter` plus legacy query fields into a watch and serializes a watch as `lens` + JSON `filter` (+ optional cadence/count). |
| Query compilation and matching | `worker/src/lib/compile.mjs:compileSub`, `rowsForCompiledQuery` | Shared by `/feed.ics` and Following preview. Builds SODA/District/route-read-model queries and applies post-filters. Meetings use `materializedMeetingRows`, including future-date, agency, keyword, and location matching. |
| D1 query mirror | `worker/src/lib/compile_d1.mjs:subToD1Opts`, `compileSub_d1` | A parallel D1 compiler for alert delivery. It is not called by `worker/src/feed.mjs`; its options and post-filter must remain equivalent to the SODA compiler. |
| Watch compilation | `worker/src/lib/compile.mjs:compileSub` and `worker/src/lib/compile_d1.mjs:compileSub_d1` | `compileSub()` is the shared email/feed query compiler. Alert delivery may select the D1 mirror through `compileSub_d1()`. Neither compiler creates an ICS event. |
| Meeting temporal projection | `worker/src/hearings.mjs:fetchRows`, `handleHearings`; `worker/src/lib/compile.mjs:materializedMeetingRows` | The materialized meeting read model is sourced from future `event_date` values. Meeting feed rows use `event_date` as the event date and publication/observation time only as `start_date`/display date. |
| Feed item temporal projection | `worker/src/lib/feed.mjs:feedItems` | Meetings set `eventDate = event_date`; ordinary notice rows set `eventDate = event_date || due_date`; awards, land projects, and other rows may have a display `date` but no calendar event date. |
| Standing-feed ICS serialization | `worker/src/lib/feed.mjs:icsFeed` | Emits one zero-duration VEVENT per item with an `eventDate`, uses local `Date` parts, sets `DTSTAMP`, `DTSTART`, and `DTEND` to the same value, and adds a one-day display alarm. |
| Individual meeting ICS serialization | `site/hearing_attend_pack.mjs:meetingCalendarICS` | Emits a timezone-aware New York event, a one-hour fallback end (or a valid supplied end), venue/access fields, a one-day alarm, and the separate `@cityscroll.org` UID form. |
| Individual meeting routes | `worker/src/hearings.mjs:handleMeetingICS`; `site/pages_edge.mjs:handleMeetingICS` | Resolve an exact ID from the materialized meeting read model and call `meetingCalendarICS`; no source refresh occurs on demand. `site/meeting_document.mjs` supplies the existing “Add to calendar” link when a clock time exists. |
| Land hearing projection | `worker/src/land_upcoming_hearings.mjs` and `tools/lib/land_upcoming_hearings.mjs` | Land hearing dates come from published ZAP disposition/milestone evidence. They are a separate `/land-upcoming-hearings` projection; the generic feed’s land item path uses `current_milestone_date` as display `date` and does not promote it to `eventDate`. |

## UID and event rules

The standing-feed namespace is deliberately unchanged:

```text
UID:<feed item id>@crol-list
```

`feedItems()` derives the item ID directly from the source identity: `meeting_id` for a
materialized meeting, `procurement_id` for a procurement object without a City Record request ID,
`project_id` for a land project, `alert_id`/`obligation_id` for mandate rows, and `request_id` for
ordinary City Record rows. `icsFeed()` escapes that ID for iCalendar syntax but does not hash,
rename, or add a new source namespace. Therefore changing a stable source ID or its item-branch
selection would make subscribers see a new event.

Individual `/meeting.ics` events intentionally use the separate
`UID:<meeting_id>@cityscroll.org` form from `meetingCalendarICS()`. This is not a standing-feed
UID migration; it is the pre-existing single-event contract.

For standing feeds, only `eventDate` becomes a VEVENT. A row can have a `date` used for feed
display and still be absent from the calendar. In particular, an award with only `start_date` is
not emitted. A due date is promoted for ordinary notice/RFP rows when there is no event date.

## Update lifecycle

An occurrence has a source-facing lifecycle of `published → scheduled → rescheduled → cancelled`.
`rescheduled` changes the civic time without changing `uid`; the feed emits one VEVENT for that
UID, so a refresh moves the event instead of leaving the old time beside the new one. A cancelled
occurrence retains its UID and date and is emitted with `STATUS:CANCELLED` rather than silently
disappearing.

When a publisher supplies an integer revision/sequence and modification timestamp, the normalized
occurrence carries them as `sequence` and `last_modified`, and ICS emits `SEQUENCE` and
`LAST-MODIFIED`. Missing publisher clocks are left unknown rather than inferred from fetch time.
Rows with the same UID are collapsed at the occurrence boundary, preferring the highest sequence,
then the newest supplied modification/observation clock, with a same-UID cancellation preferred
when no clock is available.

Subscription clients pull on their own schedules. Apple Calendar exposes an Auto-refresh setting;
Google Calendar documents that URL-based calendar changes may take up to 12 hours to appear. The
feed’s stable UID and update metadata make refreshes correct when received, but cannot make a
client refresh immediately.

## Characterization fixtures and evidence

The exact CRLF payloads are locked in `test/fixtures/calendar-contract/`:

- `meeting-feed.ics`: standing Meetings feed with City Record and community-board source IDs;
- `meeting.ics`: one timezone-aware individual meeting event;
- `keyword-agency-feed.ics`: keyword + agency Rules feed;
- `documented-parameter-feed.ics`: the README-documented `lens/q/agency/min` shape, including the
  current empty calendar result for an award row with no event/due date.

`test/calendar_contract.test.mjs` compares generated output byte-for-byte, checks the UID
namespace and source-ID derivation, exercises the legacy parser, and checks the compile/Following
boundaries. The current before-state evidence is in `docs/evidence/calendar-contract/before/`:
the captured live Meetings feed and headless desktop/mobile Meetings screenshots. The capture
asserts that the current UI has no “Subscribe to calendar” affordance or `/feed.ics` link.

## Learning for subsequent work

Most query infrastructure is already shared: `/feed.ics`, Following preview, and the alert
compiler all converge on `compileSub()` plus `rowsForCompiledQuery()`; the feed and preview then
reuse `feedItems()`. The current semantic duplication begins at the input and delivery edges:

1. The feed still parses the legacy `lens/q/agency/min` grammar independently in
   `parseFeedQuery()`, while Following carries a normalized watch with a JSON filter and
   `scope_v0` adapters.
2. Alert delivery has a materially parallel D1 compiler (`compileSub_d1`) beside the SODA/route
   compiler. Its parity is tested by existing compiler tests but is not an ICS serializer.
3. Individual meeting events use a separate, richer iCalendar formatter and UID namespace from
   standing feeds. This is semantic duplication at the event-delivery boundary, not a reason to
   alter the standing contract in this milestone.

Later work should establish one scope-to-calendar serialization boundary while preserving the
legacy feed parser and the `@crol-list` namespace until a deliberate migration exists.

## Card 2 replay findings

Card 2 establishes that boundary in `site/scope_v0.mjs`: `subscriptionParamsFromWatch()` is the
single `lens` + JSON `filter` serializer used by Following and the modern `/feed.ics` path, while
`calendarFeedUrlForScope()` suppresses a calendar URL when the scope cannot be replayed without
loss. The legacy `lens/q/agency/min` parser remains unchanged.

The following fields are carried by the canonical scope/watch or an existing surface but are not
currently replayed by `compileSub()` for the corresponding feed lens, so the calendar projection
does not advertise those scopes:

The one exact relation exception is `rules.request_ids`: a continuation with an accepted
rulemaking relation may carry the bounded member notice IDs, and both compilers constrain on those
IDs. `worker/src/lib/continuation_replay.mjs` additionally requires a lossless Following reopen
and exact subject delivery proof before publishing that continuation. A subject-only matter
candidate, title/agency query, or body-level relation remains unsupported and returns no
continuation.

- money: `mode`, `excludeSpecial`, `borough`, `route`, `name`, `tab`, `entity_refs_all`, and
  `connection_relation`;
- land: `agency`, `action`/`actions`, `stage`, `futureAction`, `attendance`, `sort`,
  `entity_refs_all`, and `connection_relation`;
- property: `borough`, `neighborhood`, `communityDistrict`, `councilDistrict`, `process`,
  `stage`, and `sort`;
- rules: `borough`, `neighborhood`, `communityDistrict`, `councilDistrict`, `locationScope`,
  and `process`;
- meetings: `process`, `group`, `action`/`actions`, `entity_refs_all`, and
  `connection_relation`;
- all feedable lenses: typed entity/project relations (`entity_refs_all`) remain present in the
  Following wire where a surface carries them, but `compileSub()` has no relation join to apply.

These are architecture findings for later scope/compiler work, not calendar-specific parameter
exceptions. Modern feed requests containing one of these fields fail with HTTP 400 at the Worker;
they never fall through to a broader query. The separate `compileSub_d1()` mirror is not involved
in calendar serialization and remains a later parity concern.
