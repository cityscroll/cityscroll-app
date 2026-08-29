---
card_standard: kraken-v1
richness_profile: standard
group: enforced
id: cityscroll-reader-journey/rj-02
title: "RJ-02 · Stop the bleeding with reader-facing queue triage"
status: proposed
wave: cityscroll-reader-journey-stop-the-bleeding
spec: "../../README.md#card-map"
builds_on:
  - cityscroll-reader-journey/rj-01
blocked_by:
  - cityscroll-reader-journey/rj-01
predecessors:
  - cityscroll-reader-journey/rj-01
related:
  - cityscroll-civic-action-paths/cap-6
  - cityscroll-procurement-intent-radar/pir-6
  - cityscroll-evidence-bearing-civic-graph/ebcg-06-source-disagreement-ledger
  - cityscroll-civic-institutions/ci-k1-compatibility-uncertainty-navigation
  - cityscroll-land-decision-path/ldp-09-timeline-role-strips
  - procurement-lifecycle-actions/pla-02
  - procurement-lifecycle-actions/pla-03
context:
  - ../../README.md#authority-and-sequencing
  - ../../README.md#concurrent-neighboring-workstream
  - ../../README.md#acceptance-criteria
  - cityscroll-authority-native-procurement/anp-04
  - cityscroll-frictionless-subscribe/fs-11-following-create-journey
verify: "test -s docs/evidence/cityscroll-reader-journey/README.md && test -s docs/evidence/cityscroll-reader-journey/cards/proposed/rj-02-stop-the-bleeding-queue-triage.md"
needs_james: false
effort: L
risk: high
target: crol-list
autodispatch: false
goal: "Give every high-risk queued reader-facing card an explicit disposition and require a concrete retained-card contract before implementation."
---
## Story

As the owner of a portfolio whose cards compete for finite page hierarchy, I need to triage queued reader-facing proposals before they execute so that a locally correct module does not inherit an already overloaded surface.

## Goal

Complete A2 for the five named cards and any newly authored reader-facing cards discovered during RJ-01 or before this card is dispatched:

| Card | Current live concern to investigate | Required output |
| --- | --- | --- |
| `cityscroll-civic-action-paths/cap-6` | A proposed participation projection could repeat meeting, calendar, Follow, contact, and application entry points on an already rich Community Board dossier. | One explicit disposition from the allowed set, with a retained-card contract if retained. |
| `cityscroll-procurement-intent-radar/pir-6` | An early-signal lifecycle surface could add another status strip or imply a prediction without an accepted source signal. | One explicit disposition from the allowed set, with a retained-card contract if retained. |
| `cityscroll-evidence-bearing-civic-graph/ebcg-06-source-disagreement-ledger` | Source disagreement is valuable when material but could become universal provenance furniture. | One explicit disposition from the allowed set, with a retained-card contract if retained. |
| `cityscroll-civic-institutions/ci-k1-compatibility-uncertainty-navigation` | Compatibility and uncertainty infrastructure may be mistaken for permanent resident-facing page chrome. | One explicit disposition from the allowed set, with a retained-card contract if retained. |
| `cityscroll-land-decision-path/ldp-09-timeline-role-strips` | Normative role information could double every historical timeline stage instead of prioritizing the current and next useful role. | One explicit disposition from the allowed set, with a retained-card contract if retained. |

The triage scope is explicitly open-ended. The concurrently authored `procurement-lifecycle-actions/PLA-02` and `procurement-lifecycle-actions/PLA-03` cards create reader-facing procurement surfaces and must be reviewed when they are available. Newly authored reader-facing cards are not exempt because they were absent from the seed's five-card list.

## Disposition authority

Each reviewed card receives exactly one primary disposition:

* `retain` — proceed as written only if the retained-card contract is complete;
* `amend` — preserve the capability but change its reader contract before execution;
* `resequence` — keep the card but move it behind a different dependency or consolidation;
* `merge` — combine it with a neighboring card that owns the same reader question or surface;
* `split` — separate a source/data capability from its reader projection or separate incompatible journeys;
* `supersede` — replace it with a new bounded card and link the replaced proposal;
* `pause` — leave it queued but do not dispatch until a named missing condition is met.

The disposition is an evidence-backed queue decision, not a judgment about whether the underlying capability matters. Do not cancel valuable source, ontology, identity, provenance, API, or machine-consumer work merely because its default UI projection needs reconsideration.

## Change

**Before:** Each queued card is locally coherent, but its page effect, neighboring sections, empty behavior, and ordinary entry path may be unspecified. A later card can therefore add another full section to compensate for a prior one.

