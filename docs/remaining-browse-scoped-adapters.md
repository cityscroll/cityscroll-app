# Remaining Browse scoped adapters

US-20 moves keyword candidate retrieval at the remaining Browse seams to the
registered `search.federated@1` capability. The adapters do not replace the
domain read models: they select candidates, then the existing renderer applies
typed filters, geography/time/status rules, detail handoffs, and analytical
joins locally.

## Migration inventory

| Source family | Before: candidate provider and local filter | Registered scope and reference shape | Local projection retained | Failure, stale, and detail behavior | Representative proof |
| --- | --- | --- | --- | --- | --- |
| People | Embedded `people_organizations_read_model.json`; `browseListParams` substring and typed row facets | `people` → `people`, `agencies`, `vendors`, `committees`, `community_boards`; `person:*`, `agency:*`, `vendor:*`, committee and Community Board refs | Type, institution, and role facets; geography/time/status are not capability inputs and remain disclosed local constraints | Static model paints first; unavailable keeps the published rows with a disclosure; canonical row hrefs remain the handoff | `parks`, `person:123`, `test/browse_scoped_adapters.test.mjs` |
| Property | Resident property snapshot; local text filter followed by asset, method, price, process, stage, and geography filters | `property` → `parcels`; `bbl:*` | All property facets and the parcel-to-property local join | Snapshot paints first; provider failure keeps it and is disclosed; property detail links stay on the retained row | `maintenance`, `bbl:1000000001`, `test/browse_scoped_adapters.test.mjs` |
| Land | ZAP land project snapshot and local substring filter | `land` → `land`; `land_use_project:*` | Status, stage, future action, procedure, family, regulatory effect, borough/district, address geocode, and map projection | Project snapshot paints first; address/block interpretation stays local; unavailable keeps the local result and says so; project detail/map handoff is unchanged | `parks`, `land_use_project:2024Q0001`, `test/browse_scoped_adapters.test.mjs` |
| Rules | Rules-domain snapshot and local text match | `rules` → `notices`; `rulemaking:notice:*` | Agency, process, geography, lifecycle and the local notice/lifecycle projection | Snapshot paints first; provider failure remains distinct from empty and leaves the local rows visible; existing notice/rules links remain authoritative | `public hearing`, `rulemaking:notice:202600001`, `test/browse_scoped_adapters.test.mjs` |
| Meetings | Shared meeting read model, then local keyword, time, place, agency, board, process, and grouping projections | `meetings` → `meetings`, `committees`; meeting ids | Time/geography/status-like windows, affected-area semantics, board disambiguation, process collapse, and analytical joins remain local | Shared meetings paint first; failure keeps that model with a disclosure; meeting and official-source handoffs are unchanged | `parks`, `meeting:2026-001`, `test/browse_scoped_adapters.test.mjs` |
| Exams | Staffing exam snapshot and `CrolStaffing.filterExams` keyword match | `exams` → `exams`; `exam:*` | Interest, eligibility, window, format, salary, fee, experience, agency certification, and application-window derivation | Static exam guide paints first; failure keeps the local guide with a disclosure; exact exam detail links remain intact | `caseworker`, `exam:7016`, `test/browse_scoped_adapters.test.mjs` |

The capability cannot express the typed constraints listed in the local
projection column. They are therefore explicit adapter metadata and are applied
after candidate selection. In particular, meetings' affected-area and other
analytical joins never become federation evidence.

## Shared outcome contract

`site/browse_scoped_adapters.mjs` preserves the federated result objects rather
than rebuilding them. The adapter carries `object_ref`, `canonical_href`,
`source_observation_refs`, `match_fields`, `edge_provenance`, producer
provenance, rank, requested lens coverage, per-lens freshness, and result
bounds. It returns `idle`, `matched`, `empty`, `partial`, or `unavailable`.

`unavailable` is used for transport/provider failure and causes the surface to
retain and disclose its static/local snapshot. `empty` is used only when the
requested scope answered with no documents. `partial` and `stale` coverage are
retained as incomplete coverage; neither is silently promoted to a complete
empty or complete result.
