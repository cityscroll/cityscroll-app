# Near You Kensington wider-district journey

Public alias: `ce70cec48d558`.

Resident journey for the retained September 23 Community Board 14 Housing and
Land Use Committee meeting: the Kensington neighborhood (`nta2020:BK1203`)
shows the meeting under labeled wider-district activity for overlapping
community districts, kept separate from exact Kensington membership.

## Verify

```bash
node --test test/kensington_wider_district_journey.test.mjs
```

## Production capture

```bash
python3 tools/capture_kensington_wider_district_journey.py --host
python3 tools/capture_kensington_wider_district_journey.py --check
```

The capture refuses to run until the served Pages `/artifact-manifest.json`
`source_commit_sha` contains the landed delivery recorded in `delivery.json`
(the squash-merge commit on the default branch). Screenshot binaries stay
under the local task scratch directory; only `capture-manifest.json` and
`delivery.json` are committed.
