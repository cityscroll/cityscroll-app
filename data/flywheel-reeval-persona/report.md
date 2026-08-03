# Persona usefulness re-evaluation (delta)

**Observed:** 2026-08-03 (cache-busted live checks against `https://cityscroll.org` and `https://api.cityscroll.org`)  
**Baseline framing:** evaluate current live state, not card existence. Shipped ≠ working.

Evidence probes: `data/flywheel-reeval-persona/probe/` (live JSON + browser session notes).

---

## Method

Four persona journeys, end-to-end: **glance → decide → act → watch**.

| Persona | Primary surface | Live entry points |
|---|---|---|
| Surplus-goods buyer | Property | `#property`, filters, `#notice/20251106024` |
| Civil-service job seeker | Staffing / exams | `#people`, `#exam/7016`, `#exam/7312` |
| Hearing attender | Land hearings + meeting logistics | `#land?status=hearings`, `#land/2024Q0292` |
| District resident | Map drill | `#map`, `#map?level=community_district&parent=Queens&lens=land` |

---

## 1. Surplus-goods buyer (Property)

### What works (live-verified)

- Commercial **item / sale-method / price-band chips** paint and filter (Vehicles 6, Timber 43, Online auction 8, Has a price 104).
- Client re-extracts commercial when the edge list omits a stamped `commercial` bag (list still usable).
- Detail `#notice/20251106024` (AUTO AUCTION): WHAT=Vehicles, sale method=online auction, GovDeals package URL, registration step, action rail primary “Open the sale / RFP package”, **Watch this notice** present.
- Non-sale destruction class stays out of commercial filters (client counts align with extract).

### Break points

| ID | Stage | Severity | Live evidence |
|---|---|---|---|
| **B-01** | Glance | **High** | Close chips render as `closes $September 16, 2013` — i18n used `closes ${date}`; `t()` substitutes `{date}`, leaving a spurious `$` on every close date. |
| **B-02** | Glance / decide | **High** | Default sort **Closing soonest** surfaces **2013** dispositions first (ascending past dates). A buyer scanning for open auctions must scroll past a decade of closed sales. |
| **B-03** | Glance | Medium | Live `GET /property-locations` (slim + `full=1`) has **0** stamped `commercial` fields (`generated_at` 2026-08-02). Client compensates; edge stamp + metrics lag deploy/refresh. |
| **B-04** | Decide | Medium | Price / deal coverage still thin on modern notices (sample extract: 1/40 priced; deal signals rare without dual labeled floor+value). |
| **B-05** | Act | Low | Many vehicle rows still “No location identified” (online marketplace universe — acceptable with GovDeals handoff). |

### Implemented this pass

- **B-01** fixed: `property_commercial_close` → `closes {date}` (en + all shipping locales). Detector test refuses `${date}` regression.
- **B-02** fixed: `sortPropertyExplorerEntries(..., closing_soon)` puts **future first** (soonest), then past (most recent first). Characterization with injected `today`.

---

## 2. Civil-service job seeker (Staffing / exams)

### What works (live-verified)

- `#people` / exam cards: open-first ordering, differentiator chips (fee, salary band, format, no-experience).
- `#exam/7016` Caseworker: fee **$68**, deep apply `OASys …/noe?examId=9629`, list-lag cohort copy (median months, n=307), process spine stages.
- Open deep-handoff exams (OASys map n=9) match live open windows for field cases 7016 / 7312 / 7013.

### Break points

| ID | Stage | Severity | Live evidence |
|---|---|---|---|
| **J-01** | Act | Medium | Of **147** exams with `application_end ≥ 2026-08-03`, only **9** are `application_handoff_mode=deep`; **138** still land on `examsforjobs` lobby (OASys active list is smaller than schedule open set). |
| **J-02** | Decide | Low–Med | List establishment stays **cohort_statistic_only** (no per-exam date) — honest vs calibration bar; still high cognitive load for “when will my list post?” |
| **J-03** | Glance | Low | `#staffing` is not a first-class hash (tab is `#people`); mistaken deep links die into Money if user invents `#staffing`. |

### Not implemented (draft cards)

- **J-01** densify OASys map / NOE deep links beyond GetActiveExams overlap; measure deep-rate on open windows weekly.
- **J-02** only promote per-exam list dates when calibration scorecard clears ship bar (existing rule).

---

## 3. Hearing attender (Land + meetings logistics)

### What works (live-verified)

- Land detail `#land/2024Q0292`: ULURP pipeline sentence (“Public review — step 2 of 5: Borough President…”), statutory clock, ZAP comment handoff, **Watch this rezoning**.
- Attendance filter chrome (In person / Livestream) exists on the hearings status mode.

