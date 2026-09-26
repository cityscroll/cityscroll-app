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

## Run receipt

The screenshot host is content-addressed, so a deterministic page keeps the same
hosted address across runs; neither the `sha256` digest nor the `screenshot_url`
can prove a fresh execution. The manifest therefore carries a `run_receipt`:

- per row, the live upload HTTP exchange (request/response timestamps, status,
  returned URL) and the per-request served headers observed while the page
  loaded (`Date`, `CF-Ray`, and the served revision), plus the shared
  `capture_run_id` and a `captured_at` inside one run window; and
- a `host_dedup_demonstration` performed in the same run - the same bytes
  uploaded twice (one URL) and a one-byte-altered copy (a different URL).

`capture_run_receipt.validate_run_receipt` (invoked by `--check`) refuses any row
without a receipt entry from this run.
