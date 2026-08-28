# Procurement lifecycle actions

**Stable ID:** `procurement-lifecycle-actions`
**Card standard:** `kraken-v1`
**Status:** proposed
**Release checkpoint:** PLA-03

## Objective

Turn CityScroll's existing procurement observations into a coherent, source-backed process state
that supports user actions across the procurement lifecycle.

The workstream uses the existing public observations from PASSPort public RFx, PASSPort public
contracts, Checkbook contracts, Checkbook spending, and City Record procurement notices. It does
not turn CityScroll into an instructional procurement site. The product surface should show the
state that the evidence establishes and make that state useful.

## Product rule

Every lifecycle state shown as fact must be backed by a source observation.

Derived states are allowed only when:

* the derivation is deterministic;
* its underlying source receipt is retained;
* the UI does not imply that an unobserved event did not happen;
* absence of evidence never becomes a compliance or delay verdict.

Prefer `Evaluation · responses no longer accepted` over `The agency is currently reviewing
proposals and will next...`. CityScroll should show state and make it useful, not teach
Procurement 101.

This rule is a publication gate, not a disclaimer. A missing event remains missing or unknown; it
is never rendered as proof that the event did not occur.

## Before / after

| Surface | Before | After |
| --- | --- | --- |
| PASSPort RFx | Every RFx is effectively `solicitation`. | Publisher procedural states become explicit, source-qualified process events: `planned`, `open`, `evaluation`, `selection_made`, or a source-specific terminal state, while the literal publisher value remains visible to evidence views. |
| City Record | Rich notice stages exist, but they are mainly a matching/lifecycle detail. | Exact City Record stages become ordered events in the same procurement process when the stable notice identity and procurement join are proven. |
| PASSPort contracts | `pending`, `registered`, and generic `contract` are coarse browse stages. | Publisher contract status and registration observations project to `pending_registration`, `registered`, or `contract_in_progress` only when the source supports the state. |
| Detail page | Residents see facts and observed stages but must assemble the story themselves. | `/procurements/:id` shows a compact process strip or timeline with source evidence on each event and no synthetic missing steps. |
| Browse and search | Search and browse can find procurement records, but procedural state is not a first-class query. | Procedural state is a structured browse/search predicate and a canonical SearchDocument field, with source-backed cards only. |
| Following | A contract can be followed, but lifecycle transitions are not the watch primitive. | A procurement can be followed until a source-backed deadline, state change, selection, registration, or first payment. |
| Timing | A narrow award-to-registration dwell model exists. | Comparable, inspectable duration cohorts are exposed as descriptive measurements, not delay or compliance verdicts. |
| Future opportunities | Planning artifacts are retained in a bounded, mostly inert bridge. | A separate `planned_procurement` object can be followed and later linked to an RFx only through an explicit identity gate. |
| Performance | No public evaluation read model is established. | Publisher evaluation observations can be queried through exact contract/vendor/agency relations; absent evaluations do not become poor performance. |

## Capabilities

| Existing observation | Product capability unlocked |
| --- | --- |
| RFx exists | Show `Planned`, `Open`, `Evaluation`, `Selection made`, or a source-specific terminal state when the publisher observation supports it. |
| RFx due date exists | Offer a deadline reminder without asserting what happened after the deadline. |
| City Record procurement notices exist | Show publication-backed intent, award, and related procedural events. |
| Contract status exists | Browse and search for awaiting registration, registered, or contract-in-progress states when status semantics match. |
| Publisher dates exist | Compute deterministic, receipt-backed durations for eligible cohorts. |
| Canonical search projection exists | Make procedural state a structured search/browse field rather than a text-only label. |
| Following exists | Follow a procurement until a selected source-backed transition or first payment. |
| Planning records exist | Discover future opportunities without pretending a plan is an RFx. |
| Evaluation records exist | Query public performance evidence and traverse its exact contract/vendor relations. |

## Shared data contract

The shared process projection is additive over retained source observations. It is not a new
identity table and it does not replace the legacy `stages` or phase-spine fields while the cards
are delivered. Every event is source-qualified and inspectable.

### `procurement_process_event`

The proposed event shape is:

```text
procurement_process_event
  procurement_id
  event_id
  state
  publisher_state
  state_basis
  effective_at
  source_system
  source_observation_ref
  deadline
  vendor_ref?
  amount?
  method_family?
  metadata?
```

