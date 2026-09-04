# SEQRA/CEQR process ontology and as-of state projector (SEQRA-02)

This is the second card of the New York SEQRA/CEQR predictive-foundation
workstream. It builds on SEQRA-01's source inventory. It makes cutoff-valid
environmental-review state a property of the data model: JSON schemas for
the commissioned core entities, deterministic stable-key functions, an
append-only review-event model, and an as-of projector that reconstructs the
state known to the public at any historical cutoff. It does not ingest a
structured source, extract a document, build a label, train a model, or
enable resident ingestion -- that is SEQRA-03 onward.

## Why an event log, not a current row

A milestone table with one mutable row per review can only ever answer "what
is this review's state right now." It cannot answer "what did the public
know about this review on a given past date" without a query someone has to
remember to write carefully, and every rewrite of that row destroys the
history a cutoff-valid feature would need. `warehouse/lib/seqra_review_event_log.mjs`
makes cutoff validity a property of the fold instead: `projectReviewStateAsOf`
always rebuilds a review's state from scratch by filtering the append-only
log to `available_to_public_at <= cutoff` and reducing, so leakage becomes a
schema property a test can catch rather than a mistake a reviewer has to
notice.

## Core entities

`warehouse/lib/seqra_ontology_spec.mjs` declares the fifteen commissioned
core entities -- `project`, `government_action`, `environmental_review`,
`review_document`, `review_event`, `technical_topic_assessment`,
`mitigation_commitment`, `alternative`, `organization`, `public_position`,
`land_use_determination`, `judicial_case`, `case_filing`, `claim_theory`,
`search_coverage` -- as one declarative spec, and derives both the committed
JSON Schema documents (`warehouse/schemas/seqra_ontology_*.v1.schema.json`,
built by `tools/build_seqra_ontology_schemas.mjs`) and the runtime validator
(`validateSeqraEntity`) from it, so the two can never drift.

Most entities define only durable identity and relationship shape -- what a
later card's adapter will populate -- carrying a minimal provenance envelope
(`observed_at`, `source_id`, `source_record_id`). Only the entities that are
inherently point-in-time observations (`review_event`,
`technical_topic_assessment`, `mitigation_commitment`, `public_position`)
carry the full commissioned temporal-integrity envelope: `observed_at`,
`available_to_public_at`, `source_id`, `source_record_id`, `source_vintage`,
`evidence`, `confidence`, `rival_explanation`, `suppression_rule`. No entity
here is populated with an invented observation; every fixture is a synthetic
identity/shape example, not a claim about a real review.

## Required relations

`SEQRA_ONTOLOGY_RELATIONS` in the same module declares the thirteen required
relation edges verbatim (`project -> requires_action -> government_action`
through `later_decision -> decision_supersedes -> earlier_decision`, the
latter two modeled as self-referential `supersedes_document_key` /
`supersedes_determination_key` foreign keys).
`warehouse/lib/seqra_ontology_graph.mjs#validateOntologyGraph` checks those
edges actually resolve over a set of entities -- every foreign key must name
a key that exists among the entities it is validated against -- and that no
entity type admits a duplicate primary key.
`warehouse/fixtures/seqra-ontology/multi_action_multi_bbl_project.mjs`
exercises this end to end: one project across two BBLs, two government
actions, and two environmental reviews -- one NYC CEQR review, one
state-led NYS SEQRA review under a different lead agency -- validating with
zero findings and staying separately identifiable rather than collapsing
into one review or merging the two regimes.

## Stable keys

`warehouse/lib/seqra_stable_keys.mjs` implements the commissioned key shapes
exactly:

```text
environmental_review:ceqr:{normalized_ceqr_number}
environmental_review:seqra:{lead_agency}:{source_review_id_or_hash}
action:{agency}:{source_system}:{source_action_id}
determination:{agency}:{action_id}:{date}
review_document:{review_key}:{document_type}:{issued_date}:{content_hash_prefix}
```

Every builder throws rather than silently generating an unstable key when a
required identity input is missing -- a CEQR review needs a valid CEQR
number, a SEQRA review needs a lead agency plus a source review id or a
stable hash seed, an action needs its agency/system/id triple. The CEQR and
state-led SEQRA branches of `environmental_review` keys can never collide:
they carry distinct literal segments (`ceqr` vs `seqra`) immediately after
the entity prefix, so no normalized text on either side can produce the same
key as the other.

