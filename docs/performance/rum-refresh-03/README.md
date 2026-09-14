# RUM refresh 03 measurement contract

Semantic readiness observations retain the caller's monotonic `performance.now()` reading as
the additive `owner_timestamp_ms` field. The pre-collector buffer captures it at the readiness
call; collector installation and drain do not replace it with a later clock reading.

The browser observation payload keeps the existing version and fields unchanged. The optional
field is carried to the Analytics Engine point as `double2`; `double1` remains the measured
latency. The grouped readiness query returns `max(double2)` as `latest_timestamp`, alongside
`sampled_count`, weighted `p50`, `p75`, and `p95`, grouped by `metric_id`, `surface_id`, and
`component_id`.

Rows written before this additive field was introduced retain their existing meaning and expose a
null `latest_timestamp` when no owner timestamp is present.

## Field read-back provenance

The deployed Worker's `/admin/performance` GET is the producer for the committed
snappiness read-backs. `tools/capture_field_rum_evidence.mjs` reads the existing
RUM aggregate for Browse Contracts, Notice context, and Notice primary, then
writes the declared evidence paths without any production write. Each artifact
must carry `cityscroll.performance.field_provenance.v1` with `source: "production
field"`, route, deployed code revision, retained dataset vintage, observation
window, and true retained sample count. Fixture network traces and lab traces
remain valid for deterministic or structural tests, but the field reader refuses
their provenance for a field distribution.
