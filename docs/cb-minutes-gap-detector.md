# Community Board minutes gap detector

The committed report covers all 59 community boards against an expected set of
minutes published during the trailing 12 months. The expected window follows
Recommendation #5 of the [NYC Comptroller Manhattan Community Boards audit](https://comptroller.nyc.gov/reports/audit-report-on-the-twelve-manhattan-community-boards-compliance-with-new-york-city-charter-and-new-york-city-administrative-code-requirements-for-public-meetings-and-hearings-and-for-web/), which calls for posting minutes for the past 12 months.

`tools/build_cb_minutes_gap_report.mjs` has two modes:

```bash
node tools/build_cb_minutes_gap_report.mjs --probe 2026-08-06
node tools/build_cb_minutes_gap_report.mjs --check
```

`--probe` fetches only explicit registry URLs and records the URL, fetch time,
HTTP status, page SHA-256, and dated document links. Boards without a known URL
receive an explicit empty probe; no URL is inferred. The detector classifies a
known publication home as class `a` (`not_yet_ingested`) and a board without a
known publication home as class `b` (`not_published`), using the lifecycle
taxonomy in [`gap-taxonomy.md`](gap-taxonomy.md). `--check` fails if the receipt
does not cover all boards or if a `collect` row has lost its URL without a
receipt-backed URL.
