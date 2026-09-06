# ADR: One retained matter generation for pages and exact watches

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-09-06 |
| Scope | Shared publication generation for public matter pages and exact-watch update eligibility |
| Supersedes | — |
| Related | `docs/adr/legislative-matter-history-population.md`, `docs/adr/exact-council-matter-watch-updates.md`, `docs/adr/matter-exact-refresh.md`, `site/matter_publication_generation.mjs` |

## Context

Public matter pages read a committed lookup artifact. The Worker refreshes
retained observations and exact-watch delivery separately. A delivered update
could name an official action that the public page did not yet contain, and an
older static snapshot could be read as current coverage.

Pinned locators from the original design remain the owning route, document,
continuation, and builder modules: `site/pages_edge.mjs`,
`site/legislative_matter_document.mjs`,
`site/council_hearing_matter_continuation.mjs`,
`tools/build_legislative_matter_documents.mjs`, and `worker/src/alerts.mjs`.
`tools/build_meeting_outcomes_snapshot.mjs` remains the snapshot builder and is
not replaced. This change reuses those owners.

## Decision

Publish one validated, versioned retained matter generation before releasing
the corresponding exact-watch updates.

- Write lookup and index artifacts first. Promote the current-generation
  manifest last. An interrupted or incomplete publication leaves the previous
  complete generation in place.
- Pages read the published generation from retained CityScroll storage. When
  that generation is unavailable, the committed static lookup is an explicit
  older-generation fallback and must not claim current coverage.
- Page requests use retained published data only. They make zero publisher
  calls.
- A delivered update is eligible only when the page generation is the same as
  or newer than the generation named by that update. Updates whose destination
  is not yet published are held.
- Watch activation that claims successful following is gated on collector
  retention configuration and delivery readiness. Failed confirmation,
  unsupported source, stale refresh, incomplete history, and no later action
  located are distinct states.
- Approval copy retains the deciding body and stage, including subcommittee
  approval, and never claims testimony, an agency reply, or resident causation
  without separate evidence.

## Consequences

Matter pages and exact watches share one generation contract. An older static
snapshot remains usable and honest. Exact matter identity and save controls are
unchanged. A second matter model is not introduced.

## Evidence

- `site/matter_publication_generation.mjs` — generation comparison, coverage
  states, and publication read model.
- `worker/src/lib/matter_publication.mjs` — artifact-then-manifest publication.
- `worker/test/retained_matter_publication_generation.test.mjs` — generation, page,
  delivery, fallback, identity, and zero publisher-call coverage.
- `docs/evidence/retained-matter-publication-generation/manifest.json` — desktop,
  mobile, keyboard, native-link, Back, and failure-state capture proof.
