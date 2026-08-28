---
card_standard: kraken-v1
richness_profile: standard
group: must-have
id: procurement-lifecycle-actions/pla-01
title: "PLA-01 · Promote PASSPort RFx procedural state"
status: proposed
wave: procurement-lifecycle-actions-existing-data
spec: "../../README.md#card-map"
builds_on: []
blocked_by: []
predecessors: []
related:
  - procurement-lifecycle-actions/pla-02
context:
  - ../../README.md#shared-data-contract
  - worker/src/passport.mjs
  - worker/src/lib/passport_parse.mjs
  - worker/src/lib/passport_lifecycle.mjs
  - site/procurement_object_contract.mjs
  - tools/build_shared_procurement_read_model.mjs
verify: "test -s docs/evidence/procurement-lifecycle-actions/README.md && test -s docs/evidence/procurement-lifecycle-actions/cards/proposed/pla-01-promote-passport-rfx-procedural-state.md"
needs_james: false
effort: M
risk: high
target: crol-list
autodispatch: false
goal: "Stop flattening every PASSPort public RFx to solicitation when the publisher exposes a procedural status."
---
## Story

PASSPort public RFx observations already carry `rfx_status`, release date, and due date, but the
current shared procurement object projects every RFx to the coarse `solicitation` stage. Residents
need the publisher's actual procedural state and a safe action attached to it.

### Goal

Stop flattening every RFx to `solicitation`. Promote source-observed PASSPort RFx procedural state
into the shared `procurement_process_event` projection while keeping the literal publisher value.

### Data sources

* `passport_public_rfx` source observations / retained `passport_rfx` rows.
* PASSPort RFx parser fields: `rfx_status`, `release_date`, `due_date`, procurement method, and
  publisher identifiers.
* Existing source receipts and `site/procurement_object_contract.mjs` identity references.

No new ingestion is required unless the current snapshot path discards a required status or date
field.

### Implementation sketch

1. Extend the shared materialization to carry the retained RFx observations into the observation
   set consumed by the procurement search/read model.
2. Normalize explicit publisher statuses as follows:
   `Planned → planned`, `Released → open`, `Responses Received → evaluation`,
   `Selections Made → selection_made`, and `Closed → closed/source-specific terminal state`.
3. Preserve the literal publisher value as `publisher_state` and attach the source observation
   reference and receipt to every event.
4. Do not infer a winning vendor from `Selections Made`; do not infer evaluation or closed from an
   expired due date.
5. Keep the legacy coarse `solicitation` field until downstream cards migrate its consumers.

### User-visible result

An RFx with `Released` is shown as `Open` with its publisher due date. An RFx with `Responses
Received` is shown as `Evaluation · responses no longer accepted` with the observed date. The
literal status and source evidence remain one click away.

### Actions unlocked

* Follow the procurement.
* Remind the resident before the publisher due date.
* Notify when a source-backed response-closure state is observed.
* Notify when a source-backed selection is made.

## Change

**Before:** Before `Released` and `Responses Received` are both effectively coarse
`solicitation`.

**After (intended):** `Released` projects to `open`; `Responses Received` projects to `evaluation`;
the literal publisher value is retained; the due date is publisher-backed; an expired deadline
alone cannot produce `evaluation` or `closed`; `Selections Made` has no selected vendor unless a
public observation identifies one; an unmapped or absent publisher status is `unknown`.

**Theory / mechanism:** A deterministic, receipt-bearing normalization makes the publisher's
procedural observation useful without inventing an agency action or an outcome.

### Gap -> fix

| ID | Gap | Fix | Acceptance |
| --- | --- | --- | --- |
| G1 | Every RFx is flattened to `solicitation`. | Map only explicit publisher statuses to canonical process events. | A1, A2 |
| G2 | The shared build omits retained RFx rows. | Add `passport_rfx` to the shared observation materialization. | A3 |
| G3 | Deadline expiry can be overread as a state. | Use due date only as a deadline field; never derive evaluation or closed from expiry. | A4, A5 |
| G4 | Selection state can be overread as a vendor identity. | Require a separate public vendor observation. | A6 |

## Acceptance

- **Before fixture:** An RFx whose publisher state is `Released` and one whose publisher state is `Responses Received` both resolve to the coarse solicitation stage.

- **After fixture:**

- [ ] A1 [outcome] A PASSPort RFx with publisher status `Released` is represented as `open` with `state_basis=explicit`, a retained source observation reference, and the literal `publisher_state=Released`.
- [ ] A2 [outcome] A PASSPort RFx with publisher status `Responses Received` is represented as `evaluation` with `publisher_state=Responses Received` and resident-facing wording that responses are no longer accepted, without claiming what an agency is doing next.
- [ ] A3 [provenance] The shared read model contains the already-retained RFx status/date observations needed by the event projection; no new acquisition is introduced when the existing snapshot contains them.
- [ ] A4 [boundary] `effective_at` and `deadline` come from publisher fields; no date is inferred from a neighboring event or from the current clock.
- [ ] A5 [negative] An expired due date alone cannot produce `evaluation`, `responses_closed`, or `closed`; the state remains the publisher-backed state or `unknown`.
- [ ] A6 [negative] `Selections Made` never emits `vendor_ref` unless a separate retained public observation identifies that vendor.
- [ ] A7 [negative] An absent or unmapped publisher status emits `unknown` rather than a lifecycle verdict.
- [ ] A8 [verification] Fixture A and Fixture B in the workstream README pass with source receipt links and deterministic state-basis metadata.

## Non-goals

Do not scrape authenticated or vendor-private PASSPort views, infer unobserved events, or replace
exact source identity with an RFx text heuristic.
