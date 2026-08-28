---
card_standard: kraken-v1
richness_profile: standard
group: must-have
id: procurement-lifecycle-actions/pla-03
title: "PLA-03 · Lifecycle browse/search/watch actions"
status: proposed
wave: procurement-lifecycle-actions-release-checkpoint
spec: "../../README.md#card-map"
builds_on:
  - procurement-lifecycle-actions/pla-01
  - procurement-lifecycle-actions/pla-02
blocked_by:
  - procurement-lifecycle-actions/pla-01
  - procurement-lifecycle-actions/pla-02
predecessors:
  - procurement-lifecycle-actions/pla-01
  - procurement-lifecycle-actions/pla-02
related:
  - procurement-lifecycle-actions/pla-04
context:
  - ../../README.md#shared-data-contract
  - site/procurement_search_producer.mjs
  - site/procurement_browse_query.mjs
  - site/procurement_document.mjs
  - site/app/routing.mjs
  - worker/src/search.mjs
  - worker/src/alerts.mjs
verify: "test -s docs/evidence/procurement-lifecycle-actions/README.md && test -s docs/evidence/procurement-lifecycle-actions/cards/proposed/pla-03-lifecycle-browse-search-watch-actions.md"
needs_james: false
effort: L
risk: high
target: crol-list
autodispatch: false
goal: "Make source-backed procurement process state a queryable and subscribable application capability."
---
## Story

Once the event projection and unified detail journey exist, procedural state must become an
application primitive. Residents should be able to find and follow a state without relying on
free-text labels or client-side reinterpretation.

### Goal

Make procedural state a queryable and subscribable capability across browse, search, the API/MCP
surface, and Following/alerts.

### Dependency

Depends on PLA-01 and PLA-02. PLA-03 is the release checkpoint: procurement state is now a
queryable/subscribable primitive.

### Data sources

* The canonical `procurement_process_event` projection.
* `site/procurement_search_producer.mjs` and the shared keyword index.
* Structured browse/query and route serialization.
* Existing Following and procurement alert paths.
* The canonical procurement document's action surface.

### Implementation sketch

1. Add structured state fields to the canonical SearchDocument and browse query contract.
2. Support predicates such as `state=open`, `state=evaluation`, `state=selection_made`,
   `state=intent_to_award`, `state=pending_registration`, and `state=registered`, with method and
   agency combinations.
3. Keep state resolution in the canonical projection; the API/MCP and browser client consume the
   same state and do not recompute it.
4. Make known-state cards and exact source links available in browse/search.
5. Extend Following and alerts so a watch can fire on an observed transition, not on an inferred
   or absent event.

### User-visible result

Residents can filter `/procurements` for DOT open opportunities, DOE awaiting registration, or
M/WBE small purchases at intent to award. A resident can follow a procurement and choose the
source-backed transition that should notify them.

### Actions unlocked

* Follow.
* Deadline reminder.
* Notify on a source-backed state change.
* Notify when a source-backed selection is made.
* Notify when a source-backed registration is observed.
* Notify when a source-backed first payment is observed.

## Change

**Before:** Procedural information is visible as text or stage detail, but no structured collection
or watch action is available.

**After (intended):** Known process state is a structured browse/search predicate, appears on
source-backed cards, is exposed consistently through API/MCP, and powers Following/alerts from the
same canonical projection.

**Theory / mechanism:** A shared typed query field is the narrow waist between materialized facts,
resident browse, machine consumers, and subscriptions.

### Gap -> fix

| ID | Gap | Fix | Acceptance |
| --- | --- | --- | --- |
| G1 | State is not a collection predicate. | Add a typed state query to the canonical procurement query path. | A1 |
| G2 | Client and API could disagree after independent recomputation. | Expose the same canonical state to browser, API, and MCP. | A2 |
| G3 | Watches cannot target transitions. | Add transition subscriptions backed by retained event observations. | A3, A4 |
| G4 | Unknown state can look like a known card. | Render/filter only known source-backed states. | A5 |

## Acceptance

- **Before:** The user can search procurement text/stage evidence but cannot reliably ask for a collection based on the new canonical process state.

- **After:**

- [ ] A1 [outcome] `/procurements` supports structured predicates for `open`, `evaluation`, `selection_made`, `intent_to_award`, `pending_registration`, and `registered`, including method and agency combinations where the underlying fields are present.
- [ ] A2 [parity] The API/MCP representation and browser search/browse card consume the same canonical state; the client does not recompute state from raw source labels.
- [ ] A3 [action] A resident can Follow a procurement, set a deadline reminder, and select notifications for state change, selection, registration, and first payment.
- [ ] A4 [watch] A procurement watched while `pending_registration` fires when a later source-backed `registered` event appears; it does not fire on a timer, expiry, or absence.
- [ ] A5 [negative] Duplicate source observations do not produce duplicate cards or duplicate transition alerts.
- [ ] A6 [negative] Unknown, unsupported, or unobserved states are not promoted to known-state cards or collection results.
- [ ] A7 [verification] Fixture A, Fixture B, and Fixture C can be expressed through the structured query/watch contract with evidence-backed results.

## Non-goals

Do not add permanently visible completeness disclaimers, infer unobserved events, or make absence a
compliance or delay verdict.
