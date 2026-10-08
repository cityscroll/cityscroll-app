# Recovered discovery: served evidence matrix

Derived by `python3 tools/capture_default_local_home_journey.py --scenario discovery-recovery` from `capture-manifest.json` and `local-capture-manifest.json`; `--check` re-derives this file and refuses any difference.

- Served capture run: `da93ae33-10f6-4137-a8d7-d48086af9f56`, 2026-10-08T21:57:31Z to 2026-10-08T21:58:29Z
- Pinned landed commit: `24b94b943fd8ca9c5d1ebeb7703328c4cb61344e`
- Served Pages revision: `2bb2734917d9db9dba12b37d9090384b8679f2b6`; served Worker revision: `0d199259163fbcd4162351ec17eaa03eaa13dd01`
- Read-model generation: `v1-a8f68c68d742edc3`; Pages data receipt: `3c913de3c8d84349a49ea7db184f26a18285a763a00023c31b4b09d6ead275f0`
- Harness capture revision: `f6c261e72354ff484706a546732239edab0769d9`
- Served result: pass

Outcomes are shown by public alias. Journey cells read phone / desktop (390x844 / 1440x900).

| Outcome | Served journeys | Offline recovery rows | Status |
| --- | --- | --- | --- |
| Leave an unsupported neighborhood filter without losing the question (`ca99610886948`) | unsupported-place-escape: pass / pass | explicit-zero: pass / pass; missing-coverage: pass / pass | met |
| Expose the record collections before a visitor chooses a place (`c6bbe0ce1d028`) | root-category-record: pass / pass | location-denied: pass / pass | met |
| Make location selection lead directly to usable local records (`cdd6dee9bc973`) | typed-place-record: pass / pass | location-denied: pass / pass; location-timeout: pass / pass; detail-failure: pass / pass | met |
| Preserve geography coverage limits through route publication (`c419deec4d475`) | unsupported-place-escape: pass / pass; suggested-place-record: pass / pass | explicit-zero: pass / pass; missing-coverage: pass / pass | met |
| Keep usable records visible when one geography slice fails (`ccfaadd338534`) | typed-place-record: pass / pass; citywide-bucket-record: pass / pass | failed-section: pass / pass | met |
| Show citywide records as relevant content with a bounded preview (`c69db1aa1163d`) | citywide-bucket-record: pass / pass | failed-section: pass / pass; explicit-zero: pass / pass | met |
| Suggest neighborhoods whose displayed record counts match their destinations (`c0cece577f277`) | suggested-place-record: pass / pass | suggested-place-record: pass / pass | met |

Refusal controls for every row: `test/default_local_home_journey.test.mjs`, "discovery-recovery [A4] the validator accepts the retained proof and refuses each weak shape specifically".

## Served observations

- root-category-record-phone: pass; opened `meeting:community_board:rectQy6gJVEczYvLa`
- typed-place-record-phone: pass; 9 local records, 9 listed; opened `meeting:community_board:https://cb14brooklyn.com/meeting/community-environment-cultural-affairs-and-economic-development-committee-meeting-october-2026/`
- unsupported-place-escape-phone: pass; local count None, escape /browse/meetings/; opened `meeting:community_board:nyc-calendar:brooklyn-cb-15:2023-03-28:general-board-meeting`
- citywide-bucket-record-phone: pass; preview total 22 = destination 22; opened `meeting:nyc_legistar_events:22568`
- suggested-place-record-phone: pass; suggestions BK1503 29 = 29, MN0102 26 = 26, MN1001 21 = 21; opened `meeting:community_board:nyc-calendar:brooklyn-cb-15:2026-09-29:general-board-meeting-in-person`
- root-category-record-desktop: pass; opened `meeting:community_board:rectQy6gJVEczYvLa`
- typed-place-record-desktop: pass; 9 local records, 9 listed; opened `meeting:community_board:https://cb14brooklyn.com/meeting/community-environment-cultural-affairs-and-economic-development-committee-meeting-october-2026/`
- unsupported-place-escape-desktop: pass; local count None, escape /browse/meetings/; opened `meeting:community_board:nyc-calendar:brooklyn-cb-15:2023-03-28:general-board-meeting`
- citywide-bucket-record-desktop: pass; preview total 22 = destination 22; opened `meeting:nyc_legistar_events:22568`
- suggested-place-record-desktop: pass; suggestions BK1503 29 = 29, MN0102 26 = 26, MN1001 21 = 21; opened `meeting:community_board:nyc-calendar:brooklyn-cb-15:2026-09-29:general-board-meeting-in-person`
