---
card_standard: kraken-v1
richness_profile: standard
group: must-have
id: cityscroll-reader-journey/rj-04
title: "RJ-04 · Make historical Contracts exploration discoverable"
status: proposed
wave: cityscroll-reader-journey-historical-contracts
spec: "../../README.md#card-map"
builds_on:
  - cityscroll-reader-journey/rj-03
blocked_by:
  - cityscroll-reader-journey/rj-03
predecessors:
  - cityscroll-reader-journey/rj-03
related:
  - cityscroll-procurement-analytical-projection/ap-04-reader-facing-analytical-projection
  - cityscroll-procurement-analytical-projection/ap-06-city-record-match-coverage
  - cityscroll-procurement-analytical-projection/ap-09-add-payments-as-second-fact
  - cityscroll-procurement-analytical-projection/ap-10-performance-evidence-gap
  - cityscroll-procurement-analytical-projection/ap-12-agency-procurement-fiscal-context
  - procurement-lifecycle-actions/pla-02
  - procurement-lifecycle-actions/pla-03
context:
  - ../../README.md#first-consolidating-reader-journey-historical-contracts
  - ../../README.md#acceptance-criteria
  - ../../README.md#design-notes-and-validation
  - site/index.html
  - site/app/money-list.mjs
  - site/analytical_projection_contract.mjs
  - site/analytical_payment_projection.mjs
  - site/procurement_document.mjs
  - site/agency_connections.mjs
  - site/agency_constellation.mjs
  - site/app/money-history.mjs
verify: "test -s docs/evidence/cityscroll-reader-journey/README.md && test -s docs/evidence/cityscroll-reader-journey/cards/proposed/rj-04-historical-contracts-journey.md"
needs_james: false
effort: L
risk: high
target: crol-list
autodispatch: false
goal: "Give ordinary Contracts readers one clear path from current procurement to historical agency, vendor, contract, and observed-payment evidence."
---
## Story

As a journalist or procurement researcher opening the ordinary Contracts surface, I need to move from current procurement to historical agency, vendor, contract, and payment evidence without knowing CityScroll query parameters or a contract identifier.

## Goal

Deliver the first consolidating reader journey:

`Contracts → historical exploration → agency → top vendors / largest contracts → contract → observed payments`

Preserve the current forward-looking Contracts default. Add one clearly scented secondary action such as “Explore contract history,” or another label consistent with current CityScroll language. The implementation may choose a dedicated route, secondary mode, agency-first directory, or another structure supported by the application; it must not assume that another tab is the answer.

## Real canaries

RJ-04 must freeze one real agency and one real registered contract with public Checkbook payments from the serving population before implementation acceptance. The current committed analytical artifacts provide a candidate, not a pre-approved fixture:

* agency: `Police Department`;
* registered contract: `CT105620268806620` with vendor `SMITH-MIDLAND CORP`;
* current artifact observation (registered-contract snapshot 2026-08-18; payment fiscal-year snapshot 2026): the registered-contract projection reports `$1,057,498` current registered value, `city_record_match=exact`, and the independent payment projection reports one FY2026 aggregate of `$752,050` for the same contract.

The dispatch must re-check those facts, retrieve the payment dates and exact transaction/document links from the serving read model, and replace the candidate if it no longer has a usable public payment specimen. A passing canary receipt must name the actual agency, contract, vendor, source vintages, registered value, cumulative observed payment amount, first and latest observed payment dates, transaction count, and exact drill-through targets. Aggregate payment rows alone are not enough to prove the date or document portions of A4.

## Journey contract

1. Start at the ordinary Contracts entry, not a deep link, text search, or manually edited URL.
2. Reach historical exploration through one clearly labeled purposeful action.
3. Reach the canary agency comparison from that entry.
4. Reach a contributing vendor or contract within two additional purposeful interactions.
5. Reach the contract-level observed payment history from the aggregate payment view and then the exact transaction/document evidence.
6. Preserve agency, vendor, fiscal-year, and contract scope through each handoff. Do not silently blend registered contract value with actual payment amount.
7. Keep coverage and methodology reachable through a deliberate secondary path. Do not let them outrank orientation, summary, or exploration.

