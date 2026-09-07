# Keeping the published measurement accountable

The public Stats page publishes four kinds of claim: how much is served, how much the search is
used, what any of it is for, and what the figures cannot say. This directory holds the evidence
for the work that keeps those claims tied to the things they are about — route attribution, the
lineage behind the published counts, the watch on whether they get published at all, and the
review that keeps a person looking at them.

## The defect this started from

The browser resolved the surface of a page view by taking the last path segment, looking it up
in a table of seven filenames, and answering `home` when it recognised nothing.

Two things had happened since that table was written. The platform serves every `.html`
document at its extensionless path — `/stats.html` answers 308 to `/stats`, which answers 200 —
so the served pathname no longer ends in a filename the table knew. And the product grew a
Search document, a data-health document, nine `/browse/<lane>/` documents and a set of record
and entity routes, none of which were in the table either.

The result was not an error anywhere. It was that the Stats, About, API, Data, Changelog and
Standards documents, the Search document, the data-health document and every browse lane all
reported themselves as the homepage, and the Worker accepted every one of those rows because
`home` is a real surface. The measurement was about a different page than the reader was on,
and nothing in the system could say so.

| Route a reader is on | Surface reported before | Surface reported now |
| --- | --- | --- |
| `/stats` | `home` | `stats` |
| `/about`, `/api`, `/data`, `/changelog`, `/standards` | `home` | their own surfaces |
| `/search/` | `home` | `search` |
| `/data-health/` | `home` | `data-health` |
| `/browse/contracts/` … `/browse/zoning/` | `browse` | one surface per lane |
| a route nothing registers | `home` | no event at all |

The lens dimension had the same shape of defect: when nothing on the page established a lens,
the producer handed out `money`. A search typed into any document with no lens control was
therefore recorded as a spending search.

## What now decides a surface

`site/analytics_surface_taxonomy.mjs` holds the vocabulary, and both halves read it — the page
script resolves the surface it may name, and the Worker builds its per-event allowlists from
the same constants. Each row is answerable to the registered route map in
`site/data/performance-classification-manifest.v1.json`.

Four checks run over that, all bidirectional, in `test/analytics_surface_taxonomy.test.mjs`:

- every surface the route map registers is answered here, exactly once;
- every surface answered here is still registered there, with the map's own matcher paths and
  route family;
- every document that ships the collector — tracked or generated — resolves to a surface a
  producer is allowed to name;
- every surface a producer is allowed to name is one some document actually produces.

A pathname the map does not register resolves to `unclassified` and the producer sends nothing.
There is no fallback surface. A submission the taxonomy refuses is counted privately under one
per-day key, with no dimension from the refused body kept, so a producer that starts naming
something unregistered shows up as a number rather than as silence.

The taxonomy version moves to 1.4.0. Rows written under 1.0.0 through 1.3.0 stay readable, and
the historical `home` rows are not re-attributed: nothing here can know how many of them
belonged to the homepage, exactly as nothing could know that about the pre-2026-08-05 rows.

## What each route now reports

`capture-manifest.json` records twenty-eight observations, taken by loading each route in a real
browser with every off-origin request denied and the event intake answered locally, so the
dimensions the collector actually attempted to send are the evidence. No image binary is
written and none is committed: the defect this records is invisible in a screenshot, because the
page renders perfectly while telling the measurement system it is a different page. Each entry
carries the route, the viewport, the repository revision, the source blobs of the two files that
decide a surface, the data vintage, the assertion, and the sha256 of the rendered scope.

```sh
tools/prepare_functional_site.sh
python3 tools/capture_route_attribution.py
```

Observed on 2026-09-06: twenty-eight of twenty-eight assertions held. Twenty-one routes each
reported exactly one page view naming their own surface; two unregistered routes reported
nothing at all; three retired documents reported only their own surface or the one they redirect
to; and two routes the static build does not serve — a Pages-edge record and a private
experiment — carry the vocabulary's own answer with the entry stating that no page was loaded.

Two observations worth keeping:

- **`/data.html` reports two page views**, its own and the API guide's. It is a redirect stub, so
  a reader really does load two documents; both are now named correctly, where before both were
  named `home`. `/changelog.html` and `/standards.html` redirect fast enough that only the
  destination is reported.
- **The extensionless aliases are not exercised in the browser here.** The 308 from `/stats.html`
  to `/stats` is the platform's behaviour and the local static server does not perform it, so the
  aliases are exercised through the shared resolver in `test/analytics_surface_taxonomy.test.mjs`
  instead. The observed production redirect table is in
  [`../stats-public-experience/README.md`](../stats-public-experience/README.md).

## Two questions that are never added

`usage.searches` counts intent — someone started a search — and comes from Analytics Engine,
whose rows are sampled and re-expanded by their own sample interval. It is an estimate.
`search_executions` counts outcome — a search finished and rendered its result — and comes from
stored execution receipts. It is exact.

`/admin/stats` now states both bases beside the figures, in a `measurement_basis` block, so an
operator reading them side by side cannot take one for the other. Neither figure is added to
the other anywhere, and `test/analytics_readiness.test.mjs` holds that: an accepted interaction
moves its own counter and contributes nothing to the completed count.

Nothing here promotes a page view, an export or a click into a public figure. The public
response still carries exactly `schema`, `generated_at`, `scope`, `coverage`,
`language_coverage` and `search_usage`.

## Dated aggregates, and why they are final

The published summary answers for the last seven and thirty days, out of a receipt store that
keeps thirty. That is enough to publish a period and nowhere near enough to hold a trend: the
day a receipt leaves retention, any figure derived by re-reading the receipts silently gets
smaller.

