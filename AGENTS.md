# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## i18n — the rules that keep Spanish (and the next nine languages) honest

- **Every page loads `i18n.js` and carries the shared header language switcher** (`#langSwitcher
  .lang-btn`) — index.html plus about/data/stats/api/changelog.html, since crol-subpages-es
  (2026-07-13). `crol_lang` in localStorage is one preference honored by every page on load
  (i18n.js's own bottom IIFE sets `window.LANG` *and* `document.documentElement.lang`/`dir`
  synchronously, before body paint, so there's no English flash).
- **Every user-facing string routes through `t()` / `tSection()`** (i18n.js) — including
  strings built in JS template literals and labels derived from DATA VALUES (City Record
  section names → `SECTION_I18N`). Two gates enforce it; run them before calling i18n work
  done: `python3 test/standards/stray_english.py` (source lint over all pages; its allowlist
  `test/standards/stray_english_allowlist.txt` may only shrink) and
  `python3 test/functional/13_stray_english.py` (hermetic rendered-DOM walk, every PR in CI;
  parameterized by `CROL_GUARD_LANGS` and, per page, `CROL_GUARD_PAGES` — default `index`;
  CI runs all six). Subpages get a lighter walk (load → switch → walk text) than index.html's
  full lens-driving one; approved translations are shared across pages automatically since
  `dict_fragments()` scans the whole `STRINGS[lang]` table.
- **Sharp edge — `t` shadowing:** never name a function parameter or local `t`
  (`pinBtn(t,…)` and `copyText(t,…)` both silently broke rendering, 2026-07-13 hotfixes).
- **Changing i18n.js requires a `?v=` hash bump** on EVERY page's script tag
  (`shasum -a 256 i18n.js | cut -c1-8`) — `test/standards/i18n_refs.py` checks all six pages
  and fails on any stale one (one shared file today, so all pages carry the same hash).
- **es orthography is gated:** `python3 test/standards/es_diacritics.py` fails accent-less
  forms of pinned Spanish words. Extend its map when a reviewer catches a new miss.
- **Language switching must repaint dynamic surfaces** — index.html's `rerenderForLang()`;
  subpages use the lighter `initSubpageLangSwitcher(onChange)` (i18n.js) — pass `onChange` when
  a page caches live-fetched data or a translated data-value (data.html's `renderSections()`
  re-runs `tSection()` from cached rows; stats.html's `paint()` re-renders the current async
  status instead of resetting to the loading string). **Wire the switcher synchronously**, not
  after an `await` — stats.html originally called `initSubpageLangSwitcher()` only inside the
  post-fetch branches, so clicking it during the loading window silently did nothing (caught in
  manual verification, 2026-07-13).
- **Interaction-gated states count:** the runtime guard seeds a pinned investigation item and
  walks `#investigation`; a new localStorage/hash-gated panel needs the guard walk extended
  or it will ship English silently (hotfix-2's lesson).
- **Content-zone carve-out for long-form/technical content:** `code`, `pre`, and `.chg-detail`
  are allowlisted content zones in `test/functional/assets/stray_english_allowlist.json`
  (technical/verbatim samples; changelog.html's per-release bullet lists and incident reports,
  which stay English behind a `chg_detail_note` disclaimer — an interim milestone, same posture
  as official notice content). Chrome, ledes, and every changelog release's reader-facing "For
  you" summary DO translate; only the archival technical detail is carved out.
- Notice CONTENT stays English (official source) with a per-language disclaimer; chrome and
  derived UI text always translate. en/es key parity enforced by `i18n_keys.py`.

## Test layers (what runs where)

- Every PR (CI "unit" + "i18n-guard" jobs): standards gates, `node --test test/*.test.mjs`,
  worker tests, and the hermetic stray-English guard across all six pages (fixtures in
  `test/functional/assets/i18n_fixtures.py` stub every upstream — no live network).
- Manual dispatch: full Playwright functional suite (`bash test/functional/run.sh`, live
  APIs). Serve on **port 8000** — the worker's CORS allowlist includes it; other local ports
  make live share/subscribe steps fail with "Couldn't reach the server".

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