Contract rules:

* Every event includes `source_observation_ref`, and that reference resolves to a retained source
  observation and receipt.
* An explicit event retains the literal `publisher_state`; its canonical `state` is a bounded
  normalization of that publisher observation.
* A deterministic projection has `metadata.derivation_rule` and
  `metadata.derivation_receipt_ref` (or an equivalent named, inspectable receipt field), as well
  as the source observation reference.
* `effective_at` and `deadline` are publisher-backed. They are null when not observed; no date is
  inferred from a neighboring event, an expiry calculation, or a contract term.
* An event is never synthesized to fill a missing step. Do not force every procurement through
  every state.
* A vendor or amount is present only when the source observation carries that fact. `Selections Made`
  alone does not identify a winning vendor.

### `state_basis` vocabulary

The minimum vocabulary is:

* `explicit` — the publisher directly reported the state or literal value.
* `deterministic_projection` — the state is a deterministic mapping over one or more retained
  observations, with a derivation rule and receipt.

An implementation may add a narrowly named basis only through a reviewed contract change; it may
not use an unqualified inference basis for a public lifecycle fact.

### Canonical state vocabulary

The base canonical vocabulary is:

```text
planned
open
responses_closed
evaluation
selection_made
intent_to_negotiate
intent_to_award
award
contract_in_progress
pending_registration
registered
payment
unknown
```

The existing publisher vocabulary also requires two source-specific extensions that must not be
silently discarded: `closed` for an explicitly closed RFx, and `vendor_list` for an exact City
Record Vendor List notice. These extensions are source-backed and do not replace the base
vocabulary. The implementation must preserve the literal publisher state in all cases.

The seed mapping `Closed → closed/source-specific terminal state` is intentional: a closed RFx is
not to be relabeled `responses_closed` unless the publisher semantics establish that equivalence.

## Workstream-level acceptance fixtures

These fixtures are normative. They are small, source-shaped acceptance examples; implementations
may add fields and receipts but may not weaken the state, action, identity, or absence semantics.

### Fixture A — open RFx with deadline

```text
Observation: PASSPort public RFx says status=Released and due_date=2026-09-18.
Expected state: open (state_basis=explicit; publisher_state=Released).
Expected action: Follow procurement; offer a deadline reminder for 2026-09-18.
Forbidden: claiming that responses will be received, evaluated, or awarded.
```

### Fixture B — evaluation after responses close

```text
Observation: PASSPort public RFx says status=Responses Received and due_date=2026-09-18.
Expected state: evaluation (state_basis=explicit; publisher_state=Responses Received).
Expected action: offer notification when a source-backed selection is made.
Forbidden: claiming that an agency is currently reviewing proposals or predicting the next step.
```

### Fixture C — intent to award through registration

```text
Observations: an exact City Record Intent to Award, an exact City Record Award, a PASSPort
pending-registration status, and a later Registered observation for one procurement.
Expected ordered states: intent_to_award → award → pending_registration → registered.
Expected result: each event has its own retained source receipt; no duplicate dots for duplicate
source observations; missing intermediate observations remain absent.
```

### Fixture D — descriptive registration duration

```text
Observations: Award effective_at and Registered effective_at produce 87 days; at least 20
comparable DOT CSP observations have both boundaries and the selected row is at the 79th
percentile among them (the comparable median may be 61 days).
Expected result: show Award → registration, 87 days, cohort definition, boundary evidence, and
the percentile as a descriptive comparison.
Forbidden: “late”, “slow”, “overdue”, “delayed by 26”, or a compliance conclusion based only on
the percentile.
```

### Fixture E — planned opportunity later linked to RFx

```text
Observation: a retained DOT bridge-inspection plan row says Planned and Expected FY27 Q2 CSP.
Expected result: show a separate planned opportunity, preserve the fiscal quarter, and offer
Follow for the later solicitation.
Later observation: a PASSPort RFx attaches only after a strong publisher identifier or reviewed
high-confidence identity gate passes.
Forbidden: treating the plan as Open or merging on text resemblance alone.
```

### Fixture F — public performance evaluation

```text
Observation: a retained publisher evaluation identifies a contract and vendor, has an evaluation
period and an Overall Satisfactory rating.
Expected result: expose a structured evaluation query and the evaluation → vendor → contract
relations, with source passages/receipts and reverse navigation.
Forbidden: treating no evaluation as poor performance or inventing an evaluation from payment or
contract status data.
```

