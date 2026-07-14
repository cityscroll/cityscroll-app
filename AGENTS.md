# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## i18n — string-catalog architecture (wave 8) + the rules that keep translations honest

- **Split-file architecture, not one monolith.** `i18n.js` is now the CORE file only: LANG_META,
  `SHIPPING_LANGS` (the one declaration selector/guard/parity-gate all read — `["es", "zh-Hans",
  "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur"]` as of wave 8 — all ten LL30 languages now
  ship; only zh-Hant remains a LANG_META stub), `LANG_FILE_HASHES`, `I18N_PROVENANCE`, the
  runtime (`t`/`tn`/`tSection`/
  `applyStrings`/`setLang`/`ensureLangLoaded`), and the **`en` dictionary inline** (en is the
  fallback, must load with zero network round-trips). Every other shipping language's
  `STRINGS`/`SECTION_I18N` table lives in its own `i18n/lang/<lang>.js`, loaded on demand: a
  Node `require()` shim at i18n.js's bottom (so tests/tooling see every shipping language
  synchronously with no browser), `document.write()` during initial `<head>` parse for the
  saved localStorage preference (still no English flash — before first paint), or async
  `<script>` injection (`ensureLangLoaded`) when the user switches language mid-session.
  Adding a language means: create `i18n/lang/<lang>.js` (see any existing one for the
  `Object.assign(window.STRINGS[lang], {...})` + `window.SECTION_I18N[lang] = {...}` shape),
  add it to `SHIPPING_LANGS` + `LANG_FILE_HASHES` (`shasum -a 256 i18n/lang/<lang>.js | cut -c1-8`),
  add its `I18N_PROVENANCE` entry, add its selector button to all six pages, add it to CI's
  `CROL_GUARD_LANGS`.
- **`tn(base, n, vars)`** (i18n.js) is the CLDR-plural helper — `Intl.PluralRules(locale).select(n)`
  picks `<base>_one/_few/_many/_other`, falling back to `<base>_other`, then the same chain
  under English. Migrated keys: `days_left`, `event_in_n_days`, `n_notices_meta`,
  `digest_footer`. zh-Hans only ever needs a `_other` key (CJK has no plural category) — but
  `i18n_keys.py`'s parity check wants literal full key-set coverage, so zh-Hans's dictionary
  duplicates `_other`'s text under `_one` too rather than special-casing the gate. Remaining
  `{s}`-suffix keys (`showing_lots_note_html`, `inv_pinned_meta`, `vendor_profile_variants`)
  are NOT yet migrated — a language may legitimately omit `{s}` from its translation (no
  plural marker needed), `i18n_glossary.py`'s placeholder check already exempts it.
- **Civic-terms glossary** (`i18n/glossary.json` + `i18n/GLOSSARY.md`) pins RFP/award/
  procurement/rezoning/City Record/PIN/community board/upset price/MIH BEFORE drafting a new
  language — cite the City's own translation (MOIA materials, an agency Language Access Plan)
  when one exists, record the judgment call when it doesn't. `test/standards/i18n_glossary.py`
  (unit job) checks two things: every `{placeholder}` and inline-tag SET (not count — a
  language may legitimately repeat a placeholder more than en does, e.g. Russian noun/adjective
  agreement) survives translation, and each glossary term's pinned rendering appears somewhere
  in that language's dictionary (a STEMMED substring check — first 5 chars — so Russian
  declension, e.g. `совет` pinned vs `советов` shipped, doesn't false-positive).
- **Machine-translation disclosure**: `I18N_PROVENANCE[lang].state` (`machine-drafted` |
  `glossary-checked` | `native-reviewed`) drives `updateLangNotice()` (i18n.js), which shows
  the `mt_disclaimer` string alongside the existing "notices stay English" note for any
  non-`native-reviewed` language — all ten shipping languages (es, zh-Hans, ru, bn, ht, ko,
  fr, pl, ar, ur) are `machine-drafted` today (formalizing what was previously an undocumented,
  unreviewed state for es too).
- **Every page loads `i18n.js` and carries the shared header language switcher** (`#langSwitcher
  .lang-btn`) — index.html plus about/data/stats/api/changelog.html. `crol_lang` in localStorage
  is one preference honored by every page on load (i18n.js's own bottom IIFE sets `window.LANG`
  *and* `document.documentElement.lang`/`dir` synchronously, before body paint).
