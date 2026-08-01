# ADR: Entity resolution taxonomy (link-not-merge)

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-07-31 |
| Scope | Foundation only — docs and unapplied schema sketch |
| Supersedes | — |
| Blocks | Runtime dual-write (`source_record`, `entity_link`) and matchers |

## Context

CityScroll joins many public sources (City Record, Checkbook, PASSPort Public, Legistar,
Doing Business, and others). Vendor spellings, agency renames, and procurement lifecycle
events are currently handled with ad hoc stems, strict ID joins, and read-time collapses.
Without a written taxonomy, importers invent pair-specific joins and invite LLM-as-matcher
shortcuts that cannot be audited or re-run.

This ADR freezes the **concepts**, **type families**, **decision enums**, and a **modular
table sketch**. It does **not** ship a production migration, a microservice, or runtime
entity merge behavior.

## Decision: link, do not merge

A match decision produces an **`entity_link`** from a `source_record` to a
`canonical_entity` (or an explicit “separate” decision). It never destructively overwrites
source rows into a single “cleaned” string that loses provenance.

| Why | Consequence |
| --- | --- |
| Merges are hard to reverse | Links are first-class and reversible |
| Multi-source disagreement is real | Evidence stays on the link, not on a rewritten source |
| Matcher rules change over time | A `resolution_run` + method version re-computes without losing inputs |
| False merges vs false splits have different costs | Decisions and confidence are stored, not only a joined display name |

Read-time UX (for example `vendorStem` collapsing spellings on a profile) may continue.
Durable identity receipts must eventually be backed by stored links, not by in-place string
rewrite alone.

## Core concepts

### `source_record`

Immutable (append-only) intake of one upstream observation.

- Carries raw payload, optional normalized projection, `content_hash`, source system id,
  native key, and ingest timestamp.
- City Record notices in D1 remain a fail-soft mirror of Socrata; a general `source_record`
  is the cross-importer generalization so identity can re-run without re-fetch loss.
- **Never** overwritten in place when a later resolution decision changes.

### `canonical_entity`

The product-facing identity handle for one real-world entity of a given type family
(vendor, agency, procurement object, or location/project).

- Has a stable opaque id, type, preferred display label, and optional attributes.
- Does **not** replace source rows. Sources point **to** it via links.
- Cluster coherence (transitive same-as) is a property of the link graph + policy, not of
  string collapse inside a source table.

### `entity_link`

The durable product of a match decision: `source_record` → `canonical_entity` (or an
explicit non-link outcome recorded for audit).

Required decision fields:

| Field | Role |
| --- | --- |
| `decision` | Enum: see Decision routing below |
| `confidence` | Numeric score or band used by the method (nullable when human-only) |
| `method` | Matcher id, e.g. `vendor_stem_v1`, `pin_exact`, `manual_review` |
| `matcher_version` | Version string for the method implementation |
| `evidence` | Structured or JSON evidence (features, source ids, human note) |
| `resolution_run_id` | Which run produced this link |
| `review_status` | Optional queue state when decision is `review` |

### `candidate_pair`

A proposed pair for scoring (blocking / candidate generation output). Exists so candidate
recall can be measured before any auto-link is written.

### `resolution_run`

One execution of a matcher pipeline: method + version + config hash + input scope +
started/finished timestamps + metrics summary. Required for reproducibility: a decision
without a run cannot be re-audited when rules change.

## Type families (five)

A shared framework (**normalize → candidates → score → decide → link**) applies to all
families. Feature sets and auto-link policy differ by family.

### 1. Vendors

Legal name, DBA, parent, subcontractor, and branch variants. Legal-suffix normalization
(existing `vendorStem`) is necessary but not sufficient for parent groups or deliberate
DBA splits. High-confidence exact-stem auto-links are the first shadow path; parent/DBA
edges stay review or never-auto until gold-set metrics exist.

### 2. Agencies

Abbreviations, renames, successors, and divisions. Exact string match on `agency_name` is
brittle across renames. Successor relationships are links with typed evidence, not silent
string replacement.

