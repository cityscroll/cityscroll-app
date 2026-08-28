# Historical land-use Council actor resolution v1

Card 3 is implemented by
[`worker/src/lib/land_prediction_actor_resolution.mjs`](../worker/src/lib/land_prediction_actor_resolution.mjs).
It is a pure join over caller-supplied snapshots:

```text
application -> location -> Council district boundary vintage -> officeholder term
```

## Contract

`resolveLandUseApplicationActors(application, options)` requires an application
identifier and `prediction_as_of`. Locations may contain coordinates or a
publisher-supplied Council district. Coordinate resolution uses only boundary
entries with an explicit `effective_at` at or before the cutoff, an optional
`effective_until` after the cutoff (validity interval
`[effective_at, effective_until)`), and source observation no later than the
cutoff. A current boundary with no historical validity interval therefore
cannot resolve an old application.

The result retains one row per location. Each row contains:

- `district`: `resolved` or `unknown`, the district id, boundary vintage,
  source, clocks, and an explicit reason when unresolved;
- `officeholder`: `resolved`, `vacant`, or `unknown`, with the exact
  `official:{PersonId}` identity, historical term, source, and clocks;
- `provenance`: location, district, and officeholder stages.

Applications with multiple locations retain every district and officeholder in
`locations`, `council_district_ids`, `officeholders`, and
`historical_actors`. A complete application is resolved only when every
location has a resolved district and either a historical officeholder or a
source-backed vacancy. Missing, conflicting, or incomplete evidence is
explicitly `unknown`.

The person hub is consumed through its historical `terms[]` rows. The resolver
does not consult `current_term` or the person-level current district, and it
does not infer an identity from a name. `historicalCouncilActorResolver()` is
the adapter for the c2 snapshot callback and always uses the callback's
`as_of` cutoff.

Focused proof:

```sh
node --test worker/test/land_prediction_actor_resolution.test.mjs worker/test/land_prediction_snapshot.test.mjs
```
