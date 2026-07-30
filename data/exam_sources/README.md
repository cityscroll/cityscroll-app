# Civil-service exam source snapshots

`tools/build_staffing_exams.mjs` turns these source snapshots into
`data/staffing_exams.json`, the only file the browser loads. This is a build-time
materialized view: the Staffing guide never fans out to City APIs at runtime.

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
  only counts are kept to track certification and hiring outcomes per exam cycle.

Run `node tools/build_staffing_exams.mjs --refresh` to refresh the Open Data
snapshots and rebuild the client artifact. The DCAS current-page snapshot remains
a reviewed input because nyc.gov sometimes blocks unattended requests from build
networks. Run `node tools/build_staffing_exams.mjs --check` for the hermetic CI
drift check.
