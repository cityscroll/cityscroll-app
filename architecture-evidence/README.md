# Generated architecture-evidence inventories

`architecture/evidence.d/` is the only committed architecture-evidence input
layer. The `cityscroll.card-inventory.v1` and
`cityscroll.card-projection-inventory.v1` aggregates are derived at check or
build time. Do not add `source-cards.json` or `projections.json` here.

Check with `node tools/architecture_evidence_shards.mjs --check`. Optional local
materialization goes to `.artifacts/architecture-evidence/` via `--write`.
