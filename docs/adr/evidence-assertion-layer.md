# ADR: Evidence assertion layer (public claims)

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-01 |
| Scope | Claim classification vocabulary + public product surfaces that show multi-source amounts/dates |
| Supersedes | — |
| Related | `entity_resolution/review/assertion_evidence.mjs`, public entity dossier, OCP award side-car |

## Context

CityScroll joins publisher feeds (City Record, Checkbook NYC, OCP awards, PASSPort, and
others). Dual-write source records already keep immutable observations. Without a named
claim layer, UI copy can misattribute a CityScroll comparison, join, or display choice as
if the publisher asserted a single resolved value.

The civic-intelligence factory stream (`cs-ev-*`) needs a thin, reusable rule:

**source assertion ≠ CityScroll interpretation ≠ derived conclusion.**

## Decision

Every public multi-source claim uses one of three classifications. Machine fields use the
snake_case tokens below; user-facing English uses the reader labels.

| Classification | Reader label | Meaning | Must not |
| --- | --- | --- | --- |
| `source_assertion` | Source assertion | A value taken from a named publisher field (system + field + value + observation time when known) | Be rewritten by CityScroll comparison logic |
| `cityscroll_interpretation` | CityScroll interpretation | CityScroll’s reading: parse, compare, conflict detect, join status | Be shown as “the city said” or as a selected winner |
| `derived_conclusion` | Derived conclusion | A product-facing summary built from evidence (e.g. dossier display name) with explicit `evidence_assertion_ids` | Pretend to be a publisher field |

### Hard rules

1. **Publisher values remain assertions.** When two feeds disagree on amount or date, both
   `source_assertion` values stay visible with source names.
2. **Conflict detection is an interpretation.** “These differ” / “unresolved” is
   `cityscroll_interpretation` with `resolution: "unresolved"` — never a silent pick.
3. **No winner without a derived conclusion.** Selecting a single display amount/date for
   the reader is only allowed when labeled `derived_conclusion` and linked to the evidence
   assertions it used. Prefer showing both assertions over inventing a winner.
4. **Missing is not a false assertion.** Unmatched joins and gap-taxonomy empty slots stay
   operational gap copy; they are not “the source said null.”

### First product surface

**Procurement notice lifecycle — OCP award side-car.** When City Record and Recent Contract
Awards (OCP) disagree on award amount or date, the UI labels each value as a source
assertion and labels the disagreement as an unresolved CityScroll interpretation with no
derived winning amount/date.

Desk ER assertion evidence and the public entity dossier already use the first two (and
dossier display name as a derived conclusion). This ADR freezes the three-way vocabulary
so new surfaces do not invent a fourth register.

### Non-goals

- No graph store, ontology platform, or vendor-brand product language
- No new city data feeds until a measured gap requires one
- No LLM scoring of which assertion “wins”
- No replacement of gap taxonomy (class a/b) or digest delivery identity

## Consequences

- `worker/src/lib/claim_layer.mjs` is the shared pure vocabulary builders for product
  surfaces (OCP first). ER desk evidence keeps its package path; both use the same
  classification tokens.
- Characterization tests and headless captures gate the OCP disagreement labels.
- Later `cs-ev-*` cards (provenance coverage, first-class contradiction rails) attach to
  this vocabulary rather than redefining it.

## Coverage metric

`public_claim_labeled_disagree_rate` on OCP-joined awards:

```
labeled_disagreements / ocp_joined_with_field_disagreement
```

A matched OCP join is eligible only when City Record and OCP disagree on amount and/or
date. It is labeled only when every disagreement row carries a complete `claim_layer`
bundle (two `source_assertion` values, unresolved `cityscroll_interpretation`, null
`derived_conclusion`). Agreeing joins and unmatched/unknown/ambiguous joins are not
eligible. Pure measure: `measurePublicClaimLabeledDisagreeRate` in
`worker/src/lib/claim_layer.mjs`. Field cases:
`worker/test/fixtures/claim-layer/ocp_joined_awards.json`. Target: **1.0** on product
join output (baseline without claim labels: **0**).

## Verify

```bash
node --test worker/test/claim_layer.test.mjs worker/test/ocp_awards.test.mjs
node --test test/lifecycle_render.test.mjs test/entity_resolution_assertion_evidence.test.mjs
python3 tools/capture_assertion_claim_layer.py
```

## Rollback

Revert claim-layer helpers, OCP corroboration claim payloads, lifecycle copy keys, dossier
derived classification label, this ADR, and the capture folder. No schema migration.
