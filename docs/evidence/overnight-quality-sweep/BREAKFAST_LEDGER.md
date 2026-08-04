# Overnight quality sweep — breakfast ledger

Measured against live `https://cityscroll.org/` (cache-busted payloads + Playwright walks) on 2026-08-04T02:44:48.966331Z.

## Operating bar

Fewer openings that read as **too much non-info** or **contradictory-looking info**.

## Census (fixed vs carded)

| Class | Fixed | Carded | Notes |
|---|---:|---:|---|
| Contradiction (dates/stages disagree) | 1 | 1 | Completed land + overdue public-review step **fixed**; completion-order noise carded |
| Methodology / contrastive narration | 1 | 0 | `precomputed` reader copy removed |
| Empty-state / apology density | 0 | 1 | Non-Council class-(b) vote gap still heavy |
| Surface-load / redundant CTAs | 0 | 4 | Rules list worst (8295 words / 131× CTA) |
| Location / map | 0 | 1 | Money still majority unlocated (honest) |
| Date-chip format | 0 | 0 | Clean on sample |
| Count-equals-list / granularity collapse | 0 | 0 | Unit + live district_activity OK (no zero-collapse) |

### Fixed in this pass

1. **Land completed vs open public-review clock** — [`#land/2022M0258`](https://cityscroll.org/#land/2022M0258)  
   Before: *Public status Completed* next to *Public review — step 4 of 5 … 879 days past the statutory window*.  
   Fix: refuse terminal pipeline sentences; client-normalize stale-open `statutory_clock`; skip past-deadline audit on terminal projects.  
   Proof: `docs/evidence/overnight-quality-sweep/fix_proof_land_clock.json`, `coherence_live_before_after.json`.

2. **Methodology wording** — staffing / lifecycle en copy no longer says “precomputed”.  
   Gate: `public_surface_vocab` 0 hits.

### Carded remainder (with shots where captured)

- **oqs-rules-surface-load** (surface-load) — Rules list exceeds surface-load budgets — https://cityscroll.org/#rules
  - Live sample: 8295 words / 1143 links / 236 buttons (budgets 5000/500/100); 131× identical 'Read the proposed rule…' CTA.
  - Suggested: Apply Property-lens cluster/collapse (clusterRepeatedEntries) or cap visible CTAs; fold secondary action links under disclosure.
  - Shot: `docs/evidence/overnight-quality-sweep/shots/landing-rules.png`
- **oqs-property-surface-load** (surface-load) — Property list slightly over surface-load budgets — https://cityscroll.org/#property
  - Live sample: 5449 words / 742 links / 207 buttons (budgets 5000/500/100).
  - Suggested: Audit closed-archive density after reground; ensure archive section stays collapsed and small-multiples clusters stay on.
  - Shot: `docs/evidence/overnight-quality-sweep/shots/landing-property.png`
- **oqs-money-map-unlocated** (location-resolution) — Money map still majority no-place-signal — https://cityscroll.org/#map?lens=money
  - Live district_activity: money located_rate≈0.3764705882352941; 212/340 no_place_signal.
  - Suggested: Continue money densify (agency service area / citywide phrase); keep coverage framing — do not invent pins.
- **oqs-non-council-votes-gap** (gap-class-b-repeat) — Non-Council hearing outcomes repeat class-(b) votes gap on walk sample — https://cityscroll.org/#meetings
  - Walk found repeated 'The city does not publish votes for this hearing' blocks on non-Council spines (intentional class-b, high visual weight).
  - Suggested: Collapse outcome+minutes class-(b) slots into one compact note per process spine (already doctrine) — audit renders that still expand both.
- **oqs-land-completion-order-noise** (coherence) — Land pre_application vs environmental completion-order noise — https://cityscroll.org/#land
  - After clock normalize, remaining violations dominated by completion_order_violation (11) often environmental dated before pre_application (publisher ordering).
  - Suggested: Treat environmental concurrent with pre-application as non-violation, or soften audit when ZAP sequences CEGR before filing complete.
- **oqs-exam-action-depth** (surface-load) — Exam detail first action below fold — https://cityscroll.org/#exam/7016
  - Surface-load live: first_action_y 1127 > budget 900; max_verbatim_repeat 2.
  - Suggested: Lead exam cards with apply/NOE CTA above process spine (staffing action-first already partial).
- **oqs-agency-action-depth** (surface-load) — Agency profile first action deep — https://cityscroll.org/#agency/City%20Council
  - Surface-load live: first_action_y 1632 > 900.
  - Suggested: Promote entity action rail / watch into first viewport on profile shell.

## Sampler notes

- Surface-load live: 15 surfaces; breaches: rules-list, property-list, exam-detail, agency-profile.
- Land coherence (n=40): violations 35 → 14 after client clock normalize.
- Walk: 47 routes, 89 finding rows (many apology_block hits are shared chrome / class-b gaps).
- Map: no council/CD zero-collapse; money + meetings high no-place-signal (money structural).

## Shots directory

`docs/evidence/overnight-quality-sweep/shots/`
