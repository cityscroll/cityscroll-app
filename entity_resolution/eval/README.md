# Entity resolution evaluation

Versioned gold set, metrics harness, and clerical-audit sampler. Metrics stay
offline; the sampler can issue read-only D1 queries. Neither path writes D1 or
creates links.

## Layout

| Path | Role |
| --- | --- |
| `gold_v0.jsonl`, `gold_v1.jsonl`, `gold_v2.jsonl` | Versioned hard-case gold (pair labels) |
| `review_action_export.mjs` | Pure export of privacy-safe desk/action-log reviews into gold-ready candidates |
| `fixtures/review_actions_v0.json` | Characterization fixture for review-action export |
| `run_metrics.mjs` | Load gold, run predictions, and print metric keys |
| `run_bakeoff.mjs` | Run the scorer bake-off and write machine-readable + readable reports |
| `blockers/token_v0.mjs` | Token/stem blocking v0 (eval candidate generation) |
| `contenders/` | Optional Splink/DuckDB and Dedupe/Gazetteer adapters |
| `run_authority.mjs` | Derive and score silver labels from `source_records` JSONL |
| `fixtures/source_records_authority_v0.jsonl` | Representative source-record rows for characterization only |
| `run_entity_components.mjs` | Sample whole components and score entity-level fragmentation / constraint violations |
| `entity_audit_sampling.mjs` | Inclusion-probability-aware entity sampler and weighted rate helpers |
| `clerical_audit.mjs` | Pure stratified sampling, label-sheet, and gold-promotion helpers |
| `tools/build_clerical_label_batch.mjs` | Append-only verdict receipts and review-only confirmation registry for a labeled tray |
| `audits/<date>/` | Versioned sample, label sheet, and reproducibility receipt |
| `entity_audits/<date>/` | Versioned entity sample, review sheet, and sampling receipt |
| `fixtures/shadow_monitoring_v0.json` | Characterization snapshot for quiet-debt monitoring |
| `monitoring/<date>/receipt.json` | Versioned read-only monitor receipt with denominators and provenance |

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
- conventional matcher v1 supplies in-memory predictions when `--predictions`
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

- `--predictions <path.jsonl>` — override matcher v1 with decisions per gold `id` (`same` \| `different` \| `unresolved`)
- `--blocker token_v0\|none` — candidate generation (default: none → `candidate_recall=null`)
- `--examples N` — how many blocked-in/out true-match lines to print (default 5 with blocker)
- `--json` — full report object after the KEY=value lines

## Shadow monitoring

The shadow monitor reads immutable observations, resolution runs, and entity
links without changing any of them. Fixture mode is deterministic:

```bash
node tools/run_er_shadow_monitor.mjs --fixture \
  --out entity_resolution/eval/monitoring/2026-08-01/receipt.json --check
```

Production mode runs bounded D1 `SELECT` statements only:

```bash
node tools/run_er_shadow_monitor.mjs --live --out er-shadow-receipt.json
```

Receipts report score distributions, candidate recall, unresolved and false-split
lead rates, authority conflicts, shadow capture/link coverage, cluster growth,
orphans, graph contradictions, and per-source freshness. Every rate carries its
numerator and denominator. `--compare <prior-receipt.json>` emits deltas only when
the schema, policy versions, window, and thresholds are compatible; otherwise it
records `incompatible`. Empty populations remain `insufficient`, never zero.

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

## Scorer bake-off

The score-stage contract is `scorer_contract_v1`: candidate pairs carry a
versioned feature row, and a scorer returns a probability plus evidence. The
existing `conventional_v2` implementation is the baseline. The compatibility
export from `matchers/` remains for existing callers; policy, review,
link-not-merge, alias-registry, and materialization behavior are unchanged.

Run the bake-off against the widened gold (optional contenders are recorded as
`not_run` unless their isolated adapters are supplied):

```bash
node entity_resolution/eval/run_bakeoff.mjs \
  --gold entity_resolution/eval/gold_v2.jsonl \
  --out-dir entity_resolution/eval/bakeoff/2026-08-06-v2
```

