# Export parity audit and record model

Audit date: 2026-08-05. The audit compares each user-facing export with the data classes rendered by its source surface. The example notice is City Record request `20260617050`, a Housing Authority solicitation whose rendered detail includes a response workflow and procurement lifecycle that the previous workbook did not carry.

## Gap table

| Export surface | Format | Before this refresh | Source surface also renders | Gap before refresh | Resolution / explicit boundary |
|---|---|---|---|---|---|
| Single notice | XLSX | 10 notice columns plus a narrow Contract trail sheet | Plain-language summaries when available; typed deadlines and events; action rail and response-guide links; lifecycle and dollar joins; project, property, subsidy, franchise, meeting, award, and entity context; provenance links | Most visible joined context was absent. Timestamps were written as dates and lost time-of-day. | The workbook now has `Notice`, `Timed events`, `Actions`, `Lifecycle`, `Entities`, `Sources`, and `Rendered context` sheets. Date-time cells retain time-of-day. Empty evidence stays empty. |
| Contracts / Money lens | CSV, XLSX | Procurement basics, one due date, contact fields, amount, PIN, two links | Action destination, lifecycle stage, joined award/vendor/dollars, geography when evidenced, entity and source links | Action and joined context were absent from both formats. | CSV gains shared enriched record columns. XLSX uses the full companion-sheet model and compiles row actions. |
| Staffing / People lens | CSV, XLSX | Hire/exam basics and one link | Process dates, salary/title identifiers, agency/person identity, canonical item link | No shared record/geography/entity/provenance vocabulary; XLSX had only one sheet. | Shared record columns and companion sheets apply. Fields outside the source record remain empty. |
| Zoning / Land lens | CSV, XLSX | Project, borough, community district, status, milestone, applicant, project ID, permalink | Project lifecycle, hearings/actions, council district and finer geography when evidenced, project/entity/source links | Current milestone was exported, but the broader joined picture was not. | The primary record preserves project fields; companion sheets accept timed, lifecycle, entity, and source groups present on rows. |
| Property lens | CSV, XLSX | Notice basics plus sale classification, price display, method, close date, and stage | Parcel IDs, place/geocode evidence, timed sale events, reader actions, disposition lifecycle, cross-domain projects/entities, tax-lien context | Core sale facts existed, but parcel/geography/action/join groups were missing or display-formatted. | Shared enriched columns add sortable numeric price and coordinates, parcel/project identifiers, action URL, and companion groups. |
| Rules lens | CSV, XLSX | Notice basics and one event date | Plain-language rule excerpt, comment/hearing/adoption events, participation actions, rulemaking lifecycle, official links | Lifecycle and participation context were absent. | Typed events, actions, lifecycle, sources, and rendered-context sheets cover the detail classes; list records carry shared enriched columns. |
| Meetings lens | CSV, XLSX | Notice basics, one event date, address, links | Participation link, attendance mode, process/outcome stages, related matters and sources | Participation and outcome joins were absent. | Typed events/actions/lifecycle/source companion sheets plus shared record columns. |
| Property auction-prep saved-search view | CSV | Address, block, lot, BBL, stage, three dates, City Record URL | Borough/neighborhood, evidenced coordinates/districts, commercial classification and numeric price, participation package, disposition join identity, joined project IDs, canonical permalink | The parcel list was exact but omitted most work-planning context. | Extended with those fields while retaining one row per represented parcel. Unpublished coordinates, dates, prices, and joins remain empty. |
| Investigation workspace | CSV, JSON, print | Pinned item type/title/meta/note/date/permalink; JSON preserves the local workspace object | Exactly the same pinned-item title, metadata, note, and link | No page/export drift was found. Pinned items intentionally store citations, not a second copy of every live join. | No schema change. Reopening the canonical item is the freshness boundary. |
| Following / saved scope | JSON Feed, RSS, Atom links | Scope-preserving feed URLs and feed items | Saved scope description, preview counts/results, subscription form | These are syndication exports, not analytical workbooks; they intentionally follow feed schemas. | Explicit exclusion from the workbook model. The scope remains reproducible in the feed URL and canonical item permalinks. |
| Event reminder actions | ICS | One selected deadline/hearing event | The same selected event and its canonical source | ICS is intentionally one-event, not a record export. | Explicit exclusion from workbook parity; the same event is also represented in `Timed events` when a workbook is exported. |
| Print / Save as PDF | Browser print | The rendered active surface with provenance header | The rendered active surface | No semantic parity gap; print is the page representation. | Remains rendering-based rather than tabular. |

## Export record model

The model is designed for action-oriented analysis rather than a minimum interchange payload:

- The primary sheet uses typed, sortable fields: record identity and kind, category/agency/title, evidence-backed plain-language summary, posted/due/event timestamps, lifecycle stage, numeric amount/price, contact and response destination, geography, parcel/project identifiers, canonical permalink, and official City Record URL.
- `Timed events` is one row per deadline, hearing, auction, lifecycle milestone, or other evidenced event. It carries event type, a real Excel date-time value, status, label, and source URL.
- `Actions` is one row per extracted or rendered action, with its destination/how-to link, delivery class, and deadline when evidenced.
- `Lifecycle` is one row per joined stage or paper-trail entry, with status, date, amount, vendor/counterparty, detail, and provenance URL.
- `Entities` holds agencies, vendors, projects, parcels, and other linked objects with relationship and evidence labels.
- `Sources` separates canonical item links from official and join-derived provenance URLs.
- `Rendered context` is the parity backstop. Each visible enriched data class contributes its text and links when it has content, so a new join cannot silently disappear merely because it has not yet received a dedicated structured extractor.

Multi-valued values that are useful for filtering stay in normalized companion sheets where possible. Compact primary-sheet values use ` | ` only for small identity/location sets such as boroughs, districts, neighborhoods, and BBLs.

## Evidence and absence rules

- Missing coordinates, districts, dates, amounts, vendor names, project IDs, and summaries are blank. A title is not relabeled as a plain-language summary.
- Inferred parcel links require an exact 10-digit BBL already present in the row or its evidence-backed location object.
- The official English notice remains the record text. Unofficial translations are an explicit export-parity exclusion and are not copied into workbooks.
- Syndication feeds, ICS reminders, and print output retain their format-specific contracts; they are documented exclusions from analytical workbook shaping, not silent omissions.

## Missed-detection law

Notice-detail enrichment mounts declare `data-export-class`. `test/export_parity.test.mjs` walks both notice render paths and fails when:

1. a known enrichment mount lacks a data-class declaration; or
2. a rendered data class lacks workbook-sheet coverage or an explicit documented exclusion in `EXPORT_CLASS_POLICY`.

This makes a new visible join an export obligation in the same change that adds its page mount.

## Before / after workbook evidence

The generated examples in `docs/evidence/export-refresh/` use request `20260617050` and public source URLs. The `before` workbook reproduces the former ten-column notice shape. The `after` workbook demonstrates the seven-sheet model, typed response time, iSupplier action link, lifecycle stage, entities, provenance, and rendered joined context. Regenerate them with:

```bash
node tools/build_export_refresh_evidence.mjs
```
