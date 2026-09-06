# Public guide: source checks for the explanations and reference

Every civic or procedural claim in the four explanations and three reference pages
was checked at publication, on **2026-09-06**, in one of two ways: the official
publisher's own page was loaded, or the product surface making the same claim was
loaded and read. Nothing was taken from a manual, a screenshot, or an earlier
description of how something used to work.

Two things this record deliberately is not. It is not a claim that these pages will
stay correct: that is what each article's own review date is for. And it is not a
substitute for the official source, which is linked from the article itself so a
reader can check it rather than take our word for it.

## Official publishers

| Source | Checked | Result |
| --- | --- | --- |
| The City Record Online — `a856-cityrecord.nyc.gov` | Loaded | 200. The city's own daily publication |
| City Record Online on NYC Open Data — `dg92-zbpx` | Loaded | 200 |
| Hearing testimony registration, NYC Council — `council.nyc.gov/testify/` | Loaded in a browser | 200, titled "Hearing Testimony Registration" |
| Legislation, NYC Council — `council.nyc.gov/legislation/` | Loaded | 200 |
| City Administrative Procedure Act, NYC Rules — `rules.cityofnewyork.us/capa/` | Loaded in a browser | 200, titled "City Administrative Procedure Act (CAPA)". An automated request without a browser is refused by the publisher, so this one is checked by loading it |
| Public hearings on proposed contracts, MOCS | Loaded | 200, and the page is about public hearings on proposed contracts |
| Public review of land-use applications, Department of City Planning | Loaded | 200, titled "Public Review". The link label was changed to match what the publisher calls the page |
| Zoning Application Portal — `zap.planning.nyc.gov` | Loaded | 200 |
| Take a civil-service exam, DCAS | Loaded | 200 |
| Open Contracting Partnership red-flags guide | Linked from About already; kept as the same citation | Unchanged owner |
| Opentender integrity indicators | Linked from About already; kept as the same citation | Unchanged owner |

## Product claims, checked against the live site

Every reader-facing label quoted in the reference pages was read off the live public
site rather than out of the source, which is what caught the two corrections below.

| Claim | Where it was checked | What was observed |
| --- | --- | --- |
| The result groups and their names | `/search/?q=housing` | Contracts, People + organizations, Land, Rules, Meetings, Exams, each with its own count. Results are marked as a title match, a summary match, or a match in the body |
| A watch is built and previewed before it starts | `/following/` | "Create a watch"; "Choosing a topic or place does not start a watch"; "Preview matches"; then "Create this watch" with an email address |
| A Community Board watch needs a borough and a number | `/following/` | "Choose a Community Board watch", with a borough select and a board-number select offering 1–18 |
| Watches are managed from the emails | `/following/` | "Your watches — Open a CityScroll email to see your watches" |
| Email frequency | `/following/` | Daily when there are matches, or a weekly digest that sends Monday |
| Deadlines are separated from events | `/now/` | An "Act by" section ahead of the events that follow |
| The calendar handoff appears only where there are dated events | `/now/` and `/browse/meetings/` | "Subscribe to calendar" is present but hidden on `/now/`, and visible on the meetings listing |
| A connection states its basis, relation and source | `/agencies/parks-and-recreation/?claim=rules%3Anotice%3A20260521021` | "Connection evidence"; "Matched by a published record"; "Matched to the agency's published name."; "How this connection was made"; relation "issued rule"; a City Record notice link; "Copy link to this connection" |
| The as-of filter and its controls | The same agency page | "As of day", an "As of" date field, Apply and Clear |
| A collection is held in the browser | `/#investigation` | "Investigation workspace · stored only in this browser"; "0 pinned items"; the Pin instruction; and the later outputs named but not offered — a read-only link, a frozen research package, a CSV or JSON export, a printed dossier. "Sharing uploads a read-only snapshot (90-day link). Nothing else ever leaves this browser." |
| A closed window is shown as closed | `/exams/7016/` | The Caseworker exam, application window 07/01/2026–07/21/2026, marked CLOSED, with the official apply and notice links still present |
| Follow this search leads to the watch builder | `/browse/meetings/` | The control opens `/following/` with the builder ready and nothing started |
| A listing explains public input beside the records | `/browse/meetings/` | A "How public input works" panel, and the distinction between a hearing and a meeting stated above the list |

## Two corrections this check produced

- The result group is labelled **People + organizations** on the live site. The first
  tutorial said "People and organizations" in two places. Both were corrected and the
  tutorial's review date moved, which is what a review date is for.
- The Following flow does not have a control called "Preview today's digest" or
  "Subscribe". The live controls are **Preview matches** and **Create watch**, and the
  reference page was rewritten to the labels a reader will actually see.

## Nothing was verified by enrolling

No watch was created, no email address was entered, no testimony was submitted and no
calendar subscription was started. Every check above is a read. The controls that
would change something were observed, described and left alone.

## Reproduction

The guide's own checks need no network:

```sh
node tools/build_guide_documents.mjs --check
node --test test/guide_documents.test.mjs
python3 test/standards/guide_content.py
python3 tools/capture_guide_release.py
```

The live checks in the table above are reads of the public routes named in it. The
seed examples with manifest ids have their own reproduction in
[`example-selection-records.md`](example-selection-records.md#reproduction).
