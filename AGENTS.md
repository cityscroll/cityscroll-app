# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## i18n — the rules that keep Spanish (and the next nine languages) honest

- **Every user-facing string routes through `t()` / `tSection()`** (i18n.js) — including
  strings built in JS template literals and labels derived from DATA VALUES (City Record
  section names → `SECTION_I18N`). Two gates enforce it; run them before calling i18n work
  done: `python3 test/standards/stray_english.py` (source lint; its allowlist
  `test/standards/stray_english_allowlist.txt` may only shrink) and
  `python3 test/functional/13_stray_english.py` (hermetic rendered-DOM walk, every PR in CI;
  parameterized by `CROL_GUARD_LANGS`).
- **Sharp edge — `t` shadowing:** never name a function parameter or local `t`
  (`pinBtn(t,…)` and `copyText(t,…)` both silently broke rendering, 2026-07-13 hotfixes).
- **Changing i18n.js requires a `?v=` hash bump** in index.html's script tag
  (`shasum -a 256 i18n.js | cut -c1-8`) — `test/standards/i18n_refs.py` fails otherwise.
- **es orthography is gated:** `python3 test/standards/es_diacritics.py` fails accent-less
  forms of pinned Spanish words. Extend its map when a reviewer catches a new miss.
- **Language switching must repaint dynamic surfaces** — `rerenderForLang()` in index.html;
  a new dynamic renderer must be re-run there or render from `data-i18n` attributes.
- **Interaction-gated states count:** the runtime guard seeds a pinned investigation item and
  walks `#investigation`; a new localStorage/hash-gated panel needs the guard walk extended
  or it will ship English silently (hotfix-2's lesson).
- Notice CONTENT stays English (official source) with a per-language disclaimer; chrome and
  derived UI text always translate. en/es key parity enforced by `i18n_keys.py`.

## Test layers (what runs where)

- Every PR (CI "unit" + "i18n-guard" jobs): standards gates, `node --test test/*.test.mjs`,
  worker tests, and the hermetic stray-English guard (fixtures in
  `test/functional/assets/i18n_fixtures.py` stub every upstream — no live network).
- Manual dispatch: full Playwright functional suite (`bash test/functional/run.sh`, live
  APIs). Serve on **port 8000** — the worker's CORS allowlist includes it; other local ports
  make live share/subscribe steps fail with "Couldn't reach the server".

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