The report measures candidate recall, pair precision/recall, false merges and
splits, cluster fragmentation, negative constraints, calibration bands, and
incremental-vs-full status. Metrics are evaluated after the unchanged policy
router; raw scorer probabilities and evidence remain in the report for
calibration. The v2 report includes the unresolved-band clerical stratum, so
precision, recall, calibration, and incremental behavior can discriminate
scorers without declaring a production winner.

For the two optional adapters and their isolated dependency environment, see
`eval/contenders/README.md` and `eval/optional-requirements.txt`.

The 2026-08-06 clerical batch extends the gold to v2 (158 cases) with 102
determinate labels from 103 ranked candidates. One parent/program case remains
undeterminable in `entity_resolution/eval/audits/2026-08-06-label-batch/` and is
not promoted. The confirmation registry is review-only; it cannot authorize an
operative entity link.

To reproduce the live vendor-bearing tray and its evidence artifacts:

```bash
node tools/export_er_clerical_audit.mjs --live \
  --source-systems city_record,checkbook_contracts,checkbook_spending,passport_public_contracts \
  --out-dir entity_resolution/eval/audits/YYYY-MM-DD \
  --near-miss-size 150 --auto-link-size 50
node tools/build_clerical_label_batch.mjs \
  --out-dir entity_resolution/eval/audits/YYYY-MM-DD-label-batch \
  --input entity_resolution/eval/audits/YYYY-MM-DD/audit_sample.jsonl
```

The optional `--source-systems` filter is restricted to vendor-bearing rails
and records the selected systems in the live receipt. Promote only reviewed
`same`/`different` rows with the existing promotion CLI; leave
`undeterminable` rows blank and retain them in the confirmation registry.

## Silver authority evaluation

The authority harness derives labels from an offline newline-delimited export of
`source_records`. It is separate from the versioned human-labeled gold set:

```bash
node entity_resolution/eval/run_authority.mjs \
  --source-records entity_resolution/eval/fixtures/source_records_authority_v0.jsonl \
  --json
```

The committed fixture verifies behavior; its rates are not production measurements.
Run the same command against a current export to measure live dual-write observations.
Each line must contain `source_system`, `source_system_id`, `content_hash`,
`normalized_snapshot`, and `ingested_at`, matching the table columns. The snapshot may
be a JSON string, as stored in D1, or an already-decoded object.

Derivation is deterministic:

- The newest immutable snapshot per `source_system` + `source_system_id` is retained.
- PIN and EPIN aliases parse through the authority-key registry into
  `(scheme, issuing authority, value, scope)`. Distinct rows become silver `same`
  pairs only when that complete tuple agrees; contract identifiers retain their
  separate family.
- Name-similar rows with comparable but disjoint hard identifiers become
  `never_auto` pressure pairs. A shared hard identifier takes precedence because one
  procurement lineage may contain several identifiers.
- The process is read-only: it does not write source records, links, or review state.

The two metric keys are:

| Metric | Meaning |
| --- | --- |
| `authority_recall` | Silver `same` pairs scored `same` by the conventional matcher |
| `authority_conflict_auto_link_rate` | `never_auto` pairs scored `same`; this is potential auto-link pressure and should remain near zero |

Characterization:
`node --test test/authority_key_registry.test.mjs test/entity_resolution_authority.test.mjs`.

## Entity-centric component evaluation

Pair metrics can hide a fragmented real-world entity behind several individually
correct edges. The component harness evaluates the partition implied by the same
gold and silver-authority evidence:

```bash
node entity_resolution/eval/run_entity_components.mjs \
  --gold entity_resolution/eval/gold_v0.jsonl \
  --source-records entity_resolution/eval/fixtures/source_records_authority_v0.jsonl \
  --sample-size 8 --json
```

Positive labels define reference components. Negative labels remain explicit
must-not-link constraints; missing labels are unknown and are never silently
treated as different. Conventional matcher links produce the predicted
components in memory. The small-N sample is deterministic, stratified by corpus
and false-split/over-merge/control status, and always includes whole components.

| Metric | Meaning |
| --- | --- |
| `entity_component_recall` | Reference multi-record entities recovered as one predicted component |
| `under_split_entity_rate` | Reference entities fragmented into two or more predicted components |
| `over_merge_component_rate` | Predicted multi-record components that violate a labeled must-not-link constraint |
| `negative_constraint_violation_rate` | Labeled different pairs connected through any predicted path |

