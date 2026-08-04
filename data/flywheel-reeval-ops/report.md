# OPS workstream re-evaluation — delta against current state

**Status:** measured live (cache-busted production + local compile) · 2026-08-03  
**Baseline:** `cs-ontology-argument-eval` (2026-08-02) + backstage `cs-ops-*` factory (next-action rail, action events, extraction/review yield) + argument-eval cards `cs-ops-01..03`  
**Rule:** covered only when a live check proves it; shipped card ≠ working surface.

---

## What was re-checked

| Check | Method | Result |
| --- | --- | --- |
| Action registry compile + destination classes | `measureActionabilitySample` on committed fixture + `compileActionRail` | **deep rate 0.4737** (9/19) — still below flywheel bar 0.5 |
| Notice action rails (solicitation / award / hearing / rule / property / franchise / exam / zoning) | unit suite `test/action-rail.test.mjs` + hand compile of field shapes | **Working** for baseline kinds; honest unavailable on closed bid |
| Land upcoming hearings list + attend/watch CTAs | production `land_upcoming_hearings.json` + local twin | **Empty list** (`hearings_extracted=88`, `upcoming_count=0`) — CTAs cannot fire; may be calendar-quiet after early Aug, still a surface hole |
| Map drill → list | `areaFeedLinks` + live `district_activity` (e.g. council 1: meetings=34) | **Lobby lie** — non-land lenses opened citywide lists labeled as plain tab names while the map showed district counts |
| Property commercial panel | `compileActionRail` with commercial payload; notice remounts rail after commercial stamp | **Working** when `package_url` / steps present |
| Attachment preview | live `/attachment-metadata?id=20240515016`; `attachmentChipHTML` + extract | Preview + document chip **on context**, but GetFile DocumentID **did not** feed the action rail when body lacked package language |
| Exam OASys apply | live `oasys_exam_map.json` (9 deep NOE maps) + exam rail | **Working** deep vs browse labels |
| Alert context-carry | code + existing tests | **Working** (`#alerts?lens=&filter=&notice=`) |
| Outcome vocabulary (`OUTCOME_ENUM` / `outcome_recorded`) | grep call sites | **Still schema-only** — zero UI emission (argument-eval `cs-ops-01` still open) |
| Money list cards | `moneyRowHTML` | **No kinetic next-action chip** — title/meta only; rail only after detail open |

Production probes (no-cache): apex 200, `/contract-lifecycle`, `district_activity`, `land_upcoming_hearings`, `property-locations`, OASys map, attachment-metadata exemplar all reachable.

---

## Coverage map — baseline program → current verdict

| Program slice | Baseline claim | Live verdict | Evidence |
| --- | --- | --- | --- |
| Next-action rail on notice detail | Shipped | **COVERED** | `mountNoticeActionRail` / land `paintLandActionRail`; closed solicitation → unavailable not fake bid |
| Deep not lobby (handoffs) | PASSPort / OASys / GetFile classifiers | **PARTIAL** | Matched RFx+rfp_id deep; many static handoffs still search_page/landing; sample deep rate **0.47** |
| Honest no-action-no-button | Unavailable delivery | **COVERED** on rail | Closed bid / past event use dashed unavailable, not a dead primary button |
| Action-first inversion (list cards) | Staffing / property / meetings explorers | **PARTIAL** | Property/meetings/land-hearings cards have primary acts; **Money list has none** |
| Attendance actions | Hearings + land logistics | **PARTIAL** | Hearing guide + land list acts work in code; **upcoming hearings inventory empty** so land filter is a dead path today |
| Alert context-carry | Prefill + preview | **COVERED** | `alerts_context_carry` + boot prefill |
| Count-equals-list (map) | District counts → scoped feeds | **GAP** (fixed this round for labels) | Counts real; list links dropped place for money/rules always and for meetings/property at council |

### New surfaces since baseline

| Surface | Ops affordances? | Verdict |
| --- | --- | --- |
| Map drills | Counts yes; feed links often citywide lobby under plain lens names | **GAP → fixed honesty** this PR; true place filters for meetings/property@council still open |
| Upcoming hearings filter | Attend / watch / open project on cards | **Broken empty inventory** (88 past-or-filtered, 0 upcoming) |
| Exam process spine + apply | Apply deep/landing + spine | **COVERED** |
| Property commercial panel | Item / price / bid steps + rail remount | **COVERED** when sale-eligible |
| Attachment text preview | Chip + progressive extract | **PARTIAL** — preview yes; package handoff from GetFile **was missing** → fixed this PR |

---

## Gaps ranked (this round)

### Implemented (this PR)

1. **Attachment GetFile DocumentID → action-rail package_url**  
   When body extract misses a package URL but T0/T1 attachment metadata has a deep GetFile, the rail now opens the package (property auction path). Detector: unit test for deep vs bare GetFile.  
   Files: `site/action_registry.js`, `site/app/feed-actions.mjs`, `worker/src/lib/action_registry.mjs`, `test/action-rail.test.mjs`.

2. **Map feed scope honesty**  
   `areaFeedLinks` stamps `scope: district|borough|citywide` and citywide jumps use honest labels (`map_feed_citywide_*`). Council district no longer labels property/meetings as if filtered. Detector: `detectMapFeedScopeLobby` + tests.  
   Files: `site/map_exploration.mjs`, `site/app/map.mjs`, `site/i18n.js`, `test/map_exploration.test.mjs`.

### Draft cards for next round (not implemented)

| Rank | Id | Title | Effort | Why not now |
| --- | --- | --- | --- | --- |
| 1 | `cs-ops-map-place-filters` | Council/CD filters on meetings + property lists so map counts open the same bag | L | Needs list grammar + stamps (or district→id samples on `district_activity`); honesty labels only this round |
| 2 | `cs-ops-upcoming-hearings-empty` | Explain or recover land upcoming-hearings when extract≪0 upcoming | M | Need date-distribution proof (past-only vs parse drop); may be honest August quiet |
| 3 | `cs-ops-money-list-next-action` | Money list rows show primary kinetic chip (respond / award guide), not detail-only | M | Touches list density + a11y; separate from map |
| 4 | `cs-ops-01-outcome-wire` | Wire `OUTCOME_ENUM` / `outcome_recorded` after official handoff | S | Still zero UI call sites; argument-eval card remains valid |
| 5 | `cs-ops-actionability-deep-rate` | Lift fixture deep rate ≥0.5 (passport search_only, OASys landing, Checkbook bare search) | M | Flywheel already emits `actionability-low`; needs real deeper handoffs not sample gaming |
| 6 | `cs-ops-02` / `cs-ops-03` | Version interpretation rules; contest guides | M | Still valid; not re-measured as regressions |

---

## Recommendation

Keep the ops affordance program as **product law** (rail + deep + honest empty). The largest residual risk is **map count → citywide list** for meetings/property at council (honesty fixed; place filters not). Second: **upcoming hearings empty** despite 88 extracted rows. Third: **outcome loop** still unwired.

This PR closes two newly measured classes with detectors; draft cards above are ordered for the next serial wave.