## Non-goals

The workstream does not:

* build a generic explainer;
* add permanently visible completeness disclaimers;
* infer that unobserved events did not occur;
* label missing observations as compliance violations;
* label a procurement late based only on peer duration;
* fuzzy-merge plans, RFx, awards, and contracts;
* infer closeout from a contract end date;
* infer active performance from a contract term;
* scrape authenticated or vendor-private PASSPort views;
* replace exact identity and provenance with lifecycle heuristics.

## Dispatch order and dependencies

The existing-data tranche is:

```text
PLA-01 → PLA-02 → PLA-03 → PLA-04
```

PLA-03 is the release checkpoint: procurement state becomes a queryable and subscribable
primitive. After that tranche, dispatch PLA-05 and PLA-06 as follow-on source/read-model work.
The contract-actions/Award-Milestones research spike may run in parallel after PLA-02 and is
explicitly **not a delivery dependency** of PLA-01 through PLA-06.

| Card | Scope | Depends on | Outcome |
| --- | --- | --- | --- |
| PLA-01 | Promote PASSPort RFx procedural state | Existing PASSPort RFx observations | Explicit RFx process states and source-backed deadline actions. |
| PLA-02 | Unified procurement journey | PLA-01 | One evidence-linked process strip/timeline across source families. |
| PLA-03 | Lifecycle browse/search/watch actions | PLA-01, PLA-02 | Queryable/subscribable procurement state; release checkpoint. |
| PLA-04 | Registration latency | PLA-03 | Reproducible descriptive duration cohorts. |
| PLA-05 | Procurement plans/future opportunities | PLA-02; may follow PLA-03 | Separate planned objects and gated later links. |
| PLA-06 | Vendor performance evaluations | PLA-03; independent source acquisition | Exact evaluation read model and traversable relationships. |
| Research spike | Contract actions/Award-Milestones | PLA-02 for context only | Accept/defer/reject source audit; no delivery blocker. |

## Design validation

The design was checked against the current codebase before authoring the cards.

### Source observations and existing projections

* PASSPort RFx observations are retained in `worker/src/passport.mjs` as `passport_rfx` rows and
  dual-written as `passport_public_rfx` source records. The row parser in
  `worker/src/lib/passport_parse.mjs` already retains `rfx_status`, `release_date`, `due_date`,
  procurement method, and publisher identifiers. `worker/src/lib/passport_lifecycle.mjs` currently
  uses that evidence to enrich a coarse `solicitation` stage.
* City Record stage extraction is already exact-label and source-backed in
  `worker/src/lib/checkbook_lifecycle.mjs`: `Solicitation`, `Intent to Negotiate`, `Vendor List`,
  `Intent to Award`, and `Award` map to known stages. The same module requires a stable notice
  identifier and an exact procurement match before an event is attached.
* Contract status fields are retained by the PASSPort and Checkbook parsers. The known PASSPort
  pending statuses and exact `Registered` status live in `worker/src/lib/passport_join.mjs`; the
  current coarse object mapping is in `site/procurement_object_contract.mjs`.
* The canonical procurement object and identity narrow waist is
  `site/procurement_object_contract.mjs`; its source references, identity keys, stage order, and
  City Record attachment gates are the correct base for `procurement_process_event`.
* The canonical search projection is `site/procurement_search_producer.mjs`, materialized through
  `tools/build_shared_procurement_read_model.mjs` and `tools/build_keyword_search_index.mjs`, with
  the runtime family in `worker/src/search.mjs`. Structured browse fields are queried through
  `site/procurement_browse_query.mjs` and the resident snapshot query path.
* The canonical detail and current action surface is `site/procurement_document.mjs`; its compact
  phase UI is `site/procurement_phase_spine.mjs` and `site/app/procurement-phase.mjs`. Existing
  Following behavior is wired through the procurement watch href in the document renderer.
* Planning inputs already have a bounded collector and receipt contract in
  `site/data/procurement_plan_sources/`, `site/procurement_planning_surface.mjs`,
  `site/procurement_planning_gate.mjs`, and `warehouse/scripts/procurement_plans_run.py`.
* Registration dwell already has a versioned formula, observations, builder, and receipt path in
  `docs/formulas/award-registration-dwell.md`, `worker/src/lib/award_registration_dwell.mjs`,
  and `tools/build_award_registration_dwell.mjs`.

