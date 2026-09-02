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

The size of the resulting improvement is **not** established. The planning
projection for this change is a 3,000-7,000 ms reduction on slow devices; that
remains an estimate.
No production before/after window has been collected, so no percentile
comparison is published here.

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

`read-back.json` is the grouped read-back over `content_ready_ms` for the
`notice` surface and the page-level `none` component. Both the before and after
groups are below the 30-sample floor with incomplete windows, so no percentiles
and no delta are published. The comparison names that reason rather than leaving
the gap to be filled by the estimate.

The 2026-08-26 field distribution for the Notice page (p50 2,073.8 ms,
p75 3,798.1 ms, p95 8,615.2 ms over 64 retained rows) is carried as historical
context. It predates the owner boundary and is not a result. That report also
found no mobile readiness subgroup clearing the sample floor, so a
mobile-specific claim is not yet available from the field at all.

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

Rebuild or verify with:

```bash
node tools/build_notice_primary_readiness_evidence.mjs
node tools/build_notice_primary_readiness_evidence.mjs --check
python3 tools/capture_notice_primary_readiness.py
```
