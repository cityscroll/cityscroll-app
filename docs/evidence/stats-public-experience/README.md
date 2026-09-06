# The public Stats page as a reader experience

The page already said, accurately, how much CityScroll serves and how often searches finish. It
did not say what any of that was *for*. A visitor who had never used the product met four
figures, two tables and a privacy note, and left with no idea what a record here lets them do.

This directory holds the evidence for the rewrite: the section order, the three worked paths and
the real records behind them, the translated copy, and the states a reader can meet.

## What a reader now meets, in order

| Section | What it answers | Where the content comes from |
| --- | --- | --- |
| What you can explore | How much is here, and where to read it | The materialised served-coverage snapshot, unchanged |
| Recent use | How much the search is being used, over named days | The published search-usage summary, unchanged |
| See how records connect | What any of it is for | Static markup in `site/stats.html` |
| About these numbers | What the figures count, and what they cannot say | Static markup in `site/stats.html` |

The order is the argument: scope, then use, then purpose, then method. The two measured sections
keep the contracts they already had — `docs/evidence/served-coverage/` and
`docs/evidence/public-search-usage/` still own them — so this change is about presentation and
the two new static sections, not about how anything is counted.

Two consequences worth stating:

- **Languages left the headline grid.** The site's eleven languages are a capability the product
  offers, not a measure of how it is used, and a tile beside three measured counts invited it to
  be read as one. It is now a stated capability in the methodology list, where it belongs.
- **The worked paths and the methodology are served markup.** They do not wait for a snapshot, an
  API answer or any client analytics. A reader whose measurement requests all fail still gets the
  point of the product, and the capture below proves that path.

## The three worked paths

Each path was taken from the public guide's existing worked-example selection records
(`docs/evidence/public-user-guide/example-selection-records.md`) rather than invented here, and
each links back to the maintained tutorial instead of copying it. Routes were resolved from the
manifests and modules that own them — `site/demo/demo-links.json` for the encoded award walk,
`landProjectPath` in `site/land_project_route.mjs` for the land route — never retyped from prose.

### Procurement — from a city agency to one award

- **Seed:** X5, *A shareable two-hop walk*.
- **Canonical URL:** `/notices/20231222103` with the `walk` parameter resolved from the
  `graph-walk-agency-vendor-award` entry in `site/demo/demo-links.json`.
- **Source-qualified identities:** agency Homeless Services (`/agencies/homeless-services/`);
  awardee `HOUSING OPTIONS GERIATRIC ASSOCIATION RESOURCES` as published, rendered *Housing
  Options & Geriatric Association Resources*
  (`/vendors/HOUSING%20OPTIONS%20GERIATRIC%20ASSOCIATION%20RESOURCES/`); award notice 20231222103
  in The City Record Online, published title *Families with Children City Sanctuary facility
  located at 226 West 50th Street, New York, NY 10019 (132 units)*.
- **Data date:** checked live against the public deploy on 2026-09-05 for the selection record and
  again on 2026-09-06 for this change.
- **Observed result:** the award notice renders a two-hop trail
  (`.traversal-path[data-traversal-hop-count='2']`) naming the awardee, reconstructed from the URL
  rather than from session state, with the prime-award snapshot present and no empty state.
- **Working next step:** the trail itself, plus the tutorial
  `/guide/start/trace-an-award-and-keep-the-trail/`.
- **Stated limit on the page:** a named award does not mean there is work to bid on now.

### Land — where a land-use project stands

- **Seed:** X10, *A land-use project and its official source*.
- **Canonical URL:** `/browse/zoning/#land/2022M0258`, resolved from `landProjectPath`. There is no
  `/projects/` path; the root-level `/#land/<id>` form canonicalises to the same destination.
- **Source-qualified identities:** project 2022M0258 *Timbale Terrace* in the NYC Department of
  City Planning Zoning Application Portal; applicant on the record, Housing Preservation and
  Development; official file `https://zap.planning.nyc.gov/projects/2022M0258`.
- **Data date:** checked live on 2026-09-05 for the selection record and again on 2026-09-06.
- **Observed result:** the project renders as *Timbale Terrace* with a "Where this stands" section
  reporting the review body acting next, a "What can I do now?" section, and four links to the
  official Zoning Application Portal project page.
- **Working next step:** the project itself, plus the how-to
  `/guide/how-to/read-a-land-use-projects-next-step/`.
- **Stated limit on the page:** a stage is what the record shows, not a promise about a date.

### Legislation — from a notice to the law behind it

- **Seed:** X2, *Notice to the mandate behind it*.
- **Canonical URL:** `/notices/20260605008`, from the `notice-sanitation-connected-mandate` entry.
- **Source-qualified identities:** City Record Online notice 20260605008, *DSNY Final Rule re
  Implementation Dates for the Brooklyn North and Upper Manhattan Commercial Waste Zones*;
  connected statutory mandate `/mandates/64116-001`, cited as New York City Charter § 753(e)(2).