### 3. Procurement objects

Solicitation ≠ award ≠ contract ≠ amendment. This is **event / lifecycle modeling** and
lineage (PIN/EPIN, Checkbook contract id), not pure name dedupe. PIN lineage is a start,
not the full ontology.

### 4. Locations / projects

Geo + temporal co-reference (addresses, BBLs, capital projects, ULURP tokens). Later wave;
included here so importers do not invent a fifth ad hoc identity space.

### 5. Officials (person-level)

Elected or appointed officials who cast recorded votes or otherwise act on public
matters. Primary key pattern `official:{person_id}` (Legistar `PersonId` when present;
name-keyed fallback only when the publisher supplies a display name without an id).
Meeting-outcomes materialization retains person-level roll-call rows and emits typed
`votes_on` edges (official → matter|agenda_item). Pure helpers live in
`entity_resolution/officials/`. Auto-link policy for cross-source person identity is
deferred until gold coverage exists; this family exists so votes and meetings can name
**who acted** without discarding person observations into aggregate tallies only.

## Decision routing

| Decision | When | Production write |
| --- | --- | --- |
| `auto_link` | High confidence, method policy allows auto | May write `entity_link` when the shadow dual-write is enabled |
| `separate` | Low confidence or clear distinct entities | No same-as link; optional negative evidence for audit |
| `review` | Middle band | Queue for human (or later adjudicator); no silent auto-link |
| `never_auto` | Material contradiction (e.g. conflicting hard identifiers) | Block auto-link permanently for the pair until policy revisits |

Routing summary: high conf → auto-link · low conf → separate · middle → review · material
contradiction → never-auto.

LLM matching is **out of scope** for this foundation and for Phase 4 matcher cards. Any
future generative adjudicator is residue-only after a conventional scorer, with stored
prompts/version and human override — not a primary matcher.

## Silent-by-default, non-breaking

- This ADR and sketch change **no** runtime reads, writes, or public APIs.
- Later dual-write cards default flags **off** until characterization tests pass.
- False splits are silent data-quality debt: metrics and review surfaces come in later
  cards; do not paper over them with aggressive auto-merge.

## Modular monolith (not a microservice)

Package future code as modules under a logical `entity_resolution/` boundary
(normalizers, candidate generation, features, matchers, policies, evaluation, review)
with tables inside the existing Worker/D1 deploy surface. Extract to a separate service
only if multi-app consumers, independent scale, or ownership force it. Semantic boundary
first.

## Schema sketch (unapplied)

**Not a production migration.** Do not apply to D1 until a later dual-write card lands.
SQL dialect: SQLite / Cloudflare D1, matching `worker/migrations/`.

