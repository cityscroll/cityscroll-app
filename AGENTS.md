# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Treat `docs/architecture.md` as the architecture source of truth; keep its declared
  `sources_hash` current when a listed source changes.
- The privacy boundary and versioned contract for aggregate usage events live in
  `docs/analytics-event-taxonomy.md`; keep collection and public stats changes within it.
- Run the standards and test commands in `.github/workflows/ci.yml`; i18n edits must also
  refresh the core and per-language cache hashes enforced by `test/standards/i18n_refs.py`.
- The static site is GitHub Pages, not Cloudflare — only the API (`api.crol-list.org`) and the
  `cityscroll.org` parallel-domain mirror (`worker/src/mirror.mjs`) are Cloudflare Workers. Don't
  assume a Cloudflare Pages project exists for the frontend.
- `index.html` shows a landing-identity layer (`#landing-identity`) instead of the tool on a
  genuinely fresh bare `/` visit — any existing hash or the `crol_landing_seen_v1` localStorage
  flag bypasses it, and it renders at most once per browser. The tool's own `#nlq`/`#nlgo` Ask
  input physically relocates into it and back (see the LANDING-IDENTITY LAYER section) rather
  than duplicating it. `test/functional/assets/i18n_fixtures.py`'s `install_routes()` pre-sets
  the seen flag so every other functional/standards spec keeps characterizing the tool,
  unaffected — a spec that means to exercise the layer itself must clear that key first (see
  `test/functional/20_landing_identity.py` and the landing-scoped states added to
  `11_accessibility.py`/`13_stray_english.py`/`14_focus_visible.py`/`15_rtl.py`).
- `test/standards/stray_english.py` and any similar single-page static lint must extract EACH
  `<script>...</script>` block independently (`re.findall`, not a first-open/last-close slice) —
  a page with more than one inline script block will otherwise have everything between the
  first and last script tag mis-scanned as JS source, including plain HTML markup.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
