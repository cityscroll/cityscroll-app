# Entity resolution evaluation

Offline gold set and metrics harness. No production traffic, no D1 writes.

## Layout

| Path | Role |
| --- | --- |
| `gold_v0.jsonl` | Versioned hard-case gold (pair labels) |
| `run_metrics.mjs` | Load gold, validate, print metric keys |

## Run

```bash
node entity_resolution/eval/run_metrics.mjs \
  --gold entity_resolution/eval/gold_v0.jsonl \
  --dry-run
```

Dry-run exits 0 and prints:

- `precision`, `recall`, `candidate_recall`, `unresolved_rate`, `false_merge`, `false_split`
  (values may be `null` until matchers / blockers exist)
- gold version, content hash, case composition

Malformed gold (bad JSON, missing fields, duplicate ids, meta/`case_count` mismatch)
exits non-zero.

Optional later flags:

- `--predictions <path.jsonl>` — decisions per gold `id` (`same` \| `different` \| `unresolved`)
- `--blocker <name>` — reserved for candidate generation (er-05)
- `--json` — full report object after the KEY=value lines

## Gold record shape

First line is required meta:

```json
{"_meta":true,"gold_version":"v0","schema_version":1,"case_count":36,"description":"..."}
```

Each following line is one labeled pair:

| Field | Required | Notes |
| --- | --- | --- |
| `id` | yes | Stable case id (`gv0-NNN`) |
| `entity_type` | yes | `vendor` \| `agency` \| `procurement` \| `location` |
| `label` | yes | `same` \| `different` (real-world identity, not product join quirks) |
| `sources` | yes | Non-empty list of source systems involved |
| `left` / `right` | yes | Each has `source_system`, `display_name`; `native_key` preferred |
| `difficulty` | no | `hard` \| `medium` \| `easy` |
| `notes` | no | Human rationale |

Prefer multi-source pairs grounded in product field cases. City Record-only spelling
pairs are allowed when labeled honestly.

## Versioning — never silent mutate

- **Filename** encodes the major gold series (`gold_v0.jsonl`, later `gold_v1.jsonl`).
- **`gold_version` + `schema_version` + `case_count`** live in the leading `_meta` line.
- **Do not** rewrite labels or drop cases in place without a version bump.
- **Allowed without a new file:** fix typo-only notes that do not change `label` /
  membership; still update `_meta.description` and expect a new `content_hash` in harness output.
- **Required new version (new file or `gold_vN`):** any change to case membership,
  `label`, `entity_type`, or side identities.
- Harness prints `content_hash` (sha256 prefix of file bytes) so diffs are visible in CI logs.

## Metric definitions (pair-level)

| Metric | Meaning |
| --- | --- |
| `precision` | TP / (TP+FP) among predicted `same` |
| `recall` | TP / (TP+FN) among gold `same` |
| `candidate_recall` | Gold `same` pairs retained by blocking / candidates |
| `unresolved_rate` | Share of gold rows with prediction `unresolved` |
| `false_merge` | Count of predicted `same` where gold is `different` |
| `false_split` | Count of gold `same` predicted not-`same` |

Dry-run leaves these `null` (no matcher). Candidate recall becomes numeric when a
blocker supplies a candidate set (er-05).

## Related

- Taxonomy ADR: `docs/adr/entity-resolution-taxonomy.md`
- Schema sketch: `docs/entity-resolution/schema-sketch.sql`
