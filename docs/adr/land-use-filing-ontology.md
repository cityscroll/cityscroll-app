# ADR: Land-use filing obligation, filing document, and RER envelope contracts

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-09-04 |
| Scope | `ontology/land_use_filing.mjs`, `ontology/registry.v0.json` object/link types |
| Supersedes | — |
| Related | `docs/adr/ontology-registry-v0.md`, `docs/adr/decides-land-project-vocabulary.md`, `warehouse/receipts/proof/land_filing_evidence_census_latest.json` |

## Context

A Racial Equity Report on Housing and Opportunity (RER) is an applicant filing
attached to a ULURP-family land-use application under NYC Administrative Code
§ 25-118. CityScroll's Land Use Decision Path already models project
procedure, stages, and CEQR identity, but had no way to represent "a filing
was required," "a document was observed," or "the filing has no bearing on
certification" as distinct, separately sourced facts.

LDP-22 ran a full-population host-side census of ZAP's project-detail API and
recorded a bounded GO/NARROW/STOP receipt
(`warehouse/receipts/proof/land_filing_evidence_census_latest.json`):

| Surface | Result | Why |
| --- | --- | --- |
| RER document observation | **GO** | RER-titled artifact groups are reliably discoverable via title-token matching on `dcp-name`; bytes are fetchable and hashable without authentication. |
| Filed LU Package version history | **GO** | `packages` is an explicit publisher relationship type with an explicit `dcp-packageversion`, submission date, and stable per-version document list. |
| Notice of Receipt / Certification-or-Referral | **NARROW** | Observable only by the same title-token method as RER (tier 2, not tier 1) — proceed, but never claim complete coverage or a timeliness/transition fact from it. |
| RER applicability-state derivation | **STOP** | `dcp-applicability` reads `"Yes"` on both a project carrying an observed RER artifact group (`2025Q0247`) and one with none (`2026K0123`). No ZAP field encodes RER applicability; deriving `required`/`not_required` would mean reconstructing DCP's criteria-chart inputs (zoning square-footage deltas, contiguous-block counts) that ZAP's project-level data does not carry. |
| CEQR document overlap | **STOP until SEQRA-04** | No CEQR document identity exists yet to overlap against; SEQRA-04 owns CEQR Access acquisition. |
| WRP / other report candidates | **STOP** | Out of scope by the commission's own negative rule; no WRP-titled artifact group was observed regardless. |

## Decision

Register three versioned contract envelopes in `ontology/land_use_filing.mjs`
and `ontology/registry.v0.json`, plus the five commissioned relations. This
card (LDP-23) registers and validates the contracts; it does not collect,
fetch, parse, or extract anything.

1. **`cityscroll.land_use_filing_obligation.v1`** — a source-qualified
   obligation with the five-state `applicability` and `fulfillment`
   contracts. The census STOP is enforced structurally, not just
   documented: `buildLandUseFilingObligation` throws unless
   `applicability.state` is `required`/`not_required` *and* an explicit
   `applicability.publisher_assertion` (source field, value, and observed
   time) is present. A title-token artifact-group match can only ever
   populate `applicability.reconstructed_candidate`, which carries a
   hard-coded `public: false` that no caller can override. Every
   `racial_equity_report` obligation's `procedural_effect.certification_blocker`
   is forced `false` (DCP: failure to submit an RER does not stop
   certification or referral).

2. **`cityscroll.land_use_filing_document.v1`** — a version-preserving
   document manifest entry. Identity is derived from the project, the
   publisher's own document id, and the first-observed clock — never from
   the filename — so a same-name/different-ID collision and a
   same-name/different-hash re-upload both stay distinct records, linked
   through `supersedes`/`supersession_basis` or `content_duplicate_of`
   rather than collapsed. `document_type: "ceqr_document_link"` is
   rejected at construction time (STOP until SEQRA-04 owns shared CEQR
   document-processing).

3. **`cityscroll.racial_equity_report.v1`** — a typed, provenance-first
   envelope covering only the eight required top-level identity fields
   (`document_ref`, `project_ref`, `applicant`, `preparer`,
   `report_preparation_date`, `source_bytes_sha256`, `extraction_version`,
   `extraction_quality`). The narrative content sections (residential,
   non-residential, community profile, displacement risk, fair-housing
   narrative, …) are typed as bounded opaque JSON placeholders that LDP-25
   will give real per-field schemas and extraction to; this card never
   parses or populates them. `displacement_risk.interpretation`, when
   present, must equal `"contextual_not_project_prediction"`. The builder
   rejects `ceqr_ref`/`is_ceqr`/`seqra_ref`-shaped keys outright — RER
   identity is never a CEQR subtype.

Five relations (`has_filing_obligation`, `filed_for_project`,
`satisfies_obligation`, `published_as_evidence`, `supersedes_document`) are
registered as `cityscroll.land_use_filing_relation.v1` edges. An `accepted`
relation requires a real `source_observation` (source field + value);
filename similarity alone cannot mint one. `satisfies_obligation` is the
strong link (the document IS the qualifying fulfillment artifact);
`published_as_evidence` is deliberately weaker (e.g. a notice or package
version relevant to the obligation's procedural context) and never sets
`fulfillment.state` by itself.

`projectLandUseFilingAsOf({ obligations, documents, relations, cutoff })`
filters every fact to what was visible by its own `available_to_public_at` /
`observed_at` clock, and further requires a relation's *named endpoints* to
already be visible before the relation itself surfaces — no later clock
backfills an earlier one. `resolveCurrentFilingDocumentVersions()` finds the
un-superseded head of a (already as-of-filtered) version chain while leaving
every prior version individually inspectable.

## Non-goals

- No statutory-criteria engine, reconstructed applicability candidate beyond
  the explicit non-public `reconstructed_candidate` field, threshold/action
  inference, or operative-date derivation (LDP-22 STOP).
- No document collector, byte fetcher, OCR/extraction pipeline, or RER
  content parser (LDP-24/LDP-25).
- No CEQR join, fetcher, or populated `ceqr_document_link` (blocked until
  SEQRA-04's shared-processing ownership decision).
- No WRP ontology, type, relation, parser, or claim.
- No resident-facing UI, API, or MCP surface change (LDP-27).

## Consequences

Downstream cards (LDP-24 document manifest, LDP-25 RER extraction, LDP-26
filing sequence) build on these contracts rather than inventing their own
obligation/document identity. Existing ZAP projection (`LDP-02`), CEQR exact
joins (`LDP-13`), and the LDP-22 census remain untouched and green; no
resident payload changes. `grounding` on all three new object types and five
new link types is recorded as `gap` — schema, validators, and tests exist,
but zero live materialization exists yet, honestly reflecting that LDP-24
onward still own wiring a real collector to this contract.
