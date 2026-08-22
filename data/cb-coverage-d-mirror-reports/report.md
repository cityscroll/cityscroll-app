# Bucket D — unofficial-source scout (Brooklyn CB 2, 6, 13, 16)

Scout only. Observed **2026-08-22**. No product inventory, adapter, or route was changed. Do not infer nyc.gov calendar URLs into the product.

The four nyc.gov index pages in this bucket are empty or near-empty. One lens deeper, two of the four boards already publish machine-readable **official** calendars on `cityofnewyork.us`, and the other two publish official minutes on nyc.gov at paths the 2026-08-13 pass did not record as upcoming-meeting sources.

| Board | HTML report | Headline | Recommendation |
| --- | --- | --- | --- |
| brooklyn-cb-02 | [report-brooklyn-cb-02.html](report-brooklyn-cb-02.html) | Live Google Calendar `bk02public@gmail.com` + public Drive on cbbrooklyn.cityofnewyork.us/cb2/. nyc.gov stub 6.5 KB / calendar.page 404. | Future adapter could use the **official** ICS (caveats: 3 MB vs 1 MB `google_calendar_v1` cap; filter BKCB2 titles). Social is unofficial. |
| brooklyn-cb-06 | [report-brooklyn-cb-06.html](report-brooklyn-cb-06.html) | Live WordPress The Events Calendar + ICS + REST on brooklyncb6.cityofnewyork.us. nyc.gov calendar.page is title-only but already links there. | Future adapter could use the **official** Upcoming Meetings ICS/REST (filter out neighborhood events). `bkcb6.app` is unofficial. |
| brooklyn-cb-13 | [report-brooklyn-cb-13.html](report-brooklyn-cb-13.html) | Minutes already inventoried. calendar.page 404. Homepage lists three tentative fall 2026 dates. Facebook/YouTube unstructured. | No followable unofficial structured source. Minutes do not need a records request. Homepage date list is official but thin. |
| brooklyn-cb-16 | [report-brooklyn-cb-16.html](report-brooklyn-cb-16.html) | Minutes HTML+PDF index at `/about/board-meeting-minutes.page` (190 files, 2006–2026). Calendar.page exists, currently “No info at this time” (summer). | No followable unofficial source. Records request not needed for minutes. Use official About paths; do not infer `/minutes/minutes.page`. |

## What this is not

- Not an authorization to write `board_source_inventory.json` or `source_registry.json`.
- Not an authorization to add Facebook, Instagram, YouTube, or `bkcb6.app` as publishers. Allowed publisher kinds remain `nyc_official`, `board_owned_official`, `city_record`, `third_party_storage`.
- Not a claim that the conventional nyc.gov `calendar.page` URLs exist. Two of four 404; one is a title-only stub; one is a real page that is seasonally empty.

## Method

Live HTTP GETs (curl, browser-like User-Agent) of nyc.gov stubs, cityofnewyork.us WordPress, ICS, Tribe REST, Google Calendar public ICS, Google Drive folder HTML, YouTube channel pages, Linktree, and the city community-board directory. Web search for independent sites, social pages, council newsletters, neighborhood press, and City Record. Compared against `site/data/non_council_outcome_sources/board_source_inventory.json` (observed 2026-08-13).
