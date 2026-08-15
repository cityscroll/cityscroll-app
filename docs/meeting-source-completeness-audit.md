# Meeting source completeness audit

As of 2026-08-15, the executable inventory is
[`site/meeting_source_completeness.mjs`](../site/meeting_source_completeness.mjs).
It contains one row per accepted source field and requires each row to name its
source seam, materialized representation, meeting-document use, search use,
alert use, and final disposition. The focused contract test fails when a row is
missing any of those decisions.

This audit distinguishes two source-qualified meeting producers from one joined
enrichment source:

| Producer | Role | Identity boundary | Public source |
| --- | --- | --- | --- |
| `city_record` | Meeting producer | Exact City Record `request_id` | [City Record Online](https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx) |
| `community_board` | Meeting producer | Exact board publisher event identifier | [NYC community boards](https://www.nyc.gov/site/communityboards/index.page) and the per-board URLs recorded in [`board_source_inventory.json`](../site/data/non_council_outcome_sources/board_source_inventory.json) |
| `legistar` | Council outcome enrichment | Exact event identity only after the measured date-and-body join to a City Record notice | [NYC Council Legistar calendar](https://nyc.legistar.com/Calendar.aspx) and the authenticated [Legistar API](https://webapi.legistar.com/v1/nyc) |

Legistar is deliberately not a third standalone `meeting_id` namespace. Its
events, agenda items, votes, and attachments enrich a strictly joined City
Record meeting in `meeting-outcomes`; unmatched events remain explicit and do
not supply cross-source values to the shared meeting object.

## Source-to-surface summary

The detailed executable inventory covers 31 City Record fields, 33
community-board source-record fields, and 37 Legistar fields.

| Source field families | Materialized representation | Meeting document | Search | Alerts |
| --- | --- | --- | --- | --- |
| City Record identity, title, event date, agency, notice type, and section | Shared `meeting` identity and core fields | Heading, time, institution, notice details, source actions | Result identity, title, and `search_text` | Identity, upcoming window, agency, and keywords |
| City Record location, notice prose, contacts, and accepted links | `venue`, `affected_area`, `participation`, `meeting_access`, retained notice fields | Where, Notice details, Contact, Related links, How to participate | Materialized `search_text` | Place matching, match context, and access actions |
| City Record printout or rule-detail body | Bounded derived description, place, and participation fields; raw attachment text is not republished | About this meeting only when richer notice paragraphs are absent | Bounded materialized description | Derived place and access context |
| Community-board publisher identity, board identity, and receipt | Source-qualified meeting identity, board ref, source record, and freshness envelope | Canonical board and official-source links; source checked time | Typed board scope and result identity | Typed place scope and freshness |
| Community-board start/end, venue, description, committee, participation, and exact documents | `event_date`, `event_end`, `venue`, `description`, `committee`, `participation`, `meeting_documents` | When/Ends, Where, About, Institution, participation, agenda, minutes | Materialized `search_text` | Upcoming window, keywords, place, and access actions |
| Legistar Event and EventItem fields | Joined `council_event`, `agenda_items`, matters, actions, and vote spines | Council outcome heading, date, location, agenda, matter, and action records | Intentionally separate from shared meeting search | Intentionally separate from meeting alerts |
| Legistar vote and attachment fields | Roll-call counts, named votes, typed `votes_on` edges, and canonical documents | Joined Council roll call and attachment links | Intentionally separate from shared meeting search | Intentionally separate from meeting alerts |

## Gaps closed by the audit

- Community-board `start_at` and `end_at` now survive event indexing as
  `event_date` and `event_end`. Date-only publisher events remain valid all-day
  events; malformed values do not receive a calendar action.
- Publisher descriptions now render from the same shared materialized row used
  by meeting search and watches. City Record attachment-derived descriptions
  render only when the structured notice paragraphs are absent.
- City Record building names render with their address instead of disappearing
  when the venue also has a street address.
- A separate Legistar `EventTime` now combines with `EventDate` before the
  strict join is rendered, preserving the publisher's wall time and canonical
  meeting, agenda, and minutes links.

## Intentional omissions and unknown states

- City Record procurement columns `address_to_request`,
  `category_description`, and `selection_method_description` remain materialized
  but do not acquire meeting semantics.
- Community-board document/video identifiers remain on their typed source
  records. Only exact attached `meeting_documents` render on a meeting.
- A community-board organizer can contribute publisher-supplied contact details,
  but it cannot mint an institution identity without an exact identity seam.
- Missing, stale, unsupported, browser-required, and checked-empty community-board
  sources retain their existing typed states. None triggers a live page-load
  lookup.
- `EventVideoStatus` is retained inside Legistar normalization but does not
  become a recording link without a publisher URL.

## Verification

```bash
node --test \
  test/meeting_object_contract.test.mjs \
  test/shared_meeting_read_model.test.mjs \
  test/meeting_document_links.test.mjs \
  test/community_board_meeting_lens_parity.test.mjs \
  test/legistar_join.test.mjs
```

The tests exercise public normalization and rendering behavior. They also check
that the Legistar event fixtures stay within the reviewed field inventory, so a
new accepted source field requires an explicit disposition.
