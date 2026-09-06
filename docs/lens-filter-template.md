# Lens filter template

The Property lens (`#property`) is the reference instance of the shared **lens filter
template** derived in [`docs/design-principles-lens.md`](design-principles-lens.md). The
other lenses carry the same accreting structure (intro + stepper + `.controls` box +
stacked chip rails). This file records the current design contract, not rollout status.

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

## Surface examples

The five historical rollout candidates are reconciled in the
[semantic-owner receipt](repository-governance/semantic-owner-mapping.v1.json).
Their former repository-local status is not proof of a canonical card or completion.

### Contracts / Money (`#`)
- **Parity:** agency, procurement method, award type, keyword, watch, export all reachable.
- **Landed shape:** method is the primary rail; keyword stays visible; mode, agency, amount,
  and timing share one disclosure; sort sits beside the result count; current solicitations
  precede the labeled archive. Award mode collapses ≥3 same-except-date rows via
  `same_consolidation`.

### Staffing (`#staffing`)
- **Parity:** format, salary band, fee, no-experience, agency, keyword, watch, export.
- **Landed shape:** search + More filters toolbar; exam format as primary rail; secondary
  facets (interest, eligibility, window, salary, fee, experience) in one disclosure; active
  filter strip + result count.

### Land / ZAP (`#land`)
- **Parity:** status, hearings filter, cd/council/boro, keyword, watch, export.

### Meetings (`#meetings`)
- **Parity:** process stage, group=place, agency, keyword, near-me, watch, export.

### Rules (`#rules`)
- **Parity:** phase, agency, keyword, watch, export.
- **Landed shape:** methodology in collapsed "How this list works"; search + More filters;
  phase rail primary; agency/borough secondary; active filter strip + count.

## Maintaining this file

Keep the template recap in sync with the Property reference instance when its current
design contract changes. Planning, sequencing, and implementation status belong in the control register.