**After (intended):** Every high-risk reader-facing proposal has a visible disposition. Every retained proposal describes the reader question, ordinary entry, destination, default/disclosed state, consolidation or displacement, empty and unresolved behavior, positive fixture, and full-page effect before implementation starts.

**Theory / mechanism:** This is portfolio sequencing, not a universal design review. A retained-card contract makes the surface owner decide what the proposal displaces and how it behaves when evidence is absent. The disposition vocabulary keeps “valuable capability” separate from “default screen real estate.”

### Gap → fix

| ID | Gap | Fix | Acceptance |
| --- | --- | --- | --- |
| G1 | Queued cards can add equally weighted modules without naming what they subordinate. | Require a disposition and full-page effect for each card. | A2 |
| G2 | Empty, partial, and unresolved source states can be designed after the layout. | Put those states in the retained-card contract before implementation. | A2 |
| G3 | A new reader-facing card can arrive after the initial review. | Re-scan the queue at dispatch and include newly authored cards, including PLA-02 and PLA-03. | A2 |
| G4 | A valid capability can be mistaken for a default projection entitlement. | Preserve the “hypothesis, not an entitlement” rule and route alternatives through the disposition set. | A2, stop conditions |

## Retained-card contract

For every card whose disposition is `retain`, `amend`, `resequence`, or `split` and which still has a reader-facing delivery, record these fields in the queue update or linked self-contained evidence:

1. **Reader question:** the question in resident language, not an internal component name.
2. **Ordinary entry path:** the existing route or surface a reader would naturally use.
3. **Exact destination surface:** the route, section, panel, disclosure, or machine-only destination that owns the result.
4. **Default or disclosed state:** what appears on first load, what requires an intentional action, and why.
5. **Replacement/consolidation decision:** the existing element this card replaces, consolidates, or subordinates; “adds another section” is not a consolidation decision.
6. **Data-state behavior:** explicit behavior for empty, partial, unresolved, contradictory, and zero-signal data.
7. **Meaningful positive fixture:** one real or source-shaped specimen that proves the question has a useful answer.
8. **Expected full-page effect:** the section count/equal-weight effect, mobile order, desktop hierarchy, and the reader decision removed or added.
9. **Evidence and reachability:** source, identity, provenance, route, and test obligations sufficient to show the destination remains reachable from its ordinary entry.

Cards that cannot fill these fields are not entitled to proceed as reader-facing implementation. They may be split into a data/API card, paused, or superseded.

## Triage procedure

1. Consume RJ-01's reconciliation matrix and re-read each live card immediately before making a disposition.
2. Inspect the card's acceptance, dependencies, current surface owners, and representative positive/negative states.
3. Trace the ordinary reader journey through the current app. Count purposeful decisions and note repeated controls, duplicated facts, hidden destinations, and empty modules.
4. Assign one disposition, the rationale, the next dependency, and the retained-card contract where applicable.
5. Re-scan newly authored reader-facing cards, including PLA-02 and PLA-03, before closing the triage pass.
6. Do not implement the proposed capability in this card. The triage result must be consumable by the queue owner and downstream implementers.

## Acceptance

- [ ] A1 [outcome] CAP-6, PIR-6, EBCG-06, CI-K1, and LDP-09 each have one explicit disposition from retain, amend, resequence, merge, split, supersede, or pause.
- [ ] A2 [outcome] The triage scope includes any newly authored reader-facing cards found at dispatch, specifically PLA-02 and PLA-03 when present; the five named cards are not the limit.
- [ ] A3 [verification] Every retained reader-facing card records all nine retained-card contract fields, including ordinary entry, exact destination, replacement/consolidation, data-state behavior, positive fixture, and full-page effect.
- [ ] A4 [boundary] A useful underlying capability may be preserved as a summary, journey step, contextual state, secondary analytical view, dedicated route, disclosure, machine/API capability, or replacement for weaker furniture; no capability is canceled solely to make a page shorter.
- [ ] A5 [negative] No retained card adds a universal explainer, permanent coverage/provenance lecture, or top-level section without naming what it replaces or subordinates.
- [ ] A6 [dependency] RJ-03 does not begin from a queue whose reader-facing dispositions or retained contracts are missing.

## Non-goals

Do not edit the five neighboring cards in this authoring PR, implement their UI, alter source acquisition, or decide their dispositions in advance of the RJ-02 dispatch. The examples in the seed are hypotheses to test, not predetermined conclusions.

**Grounding:** required — the five live cards, ANP-04's negative rule, FS-11's journey rule, and the concurrently authored PLA-02/PLA-03 scope define the triage input; dispositions remain a later queue operation.
