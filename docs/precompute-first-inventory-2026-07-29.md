# Precompute-first delivery audit (2026-07-29, owner doctrine)

Scope: all deployed pages and their live client fetch surfaces.

## Source-of-truth delivery tiers

`data/source_contracts.json` now records `delivery_tier` per source:

- `inline-at-build`
- `edge-materialized`
- `live-only`

The generated register in `docs/data-sources.md` is the public surface for this inventory.

## Live client fetch inventory

| Page | Fetch surface | Delivery tier | Why this tier | Migration status |
|---|---|---|---|---|
| `index.html` | `fetch("data/title_crosswalk.json")` | `inline-at-build` | Commit-time artifact currently used for staffing chips and titles. | Aligned, no migration needed. |
| `index.html` | `fetch("data/staffing_exams.json")` | `inline-at-build` | Built for Staffing page output. | Aligned, no migration needed. |
| `index.html` | `fetch("data/people_examples.json")` | `inline-at-build` | Built example dataset consumed by UI controls. | Aligned, no migration needed. |
| `standards.html` | `fetch("data/compliance-snapshots.json")` | `inline-at-build` | Auditing snapshot artifact consumed by standards page. | Aligned, no migration needed. |
| `index.html` | `fetch` to `https://data.cityofnewyork.us/resource/*.json` (City Record, Payroll, CSL, ZAP projects/lots) | `live-only` | User-facing search facets and notices require latest values for query UX; these were intentionally kept near-live for interactive accuracy. | No migration in this batch. Candidate for bounded migration by building page-specific projection snapshots; estimated effort 2 days per endpoint family. |
| `index.html` | `fetch` to `https://data.cityofnewyork.us/resource/w9ak-ipjd.json` and `ic3t-wcy2.json` (DOB Now + legacy demolitions) | `live-only` | Called only on explicit demolition checks and reflects last-mile operational state. | No migration in this batch. Bounded migration to worker-cached endpoint possible for 1 day; estimated effort 1 day. |
| `index.html` | `fetch` to `https://geosearch.planninglabs.nyc/v2/search` | `live-only` | Direct geocoder lookup from user typing and map actions. | No migration in this batch. Bounded migration to `worker` edge-cache endpoint likely (~1 day) but not required to preserve query freshness semantics. |
| `index.html` | `fetch` to ArcGIS `https://services5.arcgis.com/.../FeatureServer/0/query` | `live-only` | MapPLUTO geometry lookup is geometry-heavy and user-driven; no worker cache wrapper exists yet. | Not migrated this batch; bounded migration candidate with ~1.5 day effort to add `/mappluto` worker endpoint + cache. |
| `index.html` | `workerFetch("/priorcycle", "/externalaward", "/nl", "/suggestions", "/property-locations", "/hearings", "/checkbook", "/contract-lifecycle", "/inv", "/agency", "/vendor-profile", "/subscribe")` | `edge-materialized` | Routed through the established Worker edge-caching / precompute pattern (`caches.default` and KV/D1 where available). | Already on target tier. |
| `data.html` | `fetch("data/data_page_charts.json")` then hybrid SODA refresh | `inline-at-build` + hybrid live | Chart aggregates are stable between builds; first paint uses commit-time snapshot. | **Migrated (wave 2):** `tools/build_batch_precompute_snapshots.mjs` → `site/data/data_page_charts.json`; live SODA still refreshes in background. |
| `index.html` Land default list | `fetch("data/land_default_ulurp.json")` then hybrid SODA | `inline-at-build` + hybrid live | Default Active ULURP 40 rows; filter/keyword/geo stay live. | **Migrated (wave 2):** snapshot first paint; SODA refresh without re-autoSelect. |
| `index.html` Property feed | `workerFetch("/property-locations")` slim list | `edge-materialized` | Daily KV view; default response drops body-dump fields for first paint. | **Trimmed (wave 2):** `slimPropertyListView`; `?full=1` for complete rows. |
| `about.html` / `api.html` / `analytics.js` / `stats.html` | `fetch` to `window.CROL_API_ORIGIN` + fallback `window.CROL_API_FALLBACK_ORIGIN` (e.g. `/stats`, `/forecast`, `/property-locations`, etc.) | `edge-materialized` | These endpoints already use worker delivery and are cache-safe by route pattern. | Aligned, no migration needed. |

## Migration plan and proof obligations

- Class-1 candidates (`inline-at-build`): no new candidates identified beyond existing committed build artifacts.
- Class-2 candidates (`edge-materialized`): existing Worker paths are already in use and match the precompute-first target.
- All un-migrated candidates above are bounded and listed with effort estimates in this PR body section to avoid half-completed work.
- No data-source migrations were executed in this batch because they were already aligned to their selected tier or would require route-level changes outside the scoped repair/mapping work.

## Audit hash-compare + parity note

Any future class-1/class-2 migration from this list should include:

1. 20-sample p95 latency check pre/post migration.
2. Deterministic golden-output hash compare for pages depending on that surface.
3. Fixture-first coverage for mocked upstream contracts before release.
