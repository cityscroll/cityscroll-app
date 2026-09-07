# Dated committee co-service on official profiles

A Council member's profile already listed that member's own committees. Reading
who else sat on those committees, and when, meant opening several profiles and
comparing date ranges by hand. This record holds the served evidence for the
section that answers it in place.

Regenerate with:

```sh
node tools/build_cloudflare_pages.mjs --site-dir _site
python3 tools/capture_official_colleagues.py
```

The capture writes [`capture-manifest.json`](capture-manifest.json) and exits
non-zero if any assertion stops holding. No image binary is committed: each entry
carries the route, the viewport, the repository revision, the source blobs, the
data vintage, the assertion, and the sha256 of the rendered scope.

## What the section is

Two members serve together on a body when both of their dated `member_of`
observations for the same publisher BodyId cover the same day. That is a roster
fact and nothing more: it does not describe attendance or agreement, and the
copy does not either.

Three properties are load-bearing, and each has both a test and a capture:

- **The as-of day is an argument, never a clock.** The projection in
  [`site/committee_coservice.mjs`](../../../site/committee_coservice.mjs)
  requires an explicit day, and the profile passes the committee snapshot's own
  vintage. A snapshot cannot answer for a day it never observed.
- **A body is counted once.** The publisher can repeat a person/body row; a
  repeated observation is one membership.
- **Caucuses are counted and labelled separately.** They reach the reader
  through the same office-record family, so they arrive as bodies, and they
  never enter the committee count.

## Measurements

All figures come from the committed committee graph
(`site/data/committee_graph_lookup.json`, generated `2026-08-12T14:37:51Z`) and
are reproduced by `test/existing_connections_colleagues.test.mjs` and by
`measureCommitteeCoServicePairs`.

| Measure | Value |
| --- | --- |
| Dated membership observations in the graph | 1,142 |
| Bodies in the graph | 96 |
| Officials with any membership observation | 30 |
| Officials with a committee membership covering 2026-08-12 | 24 |
| Pairs of those officials sharing at least one committee | 165 |
| Pairs sharing two or more committees | 60 |
| Colleagues shown on `/officials/7801/` | 17 (8 open, 9 in the disclosure) |

These are counts of the represented records at that vintage. They are not a
count of every member of every City Council committee.

## Worked example, and the control beside it

On 2026-08-12, `/officials/7801/` (Christopher Marte) and `/officials/7824/`
(Sandy Nurse) share two committees:

| Committee | Marte | Nurse | Both listed |
| --- | --- | --- | --- |
| [5309](https://cityscroll.org/committees/5309/) Subcommittee on Landmarks, Public Sitings, Resiliency and Dispositions | Chair (`CHAIRPERSON`) | Committee Member | 2026-01-15 – 2029-12-31 |
| [5106](https://cityscroll.org/committees/5106/) Committee on Parks and Recreation | Committee Member | Committee Member | 2026-01-15 – 2029-12-31 |

They also appear in three of the same caucuses. Those are listed under their own
label and are not part of the two.

The control is the Committee on Aging. Marte served on it from 2022-01-20 to
2023-12-31; Gale A. Brewer served on it from 2006-01-18 to 2009-12-31. Both facts
are published, and they are not service together. The `desktop-subject-profile`
capture records both halves of that at once: Aging appears in Marte's membership
history on the same page, and appears nowhere in the co-service section.

## Captures

| Entry | What it holds |
| --- | --- |
| `desktop-subject-profile` | The section names the colleague with both shared committees and the dates both were listed; every link in it resolves to `/officials/` or `/committees/`; Aging is in the membership history and not in co-service. |
| `keyboard-official-colleague-committee-back` | Tab reaches the colleague link with a visible focus ring, Enter opens their profile, the reciprocal section names the first member with the same two committees, the shared committee record lists both, and two Back steps return to the profile the walk started from. |
| `narrow-subject-profile` | At 390×844 the section renders byte-identical markup to the desktop capture and the document does not scroll sideways. |
| `negative-no-supported-rows` | A member whose published committee history does not cover the snapshot day renders no co-service section at all — not an empty one — and the rest of the profile is unaffected. |

The committee destination is rendered by the Pages edge worker in production and
is not served by the local static server. The capture produces those two
documents with the repository's own committee renderer and answers them into the
browser, and every entry names what served it in `served_by`.
