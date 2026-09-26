# Board neighborhood journey evidence

Public alias: `c0a2ef2da209d`.

Retained textual proof that residents can move from a named neighborhood or exact address to a community board profile and its existing calendar or participation actions.

## Verify

```bash
node --test test/board_neighborhood_journey.test.mjs
CITYSCROLL_BROWSER_PYTHON="${CROL_A11Y_VENV:-$HOME/.local/share/cityscroll/a11y-python}/bin/python3" \
  node tools/verify_board_neighborhood_journey.mjs \
  --base-url https://cityscroll.org \
  --out docs/evidence/board-neighborhood-journey/readback.json
```

Screenshots stay under the local task scratch directory. Only textual manifests and read-backs are committed.
