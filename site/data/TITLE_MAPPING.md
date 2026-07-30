# NYC Civil-Service Title Crosswalk — Methods Note

Artifact: [`title_crosswalk.json`](./title_crosswalk.json) — 250 records, one per Title Code,
ranked by how often that code appears in the City Record "Changes in Personnel" feed.
All data pulled live from the NYC Open Data SODA API (no key, CORS-open):
`https://data.cityofnewyork.us/resource/<id>.json`.

## Record schema
```
{
  "title_code":             "53053",        // the civil-service Title Code (string; can be non-numeric, e.g. "9POLL")
  "occurrences":            6898,           // # of Changes-in-Personnel rows carrying this code (full 955,515-row scan)
  "competitive":            true,           // true = found on a civil-service exam list (vx8i-nprf / a9md-ynri)
  "official_title":         "EMERGENCY MEDICAL SPECIALIST-EMT", // null when non-competitive (code only, no official name)
  "payroll_title":          "EMERGENCY MEDICAL SPECIALIST-EMT", // the title_description matched in payroll (may differ from official_title)
  "headcount_fy2025":       2953,           // # payroll rows for that title in FY2025
  "base_min":               39386.0,        // FY2025 base_salary min  (RAW — mixes annual/hourly/daily; see gotcha)
  "base_median":            49047.0,        // FY2025 base_salary median (client-side, robust central figure)
  "base_max":               62393.0,        // FY2025 base_salary max  (RAW)
  "gross_median":           45743.82,       // FY2025 regular_gross_paid median (client-side)
  "cityrecord_salary_min":  27788.0,        // min Salary: value seen in the City Record text for this code (independent)
  "cityrecord_salary_max":  337400.0,       // max Salary: value seen in the City Record text for this code
  "name_source":            "vx8i-nprf",    // which list resolved the name: vx8i-nprf | a9md-ynri | null
  "payroll_match_method":   "exact",        // exact | paren_strip | prefix | none
  "payroll_match_ambiguous": false          // true = a fuzzy match that collapses >1 distinct code into 1 payroll bucket
}
```

## Sources
| # | Dataset | What it gives | Notes |
|---|---------|---------------|-------|
| 1 | `dg92-zbpx` (City Record, `section_name='Changes in Personnel'`) | the **Title Code** (buried in `additional_description_1` text) + a `Salary:` value | 955,515 rows; the only place the code appears |
| 2 | `k397-673e` (Citywide Payroll FY2014–2025) | title **NAME** + salaries | **no title code** — must join by name |
| 3 | `vx8i-nprf` (Civil Service List – Active) | `list_title_code → list_title_desc` | **competitive (exam-gated) titles only**, 424 codes |
| 4 | `a9md-ynri` (Civil Service List Certification) | `list_title_code → list_title_desc (+salary)` | 615 codes; second competitive source |

## Field-by-field derivation (exact queries)

### 1. `title_code` + `occurrences` + `cityrecord_salary_*`
The Title Code is **not a column** — it lives inside the `additional_description_1` template:
`Effective Date: …; Provisional Status: …; Title Code: NNNNN; Reason For Change: …; Salary: NNNNN.NN; Employee Name: …`.
So we paginated the **entire** 955,515-row feed (20 pages of `$limit=50000`, ordered by `request_id`),
pulling only `additional_description_1`, and regexed each row client-side:

- code: `Title Code:\s*([0-9A-Za-z]+)` (codes can be non-numeric, e.g. `9POLL`, `9140A`)
- salary: `Salary:\s*([0-9]+(?:\.[0-9]+)?)`

