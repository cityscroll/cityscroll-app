# Recovered discovery: served evidence matrix

Derived by `python3 tools/capture_default_local_home_journey.py --scenario discovery-recovery` from `capture-manifest.json` and `local-capture-manifest.json`; `--check` re-derives this file and refuses any difference.

- Served capture run: `db223c4d-91bf-4545-83ff-0bab7d1105a2`, 2026-09-30T01:42:32Z to 2026-09-30T01:43:29Z
- Pinned landed commit: `24b94b943fd8ca9c5d1ebeb7703328c4cb61344e`
- Served Pages revision: `49b0017ec1839a3792d6edb338db14711da49fc4`; served Worker revision: `49b0017ec1839a3792d6edb338db14711da49fc4`
- Read-model generation: `v1-a06d60763c2ad49b`; Pages data receipt: `960b533d844b29a993808e2a6b6f34e960193a863244004225e24ac83546ac25`
- Harness capture revision: `49b0017ec1839a3792d6edb338db14711da49fc4`
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

- root-category-record-phone: pass; opened `meeting:oath_trial_calendar:242838:2026-09-30:09:30:00:Scheduled-For-Trial`
- typed-place-record-phone: pass; 2 local records, 2 listed; opened `meeting:community_board:https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/`
- unsupported-place-escape-phone: pass; local count None, escape /browse/meetings/; opened `meeting:community_board:nyc-calendar:brooklyn-cb-15:2023-03-28:general-board-meeting`
- citywide-bucket-record-phone: pass; preview total 20 = destination 20; opened `meeting:nyc_legistar_events:22568`
- suggested-place-record-phone: pass; suggestions MN0102 26 = 26, MN0402 12 = 12, MN0101 9 = 9; opened `meeting:community_board:https://cbmanhattan.cityofnewyork.us/cb4/meeting/housing-health-human-services-committee-hhhs-53/`
- root-category-record-desktop: pass; opened `meeting:oath_trial_calendar:242838:2026-09-30:09:30:00:Scheduled-For-Trial`
- typed-place-record-desktop: pass; 2 local records, 2 listed; opened `meeting:community_board:https://cb14brooklyn.com/meeting/housing-and-land-use-committee-meeting-september-2026/`
- unsupported-place-escape-desktop: pass; local count None, escape /browse/meetings/; opened `meeting:community_board:nyc-calendar:brooklyn-cb-15:2023-03-28:general-board-meeting`
- citywide-bucket-record-desktop: pass; preview total 20 = destination 20; opened `meeting:nyc_legistar_events:22568`
- suggested-place-record-desktop: pass; suggestions MN0102 26 = 26, MN0402 12 = 12, MN0101 9 = 9; opened `meeting:community_board:https://cbmanhattan.cityofnewyork.us/cb4/meeting/housing-health-human-services-committee-hhhs-53/`
