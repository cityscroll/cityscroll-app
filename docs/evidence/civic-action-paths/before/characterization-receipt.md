# Civic action paths: current-state characterization

This receipt freezes the implementation observed at repository revision
`455ed2e8e91a60d5da247c286aef654f184e528a` on 2026-08-27. It records behavior and
evidence only; no product implementation is included.

## Capture method

Screenshots were produced by `tools/capture_civic_action_paths_before.py` using the
checked-in public-site build, a loopback static server, and headless Playwright. The
browser never used an interactive local browsing session. The build source was
`site/` plus the client capability modules selected by `tools/build_public_site.mjs`.

Viewports:

- desktop: 1440×1000
- mobile: 390×844

The complete file map is in `capture-manifest.json`. The capture includes the six
fixture classes requested by CAP-0 and an additional map-surface pair needed to
characterize the Community Board source directory.

## Action registry and current rails

`site/action_registry.js` is the action vocabulary and rail compiler. Its registered
reader actions are:

| Domain / input kind | Current rail behavior | Registered action types used |
| --- | --- | --- |
| fallback / generic notice | Official notice, then related-record watch | `document`, `watch` |
| hearing / meeting | Future event: official attendance or local participation guide, calendar, watch. Past event: unavailable attendance, official notice, watch | `attend`, `bid_checklist`, `calendar`, `document`, `watch` |
| agency rule | Open participation: official comment or attendance, deadline calendar, watch. Closed or proposed without an actionable handoff: unavailable comment, official notice, watch | `comment`, `attend`, `document`, `bid_checklist`, `calendar`, `watch` |
| solicitation | Official application or local response guide, calendar when applicable, watch. Closed: unavailable application, official notice, watch | `official_application`, `bid_checklist`, `calendar`, `document`, `watch` |
| zoning / land use | Comment or attendance handoff, in-person/live links, calendar, land-use watch; otherwise a local guide or unavailable state | `comment`, `attend`, `document`, `bid_checklist`, `calendar`, `watch` |
| franchise / concession | Stage-specific application, meeting, hearing, or award handoff, calendar, watch; missing stage fields remain official-notice plus watch | `official_application`, `attend`, `document`, `bid_checklist`, `calendar`, `watch` |
| exam | Open OASys application plus calendar and official notice; otherwise unavailable application plus notice | `official_application`, `calendar`, `document` |
| property disposition | Sale package, local sale guide, parcel/document links, calendar, and watch according to stage and available fields | `official_application`, `bid_checklist`, `attend`, `document`, `calendar`, `watch` |
| award | Checkbook or local tracking guide, official notice, and watch; no solicitation bid CTA | `document`, `bid_checklist`, `watch` |

The closed action set is `watch`, `calendar`, `document`, `contact`, `rsvp`,
`comment`, `attend`, `bid_checklist`, `official_application`, `return_to_matter`,
`local_note`. Delivery is one of `local`, `official_handoff`, or `unavailable`.
Rails are validated and capped at three actions. Confirmation-gated actions are
`rsvp`, `comment`, and `official_application`; action outcome telemetry is actorless
and limited to the registered values `submitted`, `attended`, `bid`, `won`, and
`not_useful`.

### Meeting action rail

The canonical meeting document renderer (`site/meeting_document.mjs`) currently
emits only the concrete calendar link (`Add to calendar`) when a meeting has a
concrete event time, plus a compatibility link to the City Record notice when one
exists. It does not emit a Following/watch CTA in the canonical meeting document.

The older notice-context rail is compiled through `compileActionRail` and is visible
in the Council captures. For the past Council fixtures it shows `This event has
passed`, `City Record`, and `Get updates about related records`; the outcome panel
then provides the Council matter action. Meeting cards route through
`site/meetings_card_interaction.mjs` to the source-qualified meeting document or
legacy notice route.

## Calendar behavior

`worker/src/hearings.mjs` serves `GET /meeting.ics?id=...` from the materialized
meeting read model (`HEARINGS_KV_KEY` with the bounded record fallback). The handler
does not perform a request-time publisher lookup. A missing ID or missing event time
returns no calendar event. `site/hearing_attend_pack.mjs` produces the timezone-aware
New York VEVENT with the source-qualified individual UID
`UID:<meeting_id>@cityscroll.org`, venue/access fields, source URL, and a one-day
alarm.