- **Every user-facing string routes through `t()` / `tn()` / `tSection()`** (i18n.js) — including
  strings built in JS template literals and labels derived from DATA VALUES (City Record
  section names → `SECTION_I18N`). Two gates enforce it; run them before calling i18n work
  done: `python3 test/standards/stray_english.py` (source lint over all pages; its allowlist
  `test/standards/stray_english_allowlist.txt` may only shrink) and
  `python3 test/functional/13_stray_english.py` (hermetic rendered-DOM walk, every PR in CI;
  parameterized by `CROL_GUARD_LANGS` and, per page, `CROL_GUARD_PAGES` — default `index`;
  CI runs all six). Subpages get a lighter walk (load → switch → walk text) than index.html's
  full lens-driving one; approved translations are shared across pages automatically since
  `dict_fragments()` scans the whole `STRINGS[lang]` table (which the guard gets by literally
  `require()`-ing i18n.js in Node — the split-file Node shim above is load-bearing for this).
  Non-Latin-script languages (zh-Hans, ru, bn, ko, ar, ur) are structurally exempt from the
  English-word-list collision risk the guard's curation step guards against
  (`test/standards/english_words.py`'s `ENGLISH_WORDS` set only ever matches ASCII `[A-Za-z]`
  runs) — that curation stays load-bearing for any Latin-script addition (fr, ht, pl shipped in
  wave 8 batch 2; the collision risk is real, not theoretical — French's own glossary pin for
  "Procurement" was originally "Marchés publics", which the guard's `[A-Za-z]+` word matcher
  reads as bare `March` once the accented `é` breaks the run, colliding with the curated
  month-name entry; re-pinned to "Approvisionnement" instead of extending the allowlist, since
  a different equally-correct term was available with no collision — prefer that over widening
  the curated list when a clean alternative exists).
  **Sharp edge — `SECTION_I18N` isn't in the guard's "approved fragments" pool.** The runtime
  guard's self-maintaining "approved translations" bucket (`dict_fragments()`) only reads
  `window.STRINGS`, not `window.SECTION_I18N` — so a short, standalone `SECTION_I18N[lang]`
  label (a City Record section name rendered alone in a chart/legend, with no surrounding
  prose to self-match against) gets ZERO benefit from that self-approval mechanism and must
  independently avoid every `ENGLISH_WORDS` collision on its own. Ordinary `STRINGS[lang]`
  prose effectively self-approves (the rendered text always substring-matches its own source
  fragment), which is why `SECTION_I18N` values are the highest-collision-risk surface in the
  whole catalog for a new Latin-script language.
- **Sharp edge — `t` shadowing:** never name a function parameter or local `t`
  (`pinBtn(t,…)` and `copyText(t,…)` both silently broke rendering, 2026-07-13 hotfixes).
