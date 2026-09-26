# Place navigation release evidence

Public alias: `cc6bdbee29292`.

Retained textual proof that the published neighborhood → board → Land journey agrees across pages, maps, and saved scope using observed production data generations.

## Packets

- `capture-manifest.json` — local hermetic fixture widths plus module-oracle journey results. Module-oracle rows are viewport-free; only measured fixture-document captures keep desktop/mobile widths.
- `readback.json` — production read-back against the served origin (runner default path). Carries HTTP/page outcomes, served generation hashes, and a per-run receipt with Date / CF-Ray / revision for each production request. Retained beside the fixture packet; it does not replace it. Watch-preview parity records two observed project-id sets (served preview markup when enumerable, otherwise the same SI0105 membership the land watch preview is built from) plus their intersection and differences, with a positive control that rejects a perturbed preview set.
- `delivery.json` — Pages delivery pin the production runner requires as an ancestor.

## Verify

```bash
node --test test/place_navigation_release.test.mjs
CITYSCROLL_BROWSER_PYTHON="${CROL_A11Y_VENV:-$HOME/.local/share/cityscroll/a11y-python}/bin/python3" \
  node tools/verify_place_navigation_release.mjs \
  --base-url https://cityscroll.org \
  --out docs/evidence/place-navigation-release/readback.json
```

Screenshots stay under the local task scratch directory. Only textual manifests and read-backs are committed.
