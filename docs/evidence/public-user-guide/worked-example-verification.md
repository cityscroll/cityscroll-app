# Public guide: worked-example verification for the advanced articles

[`example-selection-records.md`](example-selection-records.md) settled which
example each article is taught with. This record settles the next question for
the five articles that teach connected duties, connection evidence, shareable
trails, dated filtering and collections: what a reader actually sees today when
they follow the steps, and which steps are limited or unavailable.

Every observation below was made against the public deploy at
`https://cityscroll.org` on **2026-09-05**. The repository revision and the
local usability run are recorded separately in
[`guide-release/capture-manifest.json`](guide-release/capture-manifest.json).

## Evidence classes

The classes are the ones
[`example-selection-records.md`](example-selection-records.md#evidence-classes)
defines. Two further labels are used here:

| Label | What it means |
| --- | --- |
| `mocked-mutation` | The step changes state on a server. It was exercised with a stand-in response instead, so nothing was written to the public deploy. The reader-facing result is recorded from that run. |
| `limitation` | The step does not do what a reader might reasonably expect. The article says so at the step rather than describing a success that does not happen. |

## T2 — a notice, the duty behind it, and the law

- **Routes:** `/notices/20260605008`, then `/mandates/64116-001`.
- **Evidence class:** `live-public-route`.
- **Observed:** the notice renders as *DSNY Final Rule re Implementation Dates
  for the Brooklyn North and Upper Manhattan Commercial Waste Zones*, with a
  **Connected mandate** block naming the duty, the relation *Rules filing for
  this duty*, the citation *New York City Charter § 753(e)(2)*, the agency
  *Sanitation*, a **Source law** link to the item on the Council's legislation
  site, and a **Watch this mandate** link into Following. The mandate document is
  a 2.5 KB static page with no script at all: it carries Subject, Required
  action, Recurrence and Citation, a Legal provision section, and a
  **Publication evidence** section listing the notice the reader arrived from.
- **Without JavaScript:** both pages hold. The Connected mandate block is present
  in the notice document as served, before any script runs. Only the Following
  handoff at the end needs script, and the article says so at that step.
- **Boundary carried into the prose:** the connection is drawn by CityScroll from
  published records rather than certified by the agency, and a filing existing is
  not a finding that the duty was met. The article separates duty, publication,
  connection and compliance explicitly.

## T3 — a two-step trail from an agency to an award

- **Routes:** `/agencies/homeless-services/`, an organization page reached from
  it, and the finished two-hop walk resolved from the
  `graph-walk-agency-vendor-award` entry in `site/demo/demo-links.json`.
- **Evidence class:** `live-public-route`.
- **Observed, building the trail by hand:** clicking an organization in the
  agency's connected records took the reader to that organization's page, added
  a one-step trail reading *Department of Homeless Services · published by agency
  · <organization>*, and wrote a `walk=` value into the address. The trail
  carries a back control (*Back one step*) and a restart control (*Restart at
  origin*).
- **Observed, on the finished example:** the award notice renders with a
  two-hop trail — *Homeless Services · awarded to · Housing Options & Geriatric
  Association Resources · received award · Shelter services award* — and
  `data-traversal-hop-count="2"`. Pasting the same address into a fresh browser
  tab with no click history rebuilt the identical trail, which is the property
  the article teaches.
- **`limitation`:** the trail is not carried by every link. Following an award
  from an organization's record list uses a fragment route that forwards to the
  notice's own document; the forwarding allowlist for a notice document does not
  include the walk parameter, so the trail is dropped and the destination arrives
  with `legacy=unsupported-filter` and a zero-hop trail. Reproduced twice. The
  article does not claim the click path completes the two hops: it teaches the
  step that works, tells the reader the address bar is how they can tell which
  happened, and hands them the finished trail as a link. The forwarding
  allowlist belongs to `site/route_migration.mjs`, which is not this change's
  owner.
- **Boundary carried into the prose:** the two hops are two separate joins, and
  the organization named on an award is the awardee. The article states plainly
  that this is not an open subcontract opportunity, not an invitation to bid, and
  not a contact route for work.

## H6 — the receipt behind one connection

- **Route:** `/agencies/parks-and-recreation/?claim=rules%3Anotice%3A20260521021`.
- **Evidence class:** `live-public-route`.
- **Observed:** the panel headed **Connection evidence** opens already expanded
  and carries the record at the other end (*Update to Parks List of Qualifying
  Documents for Disability Membership Fee*), the warrant *Matched by a published
  record*, the one-sentence method *Matched to the agency's published name.*, an
  as-of stamp, a **How this connection was made** block whose Relation reads
  `issued rule`, the official **City Record notice** link, and **Copy link to
  this connection**, whose address is the page plus the claim identifier. The
  page carried 29 controls that open a connection this way, announced to a screen
  reader as *View connection details*.
- **`limitation` (missing evidence):** the contract connections on the same page
  carry no official source link. Six were sampled; each read *Matched from the
  precomputed PASSPort contract graph* with a relation and an as-of stamp and no
  City Record link, because the link was not read from a single published notice.
  The article describes this as the honest state and sends the reader to the
  record at the other end for its own source.
- **`limitation` (unknown claim):** an address carrying a claim identifier the
  page does not hold leaves the Connection evidence panel hidden and the rest of
  the page working. The article says so rather than implying a failure.
- **Requires script:** the panel is mounted in the browser. The agency document
  as served carries the client but not the panel, so with JavaScript off the
  records still read and the panel does not appear. The article says so before
  the first step.

## H7 — dated records as of a day

- **Routes:** `/agencies/parks-and-recreation/`,
  `/agencies/parks-and-recreation/?as_of=2024-06-01`, and the same page at
  `?as_of=1995-01-01`.
- **Evidence class:** `live-public-route`.
- **Observed, unfiltered:** the **As of day** panel reads *Pick a day to keep
  only records published or dated on or before that day*, and the Clear control
  is hidden.
- **Observed, filtered to 2024-06-01:** the date field holds the day, the
  comparison line reads *2 of 37 dated records on or before 2024-06-01 · 23
  later*, a **Later records** disclosure lists what was set aside, and Clear is
  visible and points back at the unfiltered page.
- **Observed, filtered to 1995-01-01:** the line reads *0 of 37 dated records on
  or before 1995-01-01 · 25 later* and the connected sections come back empty.
  This is the empty case the article uses, and it reads as an answer rather than
  as a failure.
- **`limitation` (undated records):** the filter compares each record's own date
  — the event date, or the publication date when there is no event date. A record
  carrying neither cannot be placed and is not kept, which is why the counts do
  not add up to the whole page. The article states this rather than leaving the
  arithmetic to look broken.
- **`limitation` (not a reconstruction):** the filter is on when things happened
  or were published, not on when CityScroll learned of them, and the counts
  describe what is linked now. The article says explicitly that this is not a
  reconstruction of what the site knew on that day and points a reader who needs
  that to a web archive.
- **Requires script:** the panel is present in the agency document as served,
  including its GET form, but the filtering is applied in the browser. Requesting
  `?as_of=2024-06-01` with no script returns the same idle panel. The article
  says so before the first step rather than implying a working no-script path.

## H8 — collecting, annotating, exporting and sharing

- **Routes:** `/notices/20231222103`, the organization page for Housing Options
  & Geriatric Association Resources, and `/#investigation`.
- **Evidence class:** `live-public-route` for pinning, annotating and exporting;
  `mocked-mutation` for sharing.
- **Observed, empty:** the workspace renders *Investigation workspace · stored
  only in this browser*, *0 pinned items*, the instruction to find a record and
  use its Pin control, and a line naming the outputs that appear once something
  is pinned. No action buttons are offered on an empty collection.
- **Observed, with two records:** pinning the award notice replaced the Pin
  control with *✓ Pinned — open investigation (1)*; pinning the organization made
  it two. The workspace listed both with the day each was pinned, a note field
  prompting *add a note…*, and the buttons **Share read-only link**, **Freeze
  research package**, **Export .csv**, **Export .json**, **Print dossier** and
  **Clear all**.
- **Observed, exports:** the CSV downloaded as `investigation.csv` with a row per
  record carrying type, title, summary line, the note, the day pinned and a
  permalink; the JSON downloaded as `investigation.json` with the same list plus
  the investigation's name and start date.
- **Observed, sharing (`mocked-mutation`):** the upload request was intercepted
  and answered with a stand-in identifier, so nothing was written to the public
  deploy. The request body carried the pinned records **including the note**, and
  the interface returned *Read-only link (lives 90 days)* with a link and a copy
  control. Opening that link with a stand-in snapshot rendered *Shared
  investigation · read-only · snapshot of <date>* with the note shown as text, no
  note fields, no delete controls, and one action: *Import into my
  investigation*. The article states that notes leave the device on sharing and
  that the link carries no password.
- **Observed, sync:** an anonymous request to the pins endpoint answered
  `{"ok":true,"recognized":false}`, so a signed-out visitor's pins are not kept
  server-side. Server-side syncing applies to a session CityScroll recognizes
  from one of its own email links. The article distinguishes device storage,
  that recognized session, a downloaded file and a shared snapshot as four
  separate places.
- **`limitation` (freeze):** **Freeze research package** refused an ordinary
  pinned set, answering *Add an admitted comparison to this investigation before
  freezing a package.* It is not the general export, and the article says so and
  sends the reader to the CSV or JSON export instead.
- **Observed, clearing:** **Clear all** emptied the collection with no
  confirmation step and returned the empty state above. The article warns about
  this.
- **Observed defect, not fixed here:** the permalink column of the CSV export
  joins the site origin to the record path with a doubled slash. It resolves, and
  it belongs to the export owner rather than to the guide, so the article
  describes the column without quoting the URL.
- **Requires script:** pinning and the workspace are drawn in the browser. The
  article says so before the first step.

## Reproduction

The manifest contract for the four demo entries these articles depend on:

```sh
python3 test/standards/demo_links.py
```

The live check of those entries against the public deploy:

```sh
CROL_BASE=https://cityscroll.org \
CROL_DEMO_LINK_IDS=notice-sanitation-connected-mandate,agency-parks-connection-evidence,graph-walk-agency-vendor-award,civic-time-ledger-as-of,agency-parks-mandates-rules,agency-parks-mandates-reports,agency-parks-mandates-predictions \
  python3 test/functional/20_demo_links.py
```

Observed on 2026-09-05: seven of seven passed.

The focused contracts under the behaviour these articles describe:

```sh
node --test test/civic_time_ledger.test.mjs test/graph_edge_provenance.test.mjs \
  test/contextual_ux_empty_investigation.test.mjs
```

The published articles themselves, which need no network:

```sh
node tools/build_guide_documents.mjs --check
node --test test/guide_documents.test.mjs
python3 test/standards/guide_content.py
python3 tools/capture_guide_release.py
```

The remaining observations above — building a trail by clicking, the dropped
walk parameter, the unsourced contract connections, the unknown claim
identifier, the empty as-of day, and the whole collection journey with a stand-in
share response — were made by driving the public deploy in a headless browser.
They are recorded here rather than as a committed check, because a required gate
must not depend on a rolling publisher record still being in the window.

## Correction to the earlier acceptance claims — 2026-09-08

This addendum corrects the interpretation of the evidence for the
[advanced-article delivery](https://github.com/cityscroll/cityscroll-app/pull/1720).
The dated observations and historical delivery receipts above remain intact.
A rendered destination, a link inventory, and a completed user journey prove
different things. The following statuses apply to the claims made from that
earlier evidence; they do not certify the later integrated guide revision.

| Earlier claim | What its cited evidence establishes | Corrected status |
| --- | --- | --- |
| A1: all five lessons teach a repeatable method; the award lesson reconstructs the trail | The T3 observation explicitly records the second-hop failure. Opening a supplied two-hop address proves rendering and replay, not creation by following the lesson. The delivery contains five advanced articles; the receipt's description of three articles is incomplete. | Contradicted for trail creation in the earlier delivery. New route-repair observations belong in the separate award-trail record; they cannot retrospectively validate the old click path or certify every revised lesson. |
| A2: duty, publication, a joined observation and compliance remain distinct; an awardee is not an open subcontract opportunity | The field-name test checks vocabulary only. The T2 and T3 boundary observations above and the articles' actual statements provide the substantive evidence: publication is not compliance, and an awardee is not an invitation to bid. | Supported by the cited article passages and dated observations, not by the vocabulary test. No new compliance finding or opportunity is inferred. |
| A3: dated filtering does not reconstruct everything the site knew on that day | H7 directly records unfiltered, filtered and empty results, explains the record-date basis, and expressly denies a reconstruction of historical site knowledge. | Supported within that dated observation's scope. It does not prove a system-history query or current record counts. |
| A4: browser storage, sync, downloads and sharing are distinct; mutations use disposable or mocked state | H8 records local pins, downloaded CSV/JSON and a mocked share response/read-only snapshot. The anonymous pins response establishes only that the visitor was unrecognized. | Supported for the local, export and mocked-share observations. Recognized-session server sync and deployed share persistence were not exercised and remain unproven by this receipt. |
| A5: positive, missing-evidence, undated and empty-collection cases were replayed | The guide's empty-section test renders an empty article category, not an investigation. H6 directly records missing/unknown connection evidence and H8 directly records an empty workspace. H7 explains undated exclusions but does not retain a separate undated-record replay. | Supported for the dated positive, missing-evidence and empty-workspace observations. The empty-section test provides no collection coverage; a separate undated-case replay is not established. |
| A6: every lesson returns to the actual product destination | The guide-home link test checks incoming article links. The product-access capture checks one housing tutorial/explanation route; it does not exercise all five advanced lessons' return links, task state or return position. | Not established. Direct return-to-product acceptance remains open until the relevant lesson journeys are followed. |

The bounded navigation repair is tracked by alias `ccf422a8ff4de`. Its A4 and A7
remain open for integrated acceptance after the related guide changes. This
addendum changes no historical receipt and does not substitute weekly upkeep,
text checks, or a guide-home link test for a completed resident journey.

## Award trail repair: direct method verification

The candidate at `760e182c7` repairs three connected failures: the vendor's
record links did not opt into traversal, notice forwarding discarded the walk,
and a fresh notice load could leave the restored trail inside a hidden initial
pane. The notice allowlist now accepts one valid, non-empty walk; malformed,
oversized, unsupported and duplicate walk payloads remain rejected. Back removes
one hop, and Restart returns to the agency without a walk.

The [capture manifest](award-trail/capture-manifest.json) records the exact
before/after addresses, public source-query URLs and response hashes, module
hashes, viewports, assertions and image hashes. Images remain outside Git.
This is **local candidate evidence using snapshotted public reads**, not a
deployment receipt. The records come from the City's City Record dataset
`dg92-zbpx`; acquisition is explicit and separate from browser replay. No
prepared walk token is an input to either create-a-trail journey.

| Chain | Vendor selected under Connected records | Award selected under On the record → Show all dates |
| --- | --- | --- |
| First | LANTERN COMMUNITY SERVICES INC | Integrated Commercial Hotels Program, notice 20260729015 |
| Second | VOLUNTEERS OF AMERICA GREATER NEW YORK INC | Integrated Commercial Hotels Program, notice 20260729014 |

Both begin at [Homeless Services](https://cityscroll.org/agencies/homeless-services/).
Click the named vendor, expand **Show all dates** under **On the record**, then
click the named award. Copy the complete browser address and paste it into a
fresh browser session. Each result visibly restores two hops. The first hop's
label is **published by agency**; the second uses the notice's translated type,
**Award** in English. The vendor connection and the award are separate joins.

| Acceptance for alias ccf422a8ff4de | Direct evidence and boundary |
| --- | --- |
| A1 | Both real chains were created by clicks, forwarded to notice documents, and reopened in fresh browser contexts at 390×844 and 1440×900. Back restored one hop; Restart cleared the trail at the agency. |
| A2 | The second vendor and distinct award repeat the same controls. The copied address is captured only after the second click; the demo's prebuilt address is never supplied. |
| A3 | The correction table above reviews all six earlier claims without deleting their historical receipts. |
| A5 | Public acquisition uses GET only. Browser replay uses isolated contexts and recorded public read models; all outbound mutations are intercepted. An unknown connection keeps its mounted evidence panel hidden, and a fresh investigation shows zero pinned items. |
| A6 | Frozen synthetic route/link/hydration tests are independent of the manual real-record observation tool. Named live awards are not required by deployment gates. |
| A4 and A7 | Open for integrated acceptance of the revised guide. The concurrent article revision owns tutorial prose; this repair changes no article prose and certifies neither all revised journeys nor language/illustration parity. |

Reproduction (each focused test and capture command completed with exit 0):

```sh
node --test test/guide_documents.test.mjs test/guide_contextual_access.test.mjs test/route_migration.test.mjs
node --test test/award_trail_navigation.test.mjs test/traversal_path.test.mjs
node --test test/no_live_external_reads.test.mjs test/notice_cold_path.test.mjs test/url_migration_map.test.mjs
node tools/build_primary_documents.mjs
node tools/build_agency_constellation_documents.mjs
node tools/build_public_site.mjs --source-dir . --site-dir _site
python3 tools/capture_guide_product_access.py --manifest "$PWD/docs/evidence/public-user-guide/award-trail/guide-product-access.json"
python3 tools/capture_award_trail.py --acquire
python3 tools/capture_award_trail.py
```

Use a full checkout, Python Playwright and Chromium. The capture tool documents
the acquisition/replay separation; a later absence of either example calls for
another observed chain, not a changed deterministic regression expectation.
The companion [product-access receipt](award-trail/guide-product-access.json)
retains its six rendered captures and eight reachability checks. Its one
housing tutorial/explanation journey is not proof of all advanced lessons.

Read-only public observation also found that the vendor-profile endpoint returned
`missing-index` and the vendor view eventually populated through its fallback.
That availability delay is separate from the navigation repair and is not
described here as a successful deployed route fix. No source-refresh, account,
subscription, email or public API capability behavior changed.
