# ADR: Link evidence; do not silently merge records

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-12 |
| Scope | Cross-domain civic links, entity resolution, and public relationship surfaces |
| Supersedes | — |
| Related | `entity_resolution/cross_domain/edge_policy.mjs`, `docs/adr/cross-domain-object-links.md`, `test/public_relationship_graph.test.mjs` |

## Context

CityScroll joins records from different publishers: notices, contracts,
payments, land projects, property records, rules, meetings, and people. A
candidate relationship can be useful without proving that two source records
are the same object. Treating a candidate as an identity merge would erase the
source boundary and could put a claim from one publisher on the wrong record.

The cross-spine router already separates deterministic exact-key edges,
public-inferred edges that clear a held-out gate, evidence-only candidates, and
no-edge outcomes. Its comments state that uncertain candidates remain in
shadow storage and that evidence-only candidates never become public edges.

## Decision

Represent cross-domain relationships as typed, provenance-bearing links rather
than silently merging source records.

- Publish deterministic links only for exact publisher keys or other explicit
  identity contracts.
- Publish inferred links only when the relation-specific evidence and frozen
  held-out precision gate pass.
- Keep plausible but unproven candidates as `evidence_only` shadow evidence.
- Use `no_edge` for malformed, unknown, contradictory, or insufficiently
  evidenced candidates.
- Preserve source record identifiers, fields, and the basis for every public
  link; do not replace either source record with a synthetic merged identity.

## Alternatives

- Merge records whenever normalized names or titles are similar.
- Publish every candidate link and let reader interpretation supply the caveat.
- Keep all cross-domain candidates private and expose no public links.

## Rationale

The implementation makes the central risk explicit: a false merge is a worse
failure than a visible split. Exact publisher keys and measured relation gates
provide a narrower path to public links, while evidence-only storage preserves
useful candidates without presenting them as fact. This rationale is evidenced
by `edge_policy.mjs`, the public relationship-graph tests, and the existing
cross-domain ADR.

## Consequences

- Public pages can connect related civic objects without claiming that their
  publishers identified one shared entity.
- Every link needs provenance and a typed relation, increasing payload and
  test requirements.
- Uncertain candidates remain available for later measurement or review but do
  not silently change reader-facing identity.
- A future promotion requires a new measured gate or an exact key, not a prose
  change that upgrades confidence.

## Evidence

- `entity_resolution/cross_domain/edge_policy.mjs` — defines the four routing
  tiers, exact-key handling, relation evidence, and shadow-edge behavior.
- `docs/adr/cross-domain-object-links.md` — records typed edges, provenance,
  non-goals, and the no-silent-merge boundary.
- `test/public_relationship_graph.test.mjs` — verifies public omission of
  uncertain relationships.
- `test/cross_spine_shadow_census.test.mjs` — measures public-inferred versus
  evidence-only relation outcomes.
