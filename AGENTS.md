# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Treat `docs/architecture.md` as the architecture source of truth; keep its declared
  `sources_hash` current when a listed source changes.
- The privacy boundary and versioned contract for aggregate usage events live in
  `docs/analytics-event-taxonomy.md`; keep collection and public stats changes within it.
- Lightweight public experiments follow `docs/beta-flags.md`; registry entries are
  default-off, tested in both states, and removed or explicitly renewed before their deadline.
- The CityScroll identity, logo usage, and design-token rationale live in `docs/brand.md`;
  regenerate raster assets with `tools/build_brand_assets.py` and run the brand identity gate
  after changing the mark, icons, or public product name.
- Run the standards and test commands in `.github/workflows/ci.yml`. Any i18n-adjacent or static
  asset change must regenerate both the `?v=` stamps and `LANG_FILE_HASHES` so a deployment cannot
  pair new pages with cached language files. I18n cache stamps are derived only in the Pages
  artifact by `tools/stamp_i18n_assets.py` and verified by `test/standards/i18n_refs.py`—do not
  commit generated hashes to source pages or `i18n.js`. The CI gates covering this discipline are
  named `Stray-English guard` and `Accessibility + language gate`.
- The static site is GitHub Pages, not Cloudflare — only the API (`api.crol-list.org`) and the
  `cityscroll.org` parallel-domain mirror (`worker/src/mirror.mjs`) are Cloudflare Workers. Don't
  assume a Cloudflare Pages project exists for the frontend.
- Post-deploy live-URL smoke (`tools/live_url_smoke.mjs`) runs after Deploy site and Deploy worker
  on `main`. It probes both public apex hosts plus a deep route for HTTP 200 with real content,
  with a bounded retry window for Pages/Fastly redirect-cache lag. Fixture-backed unit tests live
  in `test/live_url_smoke.test.mjs`.
- Hearing location extraction is deliberately dual-implemented in `hearing_location.js` and
  `worker/src/lib/hearings.mjs`; keep venue and affected area separate and run
  `test/contract/hearing_location.test.mjs` after changing either copy.
- NYC Rules RSS is ingested into a daily materialized rule record in `worker/src/rules.mjs`
  (KV key `rules:materialized:v1`, served at `/rules`). The join logic in
  `worker/src/lib/rules.mjs` matches City Record Agency Rules notices to NYC Rules RSS items
  by agency, date proximity, and title overlap; unmatched joins are explicit, never blank.
  Run `worker/test/nyc_rules.test.mjs` and `test/contract/rule_lifecycle.test.mjs` after
  changing either copy.
- Lead category pages with the newest actionable records. Search and filters refine the records
  already shown; explanatory guidance appears only at the concept it explains or on a dedicated
  guide surface. The content-first Staffing exemplar and captures are in
  [PR #122](https://github.com/cityscroll/crol-list/pull/122).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
