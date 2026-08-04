# Lens design principles — re-grounding the filter surface

Status: adopted 2026-08-03. Reference instance: the Property lens (`#property`).
This is the theory leg behind the Property redesign and the shared **lens filter
template** the other lenses adopt. It exists so the next "this feels off" is checked
against a stated reference instead of re-argued by taste.

## 1. The drift being corrected

Each shipped Property feature added its own full-width control row. By 2026-08 the
lens opened with, top to bottom:

1. a kicker + heading + deck,
2. a three-step **pipeline diagram** (Hearing → Auction/RFP → Award),
3. a bordered **controls** box (borough, neighborhood, use-my-location, agency, search, watch),
4. **Item type** chip rail,
5. **Sale method** chip rail,
6. **Price** chip rail,
7. a **Sort by** select,
8. **Disposition stage** chip rail,
9. **When** chip rail,
10. an export bar,
11. the list.

Six filter taxonomies stacked as co-equal rows, plus a diagram and two control
clusters, before a single notice is seen. This is **path-dependent accretion**: no
one row is wrong, but the sum inverts the figure/ground — controls outweigh content.

A second, compounding symptom: because the temporal state at open was "closing soon 0,
upcoming 0," the **Closed / archive** section *led* the page, and it led with five
all-caps pending-destruction notices that differ only by date — the same card printed
five times.

This is not a nudge. It is a re-grounding: recover the first principles the surface
must obey, find the clearest real-world example that already obeys them, and rebuild
against both.

## 2. First principles (from the held canon)

Mined from the library, not memory. Each quote was verified against the indexed source;
citations are `[cangshu doc]`.

### 2.1 Tufte — maximize the data-ink ratio, erase the rest
*The Visual Display of Quantitative Information* [cangshu 699].

- **Data-ink ratio** (p.91): *"Maximize the data-ink ratio, within reason."* The ink a
  reader is here for is the notices. Five rail labels, a decorative stepper, and a
  bordered control box are **non-data-ink** competing with the data.
- **Erase** (p.100): *"Erase non-data-ink. Erase redundant data-ink. Revise and edit."*
  The pipeline diagram is **redundant** with the Disposition-stage filter — two
  drawings of the same four stages. One must go (into disclosure).
- **Small multiples** (pp.168–175): well-designed small multiples repeat one design and
  let the *data* vary. Five identical destruction notices differing only in date **are**
  a small-multiples case. The Tufte-correct move is not to delete them but to **collapse
  them into one frame that carries the count and the date range** — "5 near-identical
  notices, Jan–May 2026," expandable.

**Rulings:** content dominates chrome; delete redundant drawings; collapse repeats into
one counted card.

### 2.2 Krug — don't make me think; mindless choices; cut the words
*Don't Make Me Think, Revisited* [cangshu 854].

- **First law** (§"Guiding Principles"): *"Don't make me think."* A self-evident page
  needs no analysis before use. Six co-equal filter taxonomies demand exactly that
  analysis — *which taxonomy is even mine?* — before the first click.
- **Mindless choices** (§"MINDLESS CHOICES"): *"It doesn't matter how many times I have
  to click, as long as each click is a mindless, unambiguous choice."* Clicks are cheap;
  *deciding among six equally-weighted axes* is not. Progressive disclosure trades one
  hard choice (six rails) for one easy one (the primary facet) plus an optional "More
  filters" for the rest.
- **Cut the words** (§1): *"Get rid of half the words on each page, then get rid of half
  of what's left."* Kicker + heading + deck + five uppercase rail labels is happy-talk
  noise around a list.

**Rulings:** show the one facet the primary user reaches for first; hide the rest behind
one affordance; strip label chrome.

### 2.3 Norman — affordances, signifiers, knowledge in the world
*The Design of Everyday Things* [cangshu 853].

- **Affordance vs signifier** (Ch.1): *"Affordances determine what actions are possible.
  Signifiers communicate where the action should take place."* The pipeline stepper is a
  **false signifier** — it looks like clickable steps but does nothing. A `<select>` sort
  set among chip rails is an inconsistent signifier for "narrow the list." Interactive
  things should look interactive; static things should be quiet.
- **Knowledge in the world** (Ch.3): the state a user needs should be *visible*, not held
  in their head. If filters hide behind disclosure, the surface must still show **that
  filters are active and let the user clear them** — otherwise hidden state is knowledge
  in the head.

**Rulings:** quiet the false-affordance diagram; keep active-filter state visible even
when the controls are collapsed; offer a one-click clear.

### 2.4 About Face — variation is the enemy
*About Face* [cangshu 851]: *"Unnecessary variation is the enemy of a coherent, usable
design."* Five chip rails + one select + one stepper is five visual treatments for the
single idea "narrow this list." One treatment.

