# Notice context readiness boundary

Primary Notice context readiness is the context host plus any attachment chip
already present on the notice row, or an honest unavailable/error terminal.
Flags, award, related-attachment, mandate, table, lookup, and late attachment
hydration are optional enrichments. They may continue after the owner
milestone and are timed separately. They do not change the production
`notice-context` identity.

The grouped read-back lives in `read-back.json`. It keeps the primary
`component_ready_ms` group and optional branch timings distinct, applies the
30-row sample floor, and does not publish percentiles for an incomplete or
undersized window. The 2026-08-26 field baseline remains historical context
and is not a pass for the p75 ≤ 2500 ms / p95 ≤ 5000 ms gate.

The read-back procedure, the baseline, and each production read-back result are
recorded in `data/performance/field-rum-readiness-2026-08-26.md`.

Rebuild or verify with:

```bash
node tools/build_notice_context_readiness_evidence.mjs
node tools/build_notice_context_readiness_evidence.mjs --check
```