`worker/src/feed.mjs` owns `/feed.xml`, `/feed.json`, and `/feed.ics`. The standing
contract in `docs/calendar-contract.md` keeps standing-feed UIDs in the separate
`UID:<feed_item_id>@crol-list` namespace. Only rows with an event date become
standing VEVENTs; ordinary due dates may be promoted, while an award `start_date`
alone is not treated as an event. UID stability, rescheduling, and
`STATUS:CANCELLED` behavior are documented there. The checked-in calendar fixtures
are `test/fixtures/calendar-contract/meeting-feed.ics`, `meeting.ics`,
`keyword-agency.ics`, and `documented-parameter.ics`.

## Following and watch creation

`site/following_view.mjs` parses the typed `lens` + `filter` scope, normalizes it
through `site/scope_v0.mjs`, previews the current result set, and renders a POST form
to `https://api.cityscroll.org/subscribe`. The form carries the normalized lens,
filter, frequency, and language plus an email address; the server-side path is:

`GET /following` → `watchFromFollowingParams` / preview → POST `/subscribe` →
`sanitize` → `buildSubscription` → `enrollAndWelcome` → subscription record and
actorless watch log.

A notice or action-rail watch destination is a related-record Following URL, not a
subscription to a single notice. `worker/src/lib/subscriptions.mjs` owns the
standing delivery object; `worker/src/lib/action_log.mjs` / `watchlog.mjs` retain
privacy-safe lifecycle methods such as `watch_confirmed`, `watch_updated`,
`watch_paused`, `watch_resumed`, and `watch_removed`.

## Council matter and outcome projection

`worker/src/lib/meeting_outcomes.mjs` implements a strict projection:

`agenda item → Council matter → action → vote → attachment`.

The notice-to-event join uses strict date/body evidence. A matched agenda row with a
numeric Legistar MatterId receives a `matter:<id>` subject reference and a retained
Gateway URL. An agenda row without a matter remains explicitly unmatched with
`Agenda item has no linked Council matter yet.`. Unmatched City Record notices retain
`No Council event matched this City Record notice on the strict date + body join.`;
they do not receive an invented matter or vote.

The captured stable fixtures are:

| Class | Retained identifiers | Stability / source basis |
| --- | --- | --- |
| strict matter join | City Record `20260707022`; Legistar event `22509`; MatterId `79200`; matter file `LU 0114-2026` | Committed `site/data/meeting_outcomes_snapshot.json` and `site/data/meetings_domain_observations.json` retain the publisher request ID, event ID, matter ID, Gateway URL, and City Record URL. The strict join method is `exact_date_body_tokens`. |
| multi-matter join | City Record `20260707021`; Legistar event `22502`; MatterIds `79201`, `79203`, `79202`, `79204`, `79205` | The same committed snapshots retain the event and all five distinct matter IDs and URLs. The fixture demonstrates one meeting producing multiple matter spines. |
| no matter join | City Record `20260728026`; Buildings public-hearing notice | The committed meeting snapshot retains `snapshot_state: absent`; the endpoint response preserves the strict no-match reason and no Council event/matter. |

The desktop and mobile captures are `strict_matter_join-*`,
`multi_matter_join-*`, and `no_matter_join-*`.

## Community Board source, map, and detail surfaces

The source directory at `/community-boards/` is generated by
`site/community-board-scorecard.mjs`. It is map-first, presents 59 selectable
community-district boundaries, and exposes an official source inventory with
meeting/calendar and minutes/records coverage states. The selected-board panel
provides the source-backed homepage, upcoming meetings, minutes/records, committee
directory, roster, and bylaw source states. `community_board_meeting_index.json`
retains source receipts for the bounded board meeting read model; unjoined records do
not become official graph edges.

The detail surfaces are generated Community Board documents under
`site/community-boards/<board-id>/`. The selected fixture classes are:

- `manhattan-cb-06`: source-backed public committee-member semantics. The committed
  `site/data/community_board_people.json` records Michael Cohen as
  `public_committee_member` for the board-local Transportation committee, sourced to
  `https://cbsix.org/about-us/board-members-and-staff/` with publisher document ID
  `cb6-board-members-and-staff-2026-08-25`.
- `manhattan-cb-02`: deliberately unknown bylaw participation evidence. Its current
  bylaw version records `public_committee_member_eligibility: yes`,
  `public_committee_member_voting: source_does_not_establish`, and public
  participation `yes`; the unknown voting fact is not inferred from another board.

These IDs are stable because they are canonical board identities in
`community_board_constellation_lookup.json`, not display-name matches. The captures
are `cb_source_backed-*`, `cb_unknown-*`, and `cb-source-map-*`.

## Bylaw participation evidence

`site/data/community_board_bylaws.json` is schema
`cityscroll.community_board_bylaw_source.v1`, observed 2026-08-27. Its policy sets
`unknown_answer: source_does_not_establish` and `cross_board_inference: false`.
It retains superseded Manhattan CB6 versions (`2020` and `2023-03-08`) as well as
current Queens CB6 and Manhattan CB2 versions. `site/community_board_bylaws.mjs`
resolves only a board-local current version for a current answer; it does not copy an
eligibility or voting rule across boards.

## Registered ontology seams

Relevant registrations in `ontology/registry.v0.json` are:

- `watch`: kinetic object backed by subscription/action-log records.
- `meeting`: semantic object with source-qualified identity
  `meeting:{source_system}:{source_key}`; title/date identity is not sufficient.
- `matter`: semantic object keyed by `matter:{legistar_id}`, backed by the meeting
  outcomes and Legistar lookup projections.
- `community-board`, `community-board-committee`, and `community-board-person`:
  board-local/geographic or source-qualified identities with separate committee and
  person semantics.
- `bylaw-version`: board-local, source-qualified version with explicit
  `source_does_not_establish` handling and cross-board inference forbidden.
- registered rule events: `proposal_published`, `public_hearing`, `comment_close`,
  `adoption`, and `effective`; registered meeting events include `council_event`,
  `agenda_item_action`, and `roll_call_vote`.
- registered reader-action vocabulary and watch lifecycle methods match the action
  registry inventory above. `rule`, `agenda_item`, and `vote` remain partial or
  unregistered semantic gaps rather than silently minted first-class identities.

## DOT City-Owned Bicycle Racks canary

This is the sixth fixture class requested by the steering addendum. Retained
City Record identifiers are:

- proposal/hearing notice: `20260317026`, title `DOT Proposed Rules Relating to
  City-Owned Bicycle Racks`, proposal date 2026-03-25, public hearing
  2026-04-24 10:00.
- adoption notice: `20260706041`, title `Notice of Adoption: City-Owned Bicycle
  Racks`, adoption date 2026-07-14, effective date 2026-08-13.
- source receipt: `site/data/rules_sources/verification_receipts/rulemaking_sibling_stitch_2026-08-02.json`,
  field case `bicycle_racks_proposal_adoption`, which records the two-notice
  `title_agency_window` stitch as genuine and distinct from the FHV parking sample.

The current Rules activity capture is `dot-bicycle-racks-rules-*`; the current
notice-level lifecycle capture is `dot-bicycle-racks-lifecycle-*`.

Measured current presentation on the captured adoption notice (`20260706041`):

- the notice page labels the current stage `Adoption`, dates it as since July 14,
  2026, and says `Next: Effective`;
- `Same rulemaking` reports two City Record notices and links the proposal as
  `Public hearing · March 25, 2026`;
- the visible phase control is `PROPOSE → PUBLIC → ADOPT → EFFECT`, with `ADOPT`
  current;
- the expanded lifecycle shows one milestone, `Adoption published July 14, 2026`;
- earlier phases are behind the `Earlier phases` disclosure, so proposal/hearing and
  comment-close detail are not simultaneously visible in the default expanded panel;
- the Rules activity list labels the adoption notice `Adoption` and the proposal as
  `Public process`.

