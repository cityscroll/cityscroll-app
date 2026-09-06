# ADR: Publish a history for every retained exact legislative matter

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-09-06 |
| Scope | Legislative matter read model, published population, and matter identity |
| Supersedes | — |
| Related | `docs/adr/legislative-matter-document-route.md`, `site/legislative_matter_availability.mjs`, `docs/module-map.md` |

## Context

`docs/adr/legislative-matter-document-route.md` accepted `/matters/78605/` as a
bounded proof that a matter could be an independently navigable document, and
left "broader matter coverage" as a separate future decision. This is that
decision. It does not replace that record: the route, its exact-key rule, and
its explicit-BodyId gate stand as accepted there. What changes is the population
the route answers over and how matter identity is established.

The builder behind that route selected one matter id and required it to have at
least two observed appearances. The retained Council meeting materialization
holds 66 exact matters across 78 references, of which 56 have exactly one
observed appearance. So the rule that made the route provable also made
CityScroll's coverage look arbitrary: a reader who attended a hearing about any
of the other sixty five matters was handed off to the publisher, while a reader
who attended one particular hearing got a local history. Nothing about the
retained evidence justified that difference — only the shape of the builder did.

Two further properties of the retained input made a naive generalization unsafe.
A Council meeting is often announced by more than one City Record notice, so the
same matter at the same event is observed twice; counting references as
appearances would have shown a reader two hearings where one occurred. And a
publisher can rename a matter, so an identity check that compared display labels
would have failed the build on an ordinary title change.

## Decision

Publish a local history for every exact retained matter with one or more
appearances.

- **Matter identity** is publisher system, publisher tenant, and immutable
  publisher matter id together (`legistar:nyc:matter:79200`). A numeric id
  claimed by two tenants is an ambiguity, not a merge: neither is published, and
  the collision is recorded in the artifact.
- **Appearance identity** is the native publisher event. Every notice that
  referenced the matter at that event is retained on the single appearance as
  provenance and rendered with its own identifier.
- **Display labels are mutable and identity is not.** A renamed matter keeps one
  history, displays the latest observed label, and retains the earlier ones as
  observed revisions instead of failing an identity-drift check.
- **A single appearance is a complete history, not a failure.** The page states
  how much has been located and explicitly declines to convert that into a claim
  that nothing further happened or will happen.

`tools/build_legislative_matter_documents.mjs` remains the one owner. It now
writes two artifacts from one pass over one input: the full retained history in
`site/data/legislative_matter_lookup.json`, read by the route that renders a
matter, and the compact published population in
`site/data/legislative_matter_index.json`, read by
`site/legislative_matter_availability.mjs`. The index is a projection of the same
generation — ids and official addresses, no appearances, actions, votes, or
receipts — added because the availability rule is in the browser's first-load
module graph and must not pull every retained appearance to answer "does this id
have a page".

## Rationale

Publishing by membership rather than by a named target removes the class of bug
rather than one instance of it: a matter that enters the materialization is
published and one that leaves it is not, with no list to keep in step. The
existing route, renderer, availability rule, and calendar/list presentation are
unchanged and now answer over the whole population, so this is a change of
population and identity handling rather than a new delivery surface.

Coalescing by event identity is what lets the read model be honest about volume.
Two notices for one meeting are two announcements, and the page now says so
while keeping both references openable.

The compact index exists because the two questions have different costs. "Which
ids have a page" is asked on every meetings surface, including the browser's
first paint; "what is this matter's history" is asked once, by the route that
renders it. Deriving both from one builder run is what keeps them from
describing different populations.

## Consequences

- All 66 retained matters resolve at `/matters/<id>/`. A matter continuation,
  the meetings list, and the first-paint snapshot now offer a local history for
  every retained identity, and the official-record fallback remains for
  identities the generation does not publish.
- The published lookup grows with the retained population. The browser's
  first-load JSON does not, because the availability rule reads the index.
- Frozen counts (66 matters, 76 appearances, 78 references, 10 two-event and 56
  one-event histories) describe the committed corpus at its own data vintage.
  They are an offline oracle for the builder, not a claim about live publisher
  coverage.
- Evidence captured before this change — including the specimen that showed
  matter 79200 as an official-record handoff — describes the population at its
  own recorded revision and is not re-stated as current behavior.
- Watching a matter for later official action, refreshing a matter without a new
  notice, and surviving snapshot replacement remain separate decisions. Nothing
  here polls a publisher or creates a saved watch.

## Evidence

- `tools/build_legislative_matter_documents.mjs` — population, identity, and
  coalescing rules; writes both artifacts.
- `site/data/legislative_matter_lookup.json` and
  `site/data/legislative_matter_index.json` — the two generations.
- `site/legislative_matter_document.mjs` — notice references, observed label
  revisions, and the located-history disclosure.
- `test/legislative_matter_history_population.test.mjs` — population, route,
  deduplication, identity, ordering, provenance, parity, and failure coverage.
- `docs/evidence/legislative-matter-history-population/manifest.json` — rendered
  capture manifest with route, viewport, revision, data vintage, assertion, and
  SHA-256 per capture.
