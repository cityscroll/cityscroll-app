# Lens filter template — rollout

The Property lens (`#property`) is the reference instance of the shared **lens filter
template** derived in [`docs/design-principles-lens.md`](design-principles-lens.md). The
other lenses carry the same accreting structure (intro + stepper + `.controls` box +
stacked chip rails) and should adopt the template. This file is the rollout register.

## Template (recap)

```
intro        heading + one-line deck + cross-links; methodology/stepper in a "How this works" <details>
toolbar      search · sort (beside count) · [More filters ▾ · N active] · Clear
primary rail one facet the lens's primary user reaches for first (counts kept)
more-filters <details>: every secondary facet + location/agency controls (counts kept)
count line   "N results · Sort ▾"
feed         current-first ordering · small-multiples collapse · archive-never-leads
```

Invariants: one visual treatment for "narrow this list"; active filter state visible when
collapsed; **capability parity** (every prior control reachable); counts preserved; a
one-in-one-out ledger for anything retired.

## Shared building blocks (already in the tree after the Property redesign)

- **Disclosure:** reuse `.utility-overflow` `<details>`/`<summary>` (the export-overflow
  idiom) for "More filters." No new component.
- **Primary rail + counts:** the existing `.chiprow` / `.chip` / `.ct` styling is unchanged.
- **Small-multiples collapse:** `clusterRepeatedEntries()` in
  `site/property_explorer.mjs` is written lens-neutral (signature via injected accessors);
  a lens supplies its own signature fields to reuse it.
- **Active-filter count + Clear:** `.lens-toolbar` markup + the `renderPropExplorer`
  active-count/clear logic is the copyable reference.

## Rollout cards

Each card is a concrete, independently shippable task with its own acceptance. Ship one
lens per PR; keep capability parity and re-run the lens's characterization + capture.

### card lens-tmpl-01 — Contracts / Money (`#`) — adopted
- **Do:** fold the money intro stepper into "How this works"; collapse the agency/method/
  award/keyword controls into one toolbar with **method** as the primary visible facet
  (the procurement user's first cut) and the rest behind "More filters"; sort beside the
  count; archive-never-leads on closed solicitations.
- **Parity:** agency, procurement method, award type, keyword, watch, export all reachable.
- **Verify:** `node --test test/*money*` + money capture; a11y + reading-level + stray-english green.
- **Landed shape:** method is the primary rail; keyword stays visible; mode, agency, amount,
  and timing share one disclosure; sort sits beside the result count; current solicitations
  precede the labeled archive. Award mode collapses ≥3 same-except-date rows via
  `same_consolidation`.

### card lens-tmpl-02 — Staffing (`#staffing`) — adopted
- **Do:** primary facet = **exam format** (or salary band) — the job-seeker's first cut;
  secondary (fee, no-experience, agency, keyword) behind "More filters"; sort beside count.
  Staffing already uses `aria-pressed` chips — keep that; unify with the toolbar.
- **Parity:** format, salary band, fee, no-experience, agency, keyword, watch, export.
- **Verify:** `node --test test/deadline_exam_cards.test.mjs test/noe_differentiators.test.mjs test/staffing_action_first.test.mjs` + staffing capture.
- **Landed shape:** search + More filters toolbar; exam format as primary rail; secondary
  facets (interest, eligibility, window, salary, fee, experience) in one disclosure; active
  filter strip + result count.

### card lens-tmpl-03 — Land / ZAP (`#land`) — adopted
- **Do:** primary facet = **process stage / status** (or borough); ULURP status, hearings,
  geo, keyword behind "More filters"; keep the statutory-clock chrome out of the toolbar.
- **Parity:** status, hearings filter, cd/council/boro, keyword, watch, export.
- **Verify:** `node --test test/land_*` + land capture.

### card lens-tmpl-04 — Meetings (`#meetings`) — adopted
- **Do:** primary facet = **process stage** (scheduled → agenda → held → outcomes);
  place grouping, agency, keyword behind "More filters"; fold the stepper.
- **Parity:** process stage, group=place, agency, keyword, near-me, watch, export.
- **Verify:** `node --test test/meetings_explorer.test.mjs` + meetings capture.

### card lens-tmpl-05 — Rules (`#rules`) — adopted
- **Do:** primary facet = **rulemaking phase**; agency + keyword behind "More filters";
  fold the rule-phase stepper into "How this works."
- **Parity:** phase, agency, keyword, watch, export.
- **Verify:** `node --test test/rules_explorer.test.mjs test/rules_lens_organization.test.mjs` + rules capture.
- **Landed shape:** methodology in collapsed "How this list works"; search + More filters;
  phase rail primary; agency/borough secondary; active filter strip + count.

## Maintaining this file

Update the ledger when a card ships (mark it, link the commit). Keep the template recap in
sync with the Property reference instance if the reference changes. When every lens has
adopted the template, retire the cards section and keep the template as the standing spec.

