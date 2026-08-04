# Property accessibility census — August 2026

This is the measured baseline for the Property accessibility program. It describes the
City Record notice prose a reader encounters on `#property`; it does not change the site.
The target is seventh-grade understanding or below for CityScroll-authored explanations.
Official notice text remains available verbatim and is measured here as the source-language
reference that those explanations must clarify.

## Result

The current Property corpus is far above the target:

- **243 notices** from the City Record `Property Disposition` section, dated 2013-07-22
  through 2026-06-22.
- The combined title plus rendered detail body has a **mean Flesch–Kincaid grade of
  15.14**, a median of **16.08**, and a 90th percentile of **18.93**.
- **6 of 243 notices (2.5%)** are at or below grade 7. **205 (84.4%)** are above grade 12.
- Only **4 of 212 notices with a rendered detail body (1.9%)** have body text at or below
  grade 7. Another 31 records have no `additional_description_1`, so their combined score
  measures the title alone.
- Unclaimed-property notices are the hardest pattern: mean combined grade **20.95** and
  mean body grade **23.62**.

The source census was bounded at 2026-08-04. Its canonical selected-field SHA-256 is
`99e9d655e63d9c31af53500f1d7a1e72ba93cfb8d3be742505fe7ed961989a67`.

## Template coverage tail audit

The first template pass summarized 234 of 243 notices (96.30%). The nine original-text
fallbacks resolve into two recurring source patterns and one genuine one-off:

| Request ID | Evidence-backed verdict |
|---|---|
| `20240108007` | Recurring HPD pointer: the notice sends readers to the Public Hearing section. |
| `20220103008` | Recurring HPD pointer: the notice sends readers to the Public Hearing section. |
| `20201229007` | Recurring HPD pointer: the notice sends readers to the Public Hearing section. |
| `20200102102` | Recurring HPD pointer: the notice sends readers to the Public Hearing section. |
| `20190108114` | Recurring HPD pointer: the notice sends readers to the Public Hearing section. |
| `20180628112` | Recurring HPD pointer: the notice sends readers to the Public Hearing section. |
| `20150915102` | Recurring direct-sale notice: real-property parcels offered by public auction. |
| `20131023104` | Recurring direct-sale notice: real-property parcels offered by public auction. |
| `20131113103` | Permanent honest fallback: the only future-interest deed-amendment notice in the corpus; a generic acquisition sentence would erase its conditional legal effect. |

The narrow templates raise coverage to **242 of 243 notices (99.59%)**. All 242 authored
summaries score at or below grade 7. Their mean grade is **5.03**, compared with **15.15**
for the same notices' official title and detail text. Exact fixture wording, cohort sizes,
and the one-off rationale are recorded in
`docs/evidence/property-a11y-template-fallbacks/verdicts.json`.

The census now ratchets two measures together: authored-summary mean grade may not rise,
and `templated_fraction` may not fall. The committed baseline is
`site/property-a11y-ratchet.json`; the Reading-level job runs the live census so a new
unsupported notice pattern becomes a coverage regression rather than an invisible fallback.
Reproduce both checks with:

```bash
node tools/property_a11y_census.mjs --limit 50000 \
  --ratchet-baseline site/property-a11y-ratchet.json --format markdown
```

## Method and rendering boundary

