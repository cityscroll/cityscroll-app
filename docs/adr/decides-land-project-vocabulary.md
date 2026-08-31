# ADR: Split meeting-land concern from documented land decisions

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-31 |
| Scope | Exact City Record / ZAP meeting→project joins and ZAP dispositions |
| Supersedes | — |
| Related | `docs/adr/cross-domain-object-links.md`, `docs/adr/ontology-registry-v0.md`, `site/land_project_decision_relations.mjs` |

## Context

User feedback asked for meeting history on a land project to say what the record
establishes. The exact City Record ULURP/ZAP join is a good identity join and a
poor decision claim. `entity_resolution/cross_domain/object_links.mjs` emits
`decides_land_project` whenever a hearing body cites a ULURP token or ZAP project
that resolves in corpus. `site/project_connections.mjs` groups those edges as
meetings, while documented ZAP dispositions already have a separate
`project_disposition` group. The identifier still reads as if the meeting
decided the project.

Specimen: notice `20260608005` joins project `2023X0149` from ULURP token
`240206ZMX`, source fields `body` and `ulurp_numbers`, method
`exact_ulurp_token_v1`, tier `deterministic_exact_key`. That is a Bronx Borough
President public hearing, not a documented disposition. Project `2025K0305` has
draft Community Board 11, Community Board 13, and Borough Board outcome rows
with no vote or outcome value; those rows are not decisions.

## Decision

This is a semantic migration, not a mass rename.

1. **Canonical vocabulary** in `site/land_project_decision_relations.mjs` and
   `ontology/registry.v0.json`:

   | Relation | Meaning | Evidence threshold |
   | --- | --- | --- |
   | `about_project` | The record concerns the project | Exact project, application, or ULURP reference |
   | `reviews_project` | A hearing or review proceeding concerns the project | Same exact reference, plus hearing/review-body evidence |
   | `issues_recommendation` | A body issued a recommendation on the project | Retained recommendation document |
   | `project_disposition` / `adopts` / `rejects` | Documented decision | Explicit authoritative disposition |

   Every accepted claim carries source record, exact join key/value, source
   fields, method/version, observed time, and semantic threshold.

2. **Compatibility.** `decides_land_project` remains the public graph and
   calendar identifier for the exact meeting join until migration is explicitly
   complete. The adapter stamps canonical concern/review semantics onto those
   rows. It does not rewrite stored entity-intelligence edges.

3. **Non-decisional handling.** Unknown, fuzzy, missing-identifier, draft-only,
   and meeting-only inputs never mint `decides`, `issues_recommendation`,
   `adopts`, or `rejects`. A meeting title, venue, body identity, date, draft
   row, or exact project join alone is not a decision.

## Affected consumers

Preserve current `decides_land_project` data for:

- Entity intelligence (`object_links`, warehouse index, Worker D1 read models)
- Project connections (`site/project_connections.mjs`)
- Project calendar (`site/project_calendar.mjs`)
- Agency constellation / side-link indexing
- Functional land pivots (`test/functional/05_entity_pages_pivots.py`)

Reader copy for meetings stays the existing “Considered by” group. Documented
outcomes stay “Decided by”. Draft `2025K0305` rows stay out of that group.

## Consequences

Exact join tests remain on `decides_land_project`. New tests assert canonical
concern/review labels for `2023X0149` and reject draft/fuzzy/unknown decision
claims. A later card may retire the compatibility identifier after consumers
read `canonical_relation`.