Pull query (per page):
```
curl -G 'https://data.cityofnewyork.us/resource/dg92-zbpx.json' \
  --data-urlencode "\$select=additional_description_1" \
  --data-urlencode "\$where=section_name='Changes in Personnel'" \
  --data-urlencode "\$limit=50000" --data-urlencode "\$offset=<0..950000>" \
  --data-urlencode "\$order=request_id"
```
Result: **2,350 distinct codes** across all 955,515 rows. We kept the **top 250 by frequency**.
`occurrences` is the full-population count (not a sample). `cityrecord_salary_min/max` is the min/max of the
distinct `Salary:` values seen for that code (capped at 5,000 distinct values per code for memory).

> Server-side `LIKE '%Title Code: 53053%'` *does* work for a single known code (verified: 6,898 hits for 53053),
> but you cannot `$group` on a substring of a text field, so the top-N **ranking** must be done client-side.
> Use `curl --data-urlencode` — building the `$where` by hand fails silently because of the `'`/`:`/`%` characters.

### 2. `competitive` + `official_title` + `name_source`
Pulled the full distinct `list_title_code → list_title_desc` map from **both** competitive sources:
```
curl -G '…/vx8i-nprf.json' --data-urlencode "\$select=list_title_code,list_title_desc" \
  --data-urlencode "\$group=list_title_code,list_title_desc" --data-urlencode "\$limit=5000"   # 424 codes
curl -G '…/a9md-ynri.json' --data-urlencode "\$select=list_title_code,list_title_desc,max(salary)" \
  --data-urlencode "\$group=list_title_code,list_title_desc" --data-urlencode "\$limit=5000"   # 615 codes
```
The two overlap by 420 codes with **zero name disagreements**; union = **619 competitive codes**.
For each top-250 code: if it's in either map → `competitive:true`, `official_title` = the list name (vx8i preferred,
a9md fills gaps). If in neither → `competitive:false`, `official_title:null` (non-competitive / exempt / labor — no exam,
so no official list name exists).

### 3. `payroll_title` + `headcount_fy2025` + `base_*` + `gross_median`
Payroll has no code, so we join on the **name**. For each resolved title we queried FY2025:
```
# server-side count/min/max:
curl -G '…/k397-673e.json' \
  --data-urlencode "\$select=count(*) as n, min(base_salary) as bmin, max(base_salary) as bmax" \
  --data-urlencode "\$where=fiscal_year=2025 AND title_description='<NAME>'"
# then pull the columns and compute median client-side (SODA has no median aggregate):
curl -G '…/k397-673e.json' \
  --data-urlencode "\$select=base_salary,regular_gross_paid" \
  --data-urlencode "\$where=fiscal_year=2025 AND title_description='<NAME>'" --data-urlencode "\$limit=50000"
```
`base_median`/`gross_median` = exact statistical median of the pulled column (no title in the top 250 exceeds 50k rows,
so no truncation). Two-pass matching:
1. **exact** uppercase-trim name == `title_description` → 109 of 140 titles.
2. **fuzzy fallback** for the other 31: strip a trailing parenthetical `(...)` (`paren_strip`), else
   prefix-match `title_description LIKE '<base>%'` and take the highest-headcount candidate (`prefix`).
   This recovered 29 more, leaving **2 genuinely absent** (`match_method:"none"`).

## Headline coverage & match rates
- **Top-250 codes resolved to an official competitive name: 140 / 250 = 56.0%.**
  The other **110 (44%) are non-competitive** — the City Record gives only a bare code, *no official name anywhere*.
  That 44% gap is the "official vs. unofficial" story.
- **Name-join to FY2025 payroll: 138 / 140 resolved titles = 98.6%** (109 exact, 24 paren_strip, 5 prefix, 2 none).
  The raw **exact** rate before fuzzing was 77.9% (109/140).

## Salary-range findings
- Salary spread within a single title is enormous. Widest base spreads (per-Annum staff only): **ADMINISTRATIVE STAFF
  ANALYST** $77,744–$293,094 (2,140 people), **COMPUTER SYSTEMS MANAGER**, **ADMINISTRATIVE PROJECT MANAGER**. Same
  title, ~4× pay.
