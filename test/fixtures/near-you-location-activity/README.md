# Near You location frozen district-activity

Pinned `district_activity.json` for `test/functional/32_near_you_location.py`.

`test/default_local_home_journey.test.mjs`'s own "discovery-recovery"
`FROZEN_ACTIVITY_BLOB` pins a separate, independent historical blob via
`git cat-file` (its local-capture proof is bound to a merge-base-clean
`site/data`, so it cannot be recaptured on a refresh branch); it does not need
to match this file and editing one does not require editing the other.

The functional browser shard uses a shallow checkout that does not carry historical
git blobs. Serving this committed file keeps citywide / virtual / unlocated bags
stable across daily first-class refresh without `git cat-file`.

- Base source: `site/data/district_activity.json` as of revision
  `d886b385d647f4534df985f5922749a9414fab26` (2026-09-26)
- Git blob id: `e912a2bd1b0bf892bf0f859f9e2cf049efb64cad`
- Same bytes as `git cat-file blob e912a2bd1b0bf892bf0f859f9e2cf049efb64cad`

## Keeping the one live meeting reference current

The snapshot's `citywide` bag depends on one real NYC Council committee
meeting still resolving against the live, continuously-refreshed
`site/data/shared_meeting_read_model.json` — unlike the rest of this frozen
day, that one record's identity is not allowed to go stale, because the
functional test navigates to its full `/meetings/<id>` page. A later
first-class refresh that moves the Council meeting corpus can age it out even
though nothing else in the snapshot changed (`test/functional/32_near_you_location.py`
then times out on `main[data-meeting-id]`).

The real `virtual` meeting collection has been empty in every daily refresh
checked from 2026-10-01 through 2026-11-06; this 2026-09-26 snapshot is the
only one in that window with any `virtual` content at all, so a wholesale
re-freeze from a current snapshot cannot satisfy both that and a live meeting
reference at once. Fix it with a surgical, single-record substitution instead
of re-freezing the whole file:

1. In `site/data/district_activity.json`, find a real, currently-live meeting
   with a `/meetings/<id>` route (any `meeting:nyc_legistar_events:*` record
   under `records.meetings` is a good source — pick one with a date well in
   the future, so it has headroom before the next swap).
2. In this committed fixture, find the stale record under the same key shape
   (`records.meetings["meeting:nyc_legistar_events:<old id>"]`), and the one
   list entry naming it elsewhere in `district_items`/`geography_items`/`by_level`.
3. Replace the stale key and the `id`/`route`/`source_url` fields (which all
   derive from the same numeric id) with the new real meeting's, and copy its
   real `title`, `date`, and `venue_address` verbatim. Keep the existing
   `basis: "Citywide"` / `confidence: "strong"` / `basis_method: "citywide"` /
   `placement_methods: ["citywide_phrase","citywide"]` / `place.*` shape as-is
   — do not copy the live record's own classification fields. (As of this
   writing, real legistar meetings at the same 250 Broadway committee rooms
   are being classified `"No place signal"` instead of `"Citywide"`, which
   looks like a separate placement-classifier gap worth its own investigation,
   not a reason this fixture can no longer name a citywide example.)
4. Verify with a script that a `JSON.parse` deep-equality diff between the old
   and new fixture shows only that one swapped record (plus the one list
   entry) changed — never hand-edit the minified bytes directly.
5. Update `FROZEN_ACTIVITY_BLOB` in `test/functional/32_near_you_location.py`
   and the blob id above to `git hash-object` of the new file.
