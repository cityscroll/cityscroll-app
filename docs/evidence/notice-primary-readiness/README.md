# Notice primary readiness boundary

## What this is

A Notice page is ready when its primary body is usable. That is the
edge-rendered notice itself, or an honest unavailable state when the record
cannot be served. Money history, agency rules, the client notice read,
attachment metadata, notice context, and late property enrichment are optional:
they add to the page after it is already useful.

This directory records where that boundary sits and what has actually been
measured about it.

## Summary

The primary body is the boundary. `content_ready_ms` for the `notice` surface is
reported when the edge body or its honest unavailable state is present, while
the optional owners are still in flight. A cold trace confirms that ordering.

The size of the resulting improvement is **not** established by the lab trace.
The planning projection for this change is a 3,000-7,000 ms reduction on slow
devices; that remains an estimate. A separate production before/after read-back
has been run (`read-back.json`) from the deployed Worker's retained field
aggregate: the current seven-day window has 127 rows and p75/p95 of
577.8/1,677.9 ms.

## Exploring the boundary

| Owner | Role | May delay readiness? |
| --- | --- | --- |
| Edge-rendered primary body | Primary | Yes — it is the boundary |
| Edge unavailable terminal | Primary | Yes — an honest terminal is readiness |
| Client fallback body | Primary | Yes, when no edge body was delivered |
| Client unavailable terminal | Primary | Yes |
| Money history | Optional | No |
| Agency rules | Optional | No |
| Client notice read | Optional | No |
| Attachment metadata | Optional | No |
| Notice context | Optional | No |
| Property action matter | Optional | No |

An optional owner that finishes later cannot move the readiness timestamp: the
surface milestone is recorded once, and a later report is a duplicate.

## Evidence

`cold-trace.json` is a cold lab trace at 390px and 1440px with the optional
owners blocked or delayed. It records the route, viewport, cache state, source
revision, and owner-call timing for both the pre-boundary and boundary
semantics, and it names what each capture pair demonstrates.

The trace establishes the **ordering** property only. Its before/after gap is
bounded by the delay the trace injects, so the gap's magnitude is an artifact of
the method and is not a measured saving. It corroborates neither the projected
range nor any production result.

`read-back.json` is the grouped production read-back over `content_ready_ms`
for the `notice` surface and page-level `none` component. It carries a root
`provenance` object naming the served route, deployed code revision, retained
dataset vintage, observation window, and true retained count. The current and
previous complete windows contain 127 and 102 retained rows respectively, so
the measured field comparison reports p75/p95 deltas of 2,811.4/4,874.2 ms.
The aggregate does not expose per-row device or release dimensions; the
evidence names that scope rather than reconstructing rows.

The 2026-08-26 field distribution for the Notice page (p50 2,073.8 ms,
p75 3,798.1 ms, p95 8,615.2 ms over 64 retained rows) is carried as historical
context. It predates the owner boundary and is not a result. The current
aggregate read does not expose device-specific counts, so this evidence makes
no device-specific claim.

## Methodology

Percentiles appear only when a window is complete and meets the 30-sample floor.
A delta appears only when both sides are sufficient and describe the same
measurement population; lab and field observations are named separately and are
never merged. The projected reduction is always serialized with
`measured: false`, and the contract rejects any document that fills an
unmeasured delta with the estimated range, presents the estimate as measured,
presents the historical baseline as a result, or lets an optional owner declare
itself as blocking.

This adds no metric, surface, or component identity to production RUM. It groups
observations the collector already reports.

## Production read-back source

The deterministic unit builder still reads
`test/fixtures/notice-primary-readiness/read-back-input.json`; that fixture path
is not a field gate producer. Production evidence is captured by
`tools/capture_field_rum_evidence.mjs` through the deployed Worker's bounded
admin read model, scoped to `metric_id = content_ready_ms`, `surface_id =
notice`, `component_id = none`, `traffic_class = production`. The current and
previous complete seven-day windows are `2026-09-07T09:14:27Z` –
`2026-09-14T09:14:27Z` and `2026-08-31T09:14:27Z` –
`2026-09-07T09:14:27Z`, with 127 and 102 retained rows.

```
SELECT count() AS sampled_count, sum(_sample_interval) AS estimated_count,
  quantileExactWeighted(0.50)(double1, _sample_interval) AS p50,
  quantileExactWeighted(0.75)(double1, _sample_interval) AS p75,
  quantileExactWeighted(0.95)(double1, _sample_interval) AS p95
FROM crol_rum_observations_v1
WHERE blob1 = 'cityscroll.performance_observation.v1'
  AND blob2 = 'content_ready_ms' AND blob3 = 'notice' AND blob4 = 'none'
  AND blob6 = 'mobile' AND blob10 = 'production'
  AND timestamp >= toDateTime(<window_start>) AND timestamp < toDateTime(<window_end>)
```

against `https://api.cloudflare.com/client/v4/accounts/<account>/analytics_engine/sql`.
The committed producer uses the deployed Worker's read model rather than
exposing this direct provider credential path; the SQL above remains the
corresponding bounded aggregation grammar. The read model does not return
per-row `release_id` or device dimensions, so the evidence records the deployed
read revision and explicitly scopes those dimensions as aggregate-level.

Rebuild deterministic fixture evidence or refresh production field evidence with:

```bash
node tools/build_notice_primary_readiness_evidence.mjs --fixture
python3 tools/capture_notice_primary_readiness.py
CITYSCROLL_ADMIN_KEY_FILE=<mode-0600-key-file> node tools/capture_field_rum_evidence.mjs
```
