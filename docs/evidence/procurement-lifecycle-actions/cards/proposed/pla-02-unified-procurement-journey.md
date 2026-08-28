---
card_standard: kraken-v1
richness_profile: standard
group: must-have
id: procurement-lifecycle-actions/pla-02
title: "PLA-02 · Unified procurement journey"
status: proposed
wave: procurement-lifecycle-actions-existing-data
spec: "../../README.md#card-map"
builds_on:
  - procurement-lifecycle-actions/pla-01
blocked_by: []
predecessors:
  - procurement-lifecycle-actions/pla-01
related:
  - procurement-lifecycle-actions/pla-03
context:
  - ../../README.md#shared-data-contract
  - site/procurement_object_contract.mjs
  - site/procurement_search_producer.mjs
  - site/procurement_document.mjs
  - site/procurement_phase_spine.mjs
  - worker/src/lib/checkbook_lifecycle.mjs
  - tools/build_shared_procurement_read_model.mjs
verify: "test -s docs/evidence/procurement-lifecycle-actions/README.md && test -s docs/evidence/procurement-lifecycle-actions/cards/proposed/pla-02-unified-procurement-journey.md"
needs_james: false
effort: L
risk: high
target: crol-list
autodispatch: false
goal: "Combine PASSPort RFx, City Record, PASSPort/Checkbook contract, and payment observations into one evidence-linked procurement journey."
---
## Story

The sources already describe different portions of the same procurement, but a resident must
assemble them from separate rows and coarse phases. The canonical procurement page should show an
ordered process view when exact identity and source evidence support it.

### Goal

Combine PASSPort RFx, City Record, PASSPort contracts, Checkbook contracts, and Checkbook spending
into one ordered, source-backed journey for a canonical procurement object.

### Data sources

* PASSPort public RFx observations from PLA-01.
* City Record procurement notices and exact stage extraction.
* PASSPort public contract status and registration observations.
* Checkbook contract status/registration observations.
* Checkbook spending/payment observations.
* `site/procurement_object_contract.mjs` identity and source references.

### Implementation sketch

1. Project events from the existing exact identity/read-model graph rather than creating a parallel
   join.
2. Order observed events by effective time and the bounded process order. For example:
   `Open Aug 03 RFx → Responses closed Sep 14 RFx → Intent award Nov 06 City Record → Award Nov
   21 City Record → Pending registration Dec 04 PASSPort → Registered Jan 17 PASSPort/Checkbook →
   First payment Feb 28 Checkbook`.
3. Retain all source references on each event; de-duplicate only exact repeated observations of the
   same event identity.
4. Keep contradictory source observations inspectable rather than choosing a silent winner.
5. Add the process strip/timeline to the existing canonical detail renderer and keep legacy phase
   fields available during migration.

### User-visible result

`/procurements/:id` shows a quiet, compact process strip or timeline. Each observed event opens its
source evidence. Missing or unobserved intermediate steps are simply absent; the page does not
render a tutorial or a failed checkbox sequence.

### Actions unlocked

* Follow the unified procurement.
* Offer state-change and deadline notifications based on the event stream.
* Offer selection, registration, and first-payment notifications when those events are observed.
* Deep-link from a process event to its source receipt.

## Change

**Before:** PASSPort, City Record, contract, and payment records appear as separate or coarsely
connected facts.

**After (intended):** A canonical procurement page shows the exact observed events in chronological
and process order, with no synthetic missing steps and with inspectable source receipts.

**Theory / mechanism:** The procurement object is the identity narrow waist; the process event
projection makes the existing observation graph legible without collapsing distinct sources or
inventing a complete journey.

### Gap -> fix

| ID | Gap | Fix | Acceptance |
| --- | --- | --- | --- |
| G1 | Source facts are distributed across surfaces. | Render one event projection on the canonical procurement page. | A1 |
| G2 | Repeated source rows can create duplicate timeline dots. | Use stable event identity and exact observation de-duplication. | A3 |
| G3 | Contradictory sources can disappear in a selected winner. | Preserve each conflicting source observation for inspection. | A4 |
| G4 | A timeline can imply missing stages failed. | Render only observed events and omit unobserved intermediate states. | A5 |

## Acceptance

- **Before:** A fixture with RFx + intent-to-award + award + registered contract + payment requires navigating separate records to reconstruct the sequence.

- **After:**

- [ ] A1 [outcome] For the unified journey fixture, the canonical procurement page shows the observed events `Open`, `Responses closed`, `Intent award`, `Award`, `Pending registration`, `Registered`, and `First payment` in chronological/process order.
- [ ] A2 [provenance] Every event has at least one retained source observation reference and a receipt link that opens the underlying evidence.
- [ ] A3 [deduplication] Duplicate observations of the same source event do not produce duplicate timeline dots, while distinct source events remain distinct.
- [ ] A4 [transparency] Contradictory source observations remain inspectable, with publisher values and source references visible; the renderer does not silently select an unsupported winner.
- [ ] A5 [boundary] An unobserved intermediate stage is absent rather than represented as a failed checkbox, a missing compliance step, or proof that it did not happen.
- [ ] A6 [route] The process view is attached to the existing `/procurements/:id` canonical document and does not create an instructional procurement page.
- [ ] A7 [verification] A screenshot or DOM fixture shows a CityScroll procurement record with evidence-linked events, not a generic procurement tutorial.

## Non-goals

Do not infer closeout from a contract end date, term activity, or a missing source event. Do not
replace exact identity/provenance with lifecycle heuristics.
