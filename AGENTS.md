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
  not just manual dispatch, and runs **hermetically** (wave 9: `i18n_fixtures.install_routes`,
  same fixture layer the stray-English guard uses — no live-API flakiness). It walks every
  `.tabbtn` tab (axe skips `display:none` nodes, so an inactive tab is invisible to it
  otherwise) PLUS the dynamic states no tab-activation alone reaches — digest preview,
  notice-detail (row click), entity-agency (permalink hash), the investigation workspace
  (localStorage-seeded) + its share-error path — **once in English, once in Spanish**
  (`LANGS` at the top of the file). `RATCHET_RULES` fails specific axe rule ids
  (`landmark-one-main`, `region`) regardless of impact level, so a fixed moderate finding
  stays guarded even though axe itself would only ever flag it as moderate. Local full run:
  ~30s for the entire en+es matrix.
- **Rendered-DOM census gates** (`test/standards/label_coverage.py`,
  `test/standards/heading_uniqueness.py`) also run in `a11y-pr` — they need Playwright +
  tab activation despite living under `test/standards/`, which is otherwise pure-text
  lints; they import `install_routes` from `test/functional/assets/i18n_fixtures.py` for
  the same hermetic fixture data the i18n guard uses (investigation workspace, digest
  preview, etc. all render without live network).
- **All six pages have a `<main id="main" tabindex="-1">`, a skip link (`.skip`, first
  focusable), and a `<footer>` landmark** for footer content — index got `<main>` in wave 7;
  subpages got the full set (they had none of the three) in wave 9, sharing index's `.skip`
  CSS and branded oxblood `:focus-visible` ring per page (no `?v=` machinery needed, it's
  per-page CSS). Don't reintroduce a bare content `<div>` outside `<main>`, and don't nest
  `<footer>` inside `<main>` — nested footer loses the `contentinfo` landmark role.
- **`test/standards/form_border_contrast.py`** (unit job) fails any `input`/`select`/
  `textarea` CSS rule bordering on `--rule` (1.58-1.81:1) instead of `--rule-strong`
  (3.56:1+) — the border is the only indicator of a text field's extent (1.4.11).
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

## NYC Web Content Style Guide gates (wave 10)

- **Five unit-job gates**, all pure-text (some shell out to `node -e` to load `STRINGS.en`
  from i18n.js, same trick as `link_text.py`): `nyc_copy_lint.py` (banned acronyms, emoji,
  `<em>/<i>/<s>`, ampersand-as-and, and/or, semicolons, double-space, the specific-words
  table, inclusive-language deny-list, truncation abbreviations, PDF-link assert, currency
  shorthand outside chip context, 12-hour time forms, generic-text/case on `<button>`),
  `page_metadata.py` (meta description 120–160 chars, title <60 with the house `·`
  separator), `link_targets.py` (no `target="_blank"`, no decorative external-link `↗`
  icons), `heading_punctuation.py` (no colon/period in headings, `?` excepted), and
  `genai_disclosure.py` (about.html must carry the GenAI-content disclosure).
