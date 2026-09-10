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
node --test worker/test/search_usage_schedule.test.mjs worker/test/search_usage_daily.test.mjs
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

### Scheduled publication and bootstrap

Each configured UTC window (08:00, 10:00 and 13:00) starts the same receipt-only
refresh through `ctx.waitUntil()` before dispatching the other scheduled jobs.
This is independent of delivery and publisher acquisition, including their errors,
early returns and delays. Public requests still read only the stored projection.

The regression in `worker/test/search_usage_schedule.test.mjs` executes the actual
Worker entrypoint with imported jobs replaced by controlled doubles. Before this
change, 08:00 and 10:00 never called the publisher; 13:00 called it only after the
delivery and advisory chain. A delivery exception left no snapshot attempt.
The counterfactual changes only that scheduling relationship: all three windows
publish, including when delivery throws or a publisher refresh remains pending.
Publication failure remains isolated from delivery in the opposite direction too.

The synthetic 57-execution fixture includes six receipts requiring body hydration.
With an established period it publishes 57 searches and 47 returning records;
with no measurement start it claims only the span beginning on its first refresh
day. Neither the receipt population nor the publication boundary changes.
D1 access is forbidden by the fixture because this path depends only on KV.

Production observations on 2026-09-09 reproduced an unavailable Stats section and
`search_usage.refresh.attempted_at = null`. The authenticated aggregate contained
accepted production executions with a complete scan and no unclassified receipts;
the stored daily series was empty. The deployed settings named the expected KV
binding and production environment, and all three schedules were installed. Stored
rehearsal receipts at 10:00 on September 7 and 8 demonstrate that a scheduled path
which skipped publication was running. These observations rule out an empty receipt
population and missing production classification. They do not identify which job
interrupted or delayed the historical 13:00 chain, or prove historical KV writes
succeeded; the local counterfactual establishes the scheduling defect separately.

After deployment, the next configured window should establish a verified public
summary. Allow the existing 15-minute public cache lifetime before reading it back.
The first dated aggregate follows in the first window after that measured UTC day
closes. For a deployment before 08:00 UTC on September 9, that means verification
on September 9 at 08:00 and the first stored day, September 9, on September 10 at
08:00. A deployment later in the day moves the first verification to 10:00 or 13:00;
one after 13:00 moves both dates forward. Earlier receipts do not authorize a
retroactive measurement start, so no backfill or production state edit is required.

Read back `GET /stats` for the two counts and their verified instant, then compare
the authenticated daily series and reconciliation before accepting production
publication. The independent publication monitor must name that first stored day.
Days that ended before measurement began are not measured, not missing: they can
never be stored, and they must not reopen the publication card. A gap after
measurement began is still a missed snapshot. Local fixture success alone is not
evidence that a production day has been stored.