### Break points

| ID | Stage | Severity | Live evidence |
|---|---|---|---|
| **H-01** | Glance / act | **High** | `#land?status=hearings` → **“Upcoming land-use hearings: 0”** / empty list. Live snapshot: `hearings_extracted: 88`, `upcoming_count: 0`, `hearings: []`. Attender journey dead-ends on the dedicated filter. |
| **H-02** | Act | High | Empty copy was undifferentiated (“no match for filters”) even when the corpus itself has zero future dates — false “your filters” implication. |
| **H-03** | Act | Medium | Demo project action rail is ZAP portal / watch only — no venue/livestream calendar row when `hearing_logistics` is null on `/zap-outcomes`. |
| **H-04** | Decide | Medium | ZAP CPC “review session” milestones with future dates (e.g. 2026-08-10 on 2024Q0292) are not folded into the upcoming-hearings product list (disposition-field only). |

### Implemented this pass

- **H-02** fixed: empty state classifier (`site/land_hearings_empty.mjs`) distinguishes **none_future** vs **filters**; UI shows extracted count + refresh time + next steps (Meetings upcoming / Zoning in review).

### Not implemented (draft cards)

- **H-01 / H-04** expand materialization sources: disposition logistics **plus** future ZAP milestone review sessions with hearing-shaped titles; keep synthetic-row ban.
- **H-03** stamp `hearing_logistics` on cold `/zap-outcomes` for In Public Review demos even when list filter is empty.

---

## 4. District resident (Map → drill → watch)

### What works (live-verified)

- `#map` borough density + lens switch; SVG present; citywide/virtual bags.
- Queens CD drill: `#map?level=community_district&id=Q06&parent=Queens&lens=land` with CD counts.
- District detail exposes lens deep links e.g. `#land?boro=Queens&cd=Q06`, property/meetings borough links.
- `district_activity.json` live `built_at` current; land/property fully located; meetings 85/119 located.

### Break points

| ID | Stage | Severity | Live evidence |
|---|---|---|---|
| **D-01** | Watch | Medium | No **district-scoped watch** (“watch Q06 land”) — only generic/search/notice/project watches after drill. Resident must re-derive filters on Alerts. |
| **D-02** | Glance | Low–Med | Meetings still **34 unlocated** (`no_place_signal`); money map thin (8 corpus / 2 located). |
| **D-03** | Decide | Low | CD list after drill still shows sibling CDs prominently; detail actions compete with leftover global chrome (cognitive overhead). |

### Not implemented (draft cards)

- **D-01** `alerts` context-carry from map district (`lens` + `cd`/`council`/`boro`) primary CTA.
- **D-02** venue/matter densify for meetings map (existing location-derivation flywheel).

---

## Cognitive-load / one-in-one-out notes

| Surface | Observation |
|---|---|
| Property list | Chip rails (item / method / price / process / when) are dense but **actionable**; B-01 `$date` and B-02 past-first sort undid glance value until fixed. |
| Land hearings empty | Was a silent dead-end; honesty + outbound next steps reduce “did I break the filters?” tax. |
| Exam detail | Differentiator + deep apply + lag cohort is strong; list still floods with landing-only apply CTAs (J-01). |

---

## Ranked draft cards (next round — not in this PR)

1. **H-01/H-04** — Upcoming land hearings materialization: include future ZAP hearing-shaped milestones; keep synthetic ban; receipt with upcoming_count > 0 when portal has future dates.
2. **J-01** — Raise open-window deep-apply rate (OASys / NOE densify beyond GetActiveExams=9).
3. **D-01** — Map district → Watch this area (alerts context-carry with cd/council).
4. **B-03** — Force property KV rebuild so `/property-locations` stamps `commercial` + `commercial_metrics` (edge/client parity).
5. **B-04** — Price/deal extraction densify on timber + real-property upset language.
6. **H-03** — Per-project hearing logistics on land action rail when disposition fields exist.
7. **J-03** — `#staffing` hash alias → `#people` (or documented redirect).

---

## This PR — gap fills

| Gap | Change | Detector |
|---|---|---|
| B-01 close `$date` | i18n `property_commercial_close` all locales | `test/property_commercial_lens.test.mjs` rejects `${date}` |
| B-02 past-first sort | `sortPropertyExplorerEntries` future-first | same file, injected today |
| H-02 empty honesty | `landHearingsEmptyState` + land list empty UI | `test/land_hearings_empty.test.mjs` |

Validation: `node --test test/property_commercial_lens.test.mjs test/land_hearings_empty.test.mjs` (plus module-graph refresh if app module bytes change).
