# Civil-service exam source snapshots

`tools/build_staffing_exams.mjs` turns these source snapshots into
`data/staffing_exams.json`, the only file the browser loads. This is a build-time
materialized view: the Staffing guide never fans out to City APIs at runtime.

## Authoritative feed (open windows)

For exams that are open to applications **right now**, the authoritative public
source is the DCAS open-competitive schedule page and each linked Notice of
Examination (NOE) PDF:

- Schedule: https://www.nyc.gov/site/dcas/employment/exam-schedules-open-competitive-exams.page
- OASys per-exam NOE page (preferred apply handoff when mapped):
  `https://a856-exams.nyc.gov/OASysWeb/noe?examId={examId}`
- OASys landing (unmapped exams only): https://www.nyc.gov/examsforjobs

Registry entry: `dcas-exam-notices` in `data/source_contracts.json`. Live checks
are recorded under `verification_receipts/` (for example
`verification_receipts/dcas_open_competitive_2026-07-29.json`). The Annual
Examination Schedule Open Data dataset (`4ptz-hmtc`) remains the fiscal-year
planning table and can lag mid-cycle NOE amendments.

**OASys examId map (build-time):** OASys internal `examId` is **not** the DCAS
exam number (e.g. examId `9619` → exam `6125`). Rebuild the map with
`node tools/build_oasys_exam_map.mjs` (polite live fetch of
`/OASysWeb/api/Exam/GetActiveExams`). Artifact:
`oasys_exam_map.json` + receipt
`verification_receipts/oasys_exam_map_latest.json`. Offline fixture body:
`oasys_active_exams_fixture.json`. `build_staffing_exams.mjs` joins on exact
`exam_number` and stamps `official_application_url` / `oasys_exam_id` /
`application_handoff_mode`. Unmapped rows keep the examsforjobs landing with a
browse label.

Sources and refresh rules:

- `annual_schedule.json` — DCAS/NYC Open Data dataset `4ptz-hmtc`. DCAS says the
  public schedule is updated monthly; the dataset metadata currently says annual
  updates and quarterly data changes. Refresh monthly and record both claims.
- `title_code_alias_registry.json` — exact-label spine built from the official
  Jobs NYC Postings dataset `kpav-sd4t` and canonical NYC Civil Service Titles
  dataset `nzjr-3966`. A row enters the registry only when the publisher's
  `civil_service_title` and `title_code_no` exactly normalize to the canonical
  title description and `title` code. The registry is used for coverage
  measurement; unmatched historical rows remain residuals for the
  Fellegi–Sunter candidate scorer and are not public facts.

  Refresh with `node tools/build_title_code_alias_registry.mjs`, then rebuild
  coverage with `node tools/build_title_code_family_coverage.mjs`. The committed
  artifact records source row counts, dataset update times, accepted aliases,
  canonical identities, and ambiguity counts.
- `annual_schedule_history.json` — one canonical row per exam from historical
  revisions in that same `4ptz-hmtc` dataset. Exact normalized `exam_number` is
  the join key; the latest `data_current_as_of` revision wins, with application
  close as a deterministic tie-break. Rebuild it with
  `node tools/build_staffing_exams.mjs --refresh-prediction-history`.
- `dcas_open_competitive.json` — the current DCAS open-exam table and its linked
  Notices of Examination (NOEs). Check daily while applications are open because
  an amended NOE can extend or cancel a window before the structured dataset
  catches up.
- `noe_fee_salary_densify.json` — body-parsed APPLICATION FEE / minimum salary from
  public NOE PDFs for exams the open-competitive snapshot does not yet cover
  (including multi-exam NOEs such as Police Officer 7311–7322). Never invents
  amounts; annual-schedule-only rows without a densify hit stay class-(a)
  not_yet_ingested. Receipt:
  `verification_receipts/noe_fee_salary_densify_latest.json`.
- `noe_differentiators.json` — precomputed filter facets and card leads from
  OASys `GetActiveExams` (fee, promotional, examParts EEE/MC) plus polite
  build-time parse of OASys NOE HTML pages (`/noe?examId=`). Open Data has no
  NOE body corpus (`4ptz-hmtc` schedule, `vx8i-nprf` lists only). Fields:
  salary band, fee level, exam format, qualifications, no-experience flag,
  residency, selective certification, and a corpus frequency split of
  boilerplate vs distinctive content. Rebuild:
  `node tools/build_noe_differentiators.mjs` (live, rate-limited) or
  `--from-text-fixtures`. Receipt:
  `verification_receipts/noe_differentiators_latest.json`. Text fixtures:
  `fixtures/noe_text/examId_*.txt`.
- `interest_area_taxonomy.json` — **data (not code)** mapping of exam titles
  into subscribable interest areas (public safety, social services, trades,
  admin, IT, etc.). Pure helpers: `site/exam_interest_taxonomy.mjs`. The
  staffing artifact stamps each exam with `interest_area` and emits
  `interest_taxonomy` (area descriptors + per-area exam lists with
  open/upcoming/closed window state). Edit title rules or
  `exam_overrides` / `title_code_overrides` here, then rebuild
  `tools/build_staffing_exams.mjs`. Alerts-by-area is a **separate gated**
  product surface — this file only marks areas `subscribable`.
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
  at build time **only when cycle-coherent**: for non-continuous exams,
  `published_on` must be strictly after `application_end`. Mid-window post-list
  joins are refused (exam numbers name one filing cycle). Exams without annual
  or list depth carry an explicit class-(a) not-yet-ingested gap (public sources
  exist — not a false city-withhold). Continuous / walk-in filing is exempt only
  when the source labels it. Class measurement:
  `exam_cycle_temporal_incoherence_count` on the staffing artifact + flywheel
  data-integrity dimension.

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
- `list_depth_closed_exams.json` — closed annual exams (outside the current FY
  snapshot) that join `vx8i-nprf` exam-level aggregates. The current-year schedule
  is mostly open 7xxx exams with **0%** list presence; without this supplement the
  build stamps empty aggregate slots as if no public list data existed. Each row
  is re-joined at build time from `civil_service_list_aggregates.json` (counts only).

## List-establishment timing model

The build exact-joins `annual_schedule_history.json` to
`civil_service_list_aggregates.json` and models application-close →
list-established duration with a nearest-rank ECDF. Open-competitive and
promotion cohorts require at least 20 pairs; smaller cohorts use the citywide
distribution. Join counts, miss reasons, p10/p50/p90, and the time-split
calibration scorecard are recorded in
`verification_receipts/staffing_list_establishment_prediction_latest.json`.
If the scorecard misses its ship bar, exam pages show only the cohort median and
the committed artifact emits no per-exam prediction date. The privacy floor is
unchanged: only exam-level aggregates are used or exposed.
