# Board neighborhood journey evidence

Public alias: `c0a2ef2da209d`.

Retained textual proof that residents can move from a named neighborhood or exact address to a community board profile and its existing calendar or participation actions.

## Packets

- `capture-manifest.json` — local hermetic fixture widths plus module-oracle journey results. Module-oracle rows are viewport-free; only the two measured Kensington fixture-document captures keep desktop/mobile widths.
- `readback.json` — production read-back against the served origin (runner default path). Carries HTTP/page outcomes, served generation hashes, and a per-run receipt with Date / CF-Ray / revision for each production request. Retained beside the fixture packet; it does not replace it.
- `delivery.json` — Pages delivery pin the production runner requires as an ancestor.

## Verify

```bash
node --test test/board_neighborhood_journey.test.mjs
CITYSCROLL_BROWSER_PYTHON="${CROL_A11Y_VENV:-$HOME/.local/share/cityscroll/a11y-python}/bin/python3" \
  node tools/verify_board_neighborhood_journey.mjs \
  --base-url https://cityscroll.org \
  --out docs/evidence/board-neighborhood-journey/readback.json
```

Screenshots stay under the local task scratch directory. Only textual manifests and read-backs are committed.
