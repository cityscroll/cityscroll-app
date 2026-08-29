---
card_standard: kraken-v1
richness_profile: standard
group: enforced
id: cityscroll-reader-journey/rj-06
title: "RJ-06 · Install the permanent reader-journey PR gate"
status: proposed
wave: cityscroll-reader-journey-permanent-gate
spec: "../../README.md#card-map"
builds_on:
  - cityscroll-reader-journey/rj-05
blocked_by:
  - cityscroll-reader-journey/rj-05
predecessors:
  - cityscroll-reader-journey/rj-05
related:
  - procurement-lifecycle-actions/pla-02
  - procurement-lifecycle-actions/pla-03
  - cityscroll-frictionless-subscribe/fs-11-following-create-journey
  - cityscroll-authority-native-procurement/anp-04
context:
  - ../../README.md#acceptance-criteria
  - ../../README.md#stop-conditions
  - ../../README.md#design-notes-and-validation
  - .github/workflows/
  - test/standards/
  - tools/
  - tools/capture_lifecycle_coherence.py
  - tools/capture_passport_lifecycle.py
verify: "test -s docs/evidence/cityscroll-reader-journey/README.md && test -s docs/evidence/cityscroll-reader-journey/cards/proposed/rj-06-permanent-reader-journey-gate.md"
needs_james: false
effort: M
risk: high
target: crol-list
autodispatch: false
goal: "Make reader-journey and surface-coherence obligations a durable, enforced PR convention for future reader-facing additions."
---
## Story

As a future contributor adding a reader-facing section, panel, tab, selector, timeline strip, matrix, card family, or persistent disclosure, I need the PR gate to require a full-page journey and displacement decision so that local acceptance cannot silently accumulate default clutter.

## Goal

Implement A7 in the repository's established PR-gate convention. The result must be enforced by CI or review tooling according to the repo's existing pattern, not left as a suggestion in a README or a reviewer memory aid.

The gate applies to new reader-facing presentation. It must not block source ingestion, ontology, identity, provenance, API, or machine-consumer work that has no reader-facing projection. A card may still propose a reader surface, but a PR adding that surface cannot pass without the required contract.

## Required PR contract

For every in-scope PR, the enforced checklist must require:

* the stable Kraken card;
* the reader question, ordinary entry point, and purposeful journey to the destination;
* full-page before/after captures at exactly 390px and 1440px widths, using the repository's headless capture pattern;
* default-versus-disclosed behavior and the first-load hierarchy;
* the consolidation or displacement decision, including what the new surface replaces, consolidates, or subordinates;
* one meaningful positive fixture with source/identity/provenance grounding;
* empty, partial, unresolved, contradictory, and zero-signal behavior as relevant;
* a test showing that the destination remains reachable from its normal entry surface;
* explicit surface-owner approval when a new always-visible top-level section replaces or consolidates nothing.

The capture requirement is full-page, not a component crop. Each before/after pair must make the page effect reviewable at both widths and must be committed or exposed through a stable repository/hosted review surface. Local filesystem references are not publishable evidence.

## Enforcement design

1. Identify the existing CI/review checklist and the path or metadata convention already used for required PR evidence.
2. Add a reader-journey gate to that convention rather than creating an isolated parallel process.
3. Detect in-scope presentation changes by the repository's established changed-path or declaration mechanism. Require the contract when a PR adds or materially changes a reader-facing section, panel, tab, selector, timeline strip, matrix, card family, or persistent disclosure.
4. Make missing fields fail the gate and make a complete, valid fixture pass it. A prose-only declaration must not satisfy an enforced check.
5. Require the normal-entry reachability test and the two viewport captures; do not accept a deep-link-only screenshot or a component-only visual.
6. Provide a documented, reviewable exemption for source/machine-only changes and an explicit surface-owner approval path for a non-consolidating always-visible section.

The gate is a guardrail around page hierarchy, not a mandate to remove evidence. It must preserve the same source-honesty and empty-suppression boundaries used by ANP-04 and the same fewer-decisions/canonical-route discipline demonstrated by FS-11.

## Change

**Before:** Reader-facing PRs can include local acceptance tests and screenshots while leaving the ordinary journey, first-load hierarchy, displacement, empty behavior, and normal-entry reachability implicit.

**After (intended):** The repository's durable PR gate blocks an in-scope reader-facing change until its queue identity, journey, full-page 390px/1440px captures, hierarchy, consolidation decision, fixture, data-state behavior, and reachability proof are present and reviewable.

**Theory / mechanism:** The gate moves surface ownership to the moment a new card becomes a PR. It makes “a proposed card is a hypothesis, not an entitlement to screen real estate” operational without turning every data capability into a UI review.

### Gap → fix

| ID | Gap | Fix | Acceptance |
| --- | --- | --- | --- |
| G1 | A new surface can pass local tests while degrading the full page. | Require full-page before/after captures and a displacement decision. | A7 |
| G2 | Journey reachability can be assumed from a deep link. | Require a normal-entry reachability test. | A7 |
| G3 | Empty or partial behavior can be deferred until after layout work. | Require data-state behavior and a positive fixture in the gate contract. | A7 |
| G4 | A checklist can drift into optional prose. | Enforce the checklist in CI or review tooling using the existing repo convention. | A7 |
| G5 | A broad gate can burden machine-only work. | Scope enforcement to reader-facing changes and provide a clear source/machine-only exemption. | A7, stop conditions |

## Acceptance

- [ ] A1 [outcome] An in-scope reader-facing PR cannot pass the repository gate without its stable Kraken card, reader question, ordinary entry, exact destination, and journey description.
- [ ] A2 [verification] The enforced gate requires full-page before/after captures at 390px and 1440px widths, with stable reviewable evidence rather than local-only references.
- [ ] A3 [outcome] The gate requires default-versus-disclosed behavior and a consolidation/displacement decision; a new always-visible top-level section that replaces nothing requires explicit surface-owner approval.
- [ ] A4 [verification] The gate requires one meaningful positive fixture, relevant empty/partial/unresolved/zero-signal behavior, and source/identity/provenance grounding.
- [ ] A5 [verification] The gate requires a test proving that the destination remains reachable from its normal entry surface; deep-link-only proof fails.
- [ ] A6 [negative] A valid machine/API-only or source-only change is not forced into a reader-facing capture contract, while a reader-facing projection cannot bypass the gate by describing itself as data work.
- [ ] A7 [verification] Automated or review-tool enforcement proves both rejection of an incomplete contract and acceptance of a complete fixture in the repository's established PR-gate path.
- [ ] A8 [boundary] The gate preserves evidence, machine capabilities, unresolved meaning, and existing empty-section suppression; it does not authorize removal of meaningful data merely to shorten a page.

## Non-goals

Do not add a “Reader journey” panel to CityScroll, build a second workstream registry, require screenshots for machine-only work, or replace human surface-owner judgment where the explicit approval exception is required.

**Grounding:** partial — the repository has established CI, test, and headless capture patterns and the two named journey/negative-rule precedents; the durable enforcement change remains the RJ-06 delivery.