`false_split_priority` lists fragmented authority components first, then
fragmented human-gold components. These are the highest-value maturity cases for
product language that needs to explain why records known to belong together are
still presented separately. The fixture rates characterize the harness only;
measure current shadow data with a current offline `source_records` export.

To commit a reproducible report and receipt, add
`--observed-on YYYY-MM-DD --out-dir entity_resolution/eval/components/YYYY-MM-DD`.

Characterization:
`node --test test/entity_resolution_entity_components.test.mjs`.

## Entity-centric audit sampling

Build a whole-entity review set from the component report:

```bash
node tools/export_entity_audit_sample.mjs \
  --input entity_resolution/eval/components/2026-08-01/report.json \
  --out-dir entity_resolution/eval/entity_audits/2026-08-01 \
  --observed-on 2026-08-01 \
  --sample-size 16
```

The component report retains pairwise precision, recall, false-merge,
false-split, and `candidate_recall` metrics from `token_v0` beside the
entity-level results, so the audit does not replace the established pair view.

The exclusive strata are false splits, large clusters, singletons,
low-confidence boundaries, authority-key cases, and remaining clusters. The
allocation covers each available stratum before adding depth and gives false
splits three allocation turns per control turn. Selection within a stratum is
a seeded SHA-256 rank without replacement. Every review row therefore records
its first-order inclusion probability and inverse-probability base weight.

The command writes `audit_sample.jsonl`, `label_sheet.csv`, and `receipt.json`.
Review judgments are `correct`, `false_split`, `false_merge`, `both`, or
`uncertain`, with reviewer and date required for nonblank judgments. After
review, generate Hájek weighted rates with:

```bash
node tools/export_entity_audit_sample.mjs \
  --summarize entity_resolution/eval/entity_audits/2026-08-01/label_sheet.csv \
  --summary-out entity_resolution/eval/entity_audits/2026-08-01/rates.json
```

Each stratum needs two usable judgments by default. A smaller stratum reports
`insufficient` and leaves its rates—and the overall rate—null instead of
generalizing from too few judgments. The checked-in fixture is characterization evidence,
not a production error-rate measurement.

Characterization:
`node --test worker/test/entity_audit_sampling.test.mjs`.

## Clerical audit — false-split priority

Generate a deterministic two-stratum sample from current production observations:

```bash
node tools/export_er_clerical_audit.mjs \
  --live \
  --out-dir entity_resolution/eval/audits/2026-07-31 \
  --observed-on 2026-07-31
```

The command issues `SELECT` statements only and writes three repository artifacts:

- `audit_sample.jsonl` — nested evidence for every sampled pair
- `label_sheet.csv` — flat review sheet with `label`, `reviewer`, `reviewed_at`, and `notes`
- `receipt.json` — input relation/counts, policy versions, thresholds, stratum counts, and hashes

The `near_miss` stratum contains high-similarity pairs not accepted by the
exact-stem auto-link policy; it leads the sheet because false splits are the
primary maturity signal. The `auto_link` stratum is a false-merge control.
Sampling prefers distinct display-pair shapes before filling with repeated live
attempts. When `source_records` is empty, live mode replays the checked-in policy
over vendor-bearing `notices` and records that fallback in the receipt.

For an offline replay, replace `--live` with `--input <rows.json>`. Existing
audit artifacts are idempotent when byte-identical and require `--replace` when
they differ.

After review, promote labeled rows into a new gold version:

```bash
node tools/export_er_clerical_audit.mjs \
  --promote entity_resolution/eval/audits/2026-07-31/label_sheet.csv \
  --base-gold entity_resolution/eval/gold_v0.jsonl \
  --gold-out entity_resolution/eval/gold_v1.jsonl
```

Blank labels are skipped. Promoted rows must use `same` or `different` and must
include reviewer/date evidence. Promotion rejects duplicate membership, requires
a newer version, creates a promotion receipt, and refuses to overwrite any
existing `gold_vN.jsonl`.

Characterization:
`node --test test/entity_resolution_clerical_audit.test.mjs`.

## Related

- Taxonomy ADR: `docs/adr/entity-resolution-taxonomy.md`
- Schema sketch: `docs/entity-resolution/schema-sketch.sql`