- The City Record `Salary:` field (`cityrecord_salary_*`) is *noisier* than payroll: it mixes per-annum, hourly, daily,
  and 13 years of all change types (resign/appoint/promote), so its range is always wider than payroll base
  (EMT: City Record $27,788–$337,400 vs. payroll base $39,386–$62,393). Treat it as a sanity band, not a precise range.

## Three demystification examples
1. **Competitive (exam-gated):** Code **`53053` → EMERGENCY MEDICAL SPECIALIST-EMT.** Found on the active civil-service
   list, so it needs a competitive exam. 6,898 personnel changes; FY2025 payroll: 2,953 people, base $39,386 (min) /
   $49,047 (median) / $62,393 (max). "An EMT is a tested, exam-gated title — here's the actual pay band."
2. **Non-competitive (code only, no official name):** Code **`56057`** — 21,874 changes, but it appears on **no**
   civil-service exam list, so `official_title` is `null` and `competitive:false`. The City Record gives only the bare
   code and a Salary band of $13.60–$91,292. "This role exists and people are hired into it constantly, yet there's no
   exam and no published official title — the demystify view must say 'non-competitive / no exam' and surface the code."
3. **Wild salary range:** Code **`10026` → ADMINISTRATIVE STAFF ANALYST.** FY2025 base spans **$52.03 → $293,094**
   across 2,151 people. The $52 floor is the 9 *per-hour* part-timers; the 2,140 *per-annum* staff actually run
   $77,744–$293,094. Same title, wildly different pay depending on level and pay basis.

## Gotchas the UI must handle
1. **`base_min`/`base_max` mix pay bases.** A title's `base_min` can be an hourly rate (e.g. $52.03, $26) sitting next
   to per-annum salaries. Use **`base_median`** as the headline figure; show min/max only with a "ranges include
   part-time/hourly" caveat. (`pay_basis` exists in payroll if you want to split per-Annum vs per-Hour.)
2. **Agency-ambiguous fuzzy matches** (`payroll_match_ambiguous:true`, 12 records). Payroll doesn't disambiguate agency
   in the title, so 3 distinct codes — `CAPTAIN (POLICE)` 70265, `CAPTAIN (FIRE)` 70365, `CAPTAIN (CORRECTION)` 70467 —
   all collapse to one payroll `CAPTAIN` bucket (n=1769). Same for `LIEUTENANT (FIRE)/(POLICE)` and
   `INSPECTOR (CONSTRUCTION)/(HOUSING)`. Show the salary stats but flag that the payroll figure is the **combined**
   bucket, not that specific agency's slice.
3. **`payroll_match_method != "exact"`** means the official name and payroll name differ (e.g. `CLERICAL ASSOCIATE` →
   payroll `CLERICAL ASSOCIATE MOST MAYORAL AG`; `SERGEANT (POLICE)` → `SERGEANT-`). Surface `payroll_title` so users
   see the real payroll label.
4. **`9POLL` is an outlier** — 274,435 occurrences (Board of Election poll workers, `Salary: 1.00` placeholders). It
   dominates the frequency count; consider excluding or labeling it in the UI.
5. **Codes are strings, not ints** (`9POLL`, `9140A`). Don't parse as integers.
6. **Two `match_method:"none"`** (`EMERGENCY MEDICAL SPECIALIST-PARAMEDIC`, `JUVENILE COUNSELOR`): on a civil-service
   list but no FY2025 payroll row under any near name — show "official title exists, no current payroll match."

## Downstream PERSON-view name-join note (not built here)
To join an individual across the two feeds: personnel `Employee Name` is `LAST,FIRST<pad> MI.` and **truncates the
first name to 8 chars**; payroll has full `first_name`/`last_name`. Join on `last_name` (exact) + `first_name` **prefix**
(first 8 chars) + `agency_name`. Expect collisions on common names; the Title Code + agency + effective-date narrow it.
