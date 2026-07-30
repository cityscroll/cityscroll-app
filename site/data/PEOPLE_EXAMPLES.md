# People lens — seed examples

`people_examples.json` is a curated set of 16 demo-worthy NYC civil-service roles so the
People lens opens with clickable example chips instead of a blank search box. Clicking a chip
runs that role's `keyword` through the same live query the lens already uses.

## How the file is used by the UI

1. **Load** `data/people_examples.json` (array of 16 role objects) on tab init.
2. **Render** each as a clickable chip showing `label` + `base_median` + an exam/no-exam badge
   (from `competitive`). The `note` makes a good tooltip / caption.
3. **Click** sets the title-keyword box to `keyword` and runs the existing role search
   (`pSearchRoles`), which re-derives the same `ladder` live from Citywide Payroll `k397-673e`
   (FY2025, `base_salary > 0`, grouped by `title_description`, ordered by `avg` DESC) and the
   exam flag from Civil Service List `vx8i-nprf`. The `ladder` field in the JSON is the
   pre-computed version of exactly that result (top 6 rungs by average pay), so the chip can
   render a preview before the network call returns.

Each object: `{keyword, label, official_title, competitive, base_min, base_median, base_max,
headcount, ladder:[{title,avg}…≤6], note}`. Headline number is `base_median` (mixed pay bases —
hourly/per-session/part-time rows — make min/max noisy, so median is the honest headline).

## How these 16 were chosen

Every number was verified against the **live** NYC Open Data APIs (no key) on 2026-06-24, not
just the crosswalk — so paramedic/attorney/commissioner/teacher rows that were null or absent in
the precomputed crosswalk are filled in from the live payroll. The spread is built to teach the
core concepts:

- **Iconic exam-gated uniformed roles** (the "you need a test" story): Police Officer,
  Firefighter, EMT & Paramedic, Correction Officer, Sanitation Worker, School Safety Agent.
- **White-collar competitive**: Administrative Staff Analyst, Civil Engineer, Computer Systems
  Manager, Administrative Engineer, City Planner, Architect.
- **The no-exam gap** (titles absent from the Civil Service List): Attorney / Agency Attorney,
  Commissioner / Deputy Commissioner, and the public-school Teacher.
- **Career-ladder demos**: keywords like `EMERGENCY MEDICAL`, `CIVIL ENGINEER`, and `ATTORNEY`
  return a full pay-ranked ladder in one search.

`keyword` is the broad search stem the UI runs; `official_title` is the specific canonical row
used for the headline salary/headcount. For two roles the headline title is narrower than the
keyword on purpose — `ATTORNEY` → **AGENCY ATTORNEY** and `COMMISSIONER` → **DEPUTY COMMISSIONER**
— because those keywords sprawl across many appointed titles and we want one clean headline.

## The 3 best "wow" facts

1. **Widest salary range in the city — same title.** `ADMINISTRATIVE STAFF ANALYST` is one
   exam-gated title spanning **$52 to $293,094** of base salary (median $128,122) across 2,151
   people — a ~5,600x spread driven by part-timers at the bottom and senior managers at the top.
2. **Lawyers need no exam; commissioners are the highest-paid, also no exam.** **Zero** attorney
   titles appear on the Civil Service List, so every one is non-competitive — from Agency Attorney
   (median $108,350) up to **District Attorney at $232,600**. Commissioner titles are likewise all
   appointed (no exam) and top out at **$291,821** for agency heads.
3. **Exam status doesn't track pay — and "obvious" cases flip.** The base **ACCOUNTANT** title is
   **no-exam** while **ADMINISTRATIVE ACCOUNTANT** right above it on the ladder is exam-gated; and
   a policy/discretion job like **City Planner** *is* exam-gated competitive. Garbage-can intuition
   ("senior or judgment-heavy = no test") is wrong as often as it's right.

## Data caveats

- **DOE pedagogues (Teacher) are licensed, not civil-service-competitive**, so the lens correctly
  shows **TEACHER as NO-EXAM** even though there are ~56,000 of them (median $110,848). This is a
  real property of the data, not a bug — DOE teaching titles are simply absent from `vx8i-nprf`.
  Per-session / per-diem teacher rows at the bottom of the ladder are hourly-coded (avg ~$33–$395),
  which is why we headline the median of the main `TEACHER` title, not min/max.
- **Mixed pay bases.** Many titles mix annual-salaried, hourly, and per-session/part-time records;
  `base_min` can be a few dollars (an hourly rate). Always headline `base_median`.
- **New-hire lag.** Payroll trails appointments by ~a fiscal year, so very new titles/hires may be
  thin in FY2025.
- **Headcount ≠ payroll row count.** `headcount` here is the count of FY2025 rows with `base_salary
  > 0` for the exact `official_title`; the raw payroll table also contains prior fiscal years.
- **`competitive` = "appears on the Civil Service List for that exact title."** A title absent from
  `vx8i-nprf` is treated as no-exam. The flag is per exact title, so within one keyword some ladder
  rungs can be exam and others not (see `ARCHITECT`, `ACCOUNTANT`).
