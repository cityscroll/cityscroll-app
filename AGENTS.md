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
- **Sharp edge — static-fallback drift.** A `data-i18n`/`data-i18n-html`/`-placeholder`/`-aria`
  element's fallback content (the raw HTML before `applyStrings()` repaints it) can silently
  drift from its `i18n.js` en value — `test/standards/i18n_fallback_sync.py` (unit job) catches
  this: index.html's `tab_money`/`money_trail_heading` fallback text was stuck on "Money"/
  "Money trail" for a live-since-fixed dictionary that already said "Contracts"/"Contract
  trail" (crol-staticsync-b2, 2026-07-14) — nothing had caught it before this gate. Same class
  of bug the reading-level ratchet note above already warned about for a different symptom
  (the ratchet measures this exact static text and silently gets the wrong number); this gate
  is the general enforcement. It also catches the sharper variant: a plain `data-i18n` element
  whose fallback contains a nested tag (`<b>…</b>`) never gets its text replaced at all —
  `applyStrings()`'s `if (el.children.length === 0)` guard no-ops for it in EVERY language
  forever, not just before paint — found live on three index.html empty-state hints whose
  real translations existed in all ten shipping-language files and had never once rendered.
  Fix is to keep the element markup-free (matching the dictionary's plain text) or switch it
  to `data-i18n-html`.
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

## Testing strategy

- The house style is **characterization tests with example-anchored regression fixtures**:
  every behavior change carries a test whose input is the actual observed failure (a real
  sentence, a real broken URL), named after the observable symptom, with the before-behavior
  stated in the test description ("before: X happened; after: Y"). Write the test before the
  fix where practical, so it fails for the right reason first.
- Live exemplars: `test/nl_alerts_parse.test.mjs` (the query that lost two of its three
  parts, quoted verbatim in the test name and comment) and the deep-link fixtures in
  `test/functional/assets/` (`i18n_fixtures.py`'s seeded records, driven by
  `run_notice_deep_link()` in `test/functional/13_stray_english.py`, which pins the exact
  render-ordering bug a prior hotfix found).
- A description that only says what the code does, without the before/after, is missing the
  point — the value is in pinning the failure that used to happen, not just today's output.

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
- **A deliberate copy-lengthening product decision can trip the ratchet on the page you're
  actually editing, not just a sibling PR's page.** w12-07's step-2 relabel ("Narrow by keyword"
  → "Describe what you want — plain English or keywords") nudged index.html from 15.02 to
  15.11 — expected, since the new label is a longer, more accurate sentence and the site owner
  chose accuracy over grade. Same fix as above (hand-edit the entry to the freshly measured
  number via `ror baseline <page> --preset nycsg7 -o /tmp/fresh.json`, then copy the value in),
  just triggered by your own change instead of a sibling's.
- **The extractor drops `<script>`/`<style>` entirely (`extract.py`'s `DROP_TAGS`) and never
  executes JS** — it reads static markup only, `--extract dom-rendered` is an unimplemented
  stub. A UI string that only ever reaches the DOM via `t()`/`innerHTML` at runtime (e.g. a
  notice-detail panel note assembled in a `<script>` block) contributes **zero** to any page's
  measured grade, no matter how complex its prose — verified by diffing the grade before/after
  the string existed. Conversely, any `data-i18n` element's **static fallback text already
  sitting in the HTML source** (the pre-`applyStrings()` English shown before JS repaints it)
  *is* measured — so a UI-copy change that fixes the ratchet must land in the `.html` file's own
  fallback text, not just its `i18n.js` dictionary entry (which is what actually renders after
  JS runs — keep both in sync, or the page silently reverts to the old wording once JS paints).
  Also: because most of index.html's chrome carries no terminal punctuation, textstat treats
  almost the entire page as one giant "sentence" — so words/sentence ratio (and thus grade)
  moves with *any* added or removed static label anywhere on the page, not just prose-shaped
  copy, which is why a page's grade can drift from something as small as one new dropdown option.
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

## Changelog — self-updating from merged-PR marker sections

- **`changelog.html`'s "Recent updates" list is generated, never hand-edited.** A PR marks
  itself user-facing with a `## What this means for you` section in its body (any heading
  level, case-insensitive — see `tools/changelog_extract.mjs`'s `extractUserImpact()`); a PR
  with no such section is plumbing and gets no entry, by design, not oversight. Convention is
  documented for contributors in `CONTRIBUTING.md`'s "Changelog entries" section.
- **`changelog-data.json` is the source of truth**; the HTML block between the
  `<!-- CHANGELOG:AUTO:START -->`/`<!-- CHANGELOG:AUTO:END -->` markers in `changelog.html` is
  a full rebuild from that file every time (`tools/gen_changelog.mjs`), never hand-patched —
  same "one source, generated projection" shape as `docs/architecture.md` → the kanban hub
  page, just applied to a changelog instead of an architecture doc.
- **`.github/workflows/update-changelog.yml`** runs on `pull_request: types: [closed]` (merged
  only) and extracts the marker line. `main` sits behind a merge-queue ruleset that rejects a
  direct push even from the Actions token (bypass actors aren't permitted on it), so the
  workflow instead force-pushes a standing bot branch (`bot/changelog-update`, always rebuilt
  fresh from `main`'s current tip), opens or updates a PR from it, and enqueues that PR itself
  via the `enqueuePullRequest` GraphQL mutation (needs `pull-requests: write` alongside
  `contents: write`) rather than merging it directly.
  **Loop guard, two layers.** (1) Trigger type: nothing this workflow does calls PR machinery
  on `main` directly (no merge, no admin bypass), so it can't raise another
  `pull_request closed` event itself. (2) Fixed point: the bot's own PR body
  (`.github/changelog-bot-pr-body.md`) carries no `## What this means for you` section by
  construction, so when THAT PR eventually merges through the queue, this same workflow runs
  again, extracts nothing, and the explicit no-diff guard (byte-compare against the pre-
  regeneration base, before any branch is touched) exits early — the chain always terminates
  after one hop. If a second qualifying PR merges before the queue processes the first bot PR,
  the next run reads the bot branch's own pending `changelog-data.json` as its base (not
  `main`'s stale copy) and accumulates onto that same open PR instead of opening a duplicate.
- **`.chg-auto` is a content-zone carve-out**, same posture as the pre-existing `.chg-detail`
  archival carve-out: entries are extracted verbatim from PR bodies at merge time, so they
  can't be pre-translated or guaranteed to pass the NYC copy lint — carved out of both
  `test/functional/assets/stray_english_allowlist.json` (`content_zone_selectors`) and
  `test/standards/nyc_copy_lint.py`'s skip-zone check. The list's own heading and disclosure
  note (`chg_auto_h2`/`chg_auto_note`) are ordinary translated chrome, NOT inside the carve-out
  — watch the class-name substring check in `nyc_copy_lint.py` if you rename anything (`"chg-
  auto" in cls` would also match a sibling class literally named `chg-auto-*`, which is why the
  disclosure note's class is `chgauto-note`, not `chg-auto-note`).
- **Backfill vs. future entries**: the fourteen entries seeded 2026-07-11 through 2026-07-14
  were hand-picked from `gh pr list --state merged` (pre-dating the marker convention) and
  written as if each PR had carried the marker; every entry from here on is mechanical.
- **Characterization tests**: `test/changelog_extract.test.mjs`, real merged-PR bodies
  (crol-list #26 with an appended marker section, #33 verbatim with none).

## Alerts NL query — the combined parser, and the pure-module extraction pattern

- **`nl_parse.js`** (repo root) holds `parseNL()` + its category dictionary
  (`NL_CATEGORY_DICT`) — extracted out of index.html's inline script into its own file so it's
  directly `require()`-able from a Node test (`test/nl_alerts_parse.test.mjs`) with no DOM and
  no brace-matching trick. It's a plain classic `<script>` (declares `parseNL` as a global,
  same convention as `i18n.js`), loaded right after `i18n.js` in every page that needs it
  (currently just index.html) — NOT an ES module, so it needs no bundler and Node's CJS/ESM
  interop picks up its `module.exports` automatically for `import` in `.mjs` tests. This is
  the pattern to reach for next time a chunk of index.html's inline script needs to be
  Node-testable as pure logic — prefer it over extending `test/unit.test.mjs`'s brace-matching
  extractor when the function has no dependency on anything else in that giant script.
- **The general filter schema IS money's lens field list — additive by construction.**
  `LENSES.money` (`worker/src/lib/filter.mjs`) is the single source of truth for every field
  the alert/digest query layer can actually turn into a query: `keywords` (full-text `$q`),
  `agency` (`agency_name`, exact match), `category` (`category_description`, a 6-value enum),
  `minAmount`/`maxAmount` (`contract_amount`), `months` (a due-date window — see below),
  `noticeType` (`"award"`/`"solicitation"`, an explicit override — see below), and
  `excludeSpecial` (declared, still not wired into any compiler — a known, pre-existing,
  out-of-scope gap, not a regression). This inventory came from actually reading
  `worker/src/lib/compile.mjs`/`compile_d1.mjs` and querying the live SODA dataset's real
  columns (dg92-zbpx) — not from one example sentence. `LENSES.alerts` reuses this exact list
  plus `watchType`/`place` for the one genuinely different shape (a rezoning watch has no
  dollar amount, agency, or due date at all). A subscription's stored `filter` for a money/
  alerts watch is just this object — adding a new field later is one array entry + one
  `clampField` case, no migration, since every existing stored filter is already a subset of
  it (this is also why the "moneynl" watch type never needed its own bespoke stored shape:
  it was always just `lens:"money"` with a subset of these fields).
- **`noticeType` closes a real gap: notice type used to be a SECRET function of amount-
  presence.** Before, any `minAmount`/`maxAmount` implied "Award" and their absence implied
  "Solicitation" — so "Parks Department awards, any amount" was inexpressible (no amount →
  fell into the Solicitation branch despite the word "awards"). `noticeType` is now explicit
  and authoritative when set; the amount-presence heuristic survives only as the fallback for
  every filter stored before this field existed (no migration needed — see above). `months`
  similarly went from computed-but-never-applied (the old code only used it in a cosmetic
  "code preview" string, never a real query) to a real `due_date` upper bound via
  `monthsFromISO()`/`compile.mjs`'s exported helper, mirrored in `compile_d1.mjs` as
  `opts.dueBefore` (`notices.mjs`'s `buildNoticesQuery()`) and in the front-end's
  `addMonthsISO()`. **The SODA path (`compile.mjs`) and the D1-mirror fast path
  (`compile_d1.mjs`) are two independent compilers for the same `{lens, filter}` shape** —
  `alerts.mjs` picks whichever is fresh at cron time, so a field wired into only one of them
  would make a subscriber's digest silently depend on mirror freshness. Change one, change
  both (and `worker/src/lib/notices.mjs`'s `buildNoticesQuery()` if it's a new SQL clause).
- **Place/borough is deliberately NOT a money/alerts field.** The live City Record dataset
  (dg92-zbpx) has `street_address_1/2`, `city`, `zip_code` but no `borough` column, and none of
  them are reliably populated for procurement notices — unlike `land`/ZAP, which genuinely has
  a `borough` field. Inventing a `place` filter for money/alerts that silently does nothing
  would violate the "no silent caps" rule; a place mentioned in a money-lens query is only
  ever picked up (best-effort, not guaranteed) as a `keywords` term via `$q`.
- **`nl_parse.js`'s `parseNL()` fills whatever subset of that schema a sentence names**, not
  just keywords/amount/months. `NL_AGENCY_ALIASES` is a bounded, best-effort dictionary of
  common informal agency names/acronyms → the dataset's CURRENT canonical `agency_name` string
  (grounded by querying the live dataset — it has ~300 raw variants across years, mostly
  legacy ALL-CAPS/abbreviated rows; alerts only ever watch new, future notices, so the current
  Title Case form is what's picked). `category` inference is deliberately conservative — the
  procurement-category enum is about procurement METHOD, not topic, so it's only inferred from
  unambiguous phrases (or the construction-keyword dictionary), never guessed; an over-eager
  wrong category would silently narrow a subscriber's alert, which is worse than leaving it
  null. The harder cases are left to the model-backed `/nl` endpoint's own enum-constrained
  tool call. Season-relative deadline phrases ("due this fall") are a known, deliberately
  out-of-scope extraction gap — `parseNL()` is a pure function of text alone (no "today"
  reference passed in), and season arithmetic needs one; only numeric "N months/weeks" parses.
- **The "Build an alert" form's visible fields did not grow** (`#amoneykw`/`#amoneymin`/
  `#amoneymonths` only) even though the schema/mapper now cover `agency`/`category`/
  `maxAmount`/`noticeType` too — those extra fields have no dedicated widget. They're carried
  in a hidden `moneynlExtra` object (index.html), populated by `NL.alerts.apply()`, cleared on
  any watch-type switch, folded into `aLensFilter()`'s stored filter and `aFetch()`'s live
  preview query, and surfaced read-only via the same `.qchip` "understood as" chips already
  used for keywords/amount/months — not a new UI control, just more chips in the existing row.
  If a future pass adds visible widgets for them, `moneynlExtra` can just go away.
- **Two free-text boxes on the same screen must not read as one input.** The 60-second quiz's
  keyword field (`#quiznarrow`, exact substring match) and the Ask box (full NL parse) sit in
  separate panels on the Alerts tab but both take arbitrary typed text — `quiz_step2`'s label
  now says "keyword" explicitly so it doesn't invite a full sentence. Separately, the Ask box's
  parsed-filter summary (`.qchip` spans, rendered via the shared `nlTransHTML()` helper) is
  inert status text, not a lookalike of the clickable sample-query chips (`.trychip`) sitting
  right above it — it carries `role="status"`, an explicit `nl_understood_label` prefix, and
  deliberately does NOT share `.trychip`'s pill shape or pointer cursor.
  `test/standards/nl_input_clarity.py` (unit job) statically pins both distinctions.
- **One query brain (w12-01): the quiz keyword field's "exact substring match, no parsing"
  premise above is now only true for non-`rfpkw` topics.** Field evidence: a real query typed
  into `#quiznarrow` ("education contracts over 200k due in the next 3 months") previewed
  empty because the `rfpkw` watch sent the whole sentence to SODA as one literal `$q` phrase,
  while the identical text in the Ask box worked (it already called `nlResolve()`). Three entry
  points shared the `rfpkw` watch's free-text field — the quiz's `#quizgo`, the Build-an-alert
  panel's own `#apreview` button, and the Ask box — and only the Ask box interpreted it.
  `resolveMoneyNarrow()` (index.html, right after the `NL` object) is the one place the other
  two now resolve: if `#awatch==="rfpkw"` and `#aparam` is non-literal (multi-word, unquoted —
  `isLiteralKeyword()`, nl_parse.js), it calls `nlResolve(text,"alerts")` and hands the result to
  `NL.alerts.apply()` — the SAME function the Ask box calls — which promotes the watch to
  `moneynl` and populates the structured fields, so Preview and a saved alert are built from
  ONE interpreted filter and can't diverge. A literal single word or quoted phrase (`"..."`/
  `'...'`) still passes straight through, unchanged, with no worker round-trip. Other quiz
  topics (`meetings`/`rules`/`property`/`rezone`) are untouched by design — `parseNL()`'s field
  schema is money-shaped and has no signal for those lenses, and the existing meetings/
  `"community board"` regression test (`test/functional/03_watch_quiz_feeds.py`) pins that a
  multi-word literal keyword stays literal for them. Node characterization:
  `test/quiz_narrow_resolve.test.mjs` (extracts `resolveMoneyNarrow()` the same brace-matching
  way `forecast_render.test.mjs` does, with `nlResolve`/`NL`/`nlTransHTML` injected as fakes).
  Needed zero changes to `worker/src/nl.mjs` — `lens:"alerts"` was already a supported lens.
- **w12-06 field regression: `resolveMoneyNarrow()` above only fires once `#awatch==="rfpkw"`,
  which requires clicking a step-1 topic chip first — typing straight into step 2's field and
  hitting "Preview my digest →" with no chip picked used to hard no-op** (`quizW` stays `null`,
  `$("#quizgo")`'s click handler returned after only swapping `#quiznarrow`'s placeholder — a
  no-op invisible to the user since the field already held their typed text, hiding the
  placeholder). Reproduced live against production with a fresh, cache-free browser context
  before touching code (site-owner field report, 2026-07-15): zero `/nl` requests, zero DOM
  change, the existing `03_watch_quiz_feeds.py` "PROBE" for this path only covered the
  *empty*-field case, not *typed-but-no-topic*. Fix: `nlTranslateLens(lens, opts)` now takes an
  optional `{text, inputSel}` override so a second entry point can reuse its exact
  resolve→echo→apply sequence against a different input than the injected Ask box's
  `#nlq-<lens>`; `$("#quizgo")`'s no-topic branch calls
  `nlTranslateLens("alerts", {text, inputSel:"#quiznarrow"})` whenever the field is non-empty,
  falling back to the placeholder nudge only when it's genuinely empty too. Same interpretation
  path as the topic-picked case (`NL.alerts.apply()`), so a rezoning-shaped sentence still
  resolves correctly even with no chip clicked. Browser-level regression test added to
  `test/functional/03_watch_quiz_feeds.py` (a live-API, manual-dispatch spec, not the hermetic
  i18n-guard suite) — confirmed it hangs/times out against the pre-fix code before confirming
  it passes post-fix, per the house characterization-test convention.

## Cadence estimate — "is this a yearly bid?" answered in words (w12-04)

- **`cadenceEstimate(chain)`/`cadenceHTML(est)`** (index.html, just above `chainHTML`) turn the
  paper-trail chain `chainHTML()` already renders (`loadChain()`'s same-PIN + renewal-suffix-
  widened award history) into a plain-language line — e.g. "3 prior awards, about 9 months
  apart. Next solicitation expected around Jan 2024. Estimate" — appended to `chainHTML()`'s
  output. No new fetch, no worker dependency: it's pure arithmetic over data already on hand
  client-side. Wired once, in `chainHTML()`, so both call sites (the money-tab detail pane and
  `showNotice()`'s permalink pane) get it for free.
- **Never guesses**: renders nothing (`cadenceHTML(null)` → `""`) unless the chain has at least
  `CADENCE_MIN_AWARDS` (3 — chosen to match "3 prior awards", i.e. 2 confirmed gaps) Award-type
  entries with parseable dates, every gap is at least `CADENCE_MIN_GAP_DAYS` (30 — a shorter gap
  reads as a same-round correction, not a rebid cycle) apart, the gaps aren't more than
  `CADENCE_MAX_GAP_RATIO` (4) apart from each other (an erratic pattern can't be honestly
  averaged), and the chain isn't a blanket code (`isBlanketChain()`, shared with `chainHTML()`'s
  pre-existing `blanket_note` — a blanket PIN bundles simultaneous same-day awards to different
  vendors, not sequential cycles; same-day gaps would also fail the min-gap check independently,
  a second layer of defense).
- **Sharp edge — date math must stay in UTC.** `start_date` is a date-only ISO string (UTC
  midnight per spec); the first cut used local-timezone `setDate()`/`getDate()` to project the
  next expected date, which shifted the projected day depending on the reader's own timezone
  offset (caught by a characterization test failing only in a non-UTC CI runner). Fixed by using
  `setUTCDate()`/`getUTCDate()` throughout `cadenceEstimate()`, and `cadenceMonthYear()` passes
  `timeZone:"UTC"` to `toLocaleDateString()` for the same reason.
- **Real fixture**: NYC Department of Correction PIN base `07219P0148001` ("Inmate Phone
  System"), three renewal-suffixed Awards (R002/R003/R004) 287 and 246 days apart — pinned in
  `test/cadence_estimate.test.mjs`, alongside a real 6-row (of 21) Sanitation blanket-PIN
  fixture (`82714CC00040`) for the exclusion path. Both queried live from the SODA dataset
  (dg92-zbpx) rather than invented.
- **Period-generality**: `cadenceApart(est)` picks the phrasing — `avgMonths` below
  `CADENCE_YEAR_THRESHOLD_MONTHS` (24) renders `cadence_months_apart` ("about 9 months apart");
  at or above it renders `cadence_years_apart` ("about 2 years apart") instead, using `avgYears`
  (computed straight from `avgDays`, not from the already-rounded `avgMonths`, so a long cadence
  doesn't compound two roundings into a misleading year count). Both keys are pluralized in all
  10 shipping languages (`ru`/`pl` carry the full one/few/many/other set; the rest one/other).
  Three more real fixtures in `test/cadence_estimate.test.mjs`, added on review to prove the
  logic isn't tuned to one gap length: NYC Dept for the Aging PIN base `12522P0001001`
  ("Older Adult Center(s)"), 730/719-day gaps landing exactly on the year threshold (24 months
  → 2 years); NYC HRA PIN base `06907P0017CNV` (scatter-site supportive-housing renewals), six
  awards where every individual gap already clears `CADENCE_MIN_GAP_DAYS` but the widest/
  narrowest ratio (5.85x) trips `CADENCE_MAX_GAP_RATIO` in isolation from the min-gap guard. A
  quarterly (~91-day) fixture is CONSTRUCTED, not live-pulled — a live search across 650+
  same-PIN/renewal-suffix chains found none averaging a 60-120 day gap; NYC's renewal-suffix
  convention is overwhelmingly annual-or-longer, not quarterly, so there was nothing real to pin
  and the test says so rather than mislabeling synthetic data as observed.

## Procurement forecast — discoverability cross-link + subtab deep-link

- **The forecast data is per-agency/vendor only — there is no sitewide "upcoming" feed.**
  `worker/src/inv.mjs`'s `GET /inv/<id>` and `worker/src/checkbook.mjs`'s `GET /forecast?q=`
  both require a name stem (`vendorStem(id).length >= 3`); the read path is a cheap
  precomputed KV get (cron pipelines `runCheckbookPipeline`/`runMocsPlanPipeline` do the
  real work ahead of time), but there's no all-agencies aggregation to browse. That's why
  the discoverability fix is a cross-link from something that already names an agency
  (a notice), not a new "Upcoming" mode on the Contracts tab — building a sitewide feed
  would be a real backend project, not a placement fix.
- **`agencyForecastTeaser(r, el)`** (index.html, shared by `renderDetail()`'s `#dforecast`
  and `showNotice()`'s `#nforecast` — same sibling-panel pattern as `priorCycleAwards()`)
  fetches `/inv/<agency_name>` for whatever notice is open and renders a quiet one-line
  teaser + honesty note only when forecasts exist (silent no-op otherwise, same posture as
  `fillAddressLinks()`) — reachable with zero extra clicks past picking a notice, which is
  the core interaction of the whole site.
- **`agencyHref(name, tab)`/`vendorHref(name, tab)` take an optional `tab` param** that
  appends a literal `?tab=forecast` after the encoded name (safe: `encodeURIComponent`
  escapes any real `?` inside the name itself, so the first literal `?` is always the
  separator). `applyHash()`'s `splitEntityTab()` parses it back out and passes it to
  `showAgency(name, initialTab)`/`showVendor(name, initialTab)`, which auto-clicks
  `#btn-forecast` on render if `initialTab === "forecast"` — this is how the teaser's "See
  the full forecast" link lands directly on the Forecast subtab instead of the profile's
  default Overview pane.
- **`forecastItemHTML()`/`forecastItemsHTML()`/`forecastPaneHTML()`** (index.html, defined
  once above `showAgency`) are the single builder both profile views call — the two
  hand-copied 20-line blocks this used to be are gone. Shape is pinned without a browser in
  `test/forecast_render.test.mjs`, using the same brace-matching extraction pattern as
  `apply_pnote.test.mjs` (extract the function + its deps out of index.html, inject `t`/`tn`
  via `new Function`). **Sharp edge hit while writing that test:** the extractor's
  `[^;]*` regex for pulling a `const` declaration breaks on any value containing an
  HTML-entity string literal (`"&lt;"`, `"&amp;"`, …) — each one ends in a literal `;`
  that terminates the match early. `escUiHtml`'s extraction uses `.*$` (matches to end of
  line) instead; reach for that variant, not `[^;]*`, for any future one-liner const whose
  value might contain `;`.
- **`test/functional/13_stray_english.py`'s `collect_within(page, rootSel, ...)`** is a new,
  reusable scoped variant of `collect()` — walks only a CSS-selected subtree instead of the
  whole page. Added because the agency/vendor profile's surrounding chrome (agencybar,
  actions row, footer note) is a separate, already-tracked translation gap (see the w9-05
  comment above `collect_srstatus_and_aria`) that an unscoped `collect()` on the Forecast
  subtab would have reopened as a false "regression" every run. Reach for `collect_within`
  again the next time a guard walk needs to prove ONE new subtree translates without also
  re-litigating a pre-existing gap elsewhere on the same page.

## Tab default selection — teach every lens by example

- **"Auto-open the first result" (the 2026-06-26 commit `2d369e94`) already covers Money,
  Land, and both Staffing sub-modes** — `renderList()`/`landRenderList()`/`pSearchRoles()`/
  `pSearchPeople()` all end with `document.querySelector("#<list> .row")?.click();`, so
  once ANY list renders, its first row's detail auto-opens. Money gets this for free on a
  bare page load because Money is the tab active in the markup and `if(!applyHash())
  search();` runs unconditionally; **Land gets it for free because `landSearch()` has no
  keyword gate — it always queries `ulurp_non='ULURP'`(+status/boro) and sorts
  `current_milestone_date DESC`, so a bare `#land` (or a first click into the tab) already
  populates `#ldetail` with the most-recent rezoning, no code needed.** Verify this
  empirically before "fixing" Land again — it's not broken.
- **Staffing (`#people`) was the real gap**: `pSearch()` flatly refuses to search with no
  typed keyword (`if(!kw){ ... return; }`), and there is no "browse all titles" query the
  way Land has "browse all ULURP projects" — a role search always needs one specific title
  to filter by. `applyPeopleDefault()`/`defaultRoleTitle()` (index.html, right above
  `seedPeople()`) close this: on a bare `#people` open (empty `#pkw`, `pmode==="role"`),
  live-query the payroll dataset for the single highest-headcount `title_description` and
  feed it through the exact same `pSearch()` path a typed keyword or a "Try" chip uses —
  same posture as `pExample()`, just computed live instead of from the curated
  `data/people_examples.json`. Fires once per session (`peopleDefaulted` flag); a
  query-carrying deep link (`#people?q=<title>`) or the user typing before the fetch
  resolves both win, since the guard re-checks `#pkw` after the `await`.
- **The auto-picked default must NOT decorate the address bar** — wrap the triggering
  `pSearch()` call in `hashLock = true; ...; hashLock = false;` (same idiom `applyHash()`
  itself already uses around `search()`/`landSearch()`/`pSearch()`) so `updateHash()`
  no-ops for that call. A bare `#people` bookmark should keep reading `#people` after the
  example renders, not silently pin to today's picked title forever — mirrors
  `updateHash()`'s pre-existing "don't decorate a fresh default load" carve-out for bare
  Money (`if(!location.hash && h === "#money") return;`).
- **No new i18n strings needed** for a default-selection feature like this: it just
  populates an existing input field and runs the existing search/detail render path,
  same as clicking a "Try" chip — nothing new is ever painted to the DOM.
- **`test/functional/17_default_examples.py`** is the characterization gate (hermetic,
  `i18n-guard` CI job): pins bare `#land`/`#people` render a live-picked example with zero
  clicks, the address bar stays undecorated, and `#people?q=<title>` still overrides.

## External links — every non-own destination opens in a new tab (crol-extlinks2-y8)

- **Current rule (crol-extlinks2-y8, superseding w10-03): every absolute link to a host
  CROL-List doesn't own opens in a new tab; every own-resource/in-app link stays same-tab.**
  This is a deliberate product decision that supersedes the NYC Web Content Style Guide's B18
  "same tab/window" default for external destinations — the accessible `<span class="sr-only">`
  marking (below) is the WCAG-consistent mitigation for the tab change B18 was written to
  prevent. B19 ("no external-link icons") is untouched and still applies to link TEXT.
  History: w10-03 started same-tab-always; crol-extlinks-s9 carved out City Record/PASSPort/
  Checkbook NYC after a user lost bid-response state on a round-trip; crol-extlinks2-y7 added
  NYC Open Data after the same complaint about a dataset-citation link; crol-extlinks2-y8
  generalized the carve-out into the default rule, since the lost-search-state cost applies to
  ANY external round-trip, not just government data/bid/payment systems.
- **Own resources (stay same-tab): `crol-list.org`, `api.crol-list.org`, in-app hash routes
  and relative page links (`#notice/...`, `about.html#data`, `index.html`, ...), and the
  project's own GitHub repo** (`https://github.com/jimdc/crol-list`, per product ruling — a
  governance-file citation isn't the kind of mid-task research round-trip this rule targets).
  Everything else absolute is external and must carry the new-tab treatment.
- **`test/standards/link_targets.py`'s `classify(href)`** is the single source of truth: for
  any literal `href="https://..."` it checks the host against `OWN_HOSTS`/`OWN_HREF_PREFIXES`;
  for a JS-templated `href="${expr}"` (index.html/api.html build several hrefs at runtime) it
  looks the expression prefix up in `OWN_HREF_EXPRS`/`EXTERNAL_HREF_EXPRS` — an unrecognized
  `${...}` expression is a HARD FAILURE (not a silent guess either way), so a new href-building
  helper must be classified there once, by hand, before the gate will pass. Every own/in-app
  href with `target="_blank"` fails the gate too — the rule is bidirectional, not just
  "external must have it."
- **`EXT_ATTRS`/`extSR()`** (index.html, defined next to the `REQ_URL`/`PASSPORT` consts) are
  the shared helpers for the ~20 JS-templated external anchors: `${EXT_ATTRS}` expands to
  `target="_blank" rel="noopener noreferrer"`, `${extSR()}` appends a visually-hidden
  `<span class="sr-only">` marking (`t("ext_link_new_tab_sr")`, translated in all 11
  catalogs) so a screen-reader user is told the link leaves the app before activating it.
  `link_targets.py` treats `${EXT_ATTRS}`/`${extSR()}` in index.html's raw source as
  equivalent to the literal attributes/span they expand to — it does not evaluate JS. Always
  reach for `${EXT_ATTRS}`/`${extSR()}` on a JS-templated anchor in index.html rather than
  literal attributes/span text — literal `<span class="sr-only"> (opens in new tab)</span>`
  bypasses the i18n layer and fails `test/standards/stray_english.py` the moment the
  surrounding link text is itself `t()`-routed (no adjacent URL fragment left to accidentally
  merge the literal into and dodge the word-list check — this bit the first crol-extlinks2-y8
  sweep on the ZAP/Google Maps anchors). about.html's/api.html's/data.html's static
  `data-i18n-html` strings (in both the page source and every language's
  i18n.js/i18n/lang/*.js dictionary) bake the same literal markup by hand since they're not
  JS-templated — that's the one place literal `(opens in new tab)` text is correct.
- **`.sr-only`** exists on index.html, about.html, data.html, and api.html — a new page
  gaining an external link needs the same CSS rule copied in (see `.skip{...}` neighbor in
  each page's `<style>` block for where it lives).
- **Sharp edge — an external link can live entirely inside an i18n `*_html` dictionary
  value, invisible to a page's own raw source** (crol-extlinks2-y7): the Staffing tab's
  `salary_note_html` string builds its two dataset-citation anchors via `t("salary_note_html",
  ...)` + `innerHTML` — no anchor markup for it exists anywhere in index.html itself, only in
  i18n.js/i18n/lang/*.js. `link_targets.py` therefore scans `i18n.js` + every
  `i18n/lang/<lang>.js` as additional sources (unescaping `\"` → `"` first, since these are JS
  string literals), not just the six page files — a first sweep that only grepped the six
  HTML pages missed several affected `*_html` keys across all eleven language catalogs. Any
  future `*_html` key that bakes a literal `<a href>` is covered by this scan automatically;
  the icon check (`ALLOWED_ICON_TEXT`) is deliberately NOT run against i18n sources since it's
  only curated for en/es and every language's own `view_on_crol` legitimately keeps the ↗.
- **Sharp edge — pre-existing hardcoded-English link text can hide behind a URL fragment in
  the stray-English tokenizer**, and adding `${extSR()}` right after it can expose that debt
  as a fresh gate failure even though the text itself didn't change: `fillAddressLinks()`'s
  "ZoLa zoning"/"ACRIS deeds"/"Who Owns What portfolio" link text was never `t()`-routed (a
  documented pre-existing gap, out of scope for a language-expansion pass — see the render-
  ordering note elsewhere in this file), but the extractor's chunk boundaries had merged
  "Who Owns What portfolio" into the same discarded-as-URL literal as its href — adding
  `${extSR()}` right after it created a fresh interpolation boundary that isolated the text
  into its own chunk with no URL to hide behind. Registered in
  `stray_english_allowlist.txt` (`>Who Owns What portfolio`) rather than folded into a wider
  i18n pass, consistent with how the rest of that already-known-English function is handled.
- **`test/functional/16_external_links.py`** is the characterization gate (hermetic,
  `a11y-pr` CI job): pins the reported links (City Record, PASSPort, the Staffing-tab
  salary-band's two data.cityofnewyork.us links, and the broadened case — about.html's NYC
  Charter citation, previously the gate's own same-tab NEGATIVE control before
  crol-extlinks2-y8 flipped it to a positive one) get target+rel+marking on real rendered
  output, an in-app link (`#investigation`, `about.html`'s "Back to CROL-List") does NOT
  acquire `target="_blank"`, and stats.html's own `api.crol-list.org` link stays same-tab.

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
- **`/stats` day-by-day history** (`hist:<metric>:<day>` + `hist:era:<metric>`, same
  `worker/src/lib/stats.mjs`): a permanent (no-TTL) daily counter for `digest` and
  `nl_search`, bumped at the same call sites as `bumpStatAllTime`, so it's exactly the same
  event stream just also kept per day forever — the 40-day-TTL `stats:<metric>:<day>` above
  can't serve a growing chart on its own. `worker/scripts/backfill-history.mjs` was the
  one-time migration that seeded it from whatever was still recoverable in the short-lived
  source counters (`sendcount:<day>`, 40-day TTL; `nl:<day>`, 2-day TTL) when it ran on
  2026-07-14 — safe to rerun (every write is skip-if-present) but there's nothing left to
  backfill. Its zero-fill rule is the load-bearing part: a gap day is only ever written as a
  confirmed zero when the source counter's own TTL provably still covered it at backfill
  time; otherwise the gap is left unrecorded rather than guessed. `hist:era:<metric>` marks
  the first day counted live (set once, the day the backfill ran) — before it, `/stats`
  presents the series as recovered history; from it on, as counted live. stats.html's "Over
  time" section renders this as a plain table (day / digests sent / searches asked, "Not
  recorded" for gap days before the era boundary) rather than a custom chart — see its
  `renderHistory()`.
- **Sharp edge — SODA aggregates are strings.** `count(1)`/`sum(...)` come back from Socrata
  as string fields (`stats.n === "0"`, not `0`) even when there are zero matching rows — a bare
  `stats.n` truthiness check treats `"0"` as present and renders a dash-and-zero scoreboard.
  Any code deciding whether an aggregate has real data must coerce first (`+stats.n > 0`);
  `hasAgencyAwards()` (index.html) is the shared guard for the two agency-stat call sites
  (`noticeAgencyBar()`, `agencyProfileBar()`) and the pattern to copy for new ones.

## Data-join fortifications — Checkbook field fallback + digest content dedupe

- **Follow-the-dollars tries two Checkbook NYC fields, not one.** `checkbookByPin()`
  (index.html) queries Checkbook's `pin` field first; a pre-2013 (pre-PASSPort) award's PIN
  often doesn't match there because Checkbook filed those older contracts under its `apt_pin`
  field instead — `checkbookQueryByField(pin, field)` is the shared one-shot query, and
  `checkbookByPin()` retries once against `apt_pin` only when the primary query SUCCEEDS with
  zero rows (a hard proxy/network failure on the primary query is not retried — same "say
  nothing" posture as before). Both `followDollars()` and `showMatter()` get the fallback for
  free since they both call `checkbookByPin()`. Characterized in
  `test/checkbook_apt_pin_fallback.test.mjs` using the same brace-matching extraction +
  injected-dependency pattern as `test/forecast_render.test.mjs`, with a hand-rolled fake
  `DOMParser` (Node has none) mirroring the same regex shape `worker/src/checkbook.mjs`'s
  server-side `parseCheckbookTransactions()` uses for the same XML.
- **Digest `fresh` lists dedupe by content fingerprint, not just `request_id`.** A tiny
  fraction of Award notices are republished by City Record itself, byte-identical, under a
  second `request_id` — `worker/src/alerts.mjs`'s `seen`-set (keyed on `request_id` alone)
  can't catch that. `dedupeFreshByContent(rows)` (`worker/src/lib/digest.mjs`, pure/testable
  like its sibling `digestDecision()`) collapses rows sharing `pin + agency_name +
  short_title + vendor_name + start_date` within one run's `fresh` list, keeping the
  first-seen `request_id`; both `runAlerts()`'s legacy-watch loop and `processOneSub()`'s
  subscription path call it right after computing `fresh`. `markSeen()` still marks every
  fetched row's own `request_id` (not just survivors) so a since-deduped duplicate's id
  doesn't resurface as "new" on a later run.

## Awards published outside the City Record — registry drives sweep, join, and claim

- **One data-driven registry, not scattered conditionals.** `AWARD_SOURCE_REGISTRY`
  (`external_awards.js`) maps each City Record agency that files NO awards in `dg92-zbpx` to one
  of three verdicts: `checkbook-nycha` (exact PIN join, NYCHA only), `abo` (fuzzy vendor+date join
  against a NYS Authorities Budget Office dataset on data.ny.gov, keyed by `authority_name`), or
  `absent` (verified: no open dataset publishes it). Every entry was verified live against the
  source. The registry drives all three of: which agencies are swept, the join precision, and the
  coverage claim the empty state makes. The four ABO datasets: `8w5p-k45m` (local authorities),
  `d84c-dk28` (local dev corps), `ehig-g5x3` (state authorities), `p3p6-xqr5` (IDAs — none of our
  gap agencies match it). To add coverage: verify a source returns a real dated record for the
  agency, then add the entry.
- **Dual-implemented, hand-synced** (same convention as `lib/prior_cycle.mjs`/`lib/lineage.mjs`):
  the client copy is `external_awards.js`, the worker copy `worker/src/lib/external_award.mjs`.
  `test/external_awards_registry.test.mjs` cross-checks them and fails on divergence — change one,
  change both.
- **Precomputed, served, not live-fetched** (the #68/#69 pattern). ABO sources: a WEEKLY-gated
  cron (`refreshAboAwards`, gated inside itself via `award:meta:last_refresh` KV — the sources
  refresh ~annually) pulls each authority's recent awards in bulk and caches them per source in KV
  (`award:<dataset>:<authority>`) with the dataset's own `rowsUpdatedAt` refresh date. NYCHA: one
  Checkbook `Contracts_NYCHA` request PER NOTICE (the WAF blocks per-PIN fan-out, so NEVER a bulk
  backfill), ranked by `rankNychaAwardCandidates` (exact PIN + contract date strictly after the
  solicitation — short NYCHA PINs are reused, so PIN alone is not enough), cached in D1
  (`external_award_matches`, migration `0003`), compute-on-miss + bounded cron pre-warm of
  freshly-ingested NYCHA solicitations (`ingest.mjs`'s `nychaRequestIds`). `GET /externalaward?id=`
  (per notice) or `?agency=` serves one coverage-shaped response; `externalAwardForNotice` and
  `showAgency` each read it in one `workerFetch`.
- **Exact and fuzzy stay visually AND verbally distinct.** An exact NYCHA match renders a confident
  `.box.award` chain box; a fuzzy ABO set renders a `.timeline` labeled "possible awards, matched
  by vendor and award date" with the source link + refresh date — a fuzzy result is never asserted
  as a confirmed award (the `matchEvidence()` honesty posture).
- **Empty state is registry-backed** (`agencyAwardsNote`, both `noticeAgencyBar` and
  `agencyProfileBar`): covered → names the source; verified-absent → "not published in any open
  dataset CROL-List knows of"; unknown agency → the pre-existing soft hedge
  (`agency_awards_unavailable_note`). All these strings are script-rendered via `t()`, so they do
  NOT affect the reading-level ratchet (the extractor drops `<script>`).
- **Fixtures**: `test/external_awards.test.mjs` (client render + registry), `worker/test/
  external_award.test.mjs` (endpoint + cron, one fixture per class boundary: exact NYCHA, fuzzy
  source, verified-absent, covered-with-zero-rows, malformed rows). The hermetic stray-English
  guard opens the SCA agency profile and requires the `#external-awards-content` panel — the
  worker `/externalaward` route is stubbed in `i18n_fixtures.py` to keep it guard-covered.

## Digest match evidence — why a keyword-matched item is in the digest at all

- **`matchEvidence(title, description, terms)`** is a pure, dual-implemented function (once as
  an export in `worker/src/lib/digest.mjs` for the emailed digest, once inline in index.html
  next to `digItemHTML` for the on-page preview — same logic, no cross-boundary import, mirrors
  the existing SODA-path/D1-path "must agree" posture elsewhere in this file) that finds which
  keyword actually matched and where, so a coincidental-looking notice never appears with
  nothing explaining it. Field priority: title (highlight in place) → description
  (`additional_description_1` / D1's `description`, a one-line snippet, term emphasized) →
  `unknown` (matched via a field this digest doesn't fetch — SODA's `$q` also searches
  contact/method columns — names the bare term rather than showing nothing). Returns `null` for
  amount/name-only watches (bigaward, entity) that have no keyword to explain in the first
  place. Real fixture: an "education" alert once surfaced "NOS - Equity Index Investment
  Management Products" (a Comptroller pension-fund notice) with no visible reason — the hit was
  in the description, which names the Board of Education Retirement System.
- **Rendering is per-surface, not shared**: `titleHtml()`/`evidenceLineHtml()` in alerts.mjs
  (HTML-escaped, inline-styled `<mark>` for email-client safety, `emailT()`-translated) vs.
  `digTitleHTML()`/`digEvidenceHTML()` in index.html (unescaped, matching this file's existing
  title-rendering convention, `t()`-translated via `digest_match_snippet_html`/
  `digest_match_unknown_html`). `worker/src/lib/i18n.mjs`'s `EMAIL_STRINGS` only carries en/es
  (that catalog's existing, narrower scope — see `SUPPORTED_LANGS` in `subscriptions.mjs`); the
  front-end's `digest_match_*_html` keys ship in all ten `SHIPPING_LANGS` like everything else
  in `i18n.js`. Two different i18n systems, two different coverage bars — not a gap.
- **Scope decision: rezoning (ZAP) items get no match evidence.** ZAP rows have their own shape
  (`project_name`/`project_brief`, not `short_title`/`additional_description_1`) and the
  reported failure was a City Record procurement notice — extending evidence to `land` watches
  is future work, not silently dropped.
- Wired into `additional_description_1` at three fetch sites that previously didn't select it:
  `compile.mjs`'s `CR_SELECT`, `alerts.mjs`'s legacy-watch `runWatch()`, and `compile_d1.mjs`'s
  `toDigestRow()` (mapped from D1's `description` column, which `ingest.mjs` already stored).

## Digest deep-links — every emailed item opens its why-matched view (w12-12)

- **The gap this closes**: a digest email's notice link carried nothing about the watch that
  surfaced the item — following it landed on the plain `#notice/<id>` permalink with no sign of
  why it matched or what was searched for. Fix: the originating watch's own `{lens, filter}`
  rides in the link's URL, so `showNotice()` re-renders the same Matched-evidence highlighting
  (w12-03) and interpretation echo (w12-02/09) the subscriber would see running the watch
  themselves — no server-side state, nothing identifying beyond the notice id itself.
- **`encodeWatchFilter(lens, filter)`** (`worker/src/lib/filter.mjs`) clamps a subscription's
  already-`sanitize()`d filter through the schema again (defense in depth), drops null/false/
  empty fields, and returns `encodeURIComponent(JSON.stringify({lens, filter}))` — `null` when
  there's nothing worth carrying or the lens isn't registered. `alerts.mjs`'s `processOneSub()`
  computes it once per send and threads it into `subDigestHtml()`'s per-row `noticeLink`, which
  appends it as `?w=` on the existing `/r/<kind>/<id>` count-only redirect (`src/redirect.mjs`);
  the redirect only bounds the value's shape (`validWatchParam` — length + printable-ASCII) before
  re-embedding it in `noticeUrl(id, w)`'s target hash, `#notice/<id>?w=<value>` — same "?tab="
  second-hash-segment idiom `agencyHref()`/`vendorHref()` already use. Legacy config watches
  (`alerts.config.json`, `runWatch()`/`digestHtml()`) are out of scope — they link straight to
  City Record, never through `/r` or CROL-List's own notice view, so there's no link to carry a
  filter on. Rezoning digests are also out of scope by construction — they link to ZAP directly.
- **Client side**: `parseNoticeHashSegment(rest)` (index.html, next to `applyHash()`) splits a
  `#notice/<id>?w=<...>` hash into `{id, watch}` — `watch` is `null` for the pre-w12-12 bare-id
  shape (unchanged behavior) or a malformed/truncated/oversized `?w=` value.
  `parseWatchParam(raw)` does the actual JSON parse + validation, returning `null` on anything
  that doesn't parse as `{lens, filter}` with a registered lens — the caller then falls back to
  the plain notice view, never a broken page. `DEEPLINK_LENSES`/`deeplinkClampField`/
  `sanitizeDeepLinkFilter` are a **hand-synced client port** of `worker/src/lib/filter.mjs`'s
  `LENSES`/`clampField`/`sanitize` (same dual-implementation convention as
  `external_awards.js`/`lib/external_award.mjs`) — change one, change both;
  `test/deeplink_watch.test.mjs` cross-checks them against the real worker module and fails on
  divergence. Reusing `sanitize()`'s clamp-to-schema behavior is what makes an unexpected extra
  key or an out-of-range value fail soft (silently dropped) rather than break rendering.
- **`showNotice(id, watch)`** (previously `showNotice(id)` — the second arg is optional and
  `undefined` for every other call site) computes `matchEvidence(title, matchText(r),
  watch.filter.keywords||[])` and splices a `<mark>` into the existing `<h2 class="rolename">`
  wrapper in place (not a `digTitleHTML()`/`enTitle()` swap, to avoid touching the tag's existing
  lang/dir markup) plus `digEvidenceHTML(ev)` right below it — same two functions the Money-tab
  row list and digest preview already use. `.dev`'s CSS selector gained `.panel .dev` (it was
  previously scoped to `.digitem`/`.row`/`.fcard` only) so the evidence line renders styled in
  the permalink view. `watchChipsFor(lens, filter)` renders the "We understood this as"-style
  echo (reusing `NL.alerts.chips()` for the money lens — it already covers the full money-shaped
  schema — and `NL[lens].chips()` for property/rules/meetings) into a new `deeplink_watch_context_label`
  banner (`.nlunderstood`, all `SHIPPING_LANGS`). **Entity watches (match by name, not keyword)
  deliberately render no chips or evidence** — the agency/vendor name is already shown plainly
  elsewhere on the notice, so there's nothing hidden to explain; same posture `matchEvidence()`
  already takes for entity subs in the emailed digest.
- **Known, documented, out-of-scope gap carried forward, not introduced here**: `NL.alerts.chips()`
  and `nlFeed()`'s chip builders bake connector words ("agency", "about", "amount ≥", "due within")
  as literal, untranslated English — a pre-existing gap noted in the w12-09 section above,
  unexercised by any hermetic guard walk. `watchChipsFor()` reuses these functions as-is rather
  than fixing them, so this card's guard coverage (`13_stray_english.py`'s `run_notice_deep_link`)
  intentionally stays on the bare `#notice/<id>` walk (no `?w=`, `watch` is `null`, no chips
  render) — extending it to a populated `?w=` would surface that pre-existing gap and fail CI for
  a reason outside this card's scope. `deeplink_watch_context_label` itself is fully translated in
  all ten `SHIPPING_LANGS` regardless.
- **Fixtures**: `worker/test/filter.test.mjs` (`encodeWatchFilter`), `worker/test/stats.test.mjs`
  (`noticeUrl`/`validWatchParam`/`handleRedirect` passthrough), `worker/test/
  digest_match_evidence_render.test.mjs` (the card's anchor fixture — the real "education" watch
  surfacing a Comptroller pension-fund notice, run end-to-end through `runAlerts()` to prove the
  sent email's own link carries the right `?w=`), and `test/deeplink_watch.test.mjs` (the client
  half: the same anchor fixture, a multi-filter watch, a keyword-only watch, a malformed/truncated
  fragment, and a fragment with unexpected extra keys — plus the worker/client `sanitize()`
  cross-check).

## Match evidence in every lens list, not just the Alerts ask preview (w12-03)

- **The same `matchEvidence()`/`digTitleHTML()`/`digEvidenceHTML()` trio above is now called
  from a small per-lens row builder in every result list**, not only `digItemHTML()`'s Alerts
  preview: `moneyRowHTML()` (Money/Contracts), `landRowHTML()` (Land — the scope decision above
  is about `digItemHTML()`'s emailed/on-page ALERTS preview specifically, which still skips ZAP;
  the Land TAB's own list is a separate call site and does get evidence), `feedCardHTML()`
  (Property/Rules/Meetings, shared by `renderFeed()`), `roleRowHTML()` and `personRowHTML()`
  (Staffing). Each is a pure function (row/person + terms in, HTML string out) reusing the exact
  mechanism rather than a parallel one — same pattern as `digItemHTML()` itself. `terms` is `[]`
  for plain browsing (no keyword typed), which makes `matchEvidence()` return `null` and every
  row render identically to before this existed.
- **`personRowHTML()`'s row is a PERSON, not a notice** — Staffing's "Changes in Personnel"
  results group multiple notices under one person, so evidence can't be computed against a
  single title+description. Each grouped action now carries its own notice's text
  (`pSearchPeople()`'s `.push()` adds a `text` field), and `personRowHTML()` walks them for the
  first one whose evidence field isn't `"unknown"`.
- **`landRowHTML()`'s terms are conditional on HOW the row got there**, not just whether `#lkw`
  is non-empty: `landSearch()` resolves a typed value to a geocoded BBL/block first when it can,
  and that path filters ZAP rows via a BBL join, not `$q` text matching — showing match evidence
  in that case would misrepresent a location lookup as a keyword hit. `landRenderList(kw,
  kwIsTextMatch)`'s second argument (`!block` at the call site) gates this.
- **`matchText(r)` widens the haystack beyond `additional_description_1`** to also include
  `other_info_1` — real field case (request_id 20260709010, a DYCD COMPASS afterschool-program
  award): its `additional_description_1` is blank, and the actual explanatory text (which is
  what a real "childcare" search matches on, confirmed live against the SODA dataset) lives
  entirely in `other_info_1`. Without this, `matchEvidence()` would report `field:"unknown"` for
  a notice that plainly does explain itself — just not in the one column being read. `SELECT`
  (Money/Alerts/notice-detail — they all extend the same const) and `FEED_SELECT` (Property/
  Rules/Meetings) both now fetch `other_info_1` alongside `additional_description_1`; Land's ZAP
  dataset and Staffing's role search have no equivalent field. This front-end widening has no
  counterpart yet in `worker/src/lib/digest.mjs`'s emailed-digest `matchEvidence()` — that stays
  `additional_description_1`-only, a known asymmetry, not a bug, since the emailed digest was out
  of scope for this pass.
- Characterized in `test/lens_match_evidence.test.mjs` (same brace-matching extraction pattern
  as `test/match_evidence.test.mjs`/`test/forecast_render.test.mjs`), pinned against the real
  20260709010 fixture content pulled from the live SODA dataset.

## Echo the complete interpretation, incl. lens-implied parts + contextTerms (w12-09)

- **Field evidence (site owner, production), two lenses, same class**: on Land, the suggestion
  "rezonings in Queens" produced NO "Matched:" evidence and an echo reading "We understood this
  as: in Queens" — dropping "rezonings". On Property, "police department property" echoed "We
  understood this as: agency Police Department" — dropping "property". Root cause was **not** a
  chip-vs-typed-ask divergence — a `.trychip` click and the Ask box's Go/Enter both resolve
  through the identical `nlTranslateLens(lens)` (see `renderNLSamples()`/`injectNLBoxes()`), so
  whatever `NL.<lens>.chips()` says is what every entry path echoes. The real gap: **the "kind"
  of result (rezonings / property disposals / rules / meetings) has no field in any of these
  lenses' filter schemas** — it's lens-implied (the tab's own query is hardcoded to one
  `section_name`/dataset, so there's nothing else the results could be), so a query resolving to
  e.g. `{boro:"Queens", keywords:[]}` or `{agency:"NYPD", keywords:[]}` left `chips()` with only
  the extracted field to show.
- **Echo fix — unconditional lens-implied leading chip**, same shape for all four lenses:
  `NL.land.chips()` always renders a first chip (`t("nl_chip_land_kind")`, all `SHIPPING_LANGS`,
  using the pinned `glossary.json` `rezoning` term); `nlFeed()` (shared by Property/Rules/
  Meetings) always renders `tSection(SECTIONS[key].section)` first — the SAME translated label
  already shown in the Today strip/agency profiles, so no new i18n keys were needed for those
  three. Money/Alerts don't need this (no single implied notice type — `noticeType` already
  renders when set); People already states the lens-implied part via its existing `lookupType`
  chip.
- **Evidence fix — `matchEvidence(title, description, terms, contextTerms)`.** A 4th param for
  terms that describe the query but were never sent to SODA as `$q` (Land's borough — a
  structured `borough=` filter, never folded into `#lkw`). `contextTerms` are folded into the
  same title/description search as `terms`, but **never fall through to the `{field:"unknown"}`
  guess** — that fallback's whole premise ("SODA's `$q` matched somewhere we didn't fetch")
  doesn't hold for a field that was never full-text searched. Net effect: a boro-only Land query
  now shows real "Matched: …Queens…" evidence when a project brief happens to name the borough
  (common in ZAP data), and honest silence — never a guessed "unknown" — when it doesn't.
  `landRenderList(kw, kwIsTextMatch, boro)` gained a third param threading `$("#lboro").value`
  through as `contextTerms`, kept separate from keyword-derived `terms` throughout (never merged
  before the call), so the "unknown" fallback still only ever fires for a genuine keyword miss.
  **Property/Rules/Meetings didn't need this half** — `nlFeed().apply()` already folds `f.agency`
  straight into `#<key>kw`/`$q`, so an agency-only feed query (the "police department property"
  case) already produced real evidence (a `${r.type_of_notice_description}`/title/description hit
  on the agency name, or the `unknown` fallback) before this card — only the echo was missing
  "property".
- **Real fixtures, live-pulled 2026-07-15 from the ZAP dataset (hgx4-8ukb)**: `P2012Q0008` ("XU
  HOTEL AND RESIDENCES") whose `project_brief` literally ends "...Flushing, CD7, Queens." (proves
  the contextTerm path finds a real hit); `P2012Q0316` ("WOODWARD AVENUE REZONING"), a sibling row
  from the identical borough query whose brief never says "Queens" (proves no `unknown` guess gets
  invented for it) — both in `test/lens_match_evidence.test.mjs`.
- **Two more field cases, same session, same class — the echo-rendering half**: "rezonings in the
  Bronx" echoed "We understood this as: in Bronxall · incl. closed"; "environmental protection
  land" (Property) echoed "about environmental protection / land". Neither is a missing chip —
  both are how the chips *combine*.
  - **`nlTransHTML()` joined chips with `chips.join("")`** — zero characters between adjacent
    `<span class="qchip">` elements. CSS margin still visually separates the pills, so this only
    ever showed up in anything reading `textContent` (a screen reader's accessible-name
    computation for the `role="status"` line, copy/paste, a test assertion) — "Bronx" and "all"
    ran together as the single word "Bronxall". Fixed to `chips.join(" ")`; every call site
    (`nlTranslateLens()`, `nlTranslate()`, `resolveMoneyNarrow()`, `aPreview()`'s zero-match
    branch) already filters falsy chips before calling it, so the extra space never doubles up.
  - **The `status==="all"` chip was raw filter jargon**, `<b>all</b> · incl. closed` — an
    abbreviation (banned by `nyc_copy_lint.py`'s own rules, but this string was invisible to
    every static gate, since it lives inside a `<script>` block, never in rendered static HTML —
    same class of guard-blind-spot the reading-level ratchet note documents elsewhere in this
    file). Replaced with a real i18n key, `nl_chip_land_status_all` ("including closed
    rezonings"), all `SHIPPING_LANGS`.
  - **`stripImpliedKeywords(lens, keywords)`** + `LENS_IMPLIED_WORDS` (index.html, just above
    `const NL`) filters a lens's own type-word out of the "about" keyword chip (and the applied
    search) — "environmental protection land" used to echo `about environmental protection /
    land`, with "land" riding along as if it were a real topic next to "environmental
    protection", inconsistent with how the SAME word gets dropped and stated distinctly via the
    lens-implied chip everywhere else. Applied to all four lenses' `chips()`/`apply()` — Land's
    own extraction occasionally puts "rezoning" in `keywords` too (confirmed live via the
    on-device fallback parser), which used to double up on the leading chip
    ("rezonings · about rezoning") before this.
  - Both fixes and their exact-string before/after are pinned in `test/nl_echo_completeness.test.mjs`.
- **Entry-path parity** is structural, not a separate reconciliation step: since chip-click and
  Ask both call the one `nlTranslateLens(lens)`, fixing `NL.land.chips()`/`nlFeed().chips()` fixed
  every entry path at once for both reported lenses. `test/nl_echo_completeness.test.mjs` pins the
  chip content per lens (incl. the verbatim "rezonings in Queens" and "police department
  property" field cases) AND greps `renderNLSamples()`/`injectNLBoxes()` to guard the wiring
  itself — a future change that special-cased chip clicks to bypass `nlTranslateLens()` would
  break this test even before it broke the echo.
- **Known, out-of-scope gap left as-is**: `NL.alerts.chips()`'s `noticeType` chip
  (`f.noticeType==="award"?"awards":"open RFPs"`) is bare, untranslated English — the same class
  of chip-string issue, but a pre-existing one, unexercised by any hermetic guard walk (the NL
  ask/chip interpretation panels aren't in `test/functional/13_stray_english.py`'s walk at all
  today, a separate coverage gap from this card's scope). Not touched here to keep this card's
  diff to the reported class (lens-implied chips + contextTerms), not a sweep of every chip string.

## Ask translation — paraphrase robustness + the interpretation echo (w12-02)

- **Field evidence, 2026-07-14 user interview**: the ask box "required very specific wording"
  — paraphrases of the same request failed, and the failure was a silent empty result with no
  explanation. Two independent fixes, both scoped to `worker/src/nl.mjs`/`filter.mjs` (the
  translation) and index.html's ask flow (the echo UI) — not the alert-builder/preview plumbing
  itself, which is unrelated.
- **`filterConfidence(lens, filter)`** (`worker/src/lib/filter.mjs`) is a pure function of
  `sanitize()`'s own output — `"low"` when the sanitized filter carries no narrowing signal at
  all (empty keywords, every other lens field still null/false/empty), else `"high"`. No extra
  model call, no schema change — stays inside the existing Haiku metering. `/nl`'s response
  gains a `confidence` sibling field (additive; existing consumers unaffected).
- **Prompt robustness** (`nl.mjs`'s `FIELD_DEFS`/`buildSystem`): explicit paraphrase-tolerance
  instructions — normalize currency/number format variants, convert days/weeks/"next quarter"
  into months (round up), normalize lay synonyms to the term a City agency notice would
  actually use (`school` → `education`), and never invent a specific duration from a vague
  phrase with no stated number ("closing soon" stays `months: null` — a deliberate,
  test-pinned conservative-parsing decision, not a gap).
- **Real paraphrase-tolerance can only be characterized live** (it's model behavior, not
  something `sanitize()`/mocked-fetch unit tests can prove) — the committed fixture set lives
  in `worker/e2e/nl.mjs`'s `PARAPHRASES` array (>=6 real-wording variants of "education
  contracts over $200k due in 3 months", asserting the same `minAmount`/`months`/keyword
  match), run via `npm run test:live` (costs a few Haiku calls, not part of default CI — same
  posture as the rest of that file). `worker/test/nl.test.mjs` covers the offline-testable
  half with a mocked Anthropic response: `sanitize()`/`filterConfidence()` behave the same
  regardless of input phrasing, and the pre-existing fail-soft contract (empty text/bad
  lens/no key/non-ok response/no tool_use block) is unchanged.
- **Known, documented, out-of-scope tension**: `compile.mjs`'s `compileSub()` can't actually
  honor both `minAmount` and `months` on the same money/alerts filter at once — an amount
  bound (with `noticeType` unset) resolves to the Award branch, which ignores `months`
  entirely (only the Solicitation branch applies a due-date window); a `noticeType:
  "solicitation"` override loses `minAmount` instead (Solicitations carry no `contract_amount`
  in this dataset). The canonical fixture's phrase names both an amount and a deadline in one
  breath, which the query schema genuinely can't represent as a single constraint today. This
  card's job was the NL→filter *extraction* step behaving identically across paraphrases —
  fixing what the compiled query does with a filter that names both dimensions is a separate,
  future card.
- **Interpretation echo (index.html)**: `nlTransHTML(chips, forSel, weak)` renders the existing
  "We understood this as: …chips" status line plus an always-present "Edit search" button
  (`.mini.nledit`, `data-nlfor="<input selector>"`) — one delegated `document` click listener
  (near `injectNLBoxes()`) refocuses whichever input the button names, so no per-render
  listener wiring and no duplicate-id risk across the money box (`#nltrans`) and every other
  lens's box (`#nltrans-<lens>`, all present in the DOM at once — see `injectNLBoxes()`).
  `weak` (little/nothing understood beyond money's mandatory notice-type chip, or zero search
  results) wraps both in a visible `.nlunderstood-weak` callout instead of leaving them as
  quiet status text — this is what satisfies "never a bare empty result": `nlTranslate()`
  overwrites `#list`'s generic `nothing_found` empty state with the echoed chips + edit button
  when a search comes back with zero rows. The alerts lens gets the same treatment inside
  `aPreview()`'s existing zero-match branch, gated to `$("#awatch").value === "moneynl"` (an
  ask-driven watch) — reuses `NL.alerts.chips()` on `aLensFilter().filter` rather than
  threading the original parse result through, so it costs no new state.
  **Sharp edge hit while writing this**: `test/standards/nl_input_clarity.py` statically
  greps `nlTransHTML()`'s source between its opening `{` and the FIRST `}` it finds — any
  `${...}` template expression placed before the required `role="status"`/`nl_understood_label`
  text pushes that first `}` earlier and silently drops both out of the captured region. Keep
  any new dynamic (`${}`) content in that function's template AFTER those two required
  substrings, or build it as a separate string joined with `+`/template-literal-without-braces
  rather than interpolated inline before them.
- **New i18n keys**: `nl_edit_btn`, `nl_no_matches_note` — two keys, all ten `SHIPPING_LANGS`,
  same machine-drafted provenance as everything else in the catalog.

## Past winners strip — rolling up chainHTML()'s own award stages (w12-05)

- **Field evidence**: readers could walk the paper-trail chain (`chainHTML()`) stage by stage,
  but wanted the rolled-up view — "awarded to X in 2024 ($2.1M), Y in 2023 ($1.9M)" — instead of
  opening every box in the chain to compare cycles by hand.
- **`pastWinnersHTML(chain)`** (index.html, defined just above `chainHTML`, appended to its
  return value) filters the same chain array `chainHTML()` already renders down to award-type
  stages (`type_of_notice_description` is `"Award"` or `"Intent to Award"`), lists each one's
  year/vendor/amount most-recent-first, and renders nothing when fewer than two such stages
  exist — a single award has nothing to roll up against yet, and `chainHTML()`'s own box already
  shows it in full. No new fetch, no worker dependency: same posture as `cadenceEstimate()`
  (w12-04) — pure arithmetic/filtering over `loadChain()`'s data already on hand client-side.
  Reuses the existing `.timeline`/`.tl`/`.tldate`/`.tlreason`/`.tlsal` row CSS (the same classes
  the agency/vendor profile's notice lists use) rather than inventing new styles.
- **A stage on record with no `vendor_name` is shown honestly, not omitted** — the row falls
  back to `t("past_winners_vendor_unlisted")` ("Award, vendor unlisted") instead of silently
  dropping that cycle, which would understate how many rounds the contract has actually been
  through. Real fixture proving this happens: NYC DHS PIN base `07106R0045CNV` ("Homeless
  Shelter"), whose third stage (`...R002`) is on record with neither a `vendor_name` nor a
  `contract_amount` field at all.
- **Real fixtures, both queried live from the SODA dataset (dg92-zbpx), not invented**: the DHS
  vendor-unlisted case above, and NYC DOE PIN base `04021B0003005` ("Assessments for Special
  Education Services") — a real 3-cycle chain (2022/2024/2026) where the same vendor's legal-
  suffix changed (LLC → PLLC) between rounds, pinned in `test/past_winners.test.mjs` alongside
  the DHS fixture.
- **Wiring is a single line inside `chainHTML()`** (`html += pastWinnersHTML(chain);` before its
  `return`), so both existing call sites (the money-tab detail pane and `showNotice()`'s
  permalink pane, which itself only calls `chainHTML()` at all when `chain.length>1`) get the
  strip for free with no call-site changes — same integration pattern PR #52's `cadenceHTML()`
  uses for the same function.

## Lineage indicator — surfacing chain history on Money result rows (w12-10)

- **Field evidence**: the site owner, already aware `cadenceEstimate()` (w12-04) and
  `pastWinnersHTML()` (w12-05) had shipped, could not find a live notice exhibiting either
  without being handed fixture PINs directly — both only reveal themselves after opening a
  notice that happens to have a chain. `computeLineageBadgeCounts()`/`loadLineageBadges()`
  (index.html, right after `renderList()`) surface the same signal one level up: a compact
  `<span class="tag renewal">N cycles</span>` badge on the Money result row itself, for any
  notice whose PIN chain has `>=2` Award/Intent-to-Award stages — the exact same threshold
  `pastWinnersHTML()` already uses to decide whether to render, so the badge never promises
  more than clicking through will show.
- **Cost: ONE batched SODA request per `renderList()` call, not one per row.** Every visible
  row's chain key (`lineageChainKey()` — `pinBase()`-widened PIN + agency, identical widening
  to `loadChain()`'s own) is deduped and folded into one `$where` clause of ORed conditions
  (`lineageBatchClauses()`), restricted to Award/Intent-to-Award stages. A results page never
  exceeds 40 rows (`search()`'s own `$limit`), so this is at most 40 ORed clauses in one GET.
  It fires after the list has already painted (same fire-and-forget-then-patch-in pattern as
  `loadMethodFacet()`), patching each qualifying row's pre-rendered `.lineage-slot` marker once
  counts land — never blocks or slows the list's own render.
- **`LINEAGE_MAX_STAGES` (15) is a second honesty gate beyond `isBlanketChain()`, added after
  a real production find while manually verifying this feature**: PIN `82626R0001001` (agency
  "Environmental Protection") is an ordinary, unrelated single Award whose own digits happen to
  end in something `RENEWAL_SUFFIX_RE`/`pinBase()` also matches, widening it to base `"82626"`
  and prefix-matching ~180 unrelated contracts sharing that agency's fiscal-year PIN prefix.
  `isBlanketChain()` doesn't catch this — the false-widened set mixes Award/Intent-to-Award/
  Solicitation stages, so its "every stage is Award" check is false — so without a ceiling the
  batch would render a nonsensical "180 cycles" badge. This is a **pre-existing `pinBase()`
  over-widening gap that also affects `chainHTML()`/`pastWinnersHTML()` on the detail view
  today** (out of scope to fix here — worth its own future card); `LINEAGE_MAX_STAGES` is a
  narrower, more conservative gate specific to this new surface: every genuine chain fixture
  documented in this file (cadence/past-winners sections above) tops out at 6 real stages, so a
  widened match past 15 reads as a PIN-prefix collision, not a legitimate history, and is
  treated the same as "uncertain" — no badge. Pinned in `test/lineage_indicator.test.mjs`
  against that exact live PIN.
- **The batch's own `$limit` is generous (2000, not ~40)** for a related reason: SODA applies
  `$limit` to the WHOLE combined query, with no per-clause guarantee, so a single widened key
  colliding with many unrelated PINs could otherwise silently crowd out and undercount a
  different, genuine chain sharing the same batch call. Still one request either way.
- Scoped to the Money/Contracts list only (`moneyRowHTML()`/`renderList()`) — Land/Property/
  Rules/Meetings/Staffing notices have no PIN/award-chain concept to surface.

## Near-match prior cycles — the exploratory "maybe" reveal (w12-18)

- **A second, looser tier below `priorCycleAwards()`'s own strict cross-PIN matcher**
  (`rankPriorCycleCandidates()`, documented inline in index.html) — that matcher requires a
  MAJORITY title-word overlap (score>=0.5) specifically to avoid surfacing concurrent-RFP
  siblings as false "renewals," which also silently drops a real prior round that was simply
  retitled between cycles (an address or permit code swapped into the title, "Renewal" dropped).
  `rankNearMatchCandidates()` (index.html, right after `priorCycleAwards()`) surfaces those as
  explicit, caveated maybes, hidden behind a `<details>` reveal ("Look for looser possible
  matches" — deliberately hedged, since the lazy query can't know its result until clicked) on
  the strict matcher's own empty state — never rendered eagerly, never touching the
  confident chain/cadence/past-winners/lineage-badge surfaces above, which all read
  `chainHTML()`'s own `pinBase()`-widened chain, never this function's output (honest-data
  convention).
- **Guarded disclosure + case-specific empty state (crol-nearmatch-ux, 2026-07-16)**: the reveal
  used to render unconditionally on the empty state, so notices that structurally couldn't
  corroborate anything spun through a live SODA query and then said "nothing found."
  #67 gated it on exactly what the near tier hard-requires: a `start_date` (query and gap filter
  are both bounded to strictly-earlier awards), >=2 significant title words (the 2-word `$q` can't
  form with fewer), and a corroborating signal that could actually fire — a usable PIN whose
  renewal-stripped base reaches `NEAR_MATCH_PIN_PREFIX_MIN_LEN` chars, or a positive
  `contract_amount`. (#67 did this with a predictive local `nearMatchPossible()`; the Phase 1b
  swap below deleted that predicate — the `/priorcycle` endpoint now pre-computes the near set, so
  the reveal simply shows when `near.length>0`.) Both "none"
  call sites route through `priorCycleNoneHTML(r, eligibleCount, near)`, which also replaced the old hedged
  `prior_cycle_none_note` with the one specific reason the code can distinguish: too-generic
  title (`prior_cycle_none_generic`), zero prior-eligible candidates
  (`prior_cycle_none_no_candidates_html`), or near-misses below the strict 0.5 bar
  (`prior_cycle_none_low_confidence_html`). "Prior-eligible" is `priorCycleEligibleCount()` —
  `rankPriorCycleCandidates()`'s own pre-score filters (self/agency/own-PIN/strictly-earlier/
  >=180-day gap), NOT raw fetched rows: the strict `$q` has no date bound and matches the
  notice's own title, so its rows routinely include the notice itself, later awards, and
  same-round siblings (the HPD fixture's one returned row is itself). The interpolated `{agency}`
  is an English data island wrapped `lang="en" dir="ltr"` per the RTL bidi-isolation convention —
  hence the two keys' `_html` suffix. Gate + case selection pinned in
  `test/near_match_prior_cycles.test.mjs`.
- **Server-side precompute shipped (Phase 1a, #68) and the client swap shipped (Phase 1b).**
  `worker/src/lib/prior_cycle.mjs` is a hand-synced dual implementation of the strict + near
  ranking functions above (same convention as `lib/lineage.mjs`), used by
  `worker/src/prior_cycle.mjs` to run the same two SODA queries server-side, cache the
  `{strict, near, eligibleCount}` result in the D1 `prior_cycle_matches` table (migration
  `0002`, compute-on-miss; the daily cron pre-warms freshly-ingested Award notices via
  `ingestNotices()`'s returned `awardRequestIds`), and serve `GET /priorcycle/<request_id>`
  (public, edge-cached 5 min). index.html's `priorCycleAwards()` now reads that endpoint in one
  `workerFetch()` — the strict rows, the pre-loaded near set (so the "look for looser matches"
  reveal shows only when `near.length>0`, no lazy second query), and the server-computed
  `eligibleCount` (which the client no longer recomputes, since it stops fetching the strict
  rows). `priorCycleEligibleCount` is therefore WORKER-ONLY now — the client copy was deleted in
  the swap. The endpoint also returns an `ok` flag: on a worker/SODA outage the client renders
  nothing (the pre-swap say-nothing posture) instead of a confident "no earlier awards", and the
  failure is not cached (`Cache-Control: no-store`). A `<2`-significant-word title still
  short-circuits locally in `priorCycleAwards()` with no round trip. Any change to the
  title-word/gap/score/corroboration heuristics must still land in BOTH copies of the ranking
  functions; `worker/test/prior_cycle_lib.test.mjs`'s cross-check extracts the client functions
  from index.html and fails on divergence.
- **A near-match needs the loosened title score PLUS at least one of two corroborating
  signals** — how much of the (renewal-suffix-stripped) PIN's prefix the two notices share
  (`pinPrefixShared()`, floor `NEAR_MATCH_PIN_PREFIX_MIN_LEN`=8) or whether their contract
  amounts are within `NEAR_MATCH_AMOUNT_RATIO_MAX`=3x of each other. A weak title score ALONE
  is too noisy to show — same-agency, unrelated-topic pairs routinely share one generic
  location/facility word (verified live: two unrelated 2000s-era Correction contracts, a roofing
  job and a fence-alarm repair, both score 0.43 purely from sharing "system"/"Rikers"/"Island").
  Same >=180-day gap floor as the strict matcher throughout (a weak title match at a short gap
  still reads as a same-round sibling, not a prior cycle) — the acceptance criteria only calls
  for loosening the title/PIN/amount dimensions, not the gap.
- **PIN-prefix proximity needed a real threshold, not the intuitive one.** A raw 6-character
  shared prefix (5-digit NYC agency code + 1-letter method code) is common to nearly EVERY
  contract a given agency issued in a given decade and proves nothing — verified live against
  700+ real same-agency Correction pairs, nearly all topically unrelated, all sharing exactly 6
  characters (`"072200…"`). `NEAR_MATCH_PIN_PREFIX_MIN_LEN` is set to 8 specifically to clear
  that noise floor.
- **Cost story: the near-match tier fires ONE extra SODA call, lazily, only on the reveal's
  first `<details>` toggle** (`wireNearMatchReveal()`) — never eagerly, never when the strict
  tier already found something. It can't just reuse the strict tier's own already-fetched rows:
  verified live that the strict search's own tightly-scoped 6-word `$q` (built from the notice's
  own title) starves out every OTHER candidate for an address/permit-code-heavy title — the
  real HPD fixture below returns exactly one row (itself) under that $q. The lazy query widens
  `$q` to the notice's own top `NEAR_MATCH_QUERY_WORDS`=2 significant words and bounds `$where`
  to `start_date < `this notice's own date (ordered most-recent-first), so the 50-row cap lands
  on candidates near this notice in time rather than the 50 most recent system-wide uses of an
  evergreen word like "demolition."
- **Real fixture, live-queried from the SODA dataset (dg92-zbpx)**: HPD's "IMMEDIATE EMERGENCY
  DEMOLITION OF 28 W 130th St, MANHATTAN (DM00121 E-6038R)" (2022, PIN `80622E0016001`) scores
  only 0.43 against its real prior round "IMMEDIATE EMERGENCY DEMOLITION" (2019, PIN
  `80619E0021001`, same vendor Granite Environmental, 994 days earlier) — below the strict bar,
  corroborated here by amount (ratio ≈2.4), not PIN prefix (only 3 shared chars). Correction's
  "MARINE ENGINEERING CONSULTING SERVICES" (2010) is the paired "reveal offers nothing" fixture
  — a genuine one-off with no earlier same-agency award sharing any significant title word,
  confirmed against both the strict AND the widened near-match query returning zero rows live.
  Both pinned in `test/near_match_prior_cycles.test.mjs`; one test (PIN-prefix-only
  corroboration) uses a constructed pair — no live pair combining a strong shared PIN prefix
  with an unusable amount signal turned up within this card's research budget, and the test
  says so rather than mislabeling synthetic data as observed.

## Verified, rotating suggestion chips (w12-08)

- **Field evidence**: under the money lens, the prefab suggestion chips "IT consulting RFPs"
  and "shelter services contracts" returned ZERO live results while "construction contracts
  over $500k" worked — a suggestion that leads nowhere reads as a broken site. Site owner
  decision: verify every suggestion against fresh data, and rotate the display set during the
  daily batch update so a no-result suggestion is never shown.
- **The chips being fixed are `.trychip`/`NL_SAMPLES`** (index.html, now
  `NL_SUGGESTIONS_FALLBACK` + the validated-set path below) — the sample queries under each
  lens's Ask box (`renderNLSamples()`), not the separate "Build an alert" panel's 3
  `.wandchip` quick-suggestions (`sugg_rezone_rivington`/`sugg_awards_1m`/
  `sugg_construction_rfp`), which are out of this card's scope.
- **Server side**: `worker/src/lib/suggestions.mjs` is the pure candidate pool + query builder
  — `SUGGESTION_POOL` (money/land/property/rules/meetings/alerts, ~26 candidates, each with a
  STABLE per-lens `idx` that is also its i18n key suffix, `sugg_<lens>_<idx>` — never renumber
  an existing one, only append), `MIN_SUGGESTION_RESULTS` (3 — "a handful", concrete), and
  `suggestionCountParams(lens, filter, todayISO)`, which reuses `compile.mjs`'s existing
  `compileSub()` (just swapping `$select` for `count(1) as n` and dropping `$order`/`$limit`)
  so a suggestion's honesty is judged by the IDENTICAL query shape a real click resolves to —
  no bespoke second query-builder to drift from it. `worker/src/suggest.mjs`'s
  `runSuggestionValidation(env)` (called from the 13:00 UTC `scheduled()` handler in
  `worker.mjs`, right after the D1 ingest step and before `runAlerts()`) resolves each
  candidate's text via `parseLensFilter()` — the same NL→filter core `/nl` itself calls — then
  counts live matches and stores the fruitful set (grouped by lens, with counts + a timestamp)
  in `ALERT_STATE` KV under `suggestions:validated`, alongside the other cron products
  (`fc:`/`plan:`). `GET /suggestions` (`handleSuggestions`) serves that JSON; 404s until the
  first successful cron run.
- **"people" is a documented, deliberate gap**: `compileSub()` has no case for it ("people
  isn't cron-replayable yet" — payroll-title counting needs different plumbing than every
  other lens, which all resolve to a Socrata/ZAP `$where` + count), so
  `suggestionCountParams("people", …)` returns `null` and it's never in the pool. Its 3 chips
  stay the pre-existing hardcoded `sugg_people_0/1/2`, unvalidated, unchanged.
- **Fail-soft, two layers**: one candidate's resolve/count failure is caught and skipped inside
  `runSuggestionValidation` (logged, not fatal to the run); if the WHOLE run comes back with
  nothing validated at all (Socrata or Anthropic down), the previous KV value is left
  untouched rather than overwritten with an empty set — a transient outage must never blank
  out yesterday's good chips. `worker.mjs`'s own try/catch around the call is only for
  something the pipeline didn't anticipate (e.g. a KV outage), same posture as the
  pre-existing checkbook/MOCS pipeline call just above it.
- **Client side** (index.html, same block that used to be `NL_SAMPLES`):
  `NL_SUGGESTIONS_FALLBACK` is the small, evergreen static subset shown before the worker
  responds or when it's unreachable — deliberately excludes money idx 1/2 (the two dead
  field-evidence examples) and carries its own live check, `worker/e2e/suggestions.mjs`
  (added to `npm run test:live`), which resolves each fallback candidate through the deployed
  `/nl` endpoint and fails if any returns fewer than `MIN_SUGGESTION_RESULTS` live rows today.
  `NL_SUGGESTIONS_VALIDATED` holds `GET /suggestions`'s `byLens` once `loadValidatedSuggestions()`
  fetches it (via the existing `workerFetch()` failover helper); `currentSuggestionIndices(lens)`
  prefers the validated set for a lens over the fallback, but only when it's non-empty — an
  all-fruitless validation day still shows the static subset rather than blanking the chips.
  `pickSuggestions(indices, displayCount, seed)` is the pure day-seeded rotation (`daySeed()` =
  whole days since epoch) — stable within a day, varies across days; kept as a standalone
  function (no `Date` inside it) specifically so `test/suggestions_render.test.mjs` can extract
  and test it deterministically, the same brace-matching-extraction convention as
  `forecast_render.test.mjs`/`cadence_estimate.test.mjs`.
- **Sharp edge — the fallback idx lists are duplicated by hand.** `index.html`'s
  `NL_SUGGESTIONS_FALLBACK` and `worker/src/lib/suggestions.mjs`'s `FALLBACK_INDICES` must
  name the same idx values per lens — the static site and the worker can't share an import
  across that boundary. Keep them in sync by hand when either changes.
- **i18n**: 8 new candidates (money idx 3/4/5; land/property/rules/meetings/alerts idx 3 each)
  needed fresh `sugg_<lens>_<idx>` keys across all 10 `SHIPPING_LANGS` — the pre-existing idx
  0-2 keys (money/land/property/rules/meetings/alerts) were reused verbatim, unchanged.
- **Tests**: `worker/test/suggestions.test.mjs` (offline, mocked fetch/KV — pins the
  field-evidence fixture itself: the two dead money examples excluded, the working one
  survives, plus the fail-soft/KV-untouched-on-outage behavior) and
  `test/suggestions_render.test.mjs` (root, extracts the client's pure rotation/fallback
  logic) are the two halves; `worker/e2e/suggestions.mjs` is the live check on the static
  fallback specifically (see above).
- **Keyed admin trigger (w12-13)**: `POST /admin/suggest-refresh` (`worker/src/suggest.mjs`'s
  `handleAdminSuggestRefresh`) runs `runSuggestionValidation(env)` on demand instead of waiting
  for the 13:00 UTC cron, same fail-soft contract, returning the same summary JSON plus a
  `triggeredAt` timestamp. Auth is `checkAdminKey(req, env)` (`worker/src/admin.mjs`), extracted
  as the one shared gate for every `/admin/*` route (`/admin/subs`, `/admin/feedback`, and this
  one) — 404 until `ADMIN_KEY` is configured, 401 on a wrong/missing key, key via `?key=` or an
  `Authorization: Bearer` header. Reach for `checkAdminKey` again for any future `/admin/*` route
  rather than re-copying the inline check. Tests: `worker/test/admin.test.mjs`.
- **Suggestions promote the lineage and forecast features (w12-17)**: owner directive — the
  paper-trail (`cadenceEstimate()`/`pastWinnersHTML()`, w12-04/05) and forecast
  (`agencyForecastTeaser()`, Wave 5) features are both undiscoverable unless a reader happens to
  open a notice that has one; the suggestion chips themselves should surface and quietly mark
  queries that lead to them. `worker/src/lib/lineage.mjs` is a worker-side PORT (not an import —
  the worker and static site can't share one, see the dual-implemented convention throughout
  this file) of the pinBase()/isBlanketChain()/LINEAGE_MAX_STAGES honesty rules index.html's
  own row-badge lineage machinery uses, plus a NEW candidate-level (not per-row) judgment,
  `computeLineageSignal(sampleRows, batchRows)` — "what SHARE of a candidate's own live results
  have a genuine prior-award chain," not "what count does this one row have." Thresholds
  (`LINEAGE_SAMPLE_MIN`=5, `LINEAGE_RICH_MIN_COUNT`=2, `LINEAGE_RICH_MIN_SHARE`=0.2) are grounded
  in a live check against the real "construction contracts over $500k" candidate (SUGGESTION_POOL
  money idx 0): 6 of a 25-row sample resolve to a genuine 2-stage chain (24% share) while the
  real PIN-prefix collision PR #61 (w12-10) already documents (PIN 82626R0001001, Environmental
  Protection, 125 unrelated matches live) is correctly excluded as uncertain, not counted.
- `worker/src/suggest.mjs`'s `enrichCandidate()` runs once per fruitful (count-cleared) money/
  alerts-non-rezone candidate, once daily inside `runSuggestionValidation()`: it samples the
  candidate's own live rows (`suggestionSampleParams()`, `worker/src/lib/suggestions.mjs` — just
  `compileSub()`'s own unmodified params, since that already selects pin/agency_name and caps at
  25 rows, the same "identical query shape a real click resolves to" reasoning
  `suggestionCountParams()` uses), computes the lineage signal, then separately checks whether
  ANY distinct sampled agency has a cached `fc:<stem>`/`plan:<stem>` forecast record
  (`vendorStem()`, `worker/src/lib/compile.mjs`) for the forecast-bearing signal. Both signals are
  booleans stored on the validated entry (`{idx, count, lineageRich, forecastBearing}`) — never a
  share/number the client has to threshold itself, and never computed client-side (the
  acceptance criterion: "all computed at validation time — no extra client request").
  Fail-soft: any enrichment-step failure (sample fetch, batch fetch, KV read) leaves the flag
  `false` — uncertain, not a guess — without affecting the candidate's own base validated/count
  result.
- **Money-lens rotation guarantee**: `pickSuggestionsGuaranteed(indices, lineageIndices,
  displayCount, seed, guarantee)` (index.html) picks `min(guarantee, lineageIndices.length,
  displayCount)` lineage-rich idx (day-seeded, so WHICH ones rotates too) plus fills the
  remaining slots from the ordinary `pickSuggestions()` rotation over the rest of the pool —
  representation, not exclusivity, per the acceptance criterion. `LINEAGE_GUARANTEE_MIN` = 2.
  Only wired for `lens==="money"` in `renderNLSamples()`; every other lens keeps plain
  `pickSuggestions()` unchanged. `currentSuggestionMeta(lens)` reads a validated set's
  `lineageRich`/`forecastBearing` flags into idx `Set`s — empty sets (no indicator) for the
  static `NL_SUGGESTIONS_FALLBACK` or an unvalidated lens, since unvalidated is exactly the
  "uncertain" case this feature must never guess at.
- **The indicator itself**: `trychipHTML(lens, idx, meta)` adds `.has-lineage`/`.has-forecast`
  (CSS: a 1px `border-color` tint only — `var(--amber)`/`var(--blue)`, `var(--oxblood)` when a
  chip is both — nothing louder, per the owner's "1px different color border" framing) plus an
  `aria-describedby` pointing at a `.sr-only` hint span. The hint span is a SIBLING of the
  `<button>`, never nested inside it — nesting would break `applyStrings()`'s zero-children
  `data-i18n` guard on the button's own visible label (the same static-fallback-drift sharp edge
  documented earlier in this file). New i18n keys: `sugg_lineage_hint`/`sugg_forecast_hint`, all
  10 `SHIPPING_LANGS`.
- **Tests**: `worker/test/lineage.test.mjs` pins `computeLineageSignal()` against the real
  construction-500k fixture (25-row sample, 6 real 2-stage chains individually queried live, the
  real 82626 collision reduced to a 16-row same-shaped stand-in per PR #61's own convention for
  that exact PIN) plus the ported chain-key/batch-clause helpers. `worker/test/suggestions.test.mjs`
  adds an integration-level test proving `runSuggestionValidation()` flags a real lineage-rich
  candidate and a real forecast-bearing one (a mocked `plan:EDUCATION` KV record standing in for
  a live DOE MOCS forecast, since actual forecast KV content is subscriber-driven and can't be a
  stable committed fixture — same posture `test/forecast_render.test.mjs`'s own synthetic
  `checkbookItem`/`mocsItem` fixtures already established) plus a fail-soft case. `test/
  suggestions_render.test.mjs` extracts and pins the four new client-side pure functions.

## Stats page — counter integrity, per-lens breakdowns, general-vs-technical reform (w12-14/15/16)

- **The all-time counter audit (w12-14) found no live increment bug** — every real digest
  send already ran through exactly one of two call sites in `worker/src/alerts.mjs`
  (`runAlerts()`'s legacy-watch loop, `processOneSub()` — itself shared by the inline path
  and `consumeDigestJob()`'s queue consumer), and both already bumped `bumpStatAllTime`/
  `bumpHistDay` exactly once per send. The real bug was **temporal, not logical**: those
  counters were introduced in commit `60efa88` (2026-07-13) and only count sends from their
  own deploy forward — a site that had been sending real digests for weeks before that
  honestly read "2 digests all time," and the page's "Since launch" label made it worse by
  implying the number covered the site's whole history. `stats:alltime:digest` and
  `stats:cat:digest:*` have never been renamed since introduction — the gap was purely
  "counter started later than the label claims," not a lost/renamed key.
- **`mergeRecoveredAllTime(liveTotal, histSeries, eraDay)`** (`worker/src/lib/stats.mjs`) is
  the fix: it folds every day STRICTLY BEFORE the live accumulator's own era boundary
  (`hist:era:<metric>`, already set by the one-time `worker/scripts/backfill-history.mjs` run
  that seeded `hist:<metric>:<day>` from the older, short-lived `sendcount:<day>`/`nl:<day>`
  counters) into the live total. It's pure and free — `worker/src/stats.mjs` already fetches
  the full hist series for the "over time" chart, so this costs no extra KV reads, and days
  on/after the era boundary are excluded so the live accumulator's own territory is never
  double-counted. The one bound this can't lift: `stats:cat:<metric>:<category>` (the by-topic
  breakdown) has no day dimension in its source data, so it genuinely cannot be backfilled
  past its own era — the UI discloses this with its own honest "Counted since {date}" note
  (`stats_since`, sourced from `history.<metric>.live_from`) wherever a total or breakdown is
  shown, rather than implying every number shares the same starting point.
- **Windowed per-category counters (w12-15)**: `stats:catday:<metric>:<category>:<day>`
  (`categoryDayKey`/`bumpCategoryDayStat`/`readAllCategoryStatsWindow`, same 40-day TTL as the
  plain per-day counters) is a new counter SHAPE, not a rename of the existing all-time-only
  `stats:cat:<metric>:<category>` — the all-time breakdown was already correct and needed no
  change; what was missing was a rolling-window (7-day) breakdown, which needs a day
  dimension the all-time-only key can't provide. Wired for `nl_search` only (`worker/src/nl.mjs`
  now also calls the plain `bumpStat`/new `bumpCategoryDayStat` alongside the pre-existing
  `bumpStatAllTime`/`bumpCategoryStat`/`bumpHistDay` triplet), giving `/stats` a genuine
  `nl_search.calls_last7d` + `by_category_last7d` alongside the existing all-time fields.
  "Category" here is the NL lens (money/people/land/property/rules/meetings/alerts) — reuses
  the site's own `tab_<lens>` i18n labels for display, not a new naming scheme. Digest's
  by-topic breakdown deliberately did NOT get an equivalent 7-day-by-topic table — out of
  w12-15's scope (it's about query/search counts, not digest content), and would be a
  separate card if ever wanted.
- **Daily gauge snapshot (w12-16): `snapshotHistDay`/`ensureHistEra`** (`lib/stats.mjs`) are a
  DIFFERENT shape from `bumpHistDay`/`bumpStatAllTime` — those count EVENTS (one call = one
  real thing that happened); "active watches" is a live GAUGE (a KV list count taken at read
  time), which has no discrete event to hook an increment on. `snapshotHistDay` writes that
  day's reading directly (overwrites, doesn't add) into the same `hist:<metric>:<day>` key
  shape so it's free to read via the existing `readHistSeries`/`renderHistory` machinery; a
  second same-day call just overwrites with the latest reading (idempotent by design — a
  gauge only has one true "as of today" value anyway). `ensureHistEra` is the worker-side
  equivalent of what `backfill-history.mjs` does by hand for digest/nl_search: sets
  `hist:era:<metric>` to today ONLY if unset, so a metric with no manual backfill script still
  gets an honest "counted from here on" boundary the first time it's ever written. Wired into
  `worker.mjs`'s `scheduled()` handler, once per cron run, right after `runAlerts()` — there is
  **no backfill for this metric at all** (no historical record of subscription counts exists
  anywhere), so its `hist:watches_active:<day>` series starts empty and grows from ship date
  forward; the "over time" table's `renderHistory()` on the front end treats it as
  presence-only (no zero-fill) unlike the event-counted columns, since a missing day here means
  "the once-daily cron snapshot didn't happen" — not a confirmed zero the way an event
  counter's silence would be.
- **General-vs-technical reform (w12-16)**: interview feedback named "feed batch cross,
  subscriptions, and investigation shared" as confusing/technical-feeling. stats.html now has
  two explicit tiers — `stats_h_general` ("The headline numbers": active watches, digests
  sent, searches asked, each with 7-day+today+all-time+breakdown) at the top, and
  `stats_h_technical` ("Technical details": digest-link clicks, feed fetches, saved-search API
  checks, shared investigation links — the same four cards, unchanged content, just moved and
  explicitly framed as plumbing) at the bottom. "Active subscriptions" was renamed "Active
  watches" to match the vocabulary the rest of the product already uses (`watch`/`alert`, not
  `subscription`) — same renaming logic applied per-language, anchored to whatever term each
  locale's OWN `stats_p_lede_html` string had already chosen for "watches that fired" (e.g. ru
  already conflates watch=подписка, so its label barely changes; fr/ht/ko/ar/ur/bn/pl all had
  a distinct existing term that "Active subscriptions" was inconsistent with).
- **The "since" honesty note is one key, several call sites**: `stats_since: "Counted since
  {date}."` (parameterized, same pattern as the pre-existing `stats_history_era`) is rendered
  by a single `renderSinceNote(el, liveFrom)` helper in stats.html, called once per all-time
  card and once per breakdown table — each with ITS OWN `live_from` value from the `/stats`
  response's `history.<metric>.live_from`, since different metrics can honestly account for
  different starting points.
- **Reading-level ratchet**: this reform is a full copy rewrite of stats.html, not an
  incremental edit — measure and update `reading-level-baseline.json`'s `stats.html` entry
  (`ror baseline stats.html --preset nycsg7 -o reading-level-baseline.json`) as part of any
  future edit here rather than assuming the committed baseline still matches.

## One draft alert, two views — the quiz and "Advanced options" share ONE set of fields (w12-20)

- **Field evidence**: the site owner observed the 60-second quiz and "Build an alert" were
  "unaligned - shouldn't they change as each other changes?" — picking a quiz topic never
  reached the builder's own `#awatch` until the quiz's own Preview button ran, and even then
  only one-way; switching the builder's select directly left the quiz chip highlighted for a
  topic the builder would no longer actually preview or save. There is no separate JS state
  object for "the draft" — `#awatch`/`#aparam`-or-`#amoneykw`/`#athresh`/`#amoneymin`/
  `#amoneymonths`/`#afreq` (all inside index.html's `#tab-alerts`) ARE the one shared draft,
  since `aFetch()`/`aLensFilter()`/`aPreview()`/`aDescribe()` already read them directly
  regardless of which button triggered the read. The fix is keeping the quiz's chips/narrow
  field/freq chips live-synced to those same fields in both directions, not a new state layer.
- **`refreshQuizDisplay()`** (index.html, defined next to the quiz's own event wiring) is the
  one-way repaint FROM the shared fields INTO the quiz's chip highlighting / narrow-field value
  + placeholder+disabled / freq-chip highlighting. It's called from `aWatchChange()`'s own end
  (so every real `#awatch` change, from ANY call site, repaints the quiz for free) and from the
  quiz's own `#quiznarrow`/`#quizfreq` handlers (so a quiz-side edit stays visually consistent
  with itself). The reverse direction — quiz INTO the builder — is just each quiz control
  writing straight into the shared field it corresponds to (`narrowFieldSel()` picks `#aparam`
  vs `#amoneykw` depending on the current watch type) before calling `aWatchChange()`/relying on
  its own live 'input' listener; there is no separate "push" function for that direction.
- **`aWatchChange(skipQuizSync)`** — the ONLY two call sites that pass `true` are the page-init
  call and `rerenderForLang()`'s call. Both must NOT call `refreshQuizDisplay()`, because
  `#awatch`'s mandatory default value ("bigaward") also happens to be one of the quiz's own 6
  topics — an unconditional repaint at those two bookkeeping call sites would make a completely
  untouched, fresh page look like the user had already picked "Big contract awards," breaking
  `test/functional/03_watch_quiz_feeds.py`'s "quiz CTA without topic → nudge" probe (which
  depends on `quizW` starting `null`). Every REAL interaction (a chip click, a wandchip, a
  saved-search "Watch this" button, an NL-resolved query, or the builder's own `#awatch`/
  `#afreq` controls) calls `aWatchChange()` with no argument and gets the sync for free.
- **The quiz's 6 topic chips are a curated subset of `#awatch`'s 9 options** (`QUIZ_TOPICS`) —
  no chip exists for `moneynl`/`entityvendor`/`entityagency`, so picking one of those (via the
  Ask box, a wandchip, or an entity-profile "Watch this" button) correctly leaves no quiz chip
  lit rather than guessing one. `narrowFieldSel()` is the single place that decides which of
  `#aparam`/`#amoneykw` the quiz's one narrow box currently mirrors.
- **IA**: "Build an alert" is now a `<details id="advopts" open>` nested INSIDE `#quizpanel`,
  not a sibling `.panel` — the two are one grid column, with the Preview panel as the other
  column. Open by default (not collapsed) so every builder field stays exactly as immediately
  reachable/scriptable as it was as its own panel — this is why Playwright tests that
  `select_option`/`fill`/`click` `#awatch`/`#aparam`/`#apreview` directly, with no prior click
  to expand anything, still pass unmodified.
- **A11y**: `sync_watch_announce`/`sync_freq_announce` (all `SHIPPING_LANGS`) announce via the
  shared `#srstatus` region whenever a DISCRETE control (a chip click, a `<select>` change) on
  either side pushes a value into the other view. Continuous text input (`#quiznarrow`/
  `#aparam`/`#amoneykw`'s 'input' listeners) deliberately does NOT announce — that would spam a
  screen-reader user on every keystroke.
- **Characterization fixture**: `test/functional/18_draft_alert_sync.py` pins the owner's exact
  scenario (switch the builder's watch away from the quiz's last pick, click a different quiz
  topic, edit the builder's amount, confirm BOTH Preview buttons describe the identical
  result) — confirmed failing against the pre-fix code via `git stash` before confirming it
  passes, per house testing doctrine.

## Saved-search health — a quiet watch tells its owner, with a fix path

- **The problem**: a subscription that has matched nothing new for months is a silent dead end
  its owner still believes is working — the same never-a-dead-end posture the "confidence"
  heartbeat/weekly-empty feature (`digestDecision()`, `lib/digest.mjs`) already applies to
  silence in general. This is the narrower case: not "did we email lately" but "has the
  underlying query itself stopped finding anything."
- **Storage stays inside the existing SUBS record** — `worker/src/lib/search_health.mjs`'s
  `nextSearchHealth()`/`searchHealthStatus()` are pure functions over a `health: {lastMatchAt}`
  field added to the subscription object itself (no new KV namespace). `lastMatchAt` resets to
  today whenever `fresh.length > 0` in `processOneSub()` (`alerts.mjs`); when there's no match it
  carries forward unchanged. "Quiet" = `daysBetween(lastMatchAt ?? createdAt, today) >=
  QUIET_THRESHOLD_DAYS` (56 days / 8 weeks) — `createdAt` (already stored on every sub) anchors a
  watch that has never matched, so a brand-new watch reads as "no matches yet," never "quiet."
  Any malformed/missing date fails soft to **not quiet** — an uncertain read must never
  manufacture a false alarm. `saveSubHealth()` rewrites the sub's SUBS entry every run
  regardless of the send/cap decision, so email-quota pacing can never distort the underlying
  signal; a write failure there is caught and ignored (health tracking is best-effort, never
  allowed to break digest compilation).
- **The fix-path link reuses the alert builder's own general filter shape.** `alertsFixUrl(lens,
  filter, freq)` builds `https://crol-list.org/#alerts?lens=<lens>&filter=<json>&freq=<...>` —
  literally the sub's own stored `{lens,filter}`. `prefillAlertFromLink()` (index.html, called
  from `applyHash()`'s `tab==="alerts"` branch) reverses this: a money-lens filter goes straight
  through `NL.alerts.apply()` — the SAME function the Ask box's own interpretation step calls —
  so a quiet money watch's fix-path link lands on the existing "understood as" chip echo
  (`aPreview()`'s zero-match branch) for free, no separate UI. Other lenses (entity/land/
  property/rules/meetings) are pre-filled directly (`#awatch`/`#aparam`/`#aagency`) without a
  chip echo — a documented, smaller gap, not a crash; an unrecognized lens leaves the builder at
  its defaults. Legacy `alerts.config.json` watches (the non-SUBS loop in `runAlerts()`) are
  deliberately NOT covered — they have no per-user KV record to extend, matching the acceptance
  criterion's "within the existing KV SUBS shape" scope.
- **The note itself never sends its own email** — `searchHealthNoteHtml()` is appended to
  whichever digest HTML already fires for a quiet run (the heartbeat/weekly-empty `quietHtml()`,
  or `subDigestHtml()` when only forecasts fired with zero fresh notices) and is never present
  when `fresh.length > 0` that run, since a real match always resets `lastMatchAt` to today first
  — this is what makes "the note disappears without ceremony" a structural property, not a
  separate check. `search_health_quiet`/`search_health_fix` are worker-only email strings
  (`lib/i18n.mjs`, en/es only — that catalog's established narrower scope, see the i18n section
  above) since a subscription's `lang` field is itself clamped to `SUPPORTED_LANGS = ["en","es"]`.
- **Tests**: `worker/test/search_health.test.mjs` (pure fixtures: quiet-past-threshold,
  exactly-at-threshold, just-resumed, brand-new/no-history, malformed stored health — plus an
  integration pass driving `processOneSub()` end to end with a mocked SUBS/ALERT_STATE/fetch,
  including "health still records when the send cap denies the email"); `test/
  prefill_alert_from_link.test.mjs` (root, same brace-matching extraction + injected-fakes
  pattern as `quiz_narrow_resolve.test.mjs`) pins the reverse mapping per lens.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
