# ADR: Friendly resident geography navigation contract

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-09-17 |
| Scope | `site/geography_navigation_capability.mjs`, `site/geography_navigation_entry.mjs`, Near You layer vocabulary and fixtures |
| Supersedes | — |
| Related | `docs/adr/typed-geography-relations.md`, `site/civic_geography_registry.mjs`, `site/geography_relations.mjs`, `docs/design-principles-contextual-ux.md`, `docs/mobile-surface-contract.md` |

## Context

The closed civic-geography registry already distinguishes borough, community
district, City Council district, NTA 2020, police precinct, sanitation
district, and business improvement district classes. Near You's primary map
vocabulary and hierarchy still cover only borough, community district, and
Council district for orientation, while NTA and precinct membership already
exist in the generic record index. Residents need familiar words —
Neighborhoods, Community districts, Council districts, Precincts — without
being told that statistical neighborhoods, advisory districts, electoral
districts, and service areas are the same kind of thing.

Coordinates are the common key across layers. Treating NTA as a parent of
community district or Council invents a hierarchy the published polygons do
not support. Point membership and area overlap also need different language:
a station point may sit in one Council district while its neighborhood
polygon overlaps two.

## Decision

Project a small resident navigation capability from the existing closed
registry (`site/geography_navigation_capability.mjs`). Do not add a second
geography registry.

1. **First-slice layers.** Public navigation layers are exactly `nta2020`,
   `community_district`, `council_district`, and `police_precinct`.
2. **Primary order and copy.** The primary layer switcher is Neighborhoods,
   Community districts, and Council districts. More boundaries contains
   Precincts. Neighborhoods maps to `nta2020`. Detail copy names
   “NYC Neighborhood Tabulation Area (NTA 2020).” and keeps the statistical
   qualifier; it does not call an NTA an elected, advisory, or service
   institution.
3. **Default layer.** Neighborhoods (`nta2020`) is the default orientation
   layer when a residential NTA is available.
4. **Independent point membership.** A point is resolved independently
   against each public layer. No layer is derived from another
   (never NTA → community district → Council).
5. **Direct area relationships.** Area comparisons use direct polygon
   intersection evidence. A dominant-area or centroid shortcut is not an
   acceptable substitute for resident overlap claims.
6. **Point versus area language.** Point containment uses “At this
   location.” Area relationships use “overlaps” / “This neighborhood
   overlaps.” The two must not be collapsed into one “your district”
   claim about a whole neighborhood.
7. **Selection versus comparison.** Changing the comparison layer keeps the
   originally selected outline and record scope visible.
8. **Typed institutional relations.** Preserve the accepted typed-relation
   ADR: Council may project `represented_by`, precinct may project
   `served_by`, NTA projects `statistically_classified_as`, and community
   district remains deliberately untyped (no `represented_by` or
   `served_by`).
9. **NTA subtypes.** Residential and special-use NTA subtypes remain
   distinguishable. Parks, cemeteries, airports, Rikers Island, and other
   special statistical areas are not casually labeled as someone's
   neighborhood.
10. **Explicit omissions.** State Assembly, State Senate, sanitation
    districts, and BIDs are absent from the first-slice layer switcher.
    Their omission is a reviewed capability decision, not a missing option rendered disabled.
11. **Fallback.** Unknown or stale geography keys recover to the unselected
    navigator with an explanation rather than inventing a selection.
12. **Seeded fixtures.** The capability embeds the Sheepshead Bay station
    and City Hall point bundles, plus the BK1503 area-overlap fixture, with
    source vintages. Later cards consume these exact examples.
13. **Licensing.** No BetaNYC source, CSS, assets, tokens, or runtime
    dependency are added. Repository licensing remains MIT-compatible.

## Consequences

* Later Near You UI, URL state, map runtime, overlap drawer, and record
  handoff cards consume one capability record for labels, order, eligibility,
  language, and fixtures.
* The progressive Near You map adapter (`site/geography_navigation_map.mjs`)
  renders only committed simplified local layers through a MapLibre seam and
  leaves Land on `site/app/map_runtime.mjs`.
* Crosswalk builders and entry resolvers must honor independent point
  membership and direct polygon intersection; hierarchy shortcuts fail the
  contract tests.
* Address search, place-label selection, map clicks, and explicit geolocation
  resolve through `site/geography_navigation_entry.mjs` into the same point
  bundle and durable selection state. Coordinates and address query text stay
  ephemeral after containment.
* Adding State Assembly or State Senate requires a later card that registers
  independently versioned sources and proves a useful resident destination.
* Precincts remain searchable and comparable under More boundaries without
  competing with the three ordinary orientation choices.

## Resident journey verification

Selection is a coherent transition of the map, camera, URL, and materialized
record scope. Both short map tokens (`nta2020:BK0101`) and canonical record keys
(`geography:nta2020:BK0101`) resolve to the same scope. History updates must not
assign browser Location properties or discard unrelated record filters.

Native area links, overlap continuations, surface switches, and search forms
preserve topic, agency, keyword, and time filters too. Named-place GET searches
resolve against retained geography definitions and redirect to the canonical
selection; unresolved text never falls through to citywide record membership.
Deferred requests preserve their JSON endpoint when canonicalized.

Map labels use bundled, OFL-licensed Noto Sans glyphs from the application
origin. The navigator remains available when local record coverage is unavailable;
an unavailable membership is not a citywide result and an observed empty slice
is not missing coverage. Overlapping community-district record continuations are
labelled as broader areas, using the committed direct-intersection crosswalks.

`test/functional/54_neighborhood_map_journey.py` exercises the real MapLibre
renderer under the route's Content Security Policy at desktop and mobile widths.
It covers search, canvas clicks, area links, selected camera bounds, record
geography evidence, history/reload, missing coverage, related-district navigation,
record inspection, new-tab links, and native search submission. Local runs use the production slice builder with retained
data; `CROL_BASE` selects a deployed origin. The production canary makes no
assumption that a named upstream record or a fixed record count remains present.
