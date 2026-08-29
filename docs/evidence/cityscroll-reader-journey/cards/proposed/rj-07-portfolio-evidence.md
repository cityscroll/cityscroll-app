---
card_standard: kraken-v1
richness_profile: standard
group: must-have
id: cityscroll-reader-journey/rj-07
title: "RJ-07 · Prove the portfolio reader-journey result"
status: proposed
wave: cityscroll-reader-journey-portfolio-evidence
spec: "../../README.md#card-map"
builds_on:
  - cityscroll-reader-journey/rj-06
blocked_by:
  - cityscroll-reader-journey/rj-06
predecessors:
  - cityscroll-reader-journey/rj-06
related:
  - cityscroll-reader-journey/rj-04
  - cityscroll-reader-journey/rj-05
  - cityscroll-reader-journey/rj-06
context:
  - ../../README.md#acceptance-criteria
  - ../../README.md#reader-hierarchy
  - ../../README.md#dispatch-order-and-dependencies
  - ../../README.md#design-notes-and-validation
verify: "test -s docs/evidence/cityscroll-reader-journey/README.md && test -s docs/evidence/cityscroll-reader-journey/cards/proposed/rj-07-portfolio-evidence.md"
needs_james: false
effort: M
risk: medium
target: crol-list
autodispatch: false
goal: "Show that CityScroll now offers fewer competing default choices while preserving or improving access to the underlying capabilities and evidence."
---
## Story

As a reader and maintainer evaluating a portfolio of civic capabilities, I need evidence of the whole-page result—not only evidence that another module shipped—so that a successful local implementation is not mistaken for a coherent product journey.

## Goal

Complete A8 with a bounded portfolio evidence set covering:

* the historical Contracts journey and its real agency/contract canaries;
* one representative agency dossier;
* one representative Community Board dossier;
* the normal-entry reachability and evidence links preserved by each consolidation;
* the RJ-06 gate operating on a future reader-facing change or complete fixture.

The evidence must compare equivalent routes, fixtures, widths, and source/data vintages where possible. It must show fewer competing default choices while preserving or improving access to underlying capability and evidence. “A new module exists” is not a portfolio result.

## Measures

Record measured, derived, estimated, and unknown values separately:

1. **Default hierarchy:** number of equally weighted default sections and visible competing choices at 390px and 1440px for each representative surface.
2. **Journey effort:** purposeful interactions from ordinary Contracts entry to historical agency comparison, contributing vendor/contract, and observed payment evidence.
3. **Reachability:** whether each retained Contracts, agency, and Community Board capability remains reachable from its normal entry without text search or URL editing.
4. **Evidence preservation:** source labels, identity keys, data-as-of values, unresolved/partial/empty states, and exact record/document destinations remain present.
5. **Gate operation:** an incomplete reader-facing PR contract is rejected and a complete fixture is accepted by the durable RJ-06 path.

Do not manufacture a numerical improvement where the repository can only establish a qualitative or unknown result. A stable before/after capture plus a machine-readable route/section receipt is stronger than an ungrounded score.

## Evidence package

The final package should include:

* a portfolio receipt naming the routes, specimens, source/data vintages, commit, and capture widths;
* before/after full-page captures for Contracts, the agency dossier, and the Community Board dossier at 390px and 1440px;
* a journey trace from ordinary Contracts entry through historical exploration, agency, vendor/contract, and payment/document evidence;
* a capability reachability table showing what moved, what was disclosed, what was subordinated, and what remained machine/API-only;
* empty, partial, unresolved, and zero-signal evidence for the affected surfaces;
* the RJ-06 enforcement receipt and its incomplete/complete fixture outcomes;
* any remaining gaps, rejected stop-condition risks, and follow-on work that is still warranted.

## Change

**Before:** Individual PRs can prove local accuracy, accessibility, source grounding, or a new capability while leaving the aggregate number of choices, default sections, and purposeful handoffs unmeasured.

**After (intended):** The portfolio evidence demonstrates a smaller or no-more-equal-weight default hierarchy, a discoverable historical Contracts journey, consolidated agency/Community Board entry, preserved underlying capabilities, and an operating future gate.

**Theory / mechanism:** A portfolio receipt closes the feedback loop from local acceptance to reader outcome. It treats hierarchy and reachability as product behavior, while retaining source-backed evidence and explicit unknowns.

### Gap → fix

| ID | Gap | Fix | Acceptance |
| --- | --- | --- | --- |
| G1 | Shipped capability is being used as a proxy for coherent experience. | Compare default hierarchy and purposeful journey effort. | A8 |
| G2 | Consolidation can hide or strand a capability. | Include reachability and exact evidence destinations in the receipt. | A8 |
| G3 | Empty/partial states can disappear from a polished capture. | Include positive, empty, partial, unresolved, and zero-signal proof. | A8 |
| G4 | A permanent gate can be documented but not operative. | Show incomplete rejection and complete acceptance from RJ-06. | A7, A8 |

## Acceptance

- [ ] A1 [outcome] Final evidence covers historical Contracts, one representative agency, and one representative Community Board at 390px and 1440px with equivalent before/after routes and fixtures.
- [ ] A2 [outcome] The evidence shows fewer competing default choices or no increase in equally weighted default sections while preserving or improving the reader's access to underlying capabilities and evidence.
- [ ] A3 [verification] The Contracts trace begins at the ordinary entry and reaches historical agency comparison, a contributing vendor or contract, and observed payment/document evidence without text search, contract knowledge, or manual URL editing.
- [ ] A4 [verification] The agency and Community Board traces preserve exact identity, source, as-of, empty/partial/unresolved, and record/document destinations; no second aggregation or identity path is introduced.
- [ ] A5 [boundary] Registered contract value, observed payments, coverage, performance-evidence availability, agency fiscal history, board money, and district geography remain semantically distinct in the evidence.
- [ ] A6 [verification] The RJ-06 gate receipt shows an incomplete reader-facing contract rejected and a complete contract accepted through the durable repository PR-gate convention.
- [ ] A7 [negative] The package does not claim success from screenshots alone, does not hide a meaningful unresolved state, and does not treat absence as unpaid, noncompliant, or poor performance.
- [ ] A8 [outcome] Remaining gaps and warranted follow-on work are listed explicitly; the portfolio result is not declared complete merely because each local PR merged.

## Non-goals

Do not add new UI in this evidence card, replace source receipts with screenshots, invent a portfolio score, or claim that every historical capability belongs on the default page.

**Grounding:** pending — RJ-04, RJ-05, and RJ-06 must supply the implementation and enforcement receipts before A8 can be evaluated.