- **`nyc_copy_lint.py` ships report-only** (always exits 0, prints findings) — pass
  `--gate` to enforce; that flip is a separate task once the remaining prose findings
  (mostly `e.g.`, italics, and long-form `$NM` shorthand) are fixed. Its shrink-only
  allowlist (`nyc_copy_lint_allowlist.txt`) currently only tracks the chip/threshold
  currency exception (numerals-in-buttons is the guide's own carve-out).
- **House decisions, both deliberate deviations from the guide's literal text**: (1) the
  title separator stays `·` (already the brand mark everywhere else) rather than switching
  to the guide's hyphen — `page_metadata.py`'s docstring has the reasoning; (2) external
  links were made to CONFORM (not carve out) — same-tab, no `↗` icons, descriptive text
  instead, applied site-wide including inside i18n.js's `*_html` strings, not just the
  static markup.
- **`heading_punctuation.py` and the ampersand rule both carve out changelog.html's dated
  release `<h2>` titles** (`chg_*_h2` keys) — an archival register presented verbatim, same
  posture as `.chg-detail`'s English-only carve-out in the stray-English guard.
- **Cross-gate tension with the reading-level ratchet** (below): removing a link's `↗`
  icon replaces a bare glyph with real words (e.g. a bare `↗` anchor became "View in City
  Record"), which can nudge a whole page's Flesch-Kincaid grade by a hair even though
  nothing got harder to read — a mechanical side effect of satisfying one style-guide rule
  that another gate measures. If a future compliance edit trips the reading-level ratchet
  by a trivial amount for a reason like this, that's a known interaction, not a quality
  regression — say so in the PR rather than force-simplifying unrelated prose to compensate.

## Reading level — the readable-or-else ratchet gate

- **`reading-level` CI job** (every PR) runs [readable-or-else](https://github.com/jimdc/readable-or-else)
  (`pip install git+https://github.com/jimdc/readable-or-else.git` — not yet on PyPI) in
  `--mode ratchet` against the committed `reading-level-baseline.json`, `nycsg7` preset (NYC
  Web Content Style Guide, FK grade ≤7). Ratchet, not a hard gate: all six pages still measure
  above grade 7 (see the baseline file for current numbers) — it fails only on *regression*
  against the committed baseline, not on the pre-existing gap. Tighten the baseline (`ror
  baseline <page> --preset nycsg7 -o reading-level-baseline.json`) whenever a page's score
  improves; the command only ever lowers a recorded grade, so it can't be used to relax the gate
  — including by accident. **This means a sibling PR that site-wide find/replaces chrome text
  (e.g. wave 10's `&` → `and`, decorative-icon removal) can push an untouched page's *live* grade
  above its *committed* baseline without the tool offering any way to fix it** — `ror baseline`
  will silently refuse to write the new, higher, honest number back. When rebasing onto a main
  that moved, always re-run `check` against the full six-page set before opening/updating a PR;
  if anything shows `regression:` for a page you didn't touch, hand-edit that entry in
  `reading-level-baseline.json` to the freshly measured live grade (`measure()` from
  `readable_or_else.measure`, or trust `check`'s own reported number) and say so in the PR —
  this happened for `index.html` and `about.html` in crol-rerun-j6 (2026-07-13), both caused by
  a previously-merged sibling PR, not new content.
- **`fix` mode's file-mutation half round-trips the whole file through BeautifulSoup's
  `html.parser` and reserializes it** — this reorders/re-quotes every attribute on the page and,
  critically, **lowercases `viewBox` to `viewbox`**, silently breaking the inline SVG seal (SVG
  attribute names are case-sensitive; `viewbox` is not a valid attribute and the seal stops
  rendering with the intended dimensions). Never run `ror fix <page.html>` directly against a
  real page file. Instead: run it against a scratch copy to get real LLM rewrites + denial-rule
  verdicts (`--format json`), review each accepted rewrite for meaning drift, then hand-splice
  only the accepted candidate text back into the real file's matching leaf element (preserves
  exact original formatting elsewhere).
- **`fix` mode only rewrites leaf text elements with zero nested markup** (`p`/`li`/headings/etc.
  whose entire content is plain text — see the tool's own README "Fix mode" section). Any
  paragraph or list item containing an inline `<a>`, `<b>`, `<em>`, etc. is structurally skipped,
  not partially rewritten. In practice this means most of crol-list's hardest prose (the
  data-quality caveats in about.html, the sourced asides in data.html) is **not reachable by fix
  mode at all**, because nearly every long paragraph here carries an inline citation link — that
  prose needs a hand-authored pass (informed by `--suggest`'s whole-page rewrite, but re-spliced
  by a human) in a future wave, not another `fix` run.
- **FK grade is unreliable on very short leaf text** (a lone heading word like "Privacy" or
  "About" scores grade 8–20 on the formula despite being trivially readable) — `fix` correctly
  denies these (`grade_target` — the LLM can't legally shorten "Privacy" further), and that's
  expected, not a bug to chase.
- **Suggest-mode PR annotations are opt-in via a `suggest-rewrite` label** (not on the default
  per-PR run — it costs an LLM call per over-target passage). **`fix` mode's auto-apply-and-commit
  loop (the README's "maintenance loop in CI" recipe) is documented, not wired** — turning it on
  needs `READABLE_OR_ELSE_LLM_BASE` / `READABLE_OR_ELSE_LLM_KEY` / `READABLE_OR_ELSE_LLM_MODEL`
  repo secrets pointed at an OpenAI-compatible endpoint, none of which this repo has; add them
  and the `git-auto-commit-action` step from the tool's README before enabling it, and be aware
  of the BeautifulSoup-reserialization caveat above before pointing `fix` at real files in CI.

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