### 2.5 Pending acquisitions
*Refactoring UI* (Wathan & Schoger), *Information Dashboard Design* (Few), and *Forms
That Work* (Jarrett & Gaffney) are filed for the library but not yet indexed; their
guidance (visual hierarchy by de-emphasis; declutter to raise the signal; ask only for
what's needed) is consistent with the rulings above and is cited here as **pending**.

## 3. Exemplars (praxis leg)

The didactic reference is the **GOV.UK "Filter a list" pattern** (faceted search) — the
canonical, publicly-documented civic pattern for a dense list with many facets. Its
shape:

- filters that **show and hide** like an accordion (progressive disclosure), with a
  **summary line** so a collapsed filter still reads clearly;
- a **selected-filters** summary that moves active filters to the top of the results,
  with **clear-all**;
- a **results count** and a sort control beside the list.

Sources: [GOV.UK Design System — Patterns](https://design-system.service.gov.uk/patterns/),
the "Filter a list" backlog item
([alphagov/govuk-design-system-backlog#133](https://github.com/alphagov/govuk-design-system-backlog/issues/133)),
and the MoJ Frontend Filter component
([ministryofjustice/moj-frontend#231](https://github.com/ministryofjustice/moj-frontend/issues/231)).

**Commercial confirmation:** dense-listing marketplaces (StreetEasy / Zillow-class) use a
row of a *few* primary facets plus a single **"More filters"** popover, a results count,
and one sort control — the same primary-visible / secondary-disclosed shape, tuned for a
glancing buyer.

**Foil to avoid:** the admin-dashboard look this drifted into — every facet exposed as a
co-equal always-on row. Differentiation from that foil is a requirement, not a nice-to-have.

## 4. The redesign (rulings applied)

Primary user of `#property` is the glancing surplus-goods buyer: **WHAT / HOW MUCH /
DEAL? / when-bid**. The arrangement serves that scan.

- **One primary facet visible: Item type.** It is the buyer's first cut (WHAT) and the
  identity of the thing. It stays an always-visible chip rail with counts.
- **Everything else behind one "More filters" disclosure:** sale method, price band,
  disposition stage, when, borough, neighborhood, agency, use-my-location. The summary
  shows an **active-count** so hidden state stays visible (Norman); a **Clear filters**
  control appears whenever any filter is set.
- **Sort** moves beside the results count ("N dispositions · Sort ▾"), the standard
  listing position, not a select stranded among rails.
- **Pipeline diagram folds into a "How this list works" disclosure** — kept for the
  curious, out of the lead, no longer a false signifier or a redundant drawing.
- **Small-multiples collapse:** runs of near-identical notices (same agency + asset +
  disposition class + title stem, count ≥ 3) render as **one** card carrying the count
  and date range, expandable to each notice.
- **Archive never leads:** the list is split into *current* (open/upcoming/undated) then
  *closed*. When current is empty, the page leads with an honest one-line
  "Nothing closing soon or upcoming right now — recent closed notices are below," and the
  archive follows. Past sales never sit at the top looking like live actions.

Nothing is removed. This is **arrangement, not amputation** — every filter, export, and
watch remains reachable. Retirements follow a one-in-one-out ledger (§6).

## 5. The lens filter template (extracted pattern)

Property is the reference instance. The other lenses (Contracts/Money, Staffing, Land,
Meetings, Rules) share the same intro + stepper + controls + stacked-rail structure and
are drifting the same way. The template:

```
lens
├─ intro         heading + one-line deck + cross-links
│                (methodology / stepper folded into a "How this works" <details>)
├─ toolbar       search · sort (beside count) · [More filters ▾ · N active] · Clear
├─ primary rail  the single facet the lens's primary user reaches for first (with counts)
├─ more-filters  <details>: every secondary facet + location/agency controls (counts kept)
├─ count line    "N results · Sort ▾"
└─ feed          current-first ordering · small-multiples collapse · archive-never-leads
```

Invariants: one visual treatment for "narrow this list"; active state visible when
collapsed; capability parity (every prior control reachable); counts preserved.

Per-lens rollout is carded in [`docs/lens-filter-template.md`](lens-filter-template.md).

## 6. Capability-parity ledger

Every pre-existing Property control after the redesign, and where it now lives:

| Control | Before | After | Reachable |
|---|---|---|---|
| Item type | rail | primary rail (visible) | ✅ |
| Sale method | rail | More filters | ✅ |
| Price band | rail | More filters | ✅ |
| Sort | select among rails | beside results count | ✅ |
| Disposition stage | rail | More filters | ✅ |
| When (temporal) | rail | More filters | ✅ |
| Borough | controls box | More filters | ✅ |
| Neighborhood | controls box | More filters | ✅ |
| Agency | controls box | More filters | ✅ |
| Use my location | controls box | More filters | ✅ |
| Keyword search | controls box | toolbar (visible) | ✅ |
| Watch this search | controls box | toolbar | ✅ |
| Export CSV/XLSX/Print | export bar | export bar (unchanged) | ✅ |
| Tax-lien / map links | intro | intro (unchanged) | ✅ |
| Deep-link params | hash grammar | hash grammar (unchanged ids) | ✅ |

**Retirements (one-in-one-out):**
- *Out:* the always-on pipeline **diagram** as a page-lead element.
  *In:* the same stepper inside a "How this list works" disclosure (kept, not deleted).
- *Out:* five always-on rail **labels** as non-data-ink.
  *In:* one primary label + a labelled disclosure summary carrying the rest.

No capability is dropped; only the *arrangement* changes.
