# Residential directory — production read-back

Deployment-identity-stamped observations for the Near You searchable residential
directory (public alias `cd5ed919f3be2`).

## Letters covered here

- **A1** — default chooser borough groupings, residential filter control, and
  explicitly labeled special-use reachability for airports, parks, and cemeteries.
- **A2** — served document with scripts stripped, native links, keyboard paths,
  Tribeca alias resolution, no-match recovery, and observed absence of a
  location-permission prompt.

Offline **A3** fixtures for the seven named places live in
`test/geography_navigation_shell.test.mjs` and
`test/geography_navigation_entry.test.mjs`.

## Artifacts

| File | Role |
| --- | --- |
| `read-back.json` | Observed values from the served origin, stamped with `/artifact-manifest.json` `source_commit_sha` |
| `capture-manifest.json` | Textual capture index aligned with other `docs/evidence/**/capture-manifest.json` packets |

Image binaries are not committed. Optional screenshots may exist under the local
task scratch directory during capture.

## Reproduce

```bash
python3 tools/capture_residential_directory_production_read.py
python3 tools/capture_residential_directory_production_read.py --check
node --test test/residential_directory_readback.test.mjs
```

`CROL_BASE` defaults to `https://cityscroll.org/`. The tool refuses non-production
hosts so a local rehearsal cannot overwrite this packet.
