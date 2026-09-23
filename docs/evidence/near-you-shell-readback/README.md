# Near You map-first shell — production read-back

Deployment-identity-stamped observations for the Near You map-first shell
(public alias `ced62a84f8213`).

## Letters covered here

- **A9** — hover highlights have keyboard-focus and tap equivalents (directory
  links; focusable map host), and Tab leaves the map region after Escape clears
  hover/focus state (no focus trap).
- **A13** — at the initial all-city view, observed residential neighborhood
  label counts stay inside 12–40 at 1440×900 and 6–20 at 390×844, with MapLibre
  collision handling (`text-allow-overlap=false`) and a measured overlapping
  pair count of zero.

## Artifacts

| File | Role |
| --- | --- |
| `read-back.json` | Observed values from the served origin, stamped with `/artifact-manifest.json` `source_commit_sha` |
| `capture-manifest.json` | Textual capture index aligned with other `docs/evidence/**/capture-manifest.json` packets |

Image binaries are not committed. Optional screenshots may exist under the local
task scratch directory during capture.

## Reproduce

```bash
python3 tools/capture_near_you_shell_production_read.py
python3 tools/capture_near_you_shell_production_read.py --check
node --test test/near_you_shell_readback.test.mjs
```

`CROL_BASE` defaults to `https://cityscroll.org/`. The tool refuses non-production
hosts so a local rehearsal cannot overwrite this packet.
