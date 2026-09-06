# Masthead brand home link — implementation receipt

Card: `cityscroll-engineering/masthead-brand-home-link`

## Orientation

Every public CityScroll masthead shows the same CityScroll mark + wordmark
lockup. On Following and on every civic-document masthead rendered through
`renderCivicDocumentMast()` in `site/civic_document_chrome.mjs`, that lockup is
already a link to `/`. On the main shell (`site/index.html`) and the Search
document (`site/search/index.html`) the same lockup was a plain `<div>`, so the
prominent brand did nothing on the two most-visited surfaces. Navigation
behavior changed with the rendering surface.

## Summary

The masthead brand lockup is now one home link everywhere it appears:

- `site/index.html` and `site/search/index.html`: the lockup
  `<div class="brand-lockup brand-lockup--masthead">` became
  `<a class="brand-lockup brand-lockup--masthead" href="/" aria-label="CityScroll home"
  data-i18n-aria="brand_home_aria">`, wrapping both the decorative SVG mark and
  the `<h1 class="cr-title">CityScroll</h1>` nameplate. The heading structure,
  visual design, and language switching are unchanged; the accessible name
  translates through the existing `data-i18n-aria` mechanism (new
  `brand_home_aria` key in `site/i18n.js` and all ten shipping language
  dictionaries).
- `site/brand.css`: `a.brand-lockup` drops the link underline, hover shifts to
  the action color (same rule the compact `home` lockups already used), and
  `a.brand-lockup:focus-visible` gets the standard 2px focus ring, so the brand
  link shows visible keyboard focus on every surface that loads the brand
  sheet, including civic documents.
- `renderCivicDocumentMast()` and the hand-written masts in
  `site/meeting_document.mjs`, `site/mandate_document.mjs`, and
  `site/community-board-scorecard.mjs` now emit `aria-label="CityScroll home"`,
  and the tracked civic documents under `site/exams/`, `site/parcels/`,
  `site/districts/`, and `site/following/packs/` (635 documents, one shared
  lockup string) were synced to the owning builder's current output.
- `site/following/index.html` and `site/near-you/index.html` static masts carry
  the same accessible name.

No second interaction style was added: every surface uses the existing
single-anchor lockup pattern. The tagline, search form, and hero modules are
outside the link; no "Home" button was added; destinations are `/` (relative
`index.html` on the about/stats/api subpages, their pre-existing pattern), never
a hostname.

## Exploration

Audited variants and their state before this card:

| Surface | Source | Before | After |
| --- | --- | --- | --- |
| Home main shell | `site/index.html` | non-linking `<div>` lockup | single home link, one tab stop |
| Search document | `site/search/index.html` | non-linking `<div>` lockup | single home link, one tab stop |
| Following | `site/following/index.html` | linked, name "CityScroll" | linked, name "CityScroll home" |
| Near You | `site/near-you/index.html` | linked, name "CityScroll" | linked, name "CityScroll home" |
| Civic documents | `renderCivicDocumentMast()` + 635 tracked documents | linked, name "CityScroll" | linked, name "CityScroll home" |
| Meeting / mandate / community-board masts | inline in three builders | linked, name "CityScroll" | linked, name "CityScroll home" |
| About / Stats / API nameplates | `site/about.html`, `site/stats.html`, `site/api.html` | linked to `index.html`, translated "Back to CityScroll home" | unchanged (already home links) |

Verify-not-shipped: `main` (8de8ec225) satisfied none of the masthead-lockup
link requirements on the main shell or Search document; the lockup there was a
non-interactive `<div>`. The card was not already satisfied.

## Evidence

Headless Chromium (Playwright) against the tracked static site served by the
repository's performance-harness `StaticServer` — the repository's established
headless capture pattern, not interactive tooling:

- Command: `./tools/with_local_a11y_python.sh python3 tools/capture_masthead_brand_home_link.py`
- Captures (390px and 1440px, Home and `/search/?q=rats`, at rest and with the
  brand link keyboard-focused):
  `docs/screenshots/masthead-brand-home-link/` (`home-mobile.png`,
  `home-mobile-focus.png`, `home-desktop.png`, `home-desktop-focus.png`,
  `search-rats-mobile.png`, `search-rats-mobile-focus.png`,
  `search-rats-desktop.png`, `search-rats-desktop-focus.png`,
  `capture-receipt.json`).
- The same run asserted, at both widths on Home and `/search/?q=rats`: clicking
  the SVG mark opens `/`, clicking the wordmark opens `/`, the brand is a single
  keyboard tab stop that activates with Enter, the accessible name is
  `CityScroll home`, the SVG is `aria-hidden`, and no tagline/form/nested
  interactive element sits inside the link. The same assertions passed on
  `/following/`, `/near-you/`, and the representative civic document
  `/exams/7311/`.

Static contract test (inventories every tracked public HTML brand lockup and
requires a home destination, no nested interactives, hidden decorative mark;
pins the main-shell and shared-builder contracts):

- Command: `node --test test/masthead_brand_home_link.test.mjs` — 8 pass, 0 fail.

Acceptance mapping: A1/A2 (click + keyboard open `/` on Home, Search, Browse via
the shared builder, Following, Near You, civic documents — asserted above), A3
(single tab stop, Enter activates), A4 (`CityScroll home` accessible name, SVG
hidden), A5 (inventory test: no non-anchor lockup anywhere in tracked public
HTML), A6 (tagline/search/hero asserted outside the link).

## Methodology

Focused checks run on this tree, with results:

```sh
node --test test/masthead_brand_home_link.test.mjs          # 8 pass
node --test test/following_static.test.mjs test/near_you_static.test.mjs \
  test/place_context.test.mjs test/notice_methodology_chrome.test.mjs  # 36 pass
python3 test/standards/i18n_keys.py                          # full coverage, all 10 languages
python3 test/standards/i18n_refs.py                          # OK
python3 test/standards/i18n_fallback_sync.py                 # OK
python3 test/standards/i18n_glossary.py                      # OK
python3 test/standards/es_diacritics.py                      # OK
./tools/with_local_a11y_python.sh python3 tools/capture_masthead_brand_home_link.py  # evidence + behavior assertions
node tools/architecture_evidence_shards.mjs --check          # OK
node tools/governance_evidence_placement.mjs --check              # OK, no placement input changed
make prepush                                                 # full required-check battery
```

No documentation or evidence placement inputs changed: the new evidence files
under `docs/screenshots/masthead-brand-home-link/` and this receipt contain no
private references, so `document-tree:docs/screenshots` and
`document-tree:docs/evidence` re-derive unchanged.

Language switching, static-first rendering, and staging/preview compatibility
are preserved: the link is plain static markup with a relative `/` destination
(the shared builder's `siteBase` prefixing is unchanged), and the accessible
name rides the existing `data-i18n-aria` dictionary mechanism.
