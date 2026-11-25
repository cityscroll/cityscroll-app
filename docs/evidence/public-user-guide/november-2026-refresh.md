# Public guide: November 25, 2026 refresh

Every guide page was read against the public site on November 25, 2026, signed out, and corrected
where the site had moved on. This file records what each check reached, which official source it
compared against, and whether the copy changed. It is a dated observation, not a promise that the
records shown will stay the same: publisher data rolls, so a later reader may see different counts.

Checks used ordinary HTTP reads for server-rendered pages and a headless browser where a step needs
JavaScript. Nothing was submitted: no watch, email address, observation request, shared link or
research package was created.

## Evidence matrix

Outcome is **updated** when the article text changed after the check, and **verified** when the
check found nothing to change. Every page's review date moved to 2026-11-25 only after its check.

| Id | Page | Outcome | Destination reached | Official source checked | Checked |
| --- | --- | --- | --- | --- | --- |
| Home | `/guide/` | updated | `/guide/`, `/search/`, `/browse/`, `/following/`, About feedback form | None cited; orientation now points to Search, Browse and Following and says Demo and example pages are not public records | 2026-11-25 |
| T1 | `/guide/start/explore-housing-across-city-records/` | updated | `/search/?q=housing`, `/agencies/housing-preservation-and-development/`, `/browse/rules/?q=housing`, `/notices/20260714002` | The City Record notice 20260714002, a CPC proposed-rule hearing notice | 2026-11-25 |
| T2 | `/guide/start/trace-a-notice-to-the-duty-behind-it/` | updated | `/notices/20260605008`, `/mandates/64116-001/`, `/notices/20210727108`, the Following page Watch this mandate opens | The City Record notice 20260605008; Council file for Local Law 199 of 2019 via Source law | 2026-11-25 |
| T3 | `/guide/start/trace-an-award-and-keep-the-trail/` | updated | `/agencies/homeless-services/` → vendor profile → `/notices/20260729015` with the trail kept in the address | The City Record notice 20260729015, Solicitation Awarded, Homeless Services; Checkbook NYC | 2026-11-25 |
| H1 | `/guide/how-to/find-and-narrow-records/` | updated | `/search/?q=housing`, `/browse/meetings/` with filters kept in the address, `/exams/7016/` | DCAS Notice of Examination 7016 | 2026-11-25 |
| H2 | `/guide/how-to/follow-a-search/` | updated | `/following/` preview, starting points and Left-out records; invalid manage and watch links | None beyond the product; preview only, nothing saved | 2026-11-25 |
| H3 | `/guide/how-to/follow-a-community-board/` | verified | `/following/` Community Board preview for Manhattan 7, `/near-you/` current matches | `/community-boards/` official board calendar links | 2026-11-25 |
| H4 | `/guide/how-to/put-dates-in-your-calendar/` | verified | `/now/`, a meeting page Add to calendar file, `/browse/meetings/` Subscribe to calendar panel | The published meetings calendar feed | 2026-11-25 |
| H5 | `/guide/how-to/read-a-land-use-projects-next-step/` | updated | `/browse/zoning/` with Stage set to All, project 2022M0258 | Zoning Application Portal project 2022M0258, Timbale Terrace | 2026-11-25 |
| H6 | `/guide/how-to/check-the-evidence-behind-a-connection/` | updated | `/agencies/parks-and-recreation/` connection evidence and its `?claim=` link | The City Record notice 20260521021, Notice of Adoption, Parks and Recreation | 2026-11-25 |
| H7 | `/guide/how-to/look-at-records-as-of-a-day/` | updated | `/agencies/parks-and-recreation/?as_of=2024-06-01` and Clear | The City Record Online | 2026-11-25 |
| H8 | `/guide/how-to/collect-records-and-export-them/` | updated | `/notices/20231222103` More tools → Pin, the investigation workspace, .csv and .json exports | The City Record notice 20231222103 | 2026-11-25 |
| H9 | `/guide/how-to/read-a-budget-request-and-the-answer/` | updated | `/community-boards/brooklyn-cb-14/#budget-request-214202710c`, `#budget-request-214202727e`, `/agencies/transportation/#agency-budget-requests-brooklyn-cb-14` | OMB Register of Community Board Budget Requests, tracking codes 214202710C and 214202727E | 2026-11-25 |
| H10 | `/guide/how-to/observe-city-government/` | updated | `/observe/` cards and scheduled details | Public Design Commission meetings page; BSA upcoming hearing information; OATH, CCRB, Hart Island and DDC pages | 2026-11-25 |
| H11 | `/guide/how-to/request-trial-observation/` | updated | `/observe/` OATH scheduled detail with its copyable request | OATH conference and trial calendar and observer instructions; CCRB trial page | 2026-11-25 |
| E1 | `/guide/understand/what-a-public-record-tells-you/` | updated | `/browse/meetings/` public input panel, Following meetings topic | The City Record; Council testimony registration; CAPA; MOCS public hearings; DCP public review page | 2026-11-25 |
| E2 | `/guide/understand/how-records-are-connected/` | updated | `/agencies/transportation/?claim=…` connection evidence | PASSPort public contracts and The City Record, as named on each connection | 2026-11-25 |
| E3 | `/guide/understand/dates-and-missing-information/` | updated | `/agencies/transportation/?as_of=2026-09-01`, `/exams/6002/` | DCAS exam pages linked from the exam records | 2026-11-25 |
| E4 | `/guide/understand/flags-and-historical-patterns/` | updated | `/notices/20260727023` Context line; flag anchors on exam and land pages | Open Contracting Partnership red-flags guide | 2026-11-25 |
| R1 | `/guide/reference/glossary/` | updated | `/mandates/64116-001/`, a notice's View in City Record link, a vendor profile | DCAS civil-service exam application page | 2026-11-25 |
| R2 | `/guide/reference/controls-and-outputs/` | updated | `/search/`, `/browse/contracts/`, `/following/`, `/browse/meetings/` calendar panel, connection evidence, the investigation workspace | None beyond the product | 2026-11-25 |
| R3 | `/guide/reference/sources-and-coverage/` | updated | `/search/`, `/browse/`, `/following/`, `/near-you/`, `/stats.html`, `/api.html`, `/browse/contracts/`, `/community-boards/bronx-cb-01/#budget-request-101202708c` | OMB Register of Community Board Budget Requests, tracking code 101202708C; PASSPort public solicitations; the source ledger | 2026-11-25 |

