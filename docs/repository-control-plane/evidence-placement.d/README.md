# Reviewed evidence-placement inputs

This directory holds the source-owned inputs behind the repository
evidence-placement proof. Each JSON file owns exactly one semantic key, and the
document `owner` must equal its `id`, so two candidates for one key fail
validation instead of resolving by filename order.

The whole-repository `cityscroll.repository_evidence_placement.v1` receipt is
derived from these inputs at check time. It is never tracked: a change that
reintroduces `docs/repository-control-plane/evidence-placement.v1.json` into
version control fails the check.

## Input identity

- Constant keys use `<key>.json`.
- A document-tree key `document-tree:<a>/<b>` uses `document-tree--<a>--<b>.json`.
  A tree segment may use `a-z`, `0-9`, `.`, `_`, and single `-`; a segment must
  not contain `--`, so the filename decodes back to exactly one key.
- A document tree is the first two path segments of a placement input, or the
  single segment for a top-level file. Private evidence under `docs/evidence`
  and private evidence under `docs/screenshots` are therefore independently
  owned, and an independent change edits only its own tree.

The machine schema is
[`evidence-placement-shard.v1.schema.json`](../evidence-placement-shard.v1.schema.json).

## Validation

`node tools/rcp03_evidence_placement.mjs --check` re-derives every input from
the inspected commit recorded in `input_revision`, compares it against the
reviewed values, aggregates the inputs deterministically in memory, and then
runs the tip guards: private schemes stay out of retained public content and
out of served artifacts, raw review-inventory rows stay out of the public
review document, retained proof paths resolve, placement inputs never overlap
`site/` or `worker/`, and the served blob set at the inspected commit is
unchanged.

A missing, stale, malformed, duplicate, or semantically incomplete input is a
hard failure with a named finding. `--check` never writes source inputs.

## Re-deriving an input

A reviewed refresh names every intended key explicitly:

```sh
node tools/rcp03_evidence_placement.mjs --write-shards \
  --shard-id document-tree:docs/evidence
```

`--write` emits the derived compatibility receipt under `.artifacts/` (or
`--output-dir <dir>`) for local inspection and CI upload. That projection is a
build output; it must not be committed.