The census uses the repository's established reading-level tool,
[`readable-or-else`](https://github.com/jimdc/readable-or-else), with the `nycsg7` preset.
The baseline was measured with version 0.2.0. Its primary formula is Flesch–Kincaid grade.
Each notice is measured separately; grades are then summarized by a deterministic,
mutually exclusive pattern classifier.

The measured surfaces follow the current renderer rather than treating every source field
as visible prose:

| Surface | What is measured |
|---|---|
| Property card title | Cleaned `short_title`, which is always shown. |
| Search-match excerpt | A query-dependent window of up to 70 characters on each side of the matching term. The default Property list has no excerpt, so there is no single stable excerpt document to score separately. Its text comes from the same body pool measured below. |
| Notice detail body | Cleaned `additional_description_1`, truncated to the first 6,000 characters, exactly as the full-notice disclosure renders it. |
| Combined baseline | Title plus rendered detail body. This is the primary per-notice score. |

The detail route fetches `additional_description_2`, `additional_description_3`,
`other_info_1..3`, and `printout_1..3`, but it does not put those fields in the full-notice
disclosure. They are excluded from the readability score. The search excerpt can use
`other_info_1`, so the exported `searchExcerptForTerm` helper reproduces that excerpt
window for detector tests; a corpus-wide excerpt grade would be query-dependent and
misleading.

Short titles are a weak standalone Flesch–Kincaid sample: one-word titles such as
“Disposition” can receive extreme scores. The combined and detail-body distributions are
the decision measures; title scores remain in the machine output as a diagnostic.

Reproduce the baseline:

```bash
node tools/property_a11y_census.mjs --as-of 2026-08-04 --format markdown
node tools/property_a11y_census.mjs --as-of 2026-08-04 > property-a11y-census.json
```

The second command emits machine-readable JSON, including corpus provenance, per-pattern
signal counts, current extractor coverage, jargon counts, and worst notices. `--input`
accepts a saved array, a `/property-locations` `{properties: []}` payload, or the existing
`{notices: [{row}]}` fixture shape. The run is one City Record request plus one local
`readable-or-else` process; classification uses no model calls.

## What the existing CI gate covers

The required Reading-level job runs `test/standards/reading_level.py` in ratchet mode over
seven static files: `about.html`, `api.html`, `changelog.html`, `data.html`, `index.html`,
`stats.html`, and `standards.html`. For `index.html`, that measures the checked-in shell and
site-authored labels.

Property notices arrive after startup from City Record or `/property-locations`. Titles,
search excerpts, and detail bodies are therefore absent from the HTML file that CI grades.
They escape the current gate completely. The job also fast-paths non-frontend changes, so
the new documentation and measurement script do not broaden the required check in this
ship. The census is the explicit runtime-data baseline that a later CI ratchet can consume.

## Readability distribution by structural pattern

All figures below use combined title plus rendered detail body.

| Pattern | n | Mean | Median | p90 | At or below 7 | Above 12 |
|---|---:|---:|---:|---:|---:|---:|
| Pending destruction / seized products | 12 | 13.19 | 12.42 | 17.67 | 0 | 11 |
| Unclaimed property / Property Clerk | 5 | 20.95 | 21.15 | 23.02 | 0 | 5 |
| Forest and timber sale | 43 | 11.96 | 12.38 | 15.45 | 4 | 26 |
| Lease auction or real-property RFP | 11 | 13.57 | 14.34 | 17.74 | 1 | 9 |
| Surplus, vehicle, or equipment auction | 14 | 12.21 | 10.58 | 15.28 | 0 | 7 |
| Direct real-property sale | 5 | 9.62 | 10.10 | 12.09 | 0 | 1 |
| Taxicab-medallion auction | 7 | 8.99 | 8.90 | 13.11 | 1 | 1 |
| UDAAP | 12 | 16.46 | 16.44 | 17.27 | 0 | 12 |
| Acquisition or easement | 21 | 16.46 | 16.25 | 19.90 | 0 | 21 |
| Disposition hearing or conveyance | 113 | 17.06 | 17.27 | 19.14 | 0 | 112 |

The corpus contains no destruction-of-records pattern. The 12 destruction notices concern
seized tobacco and e-cigarette products. Keeping those classes separate prevents an
incorrect action or deadline from being inferred from the pattern name.

### Worst body-text offenders

| Request ID | Title | Pattern | Body grade |
|---|---|---|---:|
| `20200128107` | Owners are wanted by the Property Clerk Division… | Unclaimed property | 26.02 |
| `20161228101` | Owners are wanted by the Property Clerk Division… | Unclaimed property | 26.02 |
| `20151217103` | Owners are wanted… property… without claimants | Unclaimed property | 26.02 |
| `20160318122` | Melrose Commons | Disposition | 22.52 |
| `20141223104` | The following listed property is in the custody… | Unclaimed property | 20.84 |
| `20170516111` | Albee Square | Acquisition or easement | 20.43 |
| `20140501106` | Property Dispositions | Acquisition or easement | 19.76 |
| `20140424105` | Property Disposition | Acquisition or easement | 19.76 |
| `20161101105` | Disposition | Disposition | 19.73 |
| `20170801103` | Disposition | Disposition | 19.67 |

## Pattern inventory: time, action, and current coverage

“Found” below means literal source-language evidence found by the census. “Extracted” means
the current Property stage or commercial extractor creates a structured field that the
action rail can use. A count is not a precision claim: the principal false positive is
called out after the table.

| Pattern | Timed events found in prose or fields | Implied reader actions | What is extracted or surfaced now |
|---|---|---|---|
| Pending destruction / seized products (12) | No structured event date and no destruction or objection deadline in the rendered body. Seizure dates may appear in source tables. | Contact the Civil Enforcement Unit about the listed products; inquiry language appears in 10. | 11 are unstaged; one is classified as a hearing because of its publisher type. There is no destruction, inquiry, or objection action. |
| Unclaimed property / Property Clerk (5) | No deadline or event date. | Ask the borough Property Clerk about property and claim ownership; all 5 contain inquiry/claim language. | All 5 are unstaged. Office details remain in official prose; there is no dedicated claim action. |
| Forest and timber sale (43) | 27 structured event dates; 24 bid-deadline phrases; 22 inspection/showing phrases. | Inspect the site, submit a bid, and use the named contact or package instructions. | 36 auction/RFP stages, 24 bid steps, 22 showing steps, and 27 generic event-date deadlines. No package URL was extracted in this corpus. |
| Lease auction or real-property RFP (11) | 5 structured dates, 2 auction windows, 3 bid-deadline phrases, 2 hearings, and 2 accommodation deadlines. | Review the package, bid or propose, attend a hearing when stated, and request an accommodation before its separate deadline. | 9 auction/RFP stages, 5 event-date deadlines, 7 alleged bid steps, and 4 package URLs. No typed accommodation deadline exists. |
| Surplus, vehicle, or equipment auction (14) | 6 auction-window phrases; no structured event dates. | Register and bid on the linked marketplace. | All 14 expose a marketplace URL and 13 expose registration guidance. Auction start/end times are not structured. |
| Direct real-property sale (5) | 4 structured event dates; one bid-action phrase. | Review sale terms and bid or attend the sale when the notice says so. | All 5 are auction/RFP stages and 4 use `event_date`; no bid-deadline step or package URL is extracted. |
| Taxicab-medallion auction (7) | 2 structured dates, 2 auction-window phrases, and 1 bid deadline. Some notices announce results rather than an open sale. | Submit a bid for open sales; for result notices, review the winning bidders. | 1 auction stage, 2 award stages, and 4 unstaged notices. The single bid deadline is not extracted. |
| UDAAP (12) | All 12 have a hearing/event date and an accommodation deadline. | Attend and be heard; request an interpreter before the separate accommodation deadline. | 7 are hearing stages and surface attendance; 5 are treated as award/conveyance because the body also says property “has sold.” All 12 are incorrectly stamped with a bid step from accommodation boilerplate. |
| Acquisition or easement (21) | All 21 have hearing/event dates; 20 have accommodation deadlines; 19 explicitly invite attendance or being heard. | Attend and speak about the proposed acquisition or easement; request an interpreter by the separate deadline. | 18 hearing stages and 3 award/conveyance stages. All event dates surface, but 20 accommodation deadlines are incorrectly stamped as bid steps. |
| Disposition hearing or conveyance (113) | 112 mention a hearing, 100 have structured event dates, 102 contain accommodation deadlines, and 104 invite attendance or being heard. | Attend and speak about the proposed disposition; inspect the appraisal/agreement; request an interpreter by its deadline. | 92 hearing, 5 auction/RFP, and 16 award/conveyance stages. The rail uses 100 event dates. It also creates 103 false bid-step candidates from non-bid “no later than” boilerplate. |

### Extraction defect revealed by the baseline

The source-grounded detector finds **28** bid/proposal-scoped deadlines. The current
commercial extractor emits **166** `bid_deadline` steps because its final alternative
matches the phrase “no later than” without requiring a nearby bid or proposal. In hearing
patterns, that phrase usually belongs to the sign-language-interpreter request deadline.
For example, the UDAAP group has 12 accommodation deadlines, zero bid-deadline signals,
and 12 current bid steps.

This is a **type confusion**: one date-shaped phrase is being assigned the wrong event
type. It is also why later work should introduce typed events with source spans instead of
adding another broad date regular expression.

## Jargon and faithful plain-language equivalents

The most repeated boilerplate is measurable: legal section/article citations occur in 153
notices, “pursuant to” in 148, “Disposition Area” in 134, “notice is hereby given” in 131,
the calendar-delay clause in 136, and “available for public examination” in 127.

The equivalents below are permitted only when the source phrase is present and its local
referent is known. Legal names and official text stay available; a definition is safer than
a substitution where the term carries legal force.

| Source term or boilerplate | Faithful plain-language rendering | Guardrail |
|---|---|---|
| pursuant to | under | Keep the cited law beside it. |
| notice is hereby given | this notice announces | Do not imply approval or completion. |
| Disposition Area | the property listed in this notice | Use only after the notice defines that term. |
| conveyance | transfer of ownership | Use “transfer of the stated property right” when the interest is narrower than ownership. |
| as soon thereafter as the matter may be reached on the calendar | the hearing may start later if earlier agenda items run long | Preserve the scheduled date, time, and venue. |
| available for public examination | the public can review it at… | Preserve office, room, days, and hours. |
| UDAAP / Urban Development Action Area Project | Urban Development Action Area Project (UDAAP) | Expand the name; do not replace this legal program label with an invented summary. |
| easement | a legal right to use part of a property | State the kind and location only when the notice does. |
| condemnation / eminent domain | government acquisition through eminent domain | Do not say the taking is final unless the source does. |
| upset price | the lowest price the seller will accept at auction | Use only for the auction's stated upset price. |
| sealed bid | a bid kept private until the opening | Preserve the submission method and deadline. |
| forfeiture | legal loss of the products under the cited law | Preserve “subject to” or other uncertainty in the source. |
| Unauthorized Products | products that meet the notice's listed untaxed, unlicensed, or prohibited-sale categories | Do not generalize beyond the notice's definition. |
| claimants | people claiming ownership | Do not imply that a claim will be accepted. |
| board feet | a lumber-volume unit | Keep the number and unit; do not convert without source-supported dimensions. |
| cordwood | wood measured in cords | Keep the number and unit. |
| shall | must | Use only where the source imposes a requirement. |

## Ranked plan for ships 2–4

### 2. Typed timed-event extraction

Highest priority because an incorrect deadline can cause direct harm.

1. Introduce a typed Property event record with `kind`, start/end or deadline, source field,
   exact evidence span, and confidence.
2. Cover hearing, auction-window start/end, bid/proposal deadline, inspection/showing,
   accommodation-request deadline, and result/award date separately.
3. Require a bid or proposal anchor for `bid_deadline`; remove the unqualified “no later
   than” match. Add the hearing and UDAAP cases above as negative fixtures.
4. Distinguish `event_date` semantics by pattern before using it as an action deadline.
5. Re-run this census and require zero known cross-type false positives. Preserve honest
   empty values when a date is absent.

### 3. Source-grounded action extraction

1. Map typed events and literal verbs to `bid`, `inspect`, `attend/be heard`, `inquire or
   claim`, `request accommodation`, and `review result` actions.
2. Surface the exact method the notice gives: URL, email, mailing address, phone, or venue.
3. Do not create an `object` or `comment` action for this baseline corpus: neither action is
   present in the rendered Property body measured here. Add them only when future source
   text supplies the act, method, and any deadline.
4. Gate past sales and hearings so expired actions become historical context, not live calls
   to action.
5. Measure action coverage and source-span precision by pattern with this script's signal and
   current-extraction sections.

### 4. Pattern-specific plain-language templates

1. Add a short CityScroll-authored summary for each measured pattern: what is happening,
   key dates, what a reader can do, and where the statement came from.
2. Build summaries only from extracted source fields and evidence spans. Never infer legal
   effect, eligibility, ownership, or an unstated deadline.
3. Pair unavoidable legal terms with the faithful definitions above. Keep the official
   notice disclosure verbatim and clearly labeled.
4. Extend the census with a `plain_summary` surface and ratchet that authored text to grade
   7 or below. Keep the official-body distribution as an invariant reference rather than
   claiming CityScroll rewrote the source.
5. Start with disposition/UDAAP/acquisition templates: 146 notices, nearly all above grade
   12, with a shared hearing and accommodation structure. Follow with unclaimed-property
   notices because they have the highest body grade and a distinct claim workflow.

## Ratchet contract

Future ships should run the same bounded corpus where comparable, record the new corpus
hash when the source changes, and report both coverage and precision:

- official title/body grade distribution by pattern;
- authored-summary grade distribution, once summaries exist;
- templated fraction, with every fallback retained in the denominator;
- source signals versus extracted typed events;
- source-grounded actions versus surfaced actions;
- known cross-type false positives;
- missing rendered bodies and honest-empty event/action fields.

The baseline must not be “improved” by dropping difficult notices, merging them into one
document, or scoring hidden source fields as if a reader saw them.
