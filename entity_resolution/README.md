# entity_resolution

Modular-monolith package for CityScroll identity work (normalize → candidates →
score → decide → link). Lives inside this repo and the existing Worker/D1 deploy
surface. **Not an HTTP microservice.**

## Layout

| Path | Role |
| --- | --- |
| `normalizers/` | Pure string identity (`vendorStem`, agency alias helpers) |
| `authority_keys/` | Scoped identifier registry (`scheme`, issuer, value, scope) |
| `candidate_generation/` | Token/stem blocking candidate pairs (`token_v0`) |
| `features/` | Deterministic family-aware pair features (`pair_features_v1`) |
| `matchers/` | Conventional `same` / `different` / `unresolved` scorer (`conventional_v1`) |
| `policies/` | Auto-link thresholds / decision routing (stub) |
| `evaluation/` | Re-exports gold, authority metrics, and clerical-audit helpers |
| `eval/` | Versioned gold, metrics CLIs, authority fixtures, and audit receipts (keep paths stable) |
| `review/` | Human review queue shaping (stub) |
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
4. **Matchers** — score + method version  
5. **Policies** — auto-link vs review vs separate  
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

## Publication boundary

Public entity-resolution responses must use the serializers in `publication/`; database rows
and desk review objects must not be serialized directly. The public contract is deliberately
small:

- entity: stable opaque id, type family, and display name
- link: canonical entity id plus publisher system, publisher-native public id, and an optional
  HTTPS source URL
- dossier: the entity, linked public source records, allowlisted source assertions, bounded
  source/time scope, explicit disagreement and missingness, and public-safe derivation status

Raw and normalized snapshots, content hashes, canonical attributes JSON, matcher scores and
versions, evidence, resolution-run ids, review state, reviewer identity, and notes are desk-only.
The link serializer distinguishes a publisher-native id from the internal `source_record_id`,
which contains a snapshot hash and is never public.

`GET /entity-dossier?id=` queries by canonical entity id and returns HTML by default; JSON is
available through `Accept: application/json` or `?format=json`. Source values remain exact and
attributed. Conflicts never select a winner, and empty fields mean only “not observed in these
linked records.” Public assertion confidence/review labels disclose only `not_scored`,
`not_published`, or `not_public`; numeric matcher scores and desk dispositions stay private.

## Verify

```bash
test -d entity_resolution/normalizers
test -f entity_resolution/README.md
node --test worker/test/entity_resolution_package.test.mjs
node --test worker/test/entity_resolution_publication.test.mjs
node --test worker/test/entity_dossier.test.mjs
```

Existing normalize + gold harnesses stay green:

```bash
node --test worker/test/vendor_stem.test.mjs worker/test/normalize_fixtures.test.mjs
node --test worker/test/entity_resolution_matcher.test.mjs
node --test test/entity_resolution_clerical_audit.test.mjs
node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v0.jsonl --dry-run
node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v0.jsonl --blocker token_v0
node entity_resolution/eval/run_authority.mjs --source-records entity_resolution/eval/fixtures/source_records_authority_v0.jsonl
```

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