## Append-only review events and the projector

`warehouse/lib/seqra_review_event_log.mjs` models one review's history as an
append-only stream of typed events (`SEQRA_REVIEW_EVENT_TYPES`: the
commission's candidate milestones, from `eas_or_eaf_accepted` through
`final_determination_issued`, plus generic `draft_document_published` /
`final_document_published` / `document_superseded` and
`determination_superseded` events and the topic/mitigation/alternative/
position observation events). `buildAppendOnlyLog` validates every event
against its schema and its event-type-specific payload contract, sorts
deterministically by `(effective_at, event_key)`, and throws
`SeqraOntologyValidationError` -- collecting every finding, not just the
first -- rather than silently dropping a malformed event.

`projectReviewStateAsOf(events, { reviewKey, cutoff })` is the as-of state
projector:

- Filters to events whose `available_to_public_at` is on or before the
  cutoff, so a feature that became public after the cutoff never leaks in.
- Always re-sorts internally before folding, so **replay order never changes
  the result** -- the same event set produces a byte-identical projection
  regardless of the array order it was passed in.
- Folds into `milestones`, `documents` (draft and final rows coexist,
  linked by `superseded_by_document_key`, never overwritten), `determinations`
  (same supersession pattern via `superseded_by_determination_key`), `topics`
  (the latest assessment per technical topic as of cutoff), `mitigations`,
  `alternatives`, and `positions`.

## Contradiction and impossible-sequence tests

`detectContradictions(events)` runs two required checks, independent of
cutoff or array order:

- **Final-before-draft**: every `final_document_published` event must name
  the `draft_document_published` event it supersedes, strictly earlier by
  `effective_at`. A final event with no matching draft, or a draft that
  published no earlier than the final it is supposed to precede, is a
  `final_before_draft` contradiction.
- **Conflicting determinations**: `final_determination_issued` events are
  grouped by `action_key`. After removing every determination explicitly
  superseded (a `determination_superseded` event, or a later determination's
  own `supersedes_determination_key`), more than one surviving outcome for
  the same action is a `conflicting_determinations_for_action` contradiction.

`projectReviewStateAsOf` surfaces a contradiction only once it touches an
event that is itself public by the requested cutoff and belongs to the
review being projected; when one is surfaced, the projector returns
`{ ok: false, contradictions }` instead of guessing a plausible state.
`warehouse/fixtures/seqra-ontology/review_event_log_fixtures.mjs` retains
both required fixtures (a final EIS naming a draft published after it; two
determinations for one action with different outcomes and no supersession)
alongside a full clean review lifecycle used for the cutoff/replay/
supersession tests.

## Command

```sh
npm run warehouse:seqra:labels                          # ontology/projector gate (deterministic, no network)
node tools/check_seqra_ontology.mjs --check              # rebuild and diff against the committed receipt
node tools/build_seqra_ontology_schemas.mjs [--check]    # rebuild/verify the fifteen schema documents
```

`npm run warehouse:seqra:labels` is this card's gate, named to match the
`verify` field the SEQRA-02 card already carries. It is not the label
builder or rolling backtest corpus SEQRA-08 owns; it validates the
ontology/projector this card actually delivers -- schema shape, relation
integrity, cutoff reproduction, replay-order independence, draft/final
coexistence, both required contradiction fixtures, and that the SEQRA-01
California/CEQA rejection path still admits zero rows -- against retained
fixtures and the previously committed SEQRA-01 inventory receipt, with no
live network access.

## Reuse and non-regression

This card adds no adapter and performs no fetch. It reuses SEQRA-01's scope
classifier (`warehouse/lib/seqra_scope_classifier.mjs`) and jurisdiction
fixture batch directly rather than forking a second copy, and its gate
confirms the retained `warehouse/receipts/proof/seqra_source_inventory_latest.json`
receipt is still present and parseable. `warehouse/lib/zap_environmental_projection.mjs`
and `warehouse/lib/ceqr_project_milestone_reconciliation.mjs` are unmodified;
their existing behavior and measured baseline are outside this card's scope
and not regressed by it.
