# Committees linked through shared members

A committee record already listed its own members. Seeing which other committees
those same people sit on meant opening each member in turn and reassembling the
connections by hand. This record holds the served evidence for the section that
answers it in place.

Regenerate with:

```sh
tools/prepare_functional_site.sh
node tools/render_committee_shared_members_fixtures.mjs
python3 tools/capture_committee_shared_members_evidence.py
```

The capture writes [`capture-manifest.json`](capture-manifest.json) and exits
non-zero if any assertion stops holding. No image binary is committed: each entry
carries the route, the viewport, the repository revision, the source blobs, the
data vintage, the assertion, and the sha256 of the rendered scope.

## What the section is

The projection is the one already shipped for a member's own profile, read from
the other end. Two committees are connected when a person the publisher records
on both holds those two memberships over days that meet.
[`site/committee_coservice.mjs`](../../../site/committee_coservice.mjs) answers
both questions from one observation reader, one repeated-row collapse and one
interval intersection, so a count shown on a member's profile cannot disagree
with the count shown on a committee record.

Three properties carry over unchanged, and each has both a test and a capture:

- **The as-of day is an argument, never a clock.** The committee record passes
  the committee snapshot's own vintage day. A snapshot cannot answer for a day it
  never observed.
- **A person is counted once.** The publisher can repeat a person/body row; a
  repeated observation is one shared member, not two.
- **Caucuses are never a committee connection.** They reach the reader through
  the same office-record family, so they arrive as bodies. None is listed as a
  linked committee, and a caucus record borrows no committees from its own
  roster.

A shared roster is a roster fact. It says that the same people are recorded on
two bodies over overlapping days, and nothing about attendance, agreement or
influence. The copy does not either, and there is no score.

## Measurements

All figures come from the committed committee graph
(`site/data/committee_graph_lookup.json`, generated `2026-09-06T15:47:21Z`) and
are reproduced by `test/existing_connections_committee.test.mjs`.

| Measure | Value |
| --- | --- |
| Committee records the graph publishes | 96 |
| Committee records that render a connections section | 44 |
| Committee records that render none | 52 |
| Members of `/committees/5309/` covering 2026-09-06 | 6 |
| Committees linked to it | 22 (8 open, 14 behind the disclosure) |
| Officials with a committee membership covering that day | 24 |
| Caucus bodies its members share, held out of the count | 6 |

These are counts of the represented records at that vintage. They are not a count
of every member of every City Council committee, and a committee reached by no
represented member is absent rather than shown as zero.

## Worked example, and the controls beside it

On 2026-09-06, `/committees/5309/` (Subcommittee on Landmarks, Public Sitings,
Resiliency and Dispositions) links to 22 committees: two share three of its
members, six share two, and fourteen share one. The eight with more than one:

| Linked committee | Shared members |
| --- | --- |
| [11](https://cityscroll.org/committees/11/) Committee on Finance | Christopher Marte, Alexa Avilés, Oswald J. Feliz |
| [19](https://cityscroll.org/committees/19/) Committee on Public Safety | Sandy Nurse, Kamillah Hanks, Oswald J. Feliz |
| [5235](https://cityscroll.org/committees/5235/) Committee on Civil and Human Rights | Sandy Nurse, Oswald J. Feliz |
| [5269](https://cityscroll.org/committees/5269/) Committee on Consumer and Worker Protection | Chi A. Ossé, Kamillah Hanks |
| [12](https://cityscroll.org/committees/12/) Committee on General Welfare | Sandy Nurse, Alexa Avilés |
| [5119](https://cityscroll.org/committees/5119/) Committee on Immigration | Alexa Avilés, Kamillah Hanks |
| [5106](https://cityscroll.org/committees/5106/) Committee on Parks and Recreation | Christopher Marte, Sandy Nurse |
| [5212](https://cityscroll.org/committees/5212/) Committee on Public Housing | Christopher Marte, Chi A. Ossé |

Each expands in place to those people, both of their recorded roles, and the days
both memberships cover — 2026-01-15 to 2029-12-31 for every row above, which are
the source term bounds rather than a promise about future service. Elsewhere in
the same list a member joined later, and the row carries that later start rather
than the committee's.

The connection is reciprocal by construction:
[`/committees/5106/`](https://cityscroll.org/committees/5106/) names Marte and
Nurse as its shared members with the subcommittee, with the two roles swapped.

Three controls sit beside it:

- **Dates.** One member, two other bodies whose recorded terms sit either side of
  a single day: Gale A. Brewer's service on Oversight and Investigations ends
  2009-03-24 and on Transportation begins 2009-03-25. Asked about 2009-03-01 the
  Committee on Aging reaches the first and not the second; asked about
  2009-04-01, the reverse. Neither is reachable at the 2026 vintage.
- **Repetition.** Duplicating a publisher row for a member on both bodies leaves
  the shared-member count unchanged.
- **Caucuses.** The subcommittee's members share six caucus bodies on that day.
  None appears among the 22, and the caucus record itself renders no section.

## Captures

| Entry | What it holds |
| --- | --- |
| `desktop-committee-connections` / `narrow-committee-connections` | The record names 22 linked committees with the distinct-people count on each, lists no caucus among them, ships no script, and does not scroll sideways. Both viewports render the same section markup: their render digests are equal. |
| `desktop-expansions-open` | Finance, Public Safety, Parks and General Welfare each expand in place to their named people, both roles and the overlapping days, every name linking to that person's own record, and every revealed link focusable. |
| `desktop-walk-committee-back` | Opening an expansion, following the linked committee, and pressing Back returns to the originating record with the same expansion still open. |
| `desktop-walk-official-back` | The same walk through a shared member's own record. |
| `narrow-reciprocal-committee` | The Parks record identifies the same two members as shared with the subcommittee, at a narrow viewport. |
| `narrow-no-javascript` | With scripting unavailable the section lists every linked committee and the URL still opens one of them onto its three named people. Its render digest equals the scripted capture's. |
| `negative-historical-roster` | A committee whose recorded roster is entirely historical at this vintage keeps every membership period and renders no section at all — not an empty one, and not a zero. |
| `negative-caucus` | A caucus record renders no connections section. |
| `negative-failed-load` | A committee whose own graph asset cannot be read answers plainly and paints no partial section. |

`/committees/:id/` is produced by the Pages edge worker, not by the static
server. `tools/render_committee_shared_members_fixtures.mjs` runs that handler
against the committed data and writes its own responses at the routes they
answer, so the walk between two committee records in these captures is a real
navigation over the real served bodies.

## Why the expansion lives in the URL

A history entry carries the URL and the scroll offset, not element state, so a
`<details>` disclosure comes back closed when a reader walks out to a record and
presses Back. The expansion here is a `:target` disclosure instead: an `id` on
each row, an anchor that opens it and an anchor back to the section that closes
it, with the visibility rules in
[`site/civic-documents.css`](../../../site/civic-documents.css). It needs no
script, keeps modified-click and browser history working, and with the stylesheet
unavailable every shared member simply renders.
