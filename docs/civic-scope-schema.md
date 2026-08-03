# Civic scope schema — topic (citywide) vs place

## Why this exists

Rules and hearings were modeled on separate pipelines:

- **Rules** default to citywide topic scope (`rule_location.mjs`) and join NYC Rules
  for lifecycle links.
- **Hearings** extract affected geography and venue separately (`hearings.mjs` /
  `hearing_location.js`) but do not declare a shared scope class with rules, and
  hearing geocodes historically stopped at borough/neighborhood.

That split cannot express the Dining Out NYC case study:

| Record | Real identity | Scope that matters |
| --- | --- | --- |
| DOT Dining Out NYC program rule | City Record `20240129008` + [NYC Rules program page](https://rules.cityofnewyork.us/rule/dot-proposed-rule-outdoor-dining/) | **Topic / citywide** — program rules apply everywhere |
| Cafe revocable-consent hearings | e.g. City Record `20260723005` | **Place** — each petition is a sidewalk/roadway cafe at a street address |

Someone looking up “Dining Out NYC” needs both, without mistaking a citywide rule
hearing for a neighborhood consent, or a consent pin for a citywide program change.

## Schema (v1.0.0)

Module: `worker/src/lib/civic_scope.mjs`  
Cafe petition parser: `worker/src/lib/cafe_consent.mjs`  
Characterization fixtures: `test/contract/fixtures/dining_out_nyc.json`  
Tests: `test/contract/civic_scope_dining_out.test.mjs`

Shared fields on every record:

| Field | Meaning |
| --- | --- |
| `kind` | `citywide_rule` · `place_consent` · `place_hearing` |
| `scope_class` | `topic` (citywide program/rule) or `place` (address-level matter) |
| `citywide` | Boolean mirror of the flag consumers already expect |
| `places[]` | Empty for topic records; one or more pins for place records |
| `modality` | `in-person` · `remote` · `hybrid` · `not-stated` |
| `accessibility` | `{ stated, summary, accommodations_url, note }` — never invents text |
| `deadline` | Hearing, comment, or effective date when known |
| `action.primary` + `action.routes` | Official HTTPS handoffs (NYC Rules, City Record, Zoom, diningoutnyc.info) |
| `outcome` | Lifecycle or hearing status; grant/deny is explicit when absent |
| `sources` | City Record and/or NYC Rules pointers |

Place pins may carry:

`label`, notice `borough`, `neighborhood`, `latitude`, `longitude`, `bbl`,
`community_district`, `council_district`, `cafe_type`, `petitioner`,
`geocode_status` (`matched` · `borough_mismatch` · `unresolved`).

Notice borough is authoritative. When GeoSearch returns a different borough, the
pin keeps the notice borough and sets `geocode_status: "borough_mismatch"`.

`expandPlaceConsentRecords` turns a multi-petition hearing into one map-friendly
record per cafe pin.

## Materialized mapping

Daily hearing geocodes (`worker/src/hearings.mjs`) now resolve subject addresses
with coordinates and BBL (same GeoSearch shape as Property), so place pins can be
mapped without a live client call to upstream geocoders. Community and council
districts are attached in the civic-scope layer from precomputed MapPLUTO lookups
keyed by BBL (fixture-backed in tests).

## Open schema questions (follow-ups)

1. **Per-petition vs parent hearing as the primary key** — v1 keeps the City Record
   notice as the parent and offers expansion for maps. Product surfaces may prefer
   petition-first cards.
2. **Grant/deny outcomes for revocable consents** — no machine-readable public
   outcome feed is joined yet; outcomes stay `scheduled` / `held` with an explicit
   “no grant/deny outcome record found” summary.
3. **Community/council district source of truth** — committed `district_boundaries.json`
   point-in-polygon (community + council, labeled `boundary_vintage`); MapPLUTO `cd` by
   BBL works when geocode BBL is correct; borough mismatches need a guarded retry
   (borough-biased geocode or PAD filter) before districts are trusted in UI.
4. **Accessibility language** — most Dining Out notices do not state
   accommodations; `stated: false` is honest. Whether remote Zoom hearings should
   inherit a default remote-access note is undecided.
5. **Cross-link from citywide rule → related place consents** — topic records do
   not yet enumerate open consent hearings under the same program.

Community-board / advocate validation sessions are out of scope for this schema
pass.
