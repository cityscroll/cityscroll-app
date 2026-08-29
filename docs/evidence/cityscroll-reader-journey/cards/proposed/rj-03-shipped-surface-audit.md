---
card_standard: kraken-v1
richness_profile: standard
group: must-have
id: cityscroll-reader-journey/rj-03
title: "RJ-03 · Audit shipped surfaces and choose consolidations"
status: proposed
wave: cityscroll-reader-journey-shipped-surface-audit
spec: "../../README.md#card-map"
builds_on:
  - cityscroll-reader-journey/rj-02
blocked_by:
  - cityscroll-reader-journey/rj-02
predecessors:
  - cityscroll-reader-journey/rj-02
related:
  - cityscroll-procurement-analytical-projection/ap-04-reader-facing-analytical-projection
  - cityscroll-procurement-analytical-projection/ap-06-city-record-match-coverage
  - cityscroll-procurement-analytical-projection/ap-09-add-payments-as-second-fact
  - cityscroll-procurement-analytical-projection/ap-10-performance-evidence-gap
  - cityscroll-procurement-analytical-projection/ap-12-agency-procurement-fiscal-context
  - cityscroll-cb-money/cb-money-04
  - cityscroll-cb-money/cb-money-05
context:
  - ../../README.md#problem-statement
  - ../../README.md#reader-hierarchy
  - ../../README.md#consolidation-targets
  - ../../README.md#design-notes-and-validation
verify: "test -s docs/evidence/cityscroll-reader-journey/README.md && test -s docs/evidence/cityscroll-reader-journey/cards/proposed/rj-03-shipped-surface-audit.md"
needs_james: false
effort: L
risk: high
target: crol-list
autodispatch: false
goal: "Turn the shipped reader-facing lineage into a bounded surface inventory and a small, evidence-backed set of consolidating changes."
---
## Story

As a reader moving among CityScroll's Contracts, agency, and Community Board surfaces, I need recently shipped capabilities to be audited as a whole page so that correct modules can be kept while their hierarchy, entry points, and empty states become coherent.

## Goal

Use RJ-01's reconciled PR range and RJ-02's dispositions to audit shipped surface changes, then select and implement only a small number of consolidating changes with the highest journey value. This card is not a request to make every surface symmetrical or to add a portfolio dashboard.

The audit must cover at least:

| Surface family | What to inspect | Typical question |
| --- | --- | --- |
| Contracts | Forward-looking default, Recent Awards, analytical fact/view selectors, coverage and evidence panels, vendor and payment drill-through | Can a reader discover historical agency/vendor/contract/payment exploration without first understanding the analytical controls? |
| Agency dossiers | Identity, connected records, contracts, top vendors, fiscal context, payments, source identity, empty/unknown categories | Does the agency remain oriented around what it is before historical measures and methodology compete with the procurement journey? |
| Community Board dossiers | Institution versus geography, records, meetings, people, committees, money, governance, participation, empty coverage states | Can a reader find a useful summary and next action without a parade of equally weighted sections? |
| Cross-surface evidence | Exact links, source labels, as-of values, unresolved states, mobile ordering, deferred loading | Does consolidation preserve the capability and evidence path rather than merely hiding the module? |

## Audit method

1. Start from RJ-02's retained-card contracts and inspect the current public document, normal entry path, default order, disclosed order, and exact destination for each shipped capability.
2. Use a representative positive specimen and a meaningful empty/partial/unresolved specimen for each surface family. Record the source, identity, and current data-as-of for every claim.
3. Count equally weighted default sections and visible choices at 390px and 1440px. Record repeated facts, controls that expose another control, route-only capabilities, and modules with no useful positive specimen.
4. Trace every proposed consolidation to the existing owner and canonical read model. Do not create a second aggregation, identity join, source adapter, or route solely to improve presentation.
5. Select a small, prioritized change set. Each item must say what moves, what stays, what is disclosed, what replaces or subordinates it, and what evidence remains reachable.
6. Stop any item that would remove a meaningful unresolved state, move source evidence below an inaccessible boundary, or add compensating navigation around an unchanged cluttered queue.