The captured Rules read-model payload was shaped from the current service response
(`schema_version: 7`, generated 2026-08-16). That response retains the adoption
notice as `stage: comment-closed` with an NYC Rules URL titled `Citywide Truck
Routes`, while the notice-level stitched renderer presents the City Record adoption
role as `Adoption`. This is a material before-state seam: the source payload and the
visible notice classifier disagree, and the payload's NYC Rules enrichment is not a
City-Owned Bicycle Racks page. The receipt preserves this discrepancy for the
future canary; it does not normalize it.

The implementation seams behind that rendering are `worker/src/lib/rules.mjs`,
`site/rules_phase_spine.mjs`, and `site/app/rules.mjs`. The derived event vocabulary
is:

| Derived event | Current source field / behavior |
| --- | --- |
| `proposal_published` | NYC Rules `pubDate` when a Rules entry joins; otherwise the City Record proposal row is retained but does not manufacture an NYC Rules proposal event. |
| `public_hearing` | `hearing_date` or the City Record `event_date`; date precision and source URL are retained. |
| `comment_close` | NYC Rules `comment_by_date`; it can carry alert eligibility and lead days. |
| `adoption` | `adoption_published_at`, or the adopted City Record notice when the stitched rulemaking identifies the adoption role. |
| `effective` | `effective_date` / the retained publisher effective-date field; it is scheduled or occurred according to the snapshot clock. |

For this bicycle-rack capture, the visible current event is `adoption` (one
milestone, July 14). `proposal_published`, `public_hearing`, and `comment_close` are
not expanded as separate event cards in the default notice view; the proposal is
represented in the two-notice same-rulemaking block, and the phase control leaves
`PUBLIC` and `EFFECT` as non-current phases. No `effective` event is currently
rendered; the current next-step label is `Effective`. The Rules list separately
shows the proposal as `Public process` and the adoption notice as `Adoption`.

The classifier states are `proposed`, `comment-open`, `hearing`, `comment-closed`,
`adopted`, and `effective`; the process filter groups them into Proposal, Public
process, Adoption, Effective, and Unstaged. The addendum checkpoints therefore map
to `hearing`/`comment-open` at T1 (before Apr 24), `adopted` at T2 (after Jul 14),
and `effective` at T3 (after Aug 13) when the retained rule facts contain those
dates. The captured current adoption notice is the T2-style presentation: adoption
current, effective next.

The source-backed canary must preserve the two City Record request IDs and the
`title_agency_window` sibling evidence. It must not claim that a resident comment
caused the rule change.

## Verification and environment notes

The required focused tests are:

- `node --test test/calendar_contract.test.mjs`
- `node --test test/action-rail.test.mjs`

Known machine-level non-blockers remain `home.cold` performance smoke,
`capture_qr_share` timeout, and the source-health gate with its deterministic fix in
flight. They are not pursued here; GitHub CI is authoritative. The merge queue is
draining an existing backlog, so this change waits its turn.

## Source fingerprints

| Source | SHA-256 |
| --- | --- |
| `site/action_registry.js` | `5ba6a9a10b0c59102c47ee17174ce0654d40d455de3a706f442f50b0503a7453` |
| `worker/src/feed.mjs` | `d3817b58b7b6bac933f023849346fc4c4e215318f3b7636d1f7b741aefd30d88` |
| `docs/calendar-contract.md` | `5e72a5800ed1748c2e0ed359f604df8493c36739f8c0ab162952e8a136572de6` |
| `worker/src/hearings.mjs` | `e2062c5a8a00888af88f92f512f9d8ee39484b6e479885b35f8dfbb6d326d60b` |
| `worker/src/lib/meeting_outcomes.mjs` | `4a763ed403ae3f97720d63b83f76c416d7e51d2838bc24ce0b50adbd6cfdda07` |
| `site/data/community_board_bylaws.json` | `b3b39d415e205593e3588f619da63e120a784f059dc6567f19d079aa65b281` |
| `ontology/registry.v0.json` | `542920273432118f2d7633ace87d045426d4a6b7e170a93e85648d391f72d641` |