## The sources and coverage page

The page keeps its route and every inbound link. It now opens with the reader's task, separates the
publisher's record from CityScroll's connections and from sample material, and keeps four dates
apart: publication date, record date, the date CityScroll last read a source, and the latest record
a publisher has released.

The `::: source-coverage` table is unchanged and still derived from
`site/data/source_contracts.json`, counting only sources whose `health_policy.public_visibility` is
`public`. On November 25, 2026 the registry held 76 contracts, 71 of them public, and the table
rendered those 71 as 19 as things happen, 43 on the publisher's schedule, 4 checked by a person, 4
closed sets and 1 pointer. The page states no count of its own.

### Worked example

Bronx Community Board 1, request 101202708C to the Department of Education, fiscal year 2027,
priority 01 among the board's capital requests to that agency:

- The CityScroll page shows two answers, published May 12, 2026 and June 30, 2026, both “Agency
  supports but cannot accommodate” with “FUNDING NOT AVAILABLE.”, and notes that the second reads the
  same as the first. Its source line reads “Read November 24, 2026.”
- The publisher's dataset (`vn4m-mk4t`) returns the same request text and the same two answers for
  publications 20260512 and 20260630. It also holds a row labelled with publication 20270217, which
  the CityScroll page does not show. The guide therefore tells readers that the published register is
  the place to confirm an answer, and does not count answers.
- `#board-budget-requests-education` and `#budget-request-101202708c` both land on a visible element
  at 390px and 1440px.
- Open solicitations are a separate record: `/browse/contracts/` opens on solicitations still
  accepting responses, and PASSPort's public solicitation browse page loads without signing in.

## Differences found between the plan and the live site

- The Start page's footer link to this page is labelled “Sources and coverage”, not “Data sources”.
  Start is outside this change, so the label was left alone.
- WinCityWork's pages are served outside the static site, and the guide's link check accepts only
  served guide routes, static-site routes and record documents. The guide therefore names
  WinCityWork's Demo view without linking it, and sends readers looking for open solicitations to
  `/browse/contracts/` and PASSPort instead. Route registration was not changed.
- The front page's search box now looks up places. Record search lives at `/search/`, and the
  housing tutorial now starts there.
- The Observe City Government page's PDC entry described the City Planning Commission. On
  CityScroll, PDC is the Public Design Commission, and the BSA calendar URL the guide linked now
  returns 404. Both sections and their tests were corrected.
- Some issues are in the product, not the guide, so the guide does not paper over them:
  - On the as-of view, the summary counts do not always add up.
  - The Clear control shows before a date is set.
  - A Rules search result for notice 20260929023 opens an empty Rules list.
  - The land-use stage summary reads “unknown” while its source materializations are stale.

## Languages

All eleven shipping languages render every refreshed page. A no-JavaScript sweep of all 242 guide
documents at 390px and 1440px, served from the built guide, made 484 reads: each returned the
expected language and direction (right-to-left for Arabic and Urdu), showed no sideways scrolling,
and leaked no translation placeholders. The sources and coverage page was also read in every
language with JavaScript on, at both widths.

Every new or changed segment has a machine-drafted translation in all ten non-English locales,
consistent with their recorded `machine-drafted` provenance. This change introduces no English
fallback.

The check also found an existing fault in nine locales (all except Spanish). A block of
explicit English-fallback entries added after the guide translations in September repeated about
780 keys that already had real translations, and because the later entry wins, those pages showed
English. Keys are hashes of the English source, so each earlier translation matches the current
text exactly. Only those shadowing duplicates were removed; the build's translation check still
validates every entry. Measured on this branch, the nine locales went from 831 of 903 guide
segments in English fallback to 58 of 904. The remaining 58 are the two observation how-tos and
their entries on the guide home, which never had a translation, and keep the existing explicit
fallback until they are translated. One of those entries showed a Spanish sentence in the other
nine locales; it now has a translation in each.

## Review cadence and the product-updates endpoint

[`review-cadence-handoff.md`](review-cadence-handoff.md) is unchanged. Its handoff contract and the
guide-review producer still pass `node tools/build_guide_review.mjs --check` with 21 articles, and
the `/product-updates.json` contracts in this repository were not touched.
