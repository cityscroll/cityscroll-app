# Entity resolution evaluation

Offline gold set and metrics harness. No production traffic, no D1 writes,
no auto-links.

## Layout

| Path | Role |
| --- | --- |
| `gold_v0.jsonl` | Versioned hard-case gold (pair labels) |
| `run_metrics.mjs` | Load gold, run predictions, and print metric keys |
| `blockers/token_v0.mjs` | Token/stem blocking v0 (eval candidate generation) |

## Run

```bash
node entity_resolution/eval/run_metrics.mjs \
  --gold entity_resolution/eval/gold_v0.jsonl \
  --dry-run
```

Dry-run exits 0 and prints:

- `precision`, `recall`, `candidate_recall`, `unresolved_rate`, `false_merge`, `false_split`
  (scorer metrics stay `null`; `candidate_recall` stays
  `null` until a blocker is named)
- gold version, content hash, case composition

### Candidate generation (token blocking v0)

```bash
node entity_resolution/eval/run_metrics.mjs \
  --gold entity_resolution/eval/gold_v0.jsonl \
  --blocker token_v0
```

With `--blocker token_v0`:

- `candidate_recall` is a number in `[0, 1]` (fraction of gold `same` pairs that
  share at least one block key)
- the report lists sample **blocked_in** and **blocked_out** true matches
  (gold `label=same`) so drops are never silent
- conventional matcher v0 supplies in-memory predictions when `--predictions`
  is omitted, so precision, recall, unresolved rate, false merges, and false
  splits are numeric
- blocked-out pairs remain unresolved rather than bypassing candidate generation

Block keys per side (eval-only, in memory):

| Key | Meaning |
| --- | --- |
| `stem:<key>` | `vendorStem` (vendors) or agency canonical id |
| `tok:<token>` | Significant tokens from the stem/display surface |
| `pin:<PIN-or-EPIN>` | Shared when either side carries the same PIN/EPIN identifier |

A pair is **blocked-in** when left and right share ≥1 key. Token blocking is a
high-recall gate — gold `different` pairs may still be candidates; later
matchers own precision.

Malformed gold (bad JSON, missing fields, duplicate ids, meta/`case_count` mismatch)
exits non-zero.

Optional flags:

- `--predictions <path.jsonl>` — override matcher v0 with decisions per gold `id` (`same` \| `different` \| `unresolved`)
- `--blocker token_v0\|none` — candidate generation (default: none → `candidate_recall=null`)
- `--examples N` — how many blocked-in/out true-match lines to print (default 5 with blocker)
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

Dry-run without `--blocker` leaves scorer metrics and `candidate_recall` as
`null`. `--blocker token_v0` fills `candidate_recall` only.

Characterization: `node --test test/entity_resolution_blocker.test.mjs`.

## Related

- Taxonomy ADR: `docs/adr/entity-resolution-taxonomy.md`
- Schema sketch: `docs/entity-resolution/schema-sketch.sql`
