# Public guide: worked-example selection records

Eleven candidate examples were carried into this plan. Each record below fixes
the canonical route, says how the example was checked, and states the observable
result a reader can look for. All live checks in this document were run against
the public deploy on **2026-09-05** at the repository revision recorded in
[`capture-manifest.json`](capture-manifest.json).

## Evidence classes

| Class | What it certifies |
| --- | --- |
| `live-public-route` | The public route was loaded from the public deploy on the date given, and the stated observable was present. |
| `historical-record` | A real record whose original opportunity has closed. Its date and the observable are given; it teaches the method, not a current action. |
| `fixture-only` | Reproduced only against local fixtures. **This never certifies a live example** and cannot be published as an instruction without a live check first. |

A route's canonical form is resolved from the routing code or the shared demo
manifest, never retyped from prose. Encoded links are resolved from their
manifest entry.

## Records

### X1 — Topic search across typed lanes

- **Route:** `https://cityscroll.org/search/?q=housing`
- **Evidence class:** `live-public-route`
- **Observable result:** Six typed lanes render side by side rather than one
  flattened list: Contracts, People + organizations, Land, Rules, Meetings, and
  Exams. Result counts and the number of "Related because" passages differ per
  lane and change with the live corpus; at the time of checking the Rules lane
  carried one cited passage and the Meetings lane carried nine.
- **Selection note:** Usable for T1 and H1, with one constraint that must reach
  the prose: **the lesson cannot promise a fixed result count.** The teachable
  observable is that results stay grouped by civic object and that a cited
  passage explains why a result is related — not how many appear.
- **Check limitation:** The shared manifest check cannot certify this entry
  against the public deploy. Its browser harness aborts both the API host and
  the worker fallback host, and the typed lanes depend on those requests, so
  every lane renders "The latest CityScroll snapshot is unavailable" and the
  contract fails on a page that is in fact working. Reproduced below. This is a
  limitation of the check harness, not of the public route, and it belongs to
  the owner of `test/functional/assets/i18n_fixtures.py`. Until it is resolved,
  a guide article citing this example is verified by loading the route, not by
  that command.

### X2 — Notice to the mandate behind it

- **Route:** `https://cityscroll.org/notices/20260605008`
- **Evidence class:** `live-public-route`
- **Observable result:** A "Connected mandate" section links `/mandates/64116-001`,
  and a "Watch this mandate" control is present. No empty or loading state
  remains on the notice view.
- **Selection note:** Usable for T2 and E1. The prose must keep finding a
  publication distinct from establishing legal compliance.

### X3 — The evidence behind a connection

- **Route:** `https://cityscroll.org/agencies/parks-and-recreation/?claim=rules%3Anotice%3A20260521021`
- **Evidence class:** `live-public-route`
- **Observable result:** The connection inspector opens already expanded on
  "How this connection was made", names the relation ("issued rule"), and links
  the official City Record source. The claim stays in the URL, so the permalink
  is shareable.
- **Selection note:** Usable for H6 and E2.

### X4 — Dated records as of a day

- **Route:** `https://cityscroll.org/agencies/parks-and-recreation/?as_of=2024-06-01`
- **Evidence class:** `live-public-route`
- **Observable result:** An "As of day" control holds the value `2024-06-01`,
  a comparison line reports the dated records kept, and the page is the Parks
  and Recreation agency constellation rather than a generic entity view.
- **Selection note:** Usable for H7. The prose must describe the supported
  valid-time filtering and its limits, and must not promise a reconstruction of
  everything known on that date.

### X5 — A shareable two-hop walk

- **Route:** `https://cityscroll.org/notices/20231222103` with the encoded walk
  parameter resolved from the `graph-walk-agency-vendor-award` entry in
  `site/demo/demo-links.json`.
- **Evidence class:** `live-public-route`
- **Observable result:** The award notice renders with a two-hop trail from
  Homeless Services through the named awardee to the award, and the trail is
  reconstructed from the URL rather than from session state.
- **Selection note:** Usable for T3 and E2. The encoded parameter is long and
  must be resolved from the manifest, never retyped. A named awardee does not
  imply an open subcontract opportunity, and the prose must say so.

### X6 — Obligations, evidence, and expected events

- **Route:** `https://cityscroll.org/agencies/parks-and-recreation/`
- **Evidence class:** `live-public-route`
- **Observable result:** Three distinct sections render on one agency page:
  "Rulemaking mandates" joined to filings, "Report mandates" with filing
  receipts and a watch control, and "Expected mandate events" with its own watch
  control.
- **Selection note:** Usable for H7 and E4, and the clearest single place to
  show that an obligation, the evidence it was met, and an expected future event
  are three different things.

### X7 — A community board watch

- **Route:** `https://cityscroll.org/following/` → Create a watch
- **Evidence class:** `live-public-route`
- **Observable result:** A control labelled "Choose a Community Board watch"
  presents two selects — a borough and a board number offering all eighteen
  boards — so a borough-qualified board such as Manhattan Community Board 7 is
  selected in two steps. A separately named "City Council District weekly" watch
  set sits beside it, which is what keeps the two kinds of district from being
  confused.
