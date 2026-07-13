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

- Every PR (CI "unit" + "a11y-pr" + "i18n-guard" jobs): standards gates, `node --test
  test/*.test.mjs`, worker tests, the axe + language + focus-visible + label-coverage +
  heading-uniqueness a11y gates (all against a plain local `http.server`, no live-API
  traffic — see Accessibility section below), and the hermetic stray-English guard across
  all six pages (fixtures in `test/functional/assets/i18n_fixtures.py` stub every
  upstream — no live network).
- Manual dispatch: full Playwright functional suite (`bash test/functional/run.sh`, live
  APIs). Serve on **port 8000** — the worker's CORS allowlist includes it; other local ports
  make live share/subscribe steps fail with "Couldn't reach the server". (When testing
  locally alongside another worktree/session, port 8000 may already be taken by someone
  else's server — pick a free port and pass `CROL_BASE=http://localhost:<port>/` instead of
  fighting over 8000, and never kill a process you didn't start without checking its cwd.)

## Accessibility — the gates that keep it wired

- **axe gate runs on every PR** (`a11y-pr` CI job, `test/functional/11_accessibility.py`),
  not just manual dispatch: static pages served locally, no live-API flakiness. It walks
  index.html's load state AND every activated `.tabbtn` tab (axe skips `display:none`
  nodes, so an inactive tab's fields are invisible to it otherwise).
- **Rendered-DOM census gates** (`test/standards/label_coverage.py`,
  `test/standards/heading_uniqueness.py`) also run in `a11y-pr` — they need Playwright +
  tab activation despite living under `test/standards/`, which is otherwise pure-text
  lints; they import `install_routes` from `test/functional/assets/i18n_fixtures.py` for
  the same hermetic fixture data the i18n guard uses (investigation workspace, digest
  preview, etc. all render without live network).
- **All six pages have a `<main>` landmark** (`index.html`'s wraps every tabpane; each
  subpage wraps its content div) — added in wave 7 to retire the axe
  `landmark-one-main`/`region` moderate findings. Don't reintroduce a bare content `<div>`
  outside `<main>`.
- **`test/functional/14_focus_visible.py`** is the focus-visible keyboard walk (NOT `13` —
  that number was already taken by `13_stray_english.py` by the time this card shipped;
  functional specs are numbered by file, not by wave, so check what's free before adding
  the next one). Static companion: `test/standards/outline_guard.py` (fails if
  `outline:none` ships without a `:focus-visible` replacement on the same selector).
- **`test/standards/attribution.py`** (pure text, unit job) asserts about.html cites all
  four open-data dataset IDs with links, per Local Law 11/2012.
- **`test/standards/link_text.py`** (pure text, unit job) is the NYC Web Content Style
  Guide descriptive-link-text lint — resolves `t("key")` calls used as link text against
  i18n.js's English dictionary before judging genericness ("click here" etc.).

## Architecture — static site + Worker backend

- The site (`index.html`, `i18n.js`, `test/`) is 100% static, deployed via GitHub Pages; the
  serverless backend lives entirely in `worker/` (Cloudflare Worker) — see `worker/README.md`
  for routes, secrets/vars, and the develop/test/deploy commands (`worker/` has its own
  `npm test`, independent of anything at repo root).
- The board-notification bridge (`worker/src/boardhook.mjs`, route `/board-hook`) auths
  App-first with a `GITHUB_BOT_TOKEN` fallback — see `worker/README.md`'s "Board-notification
  bridge auth" section. The `board-notify` GitHub App is live (app id 4288246, installed on
  cityscroll, installation id 146319774); its one-click creation kit stays outside this repo,
  in the maintainer's private tooling at `` (`INSTALL.md` has the setup steps, for
  reference if the App ever needs recreating).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
