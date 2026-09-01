# Reviewed cutover inputs

This directory holds the source-owned inputs behind the repository control-plane
cutover proof. Each JSON file owns exactly one semantic key, and the document
`owner` must equal its `id`, so two candidates for one key fail validation
instead of resolving by filename order.

The whole-repository `cityscroll.repository_control_plane_cutover.v1` receipt is
derived from these inputs at check time. It is never tracked: a change that
introduces `docs/repository-control-plane/cutover.v1.json` into version control
fails the check.

## What the inputs assert

Four inputs describe bounded migrations. Each names the commit that executed a
group of classification entries, the number of entries and dispositions it
claims, and the before/after measurements a reader can reproduce. Three constant
inputs record the history decision, the authorized-maintainer access contract for
privatized evidence, and the reconciled coverage deltas between the
classification manifest and what the migrations actually carried.

Every entry in `classification.v1.json` is claimed by exactly one migration
input. An entry claimed twice, or claimed by none, is a hard failure: the proof
exists to show that nothing classified was executed twice or silently left
behind.

## Why before and after are anchored to commits

`before` is observed at the migration commit's parent and `after` at the
migration commit itself. Both are immutable, so an unrelated documentation change
can never make a reviewed exhibit stale. `tip_relation` is the only field that
reads the current tip, and it asserts a stable invariant rather than a snapshot:
migrated control-plane content stays absent, and the root instruction file stays
under its ceiling. A later change that reintroduces migrated content fails here
and in the changed-path guard.

## Validation

`node tools/rcp05_cutover_receipt.mjs --check` re-derives every input from the
repository, compares it against the reviewed values, and then runs the proof:
entry partition and one-owner reconciliation, the before/after measurements, the
control-plane content scan at each migration boundary and at the tip, retained
architecture-evidence projection resolution, authorized-maintainer resolution for
every privatized disposition, the served `site/` and `worker/` diff for each
migration, and reachability of every migration commit from `HEAD`.

A missing, stale, malformed, duplicate, or unrecognized input is a hard failure
with a named finding. `--check` never writes source inputs; `--write` emits the
derived receipt under `.artifacts/` for local inspection.

## Ownership has two axes

`disposition_owner` names who owns the repository-side act, and is always
resolved. `outcome_owner` names who owns the product outcome the migrated intent
described. The migration deliberately left some outcome owners unresolved rather
than inventing a record for them, and the check requires that state to stay
explicit. An unresolved outcome owner is a reported count, never an implied pass.

The machine schema is
[`cutover-shard.v1.schema.json`](../cutover-shard.v1.schema.json).
