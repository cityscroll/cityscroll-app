# Civil-service exam source snapshots

`tools/build_staffing_exams.mjs` turns these source snapshots into
`data/staffing_exams.json`, the only file the browser loads. This is a build-time
materialized view: the Staffing guide never fans out to City APIs at runtime.

## Authoritative feed (open windows)

For exams that are open to applications **right now**, the authoritative public
source is the DCAS open-competitive schedule page and each linked Notice of
Examination (NOE) PDF:

- Schedule: https://www.nyc.gov/site/dcas/employment/exam-schedules-open-competitive-exams.page
- OASys application handoff: https://www.nyc.gov/examsforjobs

Registry entry: `dcas-exam-notices` in `data/source_contracts.json`. Live checks
are recorded under `verification_receipts/` (for example
`verification_receipts/dcas_open_competitive_2026-07-29.json`). The Annual
Examination Schedule Open Data dataset (`4ptz-hmtc`) remains the fiscal-year
planning table and can lag mid-cycle NOE amendments.

Sources and refresh rules:

- `annual_schedule.json` — DCAS/NYC Open Data dataset `4ptz-hmtc`. DCAS says the
  public schedule is updated monthly; the dataset metadata currently says annual
  updates and quarterly data changes. Refresh monthly and record both claims.
- `dcas_open_competitive.json` — the current DCAS open-exam table and its linked
  Notices of Examination (NOEs). Check daily while applications are open because
  an amended NOE can extend or cancel a window before the structured dataset
  catches up.
- `active_list_summary.json` — aggregate-only counts from the daily DCAS active
  civil-service-list dataset `vx8i-nprf`. Candidate names are never copied into
  this repository.
- `city_record_check.json` — a daily negative-control query against City Record
  dataset `dg92-zbpx`. Keyword matches for “exam” are reviewed as possible exam
  announcements; as of the recorded check, none are NOEs. This prevents contracts
  for exam services and unrelated uses of “examination” from becoming invented
  career listings.
- `dcas_exam_outcomes.json` — a manually curated annual aggregate outcomes
  snapshot from NYC DCAS publications. This is **not** an applicant-level feed:
  only counts are kept (applicants, eligible-list size, certifications, hires).
  `tools/build_staffing_exams.mjs` joins each row onto exam cards by `exam_number`
  at build time; exams without a published row carry an explicit not-published
  gap (real-world pending after eligible-list establishment), not a silent blank.

Run `node tools/build_staffing_exams.mjs --refresh` to refresh the Open Data
snapshots and rebuild the client artifact. The DCAS current-page snapshot remains
a reviewed input because nyc.gov sometimes blocks unattended requests from build
networks. Run `node tools/build_staffing_exams.mjs --check` for the hermetic CI
drift check.

- `civil_service_list_aggregates.json` — **exam-level only** group-by from the
  active Civil Service List (`vx8i-nprf`): list_count, established_date,
  extension_date, title_count. Per-applicant rows and names are never stored.
  Closed-exam exam_no overlap measured 2026-07-30 at **44.54%** (494/1,109);
  open-exam overlap 0%. Receipt:
  `verification_receipts/civil_service_list_closed_exams_2026-07-30.json`.
  `tools/build_staffing_exams.mjs` joins aggregates onto exam cards as post-list
  depth when annual DCAS outcomes are not yet published for that exam_number.