- **Data date:** checked live on 2026-09-05 for the selection record and again on 2026-09-06.
- **Observed result:** the notice renders a "Connected mandate" section linking
  `/mandates/64116-001` with a mandate watch control and no empty or loading state; the mandate
  document states the required action, the recurrence, the Charter citation and the notice
  evidence behind it.
- **Working next step:** the notice, plus the tutorial
  `/guide/start/trace-a-notice-to-the-duty-behind-it/`.
- **Stated limit on the page:** a published notice is not proof the duty was met.

### Substitutions

None. All three seeds resolved to live public routes with the stated observable, so no
same-purpose substitute was needed. X1 — the typed-lane topic search — was deliberately not used:
its selection record carries a check-harness limitation and its teachable observable is a search
behaviour rather than a connection between records, which is what this section is for.

Reproduce the two entries that carry manifest ids:

```sh
CROL_BASE=https://cityscroll.org/ \
CROL_DEMO_LINK_IDS=graph-walk-agency-vendor-award,notice-sanitation-connected-mandate \
  python3 test/functional/20_demo_links.py
```

Observed on 2026-09-06: two of two passed. The land route has no manifest id and was checked by
loading it, as its selection record already prescribes.

## Render evidence

`capture-manifest.json` records fourteen observations. No image binary is committed: each entry
carries the route, the viewport, the repository revision, the source blob of `site/stats.html`,
the data vintage, the assertion, the sha256 of the rendered scope, and the sha256 of the PNG that
stays under the gitignored `.artifacts/` path.

```sh
python3 tools/capture_stats_public_experience.py --public
```

- **Language and width** — English, French and Arabic at 390 and 1440 CSS pixels, with every
  off-origin request denied. Each records the four section headings in the reading language, three
  worked paths, three headline facts, six methodology terms, the document direction, and that the
  document does not scroll sideways. French is the expansion-prone check; Arabic is the
  right-to-left one.
- **States** — verified zero, small volume, ordinary volume, a period whose measurement began
  inside it, a period whose last day is still running, a summary standing on the last check that
  finished, and no summary at all. Each entry carries the fixed response it was given. These are
  acceptance figures for the rendering rule, not traffic.
- **Deployed observation** — one read of the public deploy, recorded separately and labelled, so
  the fixed figures above can never be mistaken for production totals. At capture time the
  deployed document predated the search-use section, which the entry records rather than asserts.

One defect the right-to-left inspection found and this change fixes: the skip link was parked at a
physical `left:-9999px`, which under RTL sits outside the document's own start edge and dragged
the scrollable width to 10,389 CSS pixels at a 390-pixel viewport. It now uses
`inset-inline-start`, the logical form the homepage already used. The same physical rule still
stands on `about.html` and `api.html`; those pages are outside this change.

## Route and canonical inspection

`site/_routes.json` excludes `/stats.html` from the Pages edge worker, so the document is served
as a static asset. Observed against the public deploy on 2026-09-06:

| Request | Result |
| --- | --- |
| `/stats.html` | 308 to `/stats` |
| `/stats` | 200 |
| `/stats/` | 308 to `/stats` |

The extensionless redirect is the platform's own behaviour for every `.html` document on the site
— `/about.html` and `/api.html` behave identically — and every one of those pages declares its
`.html` form as canonical. One canonical destination therefore already stands, `/stats.html`,
recorded in `tools/build_url_migration_map.mjs` and in the sitemap; this change preserves it and
every inbound alias rather than moving the site's convention on one page.

## What stays private

`DATA_HEALTH_PUBLIC` is `false` and this change does not touch it. The page exposes no Data health
or private desk link, and `test/data_health_navigation.test.mjs` and
`test/functional/36_data_health_navigation.py` still hold. When the gate is flipped elsewhere, the
crosslink comes from `renderStatsToDataHealthHtml()` in `site/data_health_navigation.mjs`, which
already returns the one boundary sentence — Stats says how much there is, Data health says how
current it is.

The methodology names the periods, the counting rules and the limits beside the claims. It states
no receipt internals: no store name, key prefix, scan bound, allowlist, projection field or
snapshot digest reaches the page, and `test/stats_public_experience.test.mjs` asserts that.
Search queries, readers, subscribers and delivery operations remain behind the authenticated desk.

## Production read-back — pending

Everything above is synthetic or local, and proves the code rather than the traffic. Reading the
deployed page's own measured figures back against the authenticated aggregate is a live step the
site owner performs after deploy; it is recorded here as pending. The procedure is in the pull
request that introduced this directory.