## Candidate consolidation questions

These are audit hypotheses, not pre-authorized changes:

* **Contracts:** Keep Open RFPs and newly published procurement prominent; give historical agency/vendor/contract exploration a clearly scented secondary entry; make coverage and performance-evidence views secondary without deleting them.
* **Agency:** Keep a compact identity and procurement summary first; make top vendors, largest contracts, and observed payments purposeful drill-throughs; keep IBO history separately labeled and non-dominant.
* **Community Boards:** Compose money, governance, meeting, people, committee, and participation capabilities into a summary/action structure; retain board-versus-district identity; suppress repeated empty categories.
* **Cross-surface:** Prefer an existing route, disclosure, or contextual state when it answers the reader question; do not add a universal “Reader journey” panel.

The delivered change set may reject any of these hypotheses when current evidence shows that the proposed move would damage orientation, source honesty, or reachability.

## Change

**Before:** Recent correct work is distributed across default sections, controls, and disclosures whose local acceptance did not measure the full-page hierarchy. Historical and analytical capabilities can be technically reachable but practically undiscoverable.

**After (intended):** A bounded inventory makes page competition measurable, and a small selected set of consolidations improves sequence and discoverability while preserving source-backed capability paths. Each change has a full-page rationale and a positive/negative fixture.

**Theory / mechanism:** Audit before implementation is a portfolio-level form of progressive disclosure. It distinguishes the data capability from the place where a reader first encounters it and creates a displacement decision before any new furniture is built.

### Gap → fix

| ID | Gap | Fix | Acceptance |
| --- | --- | --- | --- |
| G1 | Shipped modules are accepted independently but not measured as a page hierarchy. | Inventory default/disclosed sections, choices, order, and route reachability. | A1, A2 |
| G2 | A consolidation can hide a capability or its evidence. | Keep exact destination, source, identity, and disclosed-state links in every audit row. | A2, A3 |
| G3 | A broad cleanup can become another dashboard or redesign. | Select a small, prioritized set with explicit displacement and stop rules. | A1, A4 |
| G4 | Empty and zero-signal modules can dominate because they are technically correct. | Include empty/partial specimens and require compact or suppressed treatment where appropriate. | A2, A4 |

## Audit receipt

The receipt must include:

* surface family, route, normal entry, owner module, and current data-as-of;
* shipped capability and its stable originating card/PR;
* default versus disclosed state and exact destination;
* positive, empty, partial, and unresolved specimen references where applicable;
* current equally weighted section count and visible decision count at 390px and 1440px;
* duplication or hierarchy issue, preservation risk, and proposed disposition;
* selected consolidation change, what it replaces/subordinates, and what remains reachable;
* explicit rejected hypotheses and the reason for rejecting them.

## Acceptance

- [ ] A1 [outcome] Contracts, agency dossiers, and Community Board dossiers each have a current shipped-surface inventory grounded in RJ-01 and RJ-02.
- [ ] A2 [verification] Each inventory row records ordinary entry, exact destination, default/disclosed state, source/data state, positive specimen, and full-page effect at the relevant widths.
- [ ] A3 [boundary] Every selected consolidation preserves exact source-backed capabilities, unresolved meaning, identity, provenance, and normal route reachability.
- [ ] A4 [outcome] The selected set is small and prioritized; no item is a general dashboard, universal reader-journey panel, or compensating navigation layer around unchanged clutter.
- [ ] A5 [verification] Empty, partial, unresolved, and zero-signal states are represented honestly, with repeated empty categories suppressed where the owning surface already supports that rule.
- [ ] A6 [dependency] RJ-04 begins from named, evidence-backed consolidation targets rather than an unbounded redesign request.

## Non-goals

Do not implement the entire audit in this authoring PR, move source data, rewrite identity contracts, or make all existing sections equally visible. RJ-04 and RJ-05 implement only the bounded changes selected after this audit.

**Grounding:** partial — the repository contains the shipped Contracts, agency, and Community Board projections and their focused evidence; the portfolio inventory and selected consolidation set remain the RJ-03 delivery.