### Seed-to-repository adaptations

These are technical adaptations only; the product rule, non-goals, fixtures, and acceptance
semantics above remain normative.

1. **Use the existing observation/projection narrow waist.** The seed names a shared
   `procurement_process_event`; this workstream specifies it as an additive projection over
   `source_records` and `site/procurement_object_contract.mjs`, rather than a new primary identity
   table. This preserves exact source references, current identity gates, and legacy consumers.
2. **Extend shared materialization to include RFx rows.** The current
   `tools/build_shared_procurement_read_model.mjs` materializes PASSPort contracts but not the
   already-retained `spine.rows.passport_rfx` fields. PLA-01 must carry those observations into
   the shared read model before emitting the new event projection; it does not need a new source
   acquisition unless a required field is discarded by the current snapshot.
3. **Preserve both canonical and publisher vocabularies.** The seed’s base canonical vocabulary
   omits the existing `vendor_list` stage and describes `Closed` as a source-specific terminal
   state. The contract therefore keeps the exact base vocabulary, adds the source-specific
   `closed` and `vendor_list` extensions, and always retains `publisher_state`. No existing City
   Record meaning is collapsed to fit the base list.
4. **Keep legacy coarse stages during migration.** `site/procurement_phase_spine.mjs` and
   `site/app/procurement-phase.mjs` currently consume coarse stages. PLA-02 adds the event strip
   beside that contract and later cards may migrate consumers; it must not remove or silently
   reinterpret legacy fields in the first tranche.
5. **Generalize dwell through the existing receipt path.** The current award-registration model is
   intentionally narrow. PLA-04 reuses its versioned observation/receipt discipline and adds
   other explicitly bounded boundaries and cohorts; it does not create a parallel timing metric or
   use contract end dates, deadlines, or absent events as inferred boundaries.
6. **Graduate planning rather than duplicate ingestion.** PLA-05 extends the existing planning
   collector/read-model boundary into a separate `planned_procurement` object while preserving
   unmatched rows, explicit identifiers, reviewed high-confidence gates, and the current
   no-agency-total rule. A plan remains a plan until a later source observation proves otherwise.
7. **Use the canonical search and action wires.** PLA-03 extends the existing procurement
   SearchDocument, structured browse query, runtime route/query serialization, Following, and
   alert paths. It does not create a second search index or a separate watch vocabulary, and the
   client does not recompute state that the canonical projection has already resolved.
8. **Keep future and evaluation records additive.** `planned_procurement` and performance
   evaluations are new source-qualified object/read-model families. They may relate to a
   procurement, vendor, or agency only through exact or explicitly reviewed identity edges; they
   do not broaden the existing procurement identity heuristics.
9. **Use the app-native evidence home.** This repository has no top-level Kraken workstream
   registry, `service.json`, `waves.html`, or card index. Existing `kraken-v1` cards live under
   `docs/evidence/`, so this workstream lives at
   `docs/evidence/procurement-lifecycle-actions/` with its cards under `cards/proposed/`. No
   registry/index update is required in this repository; a separate hub can discover the
   committed path without duplicating a second manifest here.
10. **Use a docs-only verification gate.** The app has no workstream-specific card validator and
    this change intentionally implements no lifecycle behavior. Each proposed card therefore has
    a runnable `test -s` gate for the committed spec; delivery cards must replace it with their
    focused contract, fixture, and UI/API verification before implementation is marked complete.

## Card map

* [PLA-01 — Promote PASSPort RFx procedural state](cards/proposed/pla-01-promote-passport-rfx-procedural-state.md)
* [PLA-02 — Unified procurement journey](cards/proposed/pla-02-unified-procurement-journey.md)
* [PLA-03 — Lifecycle browse/search/watch actions](cards/proposed/pla-03-lifecycle-browse-search-watch-actions.md)
* [PLA-04 — Registration latency](cards/proposed/pla-04-registration-latency.md)
* [PLA-05 — Procurement plans and future opportunities](cards/proposed/pla-05-procurement-plans-future-opportunities.md)
* [PLA-06 — Vendor performance evaluations](cards/proposed/pla-06-vendor-performance-evaluations.md)
* [Research — Contract actions and Award-Milestones](cards/proposed/research-contract-actions-award-milestones.md)
