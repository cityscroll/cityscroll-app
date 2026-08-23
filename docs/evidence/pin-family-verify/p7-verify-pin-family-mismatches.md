---
card_standard: kraken-v1
richness_profile: micro
group: enforced
needs_james: "Human review of 6 distinct-vendor PIN-family Checkbook↔PASSPort pairs (not the original 42). Auto-labeled related instruments do not wait on a person."
id: cityscroll-procurement-observability/p7-verify-pin-family-mismatches
title: "p7 · Verify only the genuinely-ambiguous PIN-family mismatches"
status: proposed
wave: procurement-observability-w3
spec: "waves.html#card-status-heading"
small_card_reason: "Six distinct-vendor shared-PIN pairs still need a same-versus-related verdict; the other thirty-six PIN-family id mismatches are rule-labeled related instruments."
builds_on:
  - cityscroll-procurement-observability/p3-canonical-procurement-object
related:
  - cityscroll-procurement-observability/p11-recent-awards-discovery-ux
context:
  - site/data/passport_checkbook_crosswalk.json
  - site/data/pin_family_mismatch_review.json
  - entity_resolution/cross_domain/pin_family_mismatch.mjs
  - tools/build_pin_family_review.mjs
  - worker/src/lib/pin_family_verify.mjs
verify: "Open authenticated GET /admin/pin-family-verify, inspect the 6 distinct-vendor pairs with side-by-side evidence, and record same-contract versus related-instrument. Auto-labeled CTA1↔MMA1 and successor-term rows must not appear on that default queue."
---

## Story

On the two-thousand-row Checkbook slice, forty-two PIN-family joins pair different contract-id strings. Most of those are mechanically related instruments (requirement contract vs master agreement, or a newly registered successor term). Only six name different vendors on the shared PIN, so a person still has to say same-contract versus related-instrument.

## Change

**Before:** All forty-two PIN-family id mismatches were queued as human-verify asks, including CTA-vs-MMA1 pairs that already agree on vendor.

**After (intended):** Thirty-six are auto-labeled `related_instrument` (15 FMS document-type mismatches, 18 successor terms, 3 later-term renewals). Six distinct-vendor pairs are listed on `/admin/pin-family-verify` with Checkbook and PASSPort evidence and a one-click same-contract / related-instrument verdict. Exact contract-id matches stay public; PIN-family mismatches are not sold as the same contract.

**Theory / mechanism:** Different FMS contract ids that share a PIN are a related-instrument class unless a person confirms otherwise. Document-type mismatch and same-vendor sequential terms are rule-complete. Distinct vendors on one PIN are the residual ambiguous class.

### Gap -> fix
| ID | Gap | Fix | Closes |
| --- | --- | --- | --- |
| G1 | Forty-two PIN-family matches disagree on contract id | Auto-label 36; queue 6 distinct-vendor pairs | A1 |
| G2 | Auto-promotion could sell related instruments as one contract | Keep exact contract-id matches public; hold PIN-family id mismatches | A2 |
| G3 | Captain was shown matched examples without a verify action | Desk surface lists only the 6 with evidence and writes a verdict | A3 |

## Acceptance

- [ ] A1 [outcome] [G1] Each of the six distinct-vendor PIN-family pairs has a recorded same-contract or related-instrument disposition on `/admin/pin-family-verify`.
- [ ] A2 [boundary] [G2] Exact contract-id matches remain public and PIN-family id mismatches are not sold as the same contract.
- [ ] A3 [verification] [G3] The review receipt reports 42 / 36 auto / 6 human and names the remaining pairs before any further product copy change.
