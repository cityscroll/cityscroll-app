# entity_resolution

Modular-monolith package for CityScroll identity work (normalize → candidates →
score → decide → link). Lives inside this repo and the existing Worker/D1 deploy
surface. **Not an HTTP microservice.**

## Layout

| Path | Role |
| --- | --- |
| `normalizers/` | Pure string identity (`vendorStem`, agency alias helpers) |
| `authority_keys/` | Scoped identifier registry (`scheme`, issuer, value, scope) |
| `officials/` | Official person-level type family + `votes_on` edges from Legistar votes |
| `exam_certifications/` | Publisher-backed `certified_to_agency` exam/list edges with aggregate counts |
| `candidate_generation/` | Token/stem blocking candidate pairs (`token_v0`) |
| `features/` | Deterministic family-aware pair features (`pair_features_v2`) |
| `matchers/` | Backwards-compatible import path for the baseline scorer |
| `scorers/` | Removable scorer contract plus the `conventional_v2` baseline |
| `policies/` | Conservative auto-link routing + alias-registry (`conservative_v1`) |
| `evaluation/` | Re-exports gold, authority metrics, and clerical-audit helpers |
| `eval/` | Versioned gold, metrics CLIs, authority fixtures, and audit receipts (keep paths stable) |
| `review/` | Human review queue shaping + reviewed alias registry |
| `publication/` | Allowlist serializers that enforce the public sensitivity boundary |
| `index.mjs` | Package root public exports |

Worker call sites that historically imported `worker/src/lib/normalize.mjs` keep
doing so — that file is a thin re-export of `normalizers/`.

## Import examples

```js
import { vendorStem, normalizeEntity } from "../entity_resolution/normalizers/index.mjs";
// or package root:
import { vendorStem, generateCandidates, scorePair } from "../entity_resolution/index.mjs";
```

From `worker/` tests (path relative to the test file):

```js
import { vendorStem } from "../../entity_resolution/normalizers/index.mjs";
```

## Framework (shared by type families)

1. **Normalize** — deterministic key / display per family  
2. **Candidates** — blocking so scorers never see full cross-product  
3. **Features** — deterministic pair signals  
4. **Scorers** — candidate pairs + versioned features → probability + evidence
5. **Policies** — auto-link vs review vs separate; scorers never make durable links
6. **Evaluation** — gold set + precision/recall/candidate_recall  
7. **Review** — human queue for middle-band pairs  

Taxonomy ADR: `docs/adr/entity-resolution-taxonomy.md` (link-not-merge).  
Schema sketch (unapplied): `docs/entity-resolution/schema-sketch.sql`.

## Extract criteria (when an HTTP service would be justified)

Keep this package in-process until **at least one** of the following is true:

| Criterion | Meaning |
| --- | --- |
| **Multi-app consumers** | A second production app needs the same identity engine over a network boundary, not a shared git module |
| **Independent scale** | Identity compute or storage must scale on a different axis than the Worker/Pages surface |
| **Multi-team ownership** | A separate team owns release cadence and on-call for identity alone |
| **Interference** | ER jobs materially starve notice ingest, digests, or public request latency and isolation fixes that without distribution |

Until then: **semantic boundary first** — clear modules, interfaces, and tables —
not distributed cosplay for a single-maintainer product.

## Non-goals (this package / boundary card)

- **No writable public HTTP ER routes** — `/entity-dossier` is a read-only, allowlisted
  view; the separately keyed `/admin/possibly-same` desk owns review writes.
- **No destructive merges** from the shadow path; production dual-write flags capture source
  snapshots and exact-stem links without changing publisher records.
- **No LLM as primary matcher** — residue adjudicator only after a conventional scorer,
  with stored prompts/version and human override (future; not this package).
- **No destructive merge of source rows** — links only (`entity_link` taxonomy).
- **No silent gold mutation** — eval gold versioning rules in `eval/README.md`.
- **Not a published npm package** — monorepo path imports; no separate versioned registry
  artifact required for Worker deploy.

## Cross-domain object links

`cross_domain/` links the **same** agency or vendor across money / land / rules /
meetings / people without merging publisher subjects. Identity reuses
`canonicalAgency` / `vendorStem`; every edge carries provenance. Materialization:
`node tools/build_entity_intelligence.mjs` → `site/data/entity_intelligence_lookup.json`
(+ Worker twin). Rules/meetings densify from City Record domain snapshots
(`site/data/rules_domain_observations.json`,
`site/data/meetings_domain_observations.json`; refresh via
`tools/build_rules_meetings_domain_observations.mjs`) — agency `issued_rule` /
`hosts_meeting` only; no invented rule→contract joins; people densify from Legistar
`by_person` on meeting-outcomes (`site/data/people_domain_observations.json`). Serve: `GET /entity-intelligence` (`demo=1`, `kind`+`name`,
`list=1`). ADR: `docs/adr/cross-domain-object-links.md`. Verify:
`node --test test/cross_domain_object_links.test.mjs worker/test/entity_intelligence.test.mjs`.

## Publication boundary

Public entity-resolution responses must use the serializers in `publication/`; database rows
and desk review objects must not be serialized directly. The public contract is deliberately
small:

- entity: stable opaque id, type family (vendor/agency/procurement/location/**official**), and display name
- link: canonical entity id plus publisher system, publisher-native public id, and an optional
  HTTPS source URL
- dossier: the entity, linked public source records, allowlisted source assertions, bounded
  source/time scope, explicit disagreement and missingness, public-safe derivation status, and
  per-link match-strength bands (`strong` / `tentative` / `not_scored`)
- relationship graph: allowlisted vendor, agency, solicitation, contract, award, and official
  nodes joined only by named edge types (including `votes_on`) with publisher provenance,
  observed time, and public-safe confidence

Raw and normalized snapshots, content hashes, canonical attributes JSON, **numeric** matcher
scores, matcher method/version strings, evidence, resolution-run ids, review state, reviewer
identity, and notes are desk-only. Public surfaces map `entity_link.confidence` to a coarse
`link_confidence` band only (`strong` when score ≥ 0.95, else `tentative` when scored,
`not_scored` when null). The link serializer distinguishes a publisher-native id from the
internal `source_record_id`, which contains a snapshot hash and is never public.

`GET /entity-dossier?id=` queries by **canonical entity id** (not vendor-name or contract
subject-registry ids). When a published canonical entity exists it returns HTML by default;
JSON via `Accept: application/json` or `?format=json`. **Unknown / unpublished ids return
404 with `public_status: "not_yet_public"`** — do not market this route as a live product
surface for demo subject ids; subject-registry fields on `/contract-lifecycle` are the live
cross-spine identifiers. When resolved: source values stay exact and attributed; conflicts
never select a winner; empty fields mean only “not observed in these linked records.” Each
`linked_records[]` entry carries `link_confidence`; the dossier also exposes
`link_confidence_summary`. Assertion confidence/review labels remain `not_scored` /
`not_published` / `not_public` (field-level scoring is separate from link strength).

Metric: `public_entity_link_confidence_rate` =
banded linked records (`strong`|`tentative`) / all linked records on resolved dossiers.
Pure measure: `measurePublicEntityLinkConfidenceRate` in
`entity_resolution/publication/link_confidence.mjs`. Target **1.0** when every auto-link has a
banded public status (baseline without surfacing: **0**).

`GET /entity-relationships?id=` uses the same canonical-id gate (404 +
`public_status: "not_yet_public"` when unpublished). When resolved: accessible graph page;
JSON via Accept/`?format=json`. Traversal is capped at two hops and 25 outgoing edges per
node, with lower caller-selected `depth` and `fan_out` budgets supported. A clamped or
exhausted budget is reported as an explicit boundary. `node_type` and `edge_type` accept only the
published allowlists; unknown types fail closed. Unsupported source-record categories are omitted
rather than converted to generic connections. Review captures are generated by
`python3 tools/capture_public_relationship_graph.py`.

## Verify

```bash
test -d entity_resolution/normalizers
test -f entity_resolution/README.md
node --test worker/test/entity_resolution_package.test.mjs
node --test worker/test/entity_resolution_publication.test.mjs
node --test worker/test/entity_dossier.test.mjs
node --test worker/test/public_relationship_graph.test.mjs
```

Existing normalize + gold harnesses stay green:

```bash
node --test worker/test/vendor_stem.test.mjs worker/test/normalize_fixtures.test.mjs
node --test worker/test/entity_resolution_matcher.test.mjs
node --test test/entity_resolution_clerical_audit.test.mjs
node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v1.jsonl --dry-run
node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v1.jsonl --blocker token_v0
node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v1.jsonl --blocker token_v0 --pipeline
node entity_resolution/eval/run_authority.mjs --source-records entity_resolution/eval/fixtures/source_records_authority_v0.jsonl
node entity_resolution/eval/run_bakeoff.mjs --gold entity_resolution/eval/gold_v1.jsonl --out-dir entity_resolution/eval/bakeoff/2026-08-06
```

The bake-off report records scorer name, model/artifact hash, config hash, feature
version, calibration by score band, pair metrics, cluster fragmentation, negative
constraint violations, and incremental-scoring status. Splink/DuckDB and Dedupe
Gazetteer adapters are optional eval-only tools under `eval/contenders/`; they are
never part of the site build or production Worker path. See `eval/README.md`.

## Related cards

- er-01 taxonomy ADR · er-03 normalizers · er-04 gold + metrics  
- er-05 candidate generation (implemented by `candidate_generation/`)
- er-06 soft “possibly same” UI · er-07 entity_link schema
- er-08 this package boundary
- er-09 deterministic features + conventional matcher v0
- er-10 live false-split visibility from dual-write observations
- er-11 offline silver authority labels + hard-identifier metrics
- er-12 stratified clerical audit + append-only gold promotion
- er-19 scoped PIN/EPIN authority-key registry

The desk view is read-only and non-assertive. It blocks recent `source_records` with `token_v0`,
omits pairs already joined to the same canonical entity, and renders the remaining candidates
without writing review notes or entity links. The live path is implemented in
`worker/src/lib/possibly_same.mjs`.