- **Selection note:** Usable for H3 and E1. Because the board is only identified
  once a borough is chosen, the article must teach the pair, not the number.
  Whether the underlying matching is district-scoped still has to be verified
  before H3 describes coverage.

### X8 — A civil-service exam with a closed window

- **Route:** `https://cityscroll.org/exams/7016/`
- **Evidence class:** `historical-record` (checked live on 2026-09-05)
- **Observable result:** The Caseworker exam 7016 document renders with its
  application window 07/01/2026–07/21/2026, marked **CLOSED**, alongside the
  official apply and notice links, a watch control, and a copy-link control.
- **Selection note:** Usable for H1 and E3, and deliberately kept as the honest
  case: the record is complete and the method is fully teachable while the
  opportunity itself has passed. Any article using it must stop inviting the
  reader to apply and must not present a closed window as a current invitation.

### X9 — Deadlines, events, and the calendar handoff

- **Route:** `https://cityscroll.org/now/`
- **Evidence class:** `live-public-route`
- **Observable result:** An "Act by" section separates deadlines a reader can
  still act on from the events that follow. The "Subscribe to calendar" control
  is present in every lens toolbar but **hidden at rest**: it is revealed only
  for a scope with defensible dated occurrences, per
  `hasDefensibleDatedOccurrences` in `site/calendar_subscription.mjs`. The
  capture manifest records this as `present_but_hidden` at both review widths.
- **Selection note:** Usable for H4, with the condition as the lesson. An
  article that tells a reader to press a control they cannot see would be wrong
  for most scopes; the article must teach how to reach a scope that offers the
  handoff, and must cover the case where no supported occurrence exists.

### X10 — A land-use project and its official source

- **Route:** `https://cityscroll.org/browse/zoning/#land/2022M0258`
- **Route resolution:** Taken from `landProjectPath` in
  `site/land_project_route.mjs`, which is the document-owned canonical form used
  by titles and the copy-link control. No `/projects/` path exists; a root-level
  `/#land/<id>` form also appears in some producers and canonicalizes to the
  same destination.
- **Evidence class:** `live-public-route`
- **Observable result:** Selecting the project renders "Timbale Terrace" with a
  "Where this stands" section and a "What can I do now?" section, the official
  source `https://zap.planning.nyc.gov/projects/2022M0258`, and links to the
  individual disposition documents.
- **Selection note:** Usable for H5. The route needed resolving from the routing
  module precisely because the earlier description implied a project path that
  the product does not serve.

### X11 — The investigation workspace

- **Route:** `https://cityscroll.org/#investigation`
- **Route resolution:** Taken from the workspace module and the shared footer
  link ("My investigation"); shared snapshots render at
  `/#investigation/shared/<id>`. Records are added through a control labelled
  **Pin** on a notice, matter, agency, or vendor. No `/workspace/` path exists.
- **Evidence class:** `live-public-route`
- **Observable result:** With nothing pinned the workspace renders "Investigation
  workspace · stored only in this browser", "0 pinned items", and guidance to
  open a record and use its Pin control. The empty state names the later outputs
  — a read-only link, a frozen research package, a CSV or JSON export, and a
  printed dossier — without offering them yet.
- **Selection note:** Usable for H8. The article must keep four things apart:
  what is stored on the device, what a recognized session syncs, what a
  downloaded file contains, and what a shared snapshot exposes. Verification of
  the sharing and freezing steps must use disposable records rather than real
  ones.

## Substitutions

None. Every seed resolved to a live public route with a stated observable, so no
same-purpose substitute was needed. X1 carries a check-harness limitation rather
than a route failure, and X8 is retained deliberately as a closed-window record
rather than replaced with a currently open one.

## Reproduction

Static contract check over the demo manifest:

```sh
python3 test/standards/demo_links.py
```

Live check of the seed entries that have manifest ids:

```sh
CROL_BASE=https://cityscroll.org \
CROL_DEMO_LINK_IDS=notice-sanitation-connected-mandate,agency-parks-connection-evidence,graph-walk-agency-vendor-award,civic-time-ledger-as-of,agency-parks-mandates-rules,agency-parks-mandates-reports,agency-parks-mandates-predictions,exam-caseworker-7016,alerts-builder,alerts-watch-templates \
  python3 test/functional/20_demo_links.py
```

Observed on 2026-09-05: ten of ten passed.

The X1 harness limitation reproduces by adding `semantic-search-housing` to that
list, and is isolated by loading the same route in a plain browser session with
no request interception, where the typed lanes populate in about two and a half
seconds. The failing requests under the harness are the topic-search candidate
and result calls to the API host and to its worker fallback host.

Baseline capture of About and the entry points:

```sh
python3 tools/capture_guide_baseline.py
```