So each closed UTC day is folded once into its own aggregate, in the same KV namespace and the
same write-the-value-directly-under-a-day-key pattern the existing daily gauges use, and kept
far longer than the receipts behind it. Four rules make it safe to build a trend on:

- **A day is closed before it is written.** An aggregate names the instant its day ended and is
  published only after that instant. A cycle running at 00:05 publishes yesterday, not a
  fragment of today.
- **One execution has one date.** Repeated intakes collapse onto the earliest instant the store
  learned of the execution — the same rule the windowed fold uses — so a retry that crosses
  midnight resolves to the day of the first intake and cannot appear on both sides of it.
- **A published day is final.** Reprocessing recomputes and compares. Equal content is left
  exactly as it stands; different content is reported and the stored day survives. That is what
  stops retention expiry from rewriting history downwards.
- **A day nobody measured stays absent.** No zero-filling, no interpolation. A gap is reported
  as a gap, and a gap older than the receipt retention horizon is reported as one nothing can
  now recover.

`worker/test/search_usage_daily.test.mjs` exercises each of those, plus the four scenarios that
would otherwise corrupt a trend: retention expiry, a missed cycle, resumed collection, and an
unchanged rebuild. An unchanged rebuild writes nothing at all.

The dated series is private lineage. It is read back through the authenticated desk, alongside
a reconciliation of the stored days against a fresh read of the receipts, and it is not
published.

## The watch on publication

A publisher that has frozen keeps reporting success: the refresh returns a verification, the
public summary stamps a fresh instant, and the trend stops moving with every self-report
reading healthy.

`tools/stats_publication_monitor.mjs` therefore uses none of that as evidence of success. It
computes the day that should have been published from its own clock, then asks two questions
the publisher cannot answer for itself: is that day in the stored series, and has the newest
stored day advanced. A fresh verification standing beside a newest day that has not moved is
named `frozen-publisher`, which is precisely the failure a self-report is structurally unable
to see.

It rides the existing scheduled monitoring path and its outbox — one more job in
`tools/external_schedule_jobs.json`, resolving its credential exactly the way every other call
in that cycle already resolves it, and delivering through the same replayable issue intent. It
adds no scheduler, no mail route and no recipient list.

The controlled specimens are under `fixtures/` beside the tests:

```sh
node tools/stats_publication_monitor.mjs --observation test/fixtures/stats-publication/failure.json --now 2026-09-06T12:00:00Z
node tools/stats_publication_monitor.mjs --observation test/fixtures/stats-publication/recovered.json --now 2026-09-06T12:00:00Z
```

Observed: the first exits 1 with `failing_stage: frozen-publisher`; the second exits 0 and its
issue intent is a close rather than an open. `test/stats_publication_monitor.test.mjs` runs the
whole leg through the shared outbox and asserts that a repeated observation lands on one title
and one marker, so a condition observed twice is one card. No production traffic is involved in
any of it: both reads are supplied by a stub.

An unreadable observation is reported as a check that could not run, never as a failed
publication, so an outage cannot masquerade as a missing snapshot. A gap older than the
receipts is a note rather than a finding, because reopening a card every day for a day nobody
can recover is noise rather than work.

Last verified evidence stays visibly dated on the page itself: the search-use section renders
the date of the last verification and adds a "standing on the last check that finished" note
whenever the refresh is not fresh. `test/stats_public_experience.test.mjs` already holds that,
and this change does not move it.

## Joining the weekly review

`tools/build_measurement_review.mjs` is the guide-review lane's twin, deliberately: the same
report shape, the same finding-identity rule, the same shared outbox, the same refusal to
schedule itself. A review desk should not have to learn a second set of conventions.

Five checks, matching the five things that can quietly stop being true:

| Check | Question |
| --- | --- |
| source participation | Does every source the published coverage counts still exist in the registry? |
| route/taxonomy compatibility | Does the surface vocabulary still answer for the routes the product registers? |
| metric reconciliation | Do the dated aggregates behind the published figures still match the receipts? |
| example validity | Do the worked paths the page teaches still resolve to routes that exist? |
| missing publication | Was the promised daily snapshot published? |

```sh
# the three checks that need no live observation, and no clock
node tools/build_measurement_review.mjs --check

# the section a review flow includes
node tools/build_measurement_review.mjs --section --checked-at=2026-09-06

# prove replay and deduplication without reaching any outward surface
node tools/build_measurement_review.mjs --rehearse --checked-at=2026-09-06 --run-key=2026-W36
```

`--checked-at` is required for anything that produces a report: a projection that reads a clock
cannot be rebuilt and compared. The two live checks take their observations through
`--observation`; without it they report `check_unavailable`, which is not the same claim as a
measurement that went wrong.

The owner, configuration and consumer of the weekly cadence itself are recorded in
[`../public-user-guide/review-cadence-handoff.md`](../public-user-guide/review-cadence-handoff.md),
which owns that boundary. Nothing in this repository runs weekly; the weekly candidate assembly
and the review desk are not reachable from here and are deliberately not named here. See
[`handoff.md`](handoff.md) for the exact interface this lane offers that half, and for the one
acceptance item that stays open until the private consumer has actually run it.

## Production read-back — pending

Everything above is synthetic or local, and proves the code rather than the traffic. Reading the
deployed figures back — the dated series against the published periods, and the surface
breakdown against the routes readers are actually on — is a live step the site owner performs
after deploy, against private data that is not read from a development machine. It is recorded
here as pending. The procedure is in the pull request that introduced this directory.