```sql
-- SKETCH ONLY — not applied. Foundation for later dual-write cards.
-- Tables: source_record, canonical_entity, entity_link, candidate_pair, resolution_run

CREATE TABLE IF NOT EXISTS resolution_run (
  id               TEXT PRIMARY KEY,          -- opaque id
  method           TEXT NOT NULL,             -- e.g. vendor_stem_v1
  matcher_version  TEXT NOT NULL,
  config_hash      TEXT,                      -- hash of thresholds / feature flags
  entity_type      TEXT,                      -- vendor | agency | procurement | location | official
  scope_note       TEXT,                      -- human-readable input scope
  started_at       TEXT NOT NULL,             -- ISO-8601
  finished_at      TEXT,
  metrics_json     TEXT,                      -- precision/recall/candidate_recall summaries
  status           TEXT NOT NULL DEFAULT 'running'  -- running | completed | failed
);

CREATE TABLE IF NOT EXISTS source_record (
  id               TEXT PRIMARY KEY,
  source_system    TEXT NOT NULL,             -- e.g. city_record, checkbook, passport
  native_key       TEXT NOT NULL,             -- upstream id within source_system
  entity_type_hint TEXT,                      -- optional type family hint
  raw_json         TEXT NOT NULL,             -- immutable raw observation
  normalized_json  TEXT,                      -- deterministic normalize projection
  content_hash     TEXT NOT NULL,             -- hash of raw (or canonical raw bytes)
  observed_at      TEXT,                      -- upstream event time if known
  ingested_at      TEXT NOT NULL,
  UNIQUE (source_system, native_key, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_source_record_system_key
  ON source_record(source_system, native_key);
CREATE INDEX IF NOT EXISTS idx_source_record_hash
  ON source_record(content_hash);

CREATE TABLE IF NOT EXISTS canonical_entity (
  id               TEXT PRIMARY KEY,
  entity_type      TEXT NOT NULL,             -- vendor | agency | procurement | location | official
  display_name     TEXT NOT NULL,
  attrs_json       TEXT,                      -- type-specific attributes
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_canonical_entity_type
  ON canonical_entity(entity_type);

CREATE TABLE IF NOT EXISTS entity_link (
  id                 TEXT PRIMARY KEY,
  source_record_id   TEXT NOT NULL REFERENCES source_record(id),
  canonical_entity_id TEXT,                   -- null when decision is separate / never_auto without entity
  decision           TEXT NOT NULL,           -- auto_link | separate | review | never_auto
  confidence         REAL,                    -- method-defined score or band endpoint
  method             TEXT NOT NULL,
  matcher_version    TEXT NOT NULL,
  evidence_json      TEXT,                    -- features, notes, conflicting ids
  resolution_run_id  TEXT REFERENCES resolution_run(id),
  review_status      TEXT,                    -- pending | approved | rejected | null
  created_at         TEXT NOT NULL,
  UNIQUE (source_record_id, method, matcher_version, decision, canonical_entity_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_link_canonical
  ON entity_link(canonical_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_link_decision
  ON entity_link(decision);
CREATE INDEX IF NOT EXISTS idx_entity_link_run
  ON entity_link(resolution_run_id);

CREATE TABLE IF NOT EXISTS candidate_pair (
  id                 TEXT PRIMARY KEY,
  resolution_run_id  TEXT NOT NULL REFERENCES resolution_run(id),
  left_source_id     TEXT NOT NULL REFERENCES source_record(id),
  right_source_id    TEXT NOT NULL REFERENCES source_record(id),
  blocking_key       TEXT,                    -- stem / token / id block key
  score              REAL,                    -- optional pre-score or scorer output
  features_json      TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE (resolution_run_id, left_source_id, right_source_id)
);
CREATE INDEX IF NOT EXISTS idx_candidate_pair_run
  ON candidate_pair(resolution_run_id);
CREATE INDEX IF NOT EXISTS idx_candidate_pair_block
  ON candidate_pair(blocking_key);
```

Also available as a copy-only file: [`docs/entity-resolution/schema-sketch.sql`](../entity-resolution/schema-sketch.sql).

## Non-goals (this card)

1. **No public ER read migration**; the source snapshot and link tables are applied by the
   Worker migration chain for shadow writes only.
2. **No runtime merge** of vendor/agency rows; no consumer switch to `entity_link`.
3. **No new deployable service** or HTTP identity API.
4. **No LLM matching** and no middle-band adjudicator implementation.
5. **No public ER read path or destructive merge**; the gold-set harness, token blocker, and
   fail-soft shadow dual-write are implemented in their respective package/Worker paths.

## Consequences

- Importers and later ER cards share one vocabulary: four type families, five tables,
  four decision values, link-not-merge.
- er-02 can dual-write `source_record` without inventing column names.
- er-07 can materialize `entity_link` + `resolution_run` from this sketch.
- Public behavior stays unchanged until an explicit consumer card opts in.

## References (in-repo and design)

- Live ingest posture: `worker/src/ingest.mjs` (Socrata source of truth; D1 mirror)
- Vendor stem / entity lens: `worker/src/lib/compile.mjs`
- Design wave story: cityscroll entity-resolution prospective praxis, story **er-01**
- Theory: link-not-merge, type-specific ontology, modular monolith, silent false-split debt
