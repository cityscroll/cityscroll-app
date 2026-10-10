# Chelsea Near You served-surface production read

Production evidence for the Chelsea-Hudson Yards (`nta2020:MN0401`) Near You
served surface: no-lens overview, first-viewport map fit on `surface=map`,
per-lens coverage, negative controls, interaction continuity, and identity
compare against committed `district_activity` geography items.

## Capture status

**Captured** against production after Worker Live URL smoke and Pages
`artifact-manifest.json` both contained the required overview and first-viewport
map ancestors. Textual receipts only; screenshot binaries stay under local task
scratch and are not committed.

Observed production regression retained from this read (not corrected on the
served site yet):

- Overview **Open meetings** / **Open Zoning** links drop the selected
  neighborhood `geo` (and surface) and widen to the citywide Near You shell
  (`What's near you?`). Exact hrefs and resulting headings are in
  `capture-manifest.json` observation `overview-open-lens-links-place-scope`.
  Re-observe after a deploy that retains place scope on those links.

## Verify

```bash
python3 tools/capture_chelsea_served_surface_production_read.py --check-gates
python3 tools/capture_chelsea_served_surface_production_read.py --check
node --test test/chelsea_served_surface_production_read.test.mjs
```

To refresh against a newer green dual-half deploy:

```bash
python3 tools/capture_chelsea_served_surface_production_read.py
python3 tools/capture_chelsea_served_surface_production_read.py --check
```
