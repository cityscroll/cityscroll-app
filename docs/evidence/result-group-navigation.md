# Result-family jump control — implementation receipt

Card: `cityscroll-engineering/result-group-navigation`

## Orientation

Search groups results into six record families (Contracts, People +
organizations, Land, Rules, Meetings, Exams), rendered as either a desktop
grid or a mobile stack with no local way to jump straight to a family further
down the page. A reader looking for one family has to scroll or tab past
every earlier group first.

## Summary

A compact, keyboard-operable list of the six family headings now renders
above the first result group on `/search/`:

- `site/search_family_nav.mjs` (new): pure item construction plus the DOM
  rendering and click handling. Every label and status string in the list is
  copied verbatim from the family section it targets — the control has no
  independent source of truth for a count or a state, so it cannot invent
  one. Activating an item moves keyboard focus to that family's existing
  `<h3>` heading and scrolls it into view; it never fetches, never changes
  the query string, and never touches ranking, coverage, or a result's
  handoff link.
- `site/search_document.mjs`: two one-line call sites (`renderFamilyNav`,
  at the end of `paintResults()` and of `renderInitialState()`) are the only
  changes to this file, chosen to stay clear of the in-flight front-door
  scope work on the same module.
- `site/primary_document_view.mjs` / generated `site/search/index.html`:
  one `<nav data-search-family-nav hidden>` element added between the
  coverage status and the result-group containers.
- `site/search.css`: the control's styling, matching the page's existing
  pill and card tokens.
- `docs/design-principles-contextual-ux.md` (new): the sequence-preservation
  principle this control follows, linked from
  [`docs/design-principles-lens.md`](design-principles-lens.md).

No new data source, ranking model, persona inference, or search request was
introduced. The list only reflects state the page has already rendered.

## Verification

Unit test (pure item construction, live-DOM section reading, all five named
response states, and keyboard focus movement — a hand-rolled minimal DOM,
no browser dependency):

- Command: `node --test test/contextual_ux_result_groups.test.mjs` — 15 pass, 0 fail.

Accessibility + capture evidence (headless Chromium via Playwright, the
repository's established offline capture pattern):

- Command: `python3 tools/capture_result_group_navigation.py`
- Captures (390px and 1440px, `/search/?q=parks`, for `complete`, `partial`,
  `empty`, `loading`, and `error` responses):
  [`docs/evidence/result-group-navigation/capture-manifest.json`](result-group-navigation/capture-manifest.json).
  Screenshots are not committed; the manifest records each capture's route,
  viewport, revision, the state's assertion, a content hash, the jump list's
  rendered items, and a same-URL focus-activation check.
- Every state ran the vendored axe-core gate (same engine and
  critical/serious classification as `test/functional/11_accessibility.py`):
  10/10 green, no critical or serious violations, no `wcag22aa` findings.
- Every capture asserted `document.documentElement.scrollWidth` does not
  exceed the viewport width: no horizontal overflow at either width in any
  state.
- Each state's own family labels/statuses are recorded truthfully: `empty`
  shows every family as "No matches"; `loading` shows "Searching…" with no
  invented count; `error` shows "Unavailable" for every family rather than
  omitting them or presenting them as empty.

Acceptance mapping: A1 (focus moves to the heading, no new search, asserted
in both the unit test and the capture's `focus_activation` reading), A2
(existing results/ranking/coverage/handoff links are read, never written, by
this control — structurally guaranteed, since it only calls `focus()` and
`scrollIntoView()` on an existing element), A3 (the named test covers
complete/partial/empty/loading/error plus keyboard focus; captures confirm
no overflow at 390px/1440px), A5 (principle documented and cross-linked).
A4 (evaluating the control against a resident's own task) is explicitly out
of scope for this implementation; see the card.

## Methodology

Focused checks run on this tree:

```sh
node --test test/contextual_ux_result_groups.test.mjs                       # 15 pass
node --test test/search_document_contract.test.mjs                          # 8 pass (unchanged)
node --test test/agency_constellation.test.mjs test/browse_concept_view.test.mjs \
  test/search_capability_projection.test.mjs                                # unchanged (agency_constellation
                                                                              # fails in this checkout on a
                                                                              # pre-existing missing generated
                                                                              # data file, unrelated to this change)
node tools/build_primary_documents.mjs --check                              # OK
node tools/architecture_evidence_shards.mjs --check                         # OK
python3 tools/capture_result_group_navigation.py                            # axe 10/10 green, no overflow
```