## Evidence and absence rules

Registered contract value, observed payment amount, payment dates, transaction count, and City Record/performance-evidence coverage are separate facts with separate source and as-of labels. A missing payment observation must say “No public payment observed” or equivalent; it must never say “unpaid.”

The journey must preserve:

* exact source links and document identifiers;
* current-versus-historical measure distinctions;
* independent Checkbook spending population semantics;
* partial, unresolved, missing-PIN, and no-located-evidence states;
* the existing payment and related-contract drill-through links;
* ordinary vendor and agency identity routes, without a new identity path.

## Change

**Before:** The Contracts surface explains Open RFPs and Recent Awards, but historical exploration is behind the Recent Awards analytical area. “Actual payments” is an analytical Fact choice rather than an obvious journey step, and coverage/evidence modules can visually precede the contract/payment question.

**After (intended):** A reader enters the ordinary Contracts surface, chooses one clear historical action, compares agencies, opens a contributing vendor or contract, and reaches observed payment evidence through exact links. Forward-looking procurement remains the default, and analytical coverage becomes deliberately secondary.

**Theory / mechanism:** A scented route is a discovery bridge, not a new fact model. It exposes existing canonical projections and their evidence in the order a reader needs them: orientation, summary, exploration, evidence, then methodology.

### Gap → fix

| ID | Gap | Fix | Acceptance |
| --- | --- | --- | --- |
| G1 | Historical capability is hidden behind a forward-looking entry and Fact selector. | Add one clear historical exploration action from ordinary Contracts. | A3, A5 |
| G2 | Agency/vendor/contract/payment scope is not a single measured journey. | Preserve scope through existing canonical drill-throughs. | A3, A4 |
| G3 | Registered value and payments can appear as one financial total. | Keep facts in separate labeled views/cards and use source-specific drill-through. | A4, A5 |
| G4 | Coverage and no-evidence tables can outrank a useful positive question. | Move coverage/methodology to a secondary deliberate location and compact zero-signal states. | A5 |

## Acceptance

- [ ] A1 [outcome] From the ordinary Contracts entry, a reader reaches historical agency comparison through one clearly labeled action and reaches a contributing vendor or contract within two additional purposeful interactions.
- [ ] A2 [boundary] The journey works without text search, prior contract knowledge, CityScroll query-parameter knowledge, or manual URL editing; the forward-looking Contracts default remains intact.
- [ ] A3 [outcome] The real agency and real registered-contract canary are reachable through ordinary agency/vendor/contract routes and their exact source-backed scope is preserved.
- [ ] A4 [outcome] The canary contract displays registered contract value, cumulative observed public payments, first observed payment date, most recent observed payment date, payment transaction count, and exact transaction/document drill-through.
- [ ] A5 [boundary] Registered value, observed payments, City Record coverage, and performance-evidence availability remain separate facts with source/as-of labels; absence is not rendered as “unpaid” or an outcome.
- [ ] A6 [outcome] The ordinary default no longer places a full City Record agency-coverage matrix ahead of historical contract/payment exploration, while coverage and methodology remain reachable and source-complete.
- [ ] A7 [negative] Performance-evidence coverage with zero located evidence uses a compact scoped state rather than a full default table.
- [ ] A8 [verification] A route test proves the canary journey from normal Contracts entry through agency, vendor/contract, and payment/document destination; desktop and mobile captures prove the hierarchy.

## Non-goals

Do not add a second payment population, create a new identity join, delete coverage or performance evidence, make a payment imply contract performance, or turn the historical journey into a tutorial or general dashboard. PLA-02 and PLA-03 remain subject to the reader-journey gate once RJ-06 lands.

**Grounding:** partial — the current code contains separate registered-contract and payment projections, aggregate drill-throughs, agency/vendor routes, and coverage/evidence panels; the scented historical journey and contract-level date/document proof remain the RJ-04 delivery.
