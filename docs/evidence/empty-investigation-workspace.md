# Empty My investigation workspace — implementation receipt

Card: `cityscroll-contextual-ux/cx-02-empty-investigation-first-artifact`

## Orientation

The My investigation workspace (`#investigation`) is an account-free,
localStorage-only pin list. Before this change, an empty collection rendered
a one-line "Nothing pinned yet" message alongside the same six output
controls a populated collection earns: share a read-only link, freeze a
research package, export .csv, export .json, print, and clear all. A reader
opening the workspace for the first time saw those six controls before they
had anything for the controls to act on.

## Summary

- `site/app/workspace.mjs`: `showInvestigation()` now derives `hasItems` from
  the current collection. When it is empty, the item-list container renders
  a new `invEmptyGuideHtml()` block — the find → open → pin instruction, a
  labeled `Find something to pin` link to `/search/`, and a one-line preview
  of the later outputs — instead of the six-button action row, and the six
  button listeners are bound only when their buttons actually exist in the
  DOM. When at least one item is pinned, the render and every listener are
  byte-identical to before this change. Deleting the only pinned item (or
  clearing all) re-runs `showInvestigation()`, which re-derives `hasItems`
  from the store and falls back to the same guidance — no separate empty-state
  code path to drift from the real one.
- `site/i18n.js` + `site/i18n/lang/*.js`: the old English-only `inv_empty` key
  is replaced by `inv_empty_guide_html`, `inv_find_record_link`, and
  `inv_empty_later_outputs`, translated into all ten shipping languages.
- `docs/design-principles-contextual-ux.md`: added the "Design for the
  artifact's purpose" principle and its first applied instance, including the
  brief-framing hypothesis's unvalidated status.

No new investigation schema, auto-sharing, or export format was introduced.
Sharing, freezing, exporting, printing, notes, and read-only rendering are
unchanged — this touches only what renders before the first item is pinned.

## Verification

Unit test (pure extraction of the empty-guide and item-list renderers plus
the real store/save functions, evaluated with the real `t()` from
`site/i18n.js` — a hand-rolled `localStorage` stub, no browser dependency —
plus source-text checks that `showInvestigation()` actually wires the
conditional the unit tests assume):

- Command: `node --test test/contextual_ux_empty_investigation.test.mjs` — 6 pass, 0 fail.
- Covers: empty (guide renders, no output-action id present, find link is a
  native, tab-reachable `<a>`), one item (existing `.tl` render and note field
  unchanged), last-item removal (splicing the sole item out through the same
  logic `.invdel` uses leaves the store at zero items), and a stored-collection
  reload (an already-empty stored collection reloads empty; a stored item,
  with its note, reloads populated).

Accessibility + capture evidence (headless Chromium via Playwright, the
repository's established offline capture pattern, driving the real
`#investigation` route with `capabilities/*.mjs` served the same way the
production rewrite does and all other network access blocked):

- Command: `python3 tools/capture_empty_investigation_workspace.py`
- Captures (390px and 1440px, for `empty`, `one-item`, `last-item-removal` —
  an in-page delete, not a reload — and `stored-reload-empty` — a full page
  reload against an already-empty stored collection):
  [`docs/evidence/empty-investigation-workspace/capture-manifest.json`](empty-investigation-workspace/capture-manifest.json).
  Screenshots are not committed; the manifest records each capture's route,
  viewport, revision, the state's assertion, a content hash, whether the
  guide or the six action ids are present, the item count, and a keyboard-
  reachability reading for the find link.
- Every state ran the vendored axe-core gate (same engine and
  critical/serious classification as `test/functional/11_accessibility.py`):
  8/8 green, no critical or serious violations, no `wcag22aa` findings.
- Every capture asserted `document.documentElement.scrollWidth` does not
  exceed the viewport width: no horizontal overflow at either width in any
  state.
- The find-a-record link is a native `<a>` with a non-negative `tabIndex`
  (not a `<div>`/`<span>` fake control), so it is reachable in the normal tab
  order without any extra keyboard wiring.

Acceptance mapping: A1 (the guide names the find → open → pin sequence and
carries a labeled find-record link, asserted in the unit test and read back
from the live DOM in every capture), A2 (the one-item capture and unit test
confirm every existing control, note, and privacy behavior is unchanged; the
last-item-removal and stored-reload-empty captures confirm the empty guide
comes back), A3 (the named test covers empty/one-item/last-item-removal/
stored-reload; captures confirm no overflow and a keyboard-reachable link at
both widths), A5 (principle documented, including the unvalidated hypothesis).
A4 (evaluating the guidance against a resident's own research or sharing
task) is explicitly out of scope for this implementation; see the card.

## Methodology

Focused checks run on this tree:

```sh
node --test test/contextual_ux_empty_investigation.test.mjs                 # 6 pass
node --test test/research_package.test.mjs                                  # 6 pass (unchanged)
node --test test/city_record_decentering.test.mjs                           # 4 pass (unchanged)
node --test test/notice_absence_slots.test.mjs                              # 2 pass (unchanged)
node --test test/alerts_reground.test.mjs                                   # 7 pass (unchanged)
python3 test/standards/i18n_keys.py                                         # OK, full coverage in all 10 shipping languages
python3 test/standards/control_labels.py                                    # OK, EN/ES action labels stay at or under 4 words
python3 test/standards/js_syntax.py                                         # OK
node tools/architecture_evidence_shards.mjs --check                         # OK
node tools/reconcile_architecture.mjs --check --no-write                    # OK
python3 tools/capture_empty_investigation_workspace.py                      # axe 8/8 green, no overflow
```
