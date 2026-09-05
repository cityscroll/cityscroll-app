# ADR: Section-aware RER extraction and the as-filed community-profile snapshot

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-09-05 |
| Scope | `ontology/racial_equity_report_fields.mjs`, `warehouse/lib/land_filing_report_extractor.mjs` |
| Supersedes | — |
| Related | `docs/adr/land-use-filing-ontology.md`, `docs/adr/attachment-text-embeddings.md`, `warehouse/lib/document_processing.mjs` (LDP-33) |

## Context

LDP-23 registered `cityscroll.racial_equity_report.v1`: a typed,
provenance-first envelope whose top-level identity fields (`document_ref`,
`applicant`, `preparer`, `source_bytes_sha256`, `extraction_version`,
`extraction_quality`) it populates, but whose narrative content sections
(`application_scope`, `proposed_development_scope`, `residential`,
`non_residential`, `construction_employment`, `community_profile`,
`displacement_risk`, `executive_summary`, `fair_housing_narrative`) it left as
bounded opaque JSON placeholders on purpose. This card gives those sections a
real per-field schema, an extraction pipeline, and page/span/region evidence.

## Decision

1. **`buildExtractedField` (`ontology/racial_equity_report_fields.mjs`)** is
   the one wrapper every normalized RER value goes through. Two disjoint
   shapes are enforced structurally, not by convention: an abstained field
   cannot carry a value and must carry `abstention_reason`; a non-abstained
   field cannot be built without `raw_value`, `method`, `extractor_version`,
   `confidence`, and an evidence location (`page_number`, `span`, and/or a
   bounding `region` -- at least one is required). A figure without its
   basis is a number, not evidence; this module cannot represent one.

2. **Section separation.** `application_scope` and
   `proposed_development_scope` are two disjoint field-name enums
   (`APPLICATION_SCOPE_FIELDS`, `PROPOSED_DEVELOPMENT_SCOPE_FIELDS`); a
   section builder rejects a field name from the other scope's vocabulary,
   so the two can never merge, matching the official form's own allowance
   that they differ.

3. **The as-filed community-profile snapshot** (`buildCommunityProfileSection`)
   carries a hard-coded `as_filed: true` no caller can override, plus a
   required `geography`, `vintage`, and `methodology_state`, and rejects any
   key resembling live/current data (`current_data`, `current_value`,
   `refreshed_at`, `refreshed_from`, `updated_from_current`, `live_value`,
   `edde_ref`) at construction time. The negative rule -- current
   neighborhood data must never overwrite a historical filed value -- is
   enforced by absence, not a runtime check: `extractRacialEquityReportSections`
   (`warehouse/lib/land_filing_report_extractor.mjs`) accepts only a
   document's own `pages`/`tables` and an injected `semanticExtract`; there
   is no parameter through which a caller could route a current-data source
   into any section.

4. **Displacement Risk Index** (`buildDisplacementRiskSection`) re-checks
   `interpretation === "contextual_not_project_prediction"` independently of
   LDP-23's envelope builder, and requires `geography`/`vintage`/
   `methodology_state` alongside the typed `index_value` field -- it can
   never be constructed as a bare number.

5. **Narrative labelling** (`buildExecutiveSummarySection`,
   `buildFairHousingNarrativeSection`): `source` is required and is either
   `applicant_narrative` (carries its own page/span evidence, since it is a
   direct excerpt of filed text) or `generated_summary` (carries no evidence
   location of its own and instead requires at least one `evidence_refs[]`
   entry naming the extracted fields it summarizes -- a generated summary
   with no evidence trail cannot be built).

6. **The four-stage pipeline** (`extractRacialEquityReportSections`), run
   per field and never reordered:
   - *Deterministic text*: explicit-label regex matching against a page's
     text (`DETERMINISTIC_TEXT_PATTERNS`); confidence `high`.
   - *Deterministic table*: header-keyword matching against already-parsed
     table rows for income-band and job/wage tables; confidence `medium`.
     Two income-band tables that disagree are a named conflict, not
     something this pass resolves by picking one -- the affected fields
     abstain with the conflict stated. A numeric job-count field
     (`permanent_jobs_estimate`, `construction_jobs_estimate`) is filled
     only from a table whose own content identifies which job type its
     total row counts; an unlabelled or ambiguous total fills neither.
   - *Constrained semantic extraction*: an injected `semanticExtract`
     function runs only for fields stages 1-2 left missing, and only its
     evidence-bearing output (its own `raw_value` plus a page/span/region)
     is accepted -- a bare `{ value }` with no location is discarded, never
     trusted. The two job-count fields are excluded from this stage
     entirely: a narrative job claim can reach `workforce_claims` but never
     a typed numeric estimate.
   - *Abstention*: any field the first three stages did not fill is built
     via `buildExtractedField({ abstained: true, abstention_reason })`,
     always naming why.
   Page/table quality is assessed via LDP-33's `assessPageQuality`
   (`warehouse/lib/document_processing.mjs`) -- this card adds no OCR engine
   of its own; a page with no text layer and no OCR engine available is
   reported `measured: false` and its fields abstain, exactly as LDP-33
   already documents.

7. **One envelope per document, always.** `assembleRacialEquityReportEnvelope`
   builds a full envelope from one `land_use_filing_document` record and one
   extraction result; it requires `document.bytes_sha256` (extraction only
   ever runs against hashed, immutable bytes) and there is no "merge into an
   existing envelope" path. A superseding document version always produces
   its own independent envelope; the earlier envelope's as-filed sections are
   never touched, because nothing in this module's API can reach them.

## Non-goals

- No OCR/optical-recognition engine (LDP-33's own scope boundary;
  `assessPageQuality` already reports `measured: false` for a page with no
  text layer and none available).
- No PDF/byte parsing of any kind -- this module consumes already-parsed
  `pages`/`tables`, matching how LDP-24's `retrieveLandFilingDocument` takes
  an injected `extractText`.
- No live/host-time semantic-extraction call inside this module or its
  tests; `semanticExtract` is always caller-injected.
- No certification-probability or displacement-prediction feature; the DRI
  stays contextual only (`DRI_INTERPRETATION`, LDP-23).
- No resident-facing UI, API, or MCP surface change (LDP-27).
- No re-derivation, backfill, or "refresh" of an already-assembled envelope
  from current data of any kind.

## Consequences

`racial_equity_report.v1`'s narrative sections now have a real, testable,
evidence-first schema instead of an opaque placeholder. Downstream cards
(LDP-26 filing sequence, LDP-27 filing-evidence surfaces) can rely on every
populated field carrying its own page/span/region, raw value, method,
extractor version, and confidence, and on an abstained field always naming
why rather than silently reading as zero or absent-by-omission. `grounding`
for the `racial-equity-report` object type in `ontology/registry.v0.json`
remains a decision for the card that first wires this pipeline to a real
document corpus (no live materialization exists yet); this card ships the
contract, the pipeline, and its gate (`npm run warehouse:land:rer`) against
synthetic fixtures only.
