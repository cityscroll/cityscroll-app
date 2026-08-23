---
card_standard: kraken-v1
richness_profile: micro
group: enforced
needs_james: null
id: cityscroll-procurement-observability/p11-recent-awards-discovery-ux
title: "p11 · Discovery UX for Recent Awards as the small-purchase path plus PIN-sibling grouping"
status: implemented
wave: procurement-observability-w3
spec: "waves.html#card-status-heading"
small_card_reason: "This is a discovery and grouping slice that depends on p7 precision review and does not change ingest, digest compile, or the Checkbook publication cap."
builds_on:
  - cityscroll-procurement-observability/p6-restore-passport-public-fields
  - cityscroll-procurement-observability/p7-verify-pin-family-mismatches
related:
  - cityscroll-procurement-observability/p4-search-browse-follow
context:
  - site/browse_view.mjs
  - site/app/money-list.mjs
  - site/pin_sibling_grouping.mjs
  - test/procurement_browse_parity.test.mjs
  - test/pin_sibling_grouping.test.mjs
verify: "node --test test/pin_sibling_grouping.test.mjs test/procurement_browse_parity.test.mjs test/contracts_lens_organization.test.mjs; python3 test/standards/no_disclaimer_slop.py"
---

## Story

Default Open RFPs hides registered PASSPort-only rows by design, so a resident looking for small purchases has to know to open Recent Awards, and the same vendor can appear as a City Record award beside a PASSPort-only registration with no related-instrument treatment.

## Change

**Before:** Recent Awards already mixes CROL-negative rows, Open RFPs stays solicitation-only, and PIN-sharing pairs such as TAMEER's large award and small registration list as unrelated accidents.

**After:** Open RFPs copy and a Recent Awards signpost name the registered-contract list. Same-vendor PIN-family rows and p7 `related_instrument` pairs cluster as related instruments of one procurement without merging contract ids. Distinct-vendor / `needs_review` pairs stay separate related-candidates.

**Theory / mechanism:** Discovery copy should name the list that already contains registered PASSPort-only rows, and sibling grouping waits on p7's verified related-instrument class so related instruments are not collapsed into one identity.

### Gap -> fix
| ID | Gap | Fix | Closes |
| --- | --- | --- | --- |
| G1 | Open RFPs hides registered small-purchase objects | Point that path at Recent Awards | A1 |
| G2 | PIN-sharing rows list as unrelated accidents | Group them after p7 related-instrument dispositions / same-vendor PIN family | A2 |
| G3 | Distinct contract ids must not silently merge | Keep separate objects and show an explicit related treatment | A3 |

## Acceptance

- [x] A1 [outcome] [G1] A resident can reach registered PASSPort-only small purchases from a documented Recent Awards path rather than only from an exact contract-id search.
- [x] A2 [boundary] [G2] Open RFPs remains solicitation-only and PIN-siblings are not merged into one contract identity.
- [x] A3 [verification] [G3] Browse tests plus the p7 disposition receipt prove sibling grouping is explicit related-instrument treatment, not a silent join.
