# ADR: Exact legislative matter document route

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-23 |
| Scope | Exact static legislative matter document and Pages-edge route |
| Supersedes | — |
| Related | `docs/architecture.md`, `site/legislative_matter_document.mjs`, `architecture/generated/watermark.json` |

## Context

The committed meeting-outcome materialization retains exact Council matter identifiers,
meeting appearances, actions, source documents, vote tallies, and named person-vote rows.
Before this route, those facts were reachable only through meeting records and the official
publisher record; CityScroll had no independent matter document.

## Decision

Accept the bounded `/matters/78605/` document as a materialized Pages-edge surface. Its
read model is built from the committed meeting-outcome snapshot, and the route remains
exact-keyed. Committee navigation is emitted only when an explicit publisher BodyId is
present; otherwise the source committee label remains non-linking.

## Rationale

An independent matter route makes the retained legislative history directly navigable from
an existing meeting outcome, which is the smallest coherent way to expose actions, meetings,
votes, officials, and authoritative records as one evidentiary path. Reusing the existing
materialization keeps the route static-first and preserves source receipts. Exact-key and
explicit-BodyId gates prevent the new route from turning display text into an asserted identity.

The Pages-edge renderer and route canary counts and fingerprints therefore change together;
the committed architecture watermark records that reviewed topology change.

## Consequences

- `/matters/78605/` is an independently navigable document with deterministic not-found behavior.
- The Pages-edge renderer and route evidence must be re-baselined when this accepted surface lands.
- Broader matter coverage and independent vote objects remain separate future decisions.

## Evidence

- `site/data/legislative_matter_lookup.json` — exact-key materialization.
- `site/legislative_matter_document.mjs` — document projection and identity gates.
- `site/pages_edge.mjs` and `site/_routes.json` — Pages-edge handler and invocation boundary.
- `test/civic_law_receipts_matter_document.test.mjs` — route, receipt, vote, and committee-gate coverage.
