# Architecture-evidence entries

`architecture/evidence.d/` is the source-owned architecture-evidence registry.

Each change owns one stable entry file. Unrelated changes must not edit another
entry or a shared generated inventory. The files
`architecture-evidence/source-cards.json` and
`architecture-evidence/projections.json` are derived at check/build time and
must not be tracked.

## Entry identity

- Entry `id` is a **stable public change or engineering-record identity** — the
  name this repository knows the work by, for example
  `cityscroll-land-map-view/lm-02-project-point-materializer` or
  `cityscroll-engineering/shared-dependency-store`.
- The file path is `architecture/evidence.d/<id with each / replaced by -->.json`.
- Path segments may use `a-z`, `0-9`, `.`, `_`, and single `-`. A segment must not contain `--`.
- The filename must decode back to the JSON `id`. A collision, duplicate `id`, or id/path mismatch fails closed.
- An `id` is written in plain characters. A character escape in the raw source
  text is rejected even when it parses to a legal identity, because an escaped
  identity means the file does not read as what it means.

Implementation evidence may also be associated with a development record kept
outside this repository. That association is not part of the public schema:
no entry carries a private source id, and no entry carries a mapping between
its public identity and any other identity.

### Cross-boundary identities

Work that crosses from private development into this repository is published as
a **CityScroll Engineering Record**. Its public identity is
`cityscroll-engineering/<descriptive-public-id>`, where the descriptive part is
hyphen-separated words that each begin with a letter. Descriptive slugs are
required so a public identity is stable and readable, and so public numbering
cannot imply an ordering or a queue that this repository does not publish.

Where another document needs to reference such a record, the reference form is:

```text
engineering-record:cityscroll-engineering/<descriptive-public-id>#<fragment>
```

Where a change has no descriptive name yet, `cityscroll-engineering/c<12-hex>` —
the letter `c` followed by exactly 12 lowercase hex characters — is accepted as
the public id in its own right. That fallback token is minted outside this
repository; nothing in this repository can derive one from the other, and this
schema carries no field that would let it try.

`tools/public_identity_contract.mjs` is the machine statement of these rules and
is applied by the aggregator below.

### Legacy entries are unchanged

Most entries still use a workstream/card-shaped id such as
`cityscroll-land-map-view/lm-02-project-point-materializer`, predating the
`cityscroll-engineering` namespace. Those paths are not renamed and their
history is not rewritten — doing so would rewrite the public record for no
reader benefit. `inspectPathIdentityAgreement` (rule 4) still requires every
entry's path to decode to exactly its declared id, legacy or not; the
namespace above applies only where an entry opts into it.

## Evidence, not roadmap

An entry records **accepted implementation state**: what exists at this commit
and which paths project it. Entries do not carry roadmap state, planned work,
priority, sequencing, or dependency queues. That restriction is enforced
separately by `tools/inverse_control_plane_guard.mjs`.

## Schema

Entries use `cityscroll.architecture-evidence-entry.v1`. The machine schema is
[`architecture/evidence-entry.v1.schema.json`](../evidence-entry.v1.schema.json).

The derived aggregates are still named `cityscroll.card-inventory.v1` and
`cityscroll.card-projection-inventory.v1`. Those are **machine schema names kept
for compatibility with existing consumers**. They do not mean an entry id is a
development-record id; entry identity is defined above and nowhere else.

## Aggregation

`node tools/architecture_evidence_shards.mjs --check` discovers every entry,
sorts by `id`, validates schema, identity, and the public identity contract, and
derives the aggregates in memory. `--check` is read-only. `--write` may emit the
same shapes under `.artifacts/architecture-evidence/` for local inspection. A
guard rejects attempts to track or edit the generated aggregate paths.
