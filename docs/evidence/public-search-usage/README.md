# Public search-usage summary

The public Stats page reported what CityScroll serves and nothing about whether anyone uses it.
Meaningful execution statistics existed, but only behind the authenticated desk boundary, and the
older public counters that did exist counted a different thing — how often someone asked, not how
often a search finished. This directory holds the evidence for the two counts that are now
published, and the boundary that keeps everything else private.

## What is published, and where it comes from

| Artifact | Owner | Tracked | Role |
| --- | --- | --- | --- |
| `search_usage` inside `GET /stats` | `worker/src/lib/public_search_usage.mjs` | no — a stored snapshot | The closed public contract: two counts per named period, plus the state of the measurement behind them. |
| The stored snapshot | the scheduled refresh in `worker/src/worker.mjs` | no — key-value state | The last verified projection. A public read projects this and never scans the receipt store. |
| The receipt store | `worker/src/search_activity.mjs` | no — private, 30-day retention | The counting authority. Never a public input. |
| `docs/evidence/public-search-usage/capture-manifest.json` | this directory | yes | Render manifests for the page, before and after. No image is committed. |

Rebuild and verify:

```sh
node --test worker/test/search_usage.test.mjs
node --test worker/test/stats.test.mjs worker/test/stats_routes_unchanged.test.mjs
node --test test/served_coverage_snapshot.test.mjs test/post_flip_checks.test.mjs
node tools/build_cloudflare_pages.mjs --source-dir . --site-dir _site
```

## What the two counts mean

**Searches run.** Every accepted production search-execution receipt whose received instant falls
in the period. One finished search counts once. A reader who runs the same search again has run a
second search and it counts again; a browser that retries the same beacon has not, and it does not.
Developer traffic, preview-environment traffic and rejected submissions never enter, by
construction rather than by filtering: the first two are stored under a separate key prefix this
read never lists, and a rejected submission is never stored at all.

**Searches returning records.** The subset of those executions that rendered at least one result
row, including a partial result where one lane answered and another did not. The receipt contract
already reconciles the rendered row count with the stored rows and their families, so this is read
off the same evidence rather than derived a second way. It says records were shown. It does not say
the reader found what they needed, and it is never added to the count above it.

**Neither is a number of people.** A count of finished searches is not a count of readers, and the
measures that would come closer — distinct browsers, recognized accounts — are not published here.

## Why a period can be published at all

Completeness belongs to the metric. A period is published only when the measurement behind it is
established for that period:

- the receipt read finished rather than stopping at its own scan bound;
- nothing it read was unclassifiable;
- counting had already begun when the period opened.

If counting began inside the period, the shorter verified span is published instead, labelled with
the day counting actually began — never the wider label carrying a number the measurement cannot
support. If the measurement is unavailable, incomplete, or has no established start, the period is
published as unavailable with a reason. A complete period in which nobody searched publishes zero;
nothing else does.

## What stays private

The published object is assembled from an allowlist and then checked against that allowlist before
it is served, so a field added to the private aggregate later cannot ride along. It carries no
query text, result trace, account label, browser or subscriber identity, receipt or execution id,
recognized-account or distinct-browser count, private route, or scan diagnostic. The authenticated
desk keeps all of it, and still requires its key.

The check is `publicSearchUsageViolations`, and the tests assert on the final serialized response
and on the edge cache entry — not on an intermediate object — because a projection that looks
narrow in memory and leaks on the way out is the failure worth catching.

## The acceptance specimen

`worker/test/search_usage.test.mjs` writes an awkward corpus through the real intake and reads it
back through the real public path, against a fixed clock of 2026-09-15T12:00:00Z. Over that
specimen the published summary reports:

| Period | Searches run | Searches returning records |
| --- | --- | --- |
| 7 days, opening 2026-09-09T00:00Z | 6 | 4 |
| 30 days, opening 2026-08-17T00:00Z | 8 | 6 |

These are synthetic acceptance figures. They prove the counting, not the traffic.

The same corpus pins the awkward cases: a receipt exactly on a window's opening midnight is inside
it and one a millisecond earlier is not; a duplicate intake adds nothing while a reload adds one; a
clock-skewed receipt from the future belongs to no past period; developer, preview and rejected
traffic never appear; a corrupt receipt makes the period unavailable rather than a smaller-looking
total; a capped scan does the same; a failed refresh leaves the last verified snapshot standing
with the failure recorded beside it; and a snapshot whose receipts have aged past retention stops
being published rather than becoming unauditable history.

## Render evidence

`capture-manifest.json` records three observations of `/stats.html` at 390x844, each with the
repository revision, the page's source blob, the data vintage, the assertion, and the sha256 of the
rendered section. No image binary is committed.

- **before** — at `553ffc79`, the page carried no search-use section at all.
- **after-unreachable** — with every off-origin request denied, the section states that counts are
  not published, shows no figure and no zero, and the served-coverage section above it is
  unaffected.
- **after-published** — with the public statistics response supplied, both periods render as dated
  columns carrying the specimen's figures, each measure states what it counts, and the document
  does not scroll sideways.

## Production reconciliation

The figures above prove the code, not the traffic. Reconciling the deployed public snapshot against
the authenticated private aggregate is a live measurement step, described in the pull request that
introduced this directory, and it is recorded as pending until the site owner performs it.