- **Changing i18n.js (core) requires a `?v=` hash bump** on EVERY page's script tag
  (`shasum -a 256 i18n.js | cut -c1-8`) — `test/standards/i18n_refs.py` checks all six pages
  and fails on any stale one. Changing a per-language file requires bumping ONLY its own
  `LANG_FILE_HASHES` entry in i18n.js (which itself then needs the core `?v=` bump, since
  i18n.js's content changed) — `i18n_refs.py`'s second check verifies every shipping
  language's declared hash matches its actual file hash.
- **es orthography is gated:** `python3 test/standards/es_diacritics.py` fails accent-less
  forms of pinned Spanish words. Extend its map when a reviewer catches a new miss.
- **Language switching must repaint dynamic surfaces, TWICE if the dictionary is lazy-loaded.**
  index.html's `rerenderForLang()`; subpages use the lighter `initSubpageLangSwitcher(onChange)`
  (i18n.js) — pass `onChange` when a page caches live-fetched data or a translated data-value
  (data.html's `renderSections()` re-runs `tSection()` from cached rows; stats.html's `paint()`
  re-renders the current async status). Since wave 8, `setLang(lang, onReady)` takes a SECOND
  callback: it fires immediately (instant feedback, possibly still-English if the dictionary
  hasn't loaded yet) AND AGAIN once a lazily-loaded shipping language's `<script>` finishes
  fetching — `applyStrings()` alone only touches static `[data-i18n]` elements, so content
  already stamped out via `t()`/`tn()` template literals (search results, today-strip, a
  subpage's live data) would otherwise stay in English forever after the network request
  resolves. Caught by the runtime guard going red for ru (which is never the initial saved
  language in the guard's fresh browser context, so always hits the lazy-load path) even
  though the dictionary itself was correct — a good example of why the guard exercises every
  page/lens, not just "does the dictionary have the right strings." **Wire the switcher
  synchronously**, not after an `await` — stats.html originally called
  `initSubpageLangSwitcher()` only inside the post-fetch branches, so clicking it during the
  loading window silently did nothing (caught in manual verification, 2026-07-13).
- **Interaction-gated states count:** the runtime guard seeds a pinned investigation item and
  walks `#investigation`; a new localStorage/hash-gated panel needs the guard walk extended
  or it will ship English silently (hotfix-2's lesson).
- **Permalink panes (`#notice/`, `#vendor/`, `#agency/`, `#matter/`) have no `.tabbtn`**
  (`syncTabAria()`'s comment explains why — they're reached only via permalink/pivot, never
  the tablist). `rerenderForLang()`'s `.tabbtn.active` lookup returns `tab = null` while one
  of these is showing, so a language switch WHILE VIEWING one silently left its chrome (glance
  labels, action buttons, how-to-respond panel, permalink footer — all built once via `t()`
  when `showNotice()`/`showVendor()`/etc. first ran) stuck in whatever language was active at
  that moment (hotfix 3, 2026-07-13). Fresh direct loads of a `#notice/…` URL were never
  actually broken — `window.LANG`/`STRINGS[lang]` are populated synchronously via i18n.js's
  `document.write()` before the body's hash router runs — only the in-place-switch path was.
  Fix: `rerenderForLang()` checks `.tabpane.active` for `tab-notice`/`tab-entity` and re-runs
  `applyHash()` (which already knows how to dispatch back to the right `show*(id)`) instead of
  falling into the tabbtn-keyed branches below it. The runtime guard's `run_notice_deep_link()`
  (`test/functional/13_stray_english.py`) now pins both the fresh-load and switch-while-viewing
  paths — it was a guard blind spot (no `#notice/` walk existed at all) as much as a code bug.
  Separately, unrelated pre-existing gaps found while chasing this (do NOT conflate with the
  above): `deadlineTag()`'s `_spellNum()` hardcodes English number words ("one".."nine") into
  `closes_in_n_days` for any language when a deadline is 2-9 days out; `noticeFlags()`/
  `awardContext()`'s anomaly-flag and "Context" panel text, and `fillAddressLinks()`'s
  "This address elsewhere" panel, are hardcoded English with no `t()` calls at all. All three
  are real gaps but out of this hotfix's class (render-ordering, not missing translations) —
  worth their own pass.
- **Content-zone carve-out for long-form/technical content:** `code`, `pre`, and `.chg-detail`
  are allowlisted content zones in `test/functional/assets/stray_english_allowlist.json`
  (technical/verbatim samples; changelog.html's per-release bullet lists and incident reports,
  which stay English behind a `chg_detail_note` disclaimer — an interim milestone, same posture
  as official notice content). Chrome, ledes, and every changelog release's reader-facing "For
  you" summary DO translate; only the archival technical detail is carved out.
- Notice CONTENT stays English (official source) with a per-language disclaimer; chrome and
  derived UI text always translate. Full key parity across ALL `SHIPPING_LANGS` enforced by
  `i18n_keys.py` (reads the shipping list from i18n.js, checks each `i18n/lang/<lang>.js`).
- **w8-06 (script rendering) has shipped piecemeal, one language at a time, not as its own
  card**: `LANG_META[lang].fontStack`/`lineHeightScale`, applied as `--lang-font-stack`/
  `--lang-line-height-scale` CSS custom properties by `applyStrings()`, exist today for
  zh-Hans, bn, ar, and ur; a page-level `:lang(zh-Hans),:lang(ko),:lang(bn),:lang(ar),
  :lang(ur){letter-spacing:normal !important;text-transform:none !important}` rule
  neutralizes the masthead's Latin-typography devices (small-caps, tracking, forced
  uppercase) site-wide, since none of those scripts have letter-casing. ru/ht/fr/pl need no
  script-rendering changes (Latin/Cyrillic case normally, tracking doesn't break cursive
  joining the way it does for Arabic). ko needs the neutralization rule but no font stack
  (system Hangul rendering is fine as-is). ar/ur need it for a stronger reason than CJK/
  Bengali: letter-spacing doesn't just look wrong on Arabic script, it breaks the cursive
  joining between letters outright. The full regression-tested script-rendering spec
  (per-script joining/line-height screenshots, `test/functional/15_script_rendering.py`) is
  still unwritten — this is all still ad hoc per-language additions, not that card's scope.
- **Cross-gate tension, readable-or-else + non-English content**: readable-or-else's Flesch-
  Kincaid extractor (`extract_visible_text`) has no `lang`-attribute awareness — it feeds
  ALL visible page text (including a page's own language-switcher button labels, in every
  shipping language's native script) through the English-only syllable/sentence heuristic.
  Adding a language's native-script button label can therefore nudge a page's measured grade
  by a hair with zero actual change to English readability (index.html's baseline moved
  14.809 → 14.881 when zh-Hans/ru shipped, then → 15.02 when bn/ht/ko/fr/pl shipped, then →
  15.04 when ar/ur shipped — about/data/stats/api/changelog moved by similar hairs each
  round) — same class of "known interaction, not a regression" as the ↗-icon case below; the
  baseline entry needs a hand-edit (the tool's own `baseline` command refuses to raise a
  value) with the reasoning recorded in the commit, not
  prose simplification to compensate.

## RTL support (wave 8: ar + ur)

- **Logical CSS properties, not a parallel RTL stylesheet.** index.html's ~15 physical
  `left`/`right`/`margin-left`/`padding-left`/`border-left`/`text-align:left|right` declarations
  were converted in place to `inline-start`/`inline-end`/`inset-inline-start`/logical
  `border-*-radius` (e.g. `border-start-end-radius`) — the browser derives the physical side
  from `dir` automatically, so there is no `[dir=rtl] { ... }` override stylesheet to keep in
  sync. Any NEW physical left/right CSS added to index.html going forward is a regression;
  `test/functional/15_rtl.py` spot-checks two of these (the `.skip` skip-link's mirrored
  off-screen side, `.tag`'s mirrored margin) as a canary, not an exhaustive audit — grep for
  `left:|right:|margin-left|padding-left|border-left|text-align:\s*(left|right)` before
  merging further index.html CSS changes.
- **Bidi isolation of English data islands.** Notice titles/agency names are English data
  rendered inside RTL (ar/ur) chrome — `enTitle()` and every hand-written `lang="en"` span/
  heading (`.ragency`, `h2.rolename`, the vendor-variants span) now pair `lang="en"` with
  `dir="ltr"`. This isn't cosmetic: an explicit `dir` attribute gets `unicode-bidi: isolate`
  for free from the browser's UA stylesheet (verified empirically, not assumed — see
  `test/functional/15_rtl.py`'s bidi check), which is what actually stops a title's trailing
  punctuation/numerals from reordering against the surrounding Arabic/Urdu text (WCAG 1.3.2).
  `lang="en"` alone (the pre-existing wave-9 convention) does NOT isolate — don't drop the
  `dir="ltr"` half of the pair when adding a new English-data span. The global `code{}` rule
  also carries `unicode-bidi:isolate` for PIN/id snippets, which are always-English data too.
- **Digit policy: Western (Latin) digits, pinned via the `-u-nu-latn` Unicode locale
  extension** (`LANG_META.ar/ur.intlDate = "ar-u-nu-latn"` / `"ur-u-nu-latn"`), not the bare
  `"ar"`/`"ur"` macrolocale — verified empirically that a bare locale's default numbering
  system varies (Node's bundled ICU resolves plain `"ar"` to Latin digits already, but
  `"ar-SA"`/`"ar-EG"` resolve to Arabic-Indic; don't assume a browser's ICU agrees with
  Node's — the extension makes the choice explicit regardless). Matches NYC MOIA's own
  Arabic/Urdu print materials, which use Western digits.
- **Arrow-mirroring convention for ar/ur translations**: any directional glyph (`→`/`←`/`↗`)
  in an English string is mirrored in the Arabic/Urdu translation, keeping the same
  leading/trailing POSITION in the string but flipping the glyph — a trailing `→` (forward,
  e.g. "Subscribe →") becomes a trailing `←`; a leading `←` (back) becomes a leading `→`; `↗`
  becomes `↖`. This is a per-string translator judgment call (Unicode doesn't auto-mirror
  arrow glyphs the way it does parentheses/brackets), not something a gate enforces — a
  future translation fix should preserve this convention by hand.
- **Selector placement stayed centered, not top-right/top-left** — the w8-04 design note
  about USWDS's top-right/top-left RTL flip describes a header layout this site never
  actually used (`#langSwitcher` is a centered flex row under the masthead); flex row order
  already mirrors automatically under `dir=rtl` with zero extra CSS, so there was nothing to
  flip. Each option still carries its own `lang`+`dir` (WCAG 3.1.2) regardless of container
  layout.
- **`test/functional/15_rtl.py`** (hermetic, joins the `i18n-guard` CI job) is the RTL-specific
  gate: dir/lang propagation, the two logical-property mirror spot-checks above, bidi
  isolation of an `enTitle()` span, and no horizontal overflow at 375px/1280px. It does NOT
  re-check translation completeness — that's `test/functional/13_stray_english.py` (now
  parameterized with `ar,ur` in `CROL_GUARD_LANGS` alongside es/zh-Hans/ru).
- **`15_rtl.py` only drives index.html** — the five subpages (about/data/stats/api/changelog)
  share index.html's `.skip{position:absolute;left:-9999px}` skip-link CSS but were never
  retrofitted to the logical-property conversion described above. In RTL (ar/ur) this causes
  real horizontal overflow (confirmed via `document.documentElement.scrollWidth` on stats.html,
  ~10,000px) — a pre-existing gap, not caught by any gate today. A future RTL pass should
  either convert subpage `.skip` to `inset-inline-start` or extend `15_rtl.py` to cover subpages.

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
- **`nyc_copy_lint.py` is CI-enforcing** (`--gate`, since w10-06) — default invocation with
  no flags stays report-only (exits 0) for a quick local check. Its shrink-only allowlist
  (`nyc_copy_lint_allowlist.txt`) tracks the chip/threshold currency exception
  (numerals-in-buttons is the guide's own carve-out) plus one search-placeholder hint that
  shares that UI register. The i18n.js dictionary scan decodes HTML entities before running
  the text rules (`strip_html_value`) and skips `chg_*_h2` keys — without both, an escaped
  `&lt;`/`&gt;`/`&amp;` abutting a stripped tag reads as a false semicolon/heading-carve-out
  miss (caught during the w10-06 copy sweep).
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
- The board-notification bridge (route `/board-hook`) is an **optional** npm dependency,
  [`board-notify`](https://github.com/jimdc/board-notify) (`github:` dep pinned to a commit
  SHA in `worker/package.json`, since it isn't on npm yet) — not code that lives in this
  repo. See `worker/README.md`'s "Board notifications" section. It's a maintainers-only
  convenience, deliberately kept out-of-tree by maintainer decision: a fork that never
  configures its secrets ships a working crol-list with the bridge simply switched off,
  which is the whole point of keeping crol-list cleanly cloneable. The `board-notify` GitHub
  App is live (app id 4288246, installed on cityscroll, installation id 146319774); its
  one-click creation kit stays outside this repo, in the maintainer's private tooling at
  `` (`INSTALL.md` has the setup steps, for reference if the App
  ever needs recreating).
- **`/stats` counters (`worker/src/lib/stats.mjs`)**: the original per-day rolling counters
  (`bumpStat`/`sumStat`, key `stats:<metric>:<day>`, 40-day TTL) were joined by an all-time +
  per-category layer — `bumpStatAllTime`/`readStatAllTime` (key `stats:alltime:<metric>`, no
  TTL, accumulates forever) and `bumpCategoryStat`/`readAllCategoryStats` (key
  `stats:cat:<metric>:<category>`, no TTL, categories discovered dynamically via a KV prefix
  `list()` rather than a hardcoded set). Wired for two metrics so far: `digest` (category =
  City Record `section_name`, falling back to the watch's lens for land/ZAP notices which
  carry no `section_name`) and `nl_search` (category = the NL lens itself: money/people/land/
  property/rules/meetings). Adding a new all-time/category metric means calling these same
  helpers at the event site plus adding the matching `readStatAllTime`/`readAllCategoryStats`
  calls in `worker/src/stats.mjs`'s `Promise.all` — the response body only ever gains new
  sibling fields (`sent_all_time`, `by_category`, etc.), never changes an existing field's
  shape, so existing consumers (stats.html's 7-day grid) are unaffected by design.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
