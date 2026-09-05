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
