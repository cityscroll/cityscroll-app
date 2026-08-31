# Architecture-evidence entries

`architecture/evidence.d/` is the source-owned architecture-evidence registry.

Each card or change owns one stable entry file. Unrelated changes must not edit
another card's entry or a shared generated inventory. The files
`architecture-evidence/source-cards.json` and
`architecture-evidence/projections.json` are derived at check/build time and
must not be tracked.

## Entry identity

- Entry `id` is the card id (for example `cityscroll-land-map-view/lm-02-project-point-materializer`).
- The file path is `architecture/evidence.d/<id with each / replaced by -->.json`.
- Path segments may use `a-z`, `0-9`, `.`, `_`, and single `-`. A segment must not contain `--`.
- The filename must decode back to the JSON `id`. A collision, duplicate `id`, or id/path mismatch fails closed.

## Schema

Entries use `cityscroll.architecture-evidence-entry.v1`. The machine schema is
[`architecture/evidence-entry.v1.schema.json`](../evidence-entry.v1.schema.json).

## Aggregation

`node tools/architecture_evidence_shards.mjs --check` discovers every entry,
sorts by `id`, validates schema and identity, and derives the existing
`cityscroll.card-inventory.v1` / `cityscroll.card-projection-inventory.v1`
aggregates in memory. `--check` is read-only. `--write` may emit the same
shapes under `.artifacts/architecture-evidence/` for local inspection. A
guard rejects attempts to track or edit the generated aggregate paths.
