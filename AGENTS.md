# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## PR and CI preflight

- Run `./tools/preflight-required-checks.sh` before creating or handing back a PR URL and
  before opening a pull request. CI still runs the full accessibility and runtime
  stray-English work after Unit checks.

## CI path fast paths and merge queue

- Required checks always report a conclusion (never stay missing). Fast paths:
  `changelog_only` (bot-owned changelog files) and `docs_only` (`tools/docs-only-path-guard.sh`)
  skip the full unit suite; non-frontend PRs skip browser a11y / reading-level
  heavy work while still posting SUCCESS. Performance budgets run only when `frontend` changes.
- Stray-English: **Unit static lint only** (`test/standards/stray_english.py`). The runtime
  multi-locale walk (`test/functional/13_stray_english.py`) is **not** a CI job or required
  check — optional locally via that script or `run_stray_english_shards.sh`. Required merge
  checks are Unit, Accessibility + language, and Reading-level (three total).
- Playwright installs go through `.github/actions/setup-playwright` (browser cache for a11y/perf).
- Merge-queue parameters: `tools/merge_queue_policy.json` + `node tools/apply_merge_queue_policy.mjs`
  (short train wait). Concurrent merge-when-ready seating for this repo is capped outside this tree.

## Maintaining this file

- Keep this file for durable project-intrinsic facts that should outlive any one pull request.
- Prefer pointers to authoritative commands/files over duplicating implementation details.


## README live screenshots

`tools/capture_readme_screens.py` → `docs/readme/*.png` (linked from root `README.md`).
Captures the live site. Each frame waits on data-bearing selectors (not network-idle /
fixed sleep) and **fails if a skeleton is still visible** (`.today-skeleton`, `.empty.skel`,
`.skl`). Homepage must clear the email CTA (`#homeCta`) and the default Contracts list
(`#list .row`). Data page must clear
section counts and chart bars (sections paint last; "Counting 1M…" / "Loading…" are not ready).
Re-run: `python3 tools/capture_readme_screens.py`. Eyeball PNGs before commit.

## PASSPort Public machine path

PASSPort Public has **no Socrata dataset** for contracts/RFx. Stable machine dumps:

- `https://a0333-passportpublic.nyc.gov/dataJs/contractData.js` (`public_ctr_data`)
- `https://a0333-passportpublic.nyc.gov/dataJs/rfxData.js` (`public_rfx_data`)

Edge materialization: `worker/src/passport.mjs` → D1 `passport_contracts` / `passport_rfx`.
Strict EPIN↔PIN join: `worker/src/lib/passport_join.mjs`. Measured rates live in
`site/data/source_contracts.json` (`join_measurement`) and
`site/data/passport_sources/verification_receipts/`.
Deploy applies D1 migrations before worker code (`deploy-worker.yml`); `ensurePassportSchema`
is the runtime safety net. `lookup_status` is three-state: `ok` / `error` / `skipped` —
error must never render as a confident empty miss. Characterization:
`node --test worker/test/passport_lookup.test.mjs`.

Solicitation response handoffs are evidence records, not generic bid links:
`site/action_registry.js` → `solicitationHandoff`. Notice-named agency systems take
precedence; PASSPort matches hydrate the guide from `rfx_detail`; unmatched EPIN-shaped
notices get a search recipe because PASSPort Public has no stable per-RFx URL. Keep the
field cases in `test/action-rail.test.mjs` and visual evidence in
`tools/capture_passport_bid_guide.py`.

**Package documents (measured stop, 2026-07-30):** `public_rfx_data` has **no document
URL columns**. Kill sample on 50 Solicitation+PIN notices: EPIN join **38%**, document
URL join **0%** (modern universe 0/1470). OCP `3khw-qi8f` and City Record solicitation
`document_links` also **0%** for `start_date` ≥ 2025-01-01. Gap
`procurement-solicitation-documents` is class (b) **not_published** → City Record
GetFile (`a856-cityrecord.nyc.gov/Search/GetFile`). Do not edge-materialize package
docs from RFx; RFx **metadata** materialization is unchanged. Helpers/receipt:
`worker/src/lib/rfx_documents_join.mjs`,
`site/data/passport_sources/verification_receipts/passport_rfx_documents_2026-07-30.json`.

## Bid Tabulations Historical (`9k82-ys7w`)

Ranked class-(a) bid-count source. **Measured below usefulness** (2026-07-30): strict
PIN↔`bid_number` join is **0%** on Procurement notices since 2025-01-01 and **9.07%** on
2016–2021 overlap (no PIN column; openings end 2021-03-24). Source contract
`bid-tabulations-historical` is **disabled** — no edge materialization. Strategies and
receipts: `worker/src/lib/bid_tabulations_join.mjs`,
`site/data/bid_tabulation_sources/`.

## Doing Business Search Entities (`72mk-a8z7`)

Vendor identity enrichment (listing, ownership structure, phone, start date). **Measured
above usefulness** (2026-07-30): `vendorStem` join is **70.42%** notice-level and
**61.62%** of distinct vendors on modern awards (`start_date` ≥ 2025-01-01). Four
columns only (no EIN/BIN/PIN). Source contract `doing-business-entities` is **live**
edge-materialized onto daily vendor-profile rebuilds (`doingBusiness` field).
Strategies and receipts: `worker/src/lib/doing_business_join.mjs`,
`site/data/doing_business_sources/`. Publisher dates often use truncated `00YY` years —
normalize to `20YY` before display.

## ULURP Recommendations (`4j6i-9rmr` + PDF `gt5i-dmde`)

Land-outcome depth candidate (Borough President positions + letter PDFs). **Measured
below usefulness** (2026-07-30): strict ULURP-token join on ZAP projects with non-null
`ulurp_numbers` is **0.54%** either-source (152/27,971), **0.29%** recommendations,
**0.25%** PDFs. Borough-scoped historical catalogs (91 + 88 rows). Source contracts
`ulurp-recommendations` and `ulurp-recommendation-pdfs` are **disabled** — no edge
materialization; keep the class-(a) land-outcome pointer. **Wrong universe:** Property
Disposition notices are not ZAP projects — do not use that slice as a success metric.
Strategies and receipts: `worker/src/lib/ulurp_recommendations_join.mjs`,
`site/data/ulurp_recommendation_sources/`.

## Land/ZAP event spine

`GET /zap-outcomes?id=` returns `record.spine`: a date-normalized rail joining ZAP API
milestones/dispositions with City Record notices by strict ULURP token. Each event carries
`time` (value/precision/basis/certainty) and a named source URL; `gaps` preserves class-(a),
class-(b), and operational-unavailable states, while `lag.open_data_vs_portal` compares the
two published milestone dates without treating Open Data as live. Pure characterization:
`node --test test/land_event_spine.test.mjs`. UI capture:
`python3 tools/capture_land_event_spine.py`.

## Legistar agenda/vote depth

Ranked class-(a) meeting-outcomes depth. **Edge materialization is live** (daily
cron) with Worker secret `LEGISTAR_API_TOKEN` (full multi-segment key as `token=`
query; first segment alone → 403). GitHub Actions secret syncs on worker deploy.

- Modern City Council notice → Legistar event join: **100%** (59/59)
- Joined events with EventItems: **100%**; matter-linked items: **98.3%**; roll-call
  votes sampled on ~**10%** of subcommittee hearings (voice/committee outcomes use
  inline `EventItemActionName`)
- Nested routes: `Events/{id}/EventItems`, `EventItems/{id}/Votes`,
  `EventItems/{id}/Attachments` (top-level EventItems/Votes are 404)

Client: `worker/src/lib/legistar_client.mjs`. Strict join: `worker/src/lib/legistar_join.mjs`.
Read model: `worker/src/lib/meeting_outcomes.mjs` → KV `meeting-outcomes:materialized:v2`.
Open Data `m48u-yjt8` remains a **disabled** freeze through 2024-12-19 (0% modern).
Receipts: `site/data/legistar_sources/`. Demo: notice `20260706036` → event `22526`.

**Official entity family (person-level votes):** Legistar roll-call rows retain
`PersonId`/`PersonName` as `official:{person_id}` objects with typed `votes_on`
edges (official → matter|agenda_item), not only aye/nay tallies. Pure helpers:
`entity_resolution/officials/`. Named metrics: `person_vote_retention_rate` and
`official_votes_on_edge_rate` (receipt under
`site/data/legistar_sources/verification_receipts/`). Meeting UI renders roll call
when `by_person` is present. `source_records` dual-write for Legistar votes remains
a gap. Verify: `node --test test/official_entity_family.test.mjs
test/legistar_client.test.mjs test/contract/meeting_outcomes.test.mjs`.

## Content and testing — lifecycle gap taxonomy

**Standing contract:** every absent-data state on a lifecycle surface must tell the reader *which kind of gap* it is. Never ship an undifferentiated “no record” / “unknown” / blank slot when the product has decided a field is missing.

| Class | Reader-facing register | Meaning |
|---|---|---|
| **Not yet ingested** | “Not yet shown here — … live in *source*.” | A public source publishes this field; the empty slot is incomplete join or a missing adapter. Name the source. |
| **Not published** | “The city does not publish this — it would appear in *where* if released.” | No public, joinable release is known. Name the logical home when one exists. |

Keep **per-item** specificity (pending vs registered vs payments; subsidy outcome vs company field; Council vote vs matter). No page-level disclaimer in place of a slot-level line.

**Out of taxonomy (keep operational wording):** source unreachable (`lifecycle_unknown_html`, `subsidy_source_unavailable_html`) and multi-match ambiguity (`lifecycle_ambiguous_html`).

**Where it lives**

- Depot (join graph + gap inventory + ranked class-(a) ingest list): [`site/data/gap_taxonomy.json`](site/data/gap_taxonomy.json) — `sources` / `crosswalks` are the graph; `gaps` are the slots
- Direction page (generated): [`docs/gap-taxonomy.md`](docs/gap-taxonomy.md)
- Re-derive after source-contract or taxonomy changes: `node tools/depot_rederive.mjs` (CI drift gate: `--check`)
- Characterization: `node --test test/gap_taxonomy.test.mjs test/depot_rederive.test.mjs`
- Screenshot capture: `python3 tools/capture_gap_taxonomy.py`

### Live source-contract monitor

Daily workflow `.github/workflows/source-contracts-live.yml` →
`node tools/verify_source_contracts.mjs --live`. Fixture check stays in PR CI; live
alerts open/update the drift issue.

**Probe classes (keep teeth, cut CI noise):**

- **Ingest** (default Socrata/Checkbook/RSS): schema + sample + freshness gate
- **Pointer** (`contract_class: "pointer"`, `stale_policy: "skip"`): existence +
  schema only — Capital Projects is the exemplar
- **Bot-blocked egress** (`egress_class: "bot_blocked"`, often with
  `landing_probe: "bot_blocked"`): CI runners get HTTP 403 from the publisher (PASSPort
  HTML **and** dataJs). That is not upstream drift — product freshness is the Worker’s
  materialization. Still fail on non-403 failures (404, DNS, empty body when reachable)
- **Auth API** (`auth_token_env`, e.g. Legistar): with token → 200 JSON; without →
  HTTP 403/401 is the expected gate, not a failure. Wire `LEGISTAR_API_TOKEN` into the
  live workflow when present
- **Templated endpoints**: require `probe_sample_id` or `probe_endpoint` (never probe
  the literal `{project_id}` path)
- **Checkbook Spending**: product shape is Contracts-then-Spending-by-`contract_id`
  (PIN is rejected); required XML fields are `contract_id`, `payee_name`,
  `check_amount`, `issue_date`

Every live failure line must name `source_id` and URL class. Never emit bare
`fetch failed`. After registry edits that touch landing URLs, run
`node tools/depot_rederive.mjs` so gap taxonomy does not retain a stale copy.

When adding a new lifecycle empty state: pick class a or b with evidence, add or update the inventory row, use the matching register in English and all shipping locales, and extend the characterization test. Prefer pointing new work at the inventory over inventing a third gap register. After landing a source or stamping `join_measurement`, run `depot_rederive.mjs` so realized coverage, candidate crosswalks, and the ranked queue stay current.

### Lifecycle rendering coherence (notice detail)

Precompute-first on the notice page: never live Checkbook proxy; never render `lifecycle_unknown_html` (“Could not reach…”) as a public data gap. Coerce `unknown` → taxonomy unmatched, or **passed** when a later stage is matched. No-PIN collapses Checkbook stages into the single class-(b) note. Format zero amounts with `lifecycleMoney` (`$0` / `—`), never literal `null`.

**One owner per fact (lifecycle vs detail):** when the Checkbook registration join exists, the payments card **summarizes** (`$X paid of $Y committed`, zero-lag note when $0-fresh) and anchor-links to `#follow-the-dollars`; it never emits class-(a) gap copy in parallel. Follow-the-Dollars owns paid-to-date detail and must not re-emit the payments gap. Gap register for payments only when the join is genuinely absent (no PIN / no registered record). Same ownership rule for subsidy: project-level unmatched is one note, not stacked per-stage gaps. Characterization: `node --test test/lifecycle_coherence_field_cases.test.mjs` (symptom: *joined payments rendered as not-shown, duplicated*). Captures: `python3 tools/capture_lifecycle_coherence.py`.

## Changelog harvest

Public surface: `site/changelog-data.json` + `site/changelog.html` (not repo-root). Workflow:
`.github/workflows/update-changelog.yml` → `tools/prepare-changelog-base.sh` →
`tools/gen_changelog.mjs`. Editorial bar: `changelog:major` **and** an accepted user-impact
heading (canonical `## What this means for you`; aliases in `tools/changelog_extract.mjs`).
**Vacuity tripwire:** major label with nothing extractable, or major with an empty `site/`
delta that is not already-recorded, fails the job — never a green no-op. Convention:
`CONTRIBUTING.md` “Changelog entries”. Characterization: `test/changelog_*.test.mjs`,
`test/changelog_entry_gate.test.mjs`.

**Self-merge / merge queue:** main’s ruleset requires three named checks (see
`update-changelog.yml` `REQUIRED_CHECKS` and `tools/merge_queue_policy.json`). Changelog-only
bot PRs take `ci.yml`’s `changelog_only` fast path so those check names report SUCCESS within
about a minute (workflow_dispatch + merge_group); without that, the queue waits forever.
Auto-merge arms with `gh pr merge --auto` (no strategy flag — the queue’s method is SQUASH).
Path guard: `tools/changelog-path-guard.sh`. Characterization: `test/changelog_queue_checks.test.mjs`.

## Live-URL smoke target sets

Post-deploy gate: `node tools/live_url_smoke.mjs` (default set includes apex, www, crol-list redirect host, about). Named opt-in sets do not change production routing:

- `--set pages-dev` — parallel host only (or `--base-url https://cityscroll.pages.dev`)
- `--set post-flip` — post-cutover URL matrix **plus** named incident checks (EMAIL HEALTH, STATS SANITY, WORKER ACCESS, HUMAN-PATH JOURNEY in `tools/post_flip_checks.mjs` + `tools/human_path_journey.py`); select only after an owner-authorized flip

Migration value baseline (merge-to-live wall-clock, detection exemplars, rollback estimate): `docs/evidence/hosting-migration-baseline.json`. After cutover, measure against it — do not assert improvements.

Characterization: `node --test test/live_url_smoke.test.mjs test/post_flip_checks.test.mjs`. Operator flip procedure lives outside this public tree.


## Hearing participation (one owner, list + detail)

Meetings list cards and notice permalinks share one derivation:
`normalizeHearing` / `normalizeHearingRow` → `participation.links` →
`participationLinksHTML` in `site/index.html`. Strip trailing punctuation
**before** dedupe (body often has `https://…hearings,` and `https://…hearings`);
one outbound affordance per notice. NYCIDA board URL labels as **IDA meetings page**
(the deepest public target those notices publish). Characterization:
`node --test test/ida_notice_defects.test.mjs`. Captures:
`python3 tools/capture_ida_notice_defects.py`.

## Contract lifecycle category gate

`isContractLifecycleEligible` — Procurement section or Solicitation/Award/Intent
types only. Hearings, Agency Rules, Property Disposition, and Changes in Personnel
never mount contract lifecycle / OCP / PIN gap modules (wrong-universe). Subsidy and
meeting-outcomes keep their own eligibility helpers. Characterization:
`test/ida_notice_defects.test.mjs`, `test/lifecycle_coherence_field_cases.test.mjs`.

## Subsidy lifecycle (NYCIDA / Build NYC)

Endpoint `GET /subsidy-lifecycle?id=` (`worker/src/subsidy_lifecycle.mjs`). The
EDC documents page is often Cloudflare-blocked to edge fetch (HTTP 403 / challenge
HTML) — treat as feed failure, do **not** permanently D1-cache `source_status:
unavailable`. When the feed fails, `projectFromIdaNotice` derives a hearing-stage
join from the City Record IDA hearing notice (company names, event date). Keep
honest unavailable copy only when the feed is down **and** no notice-derived
hearing applies. Schema safety net: `ensureSubsidySchema` (migration
`0005_subsidy_lifecycle.sql`).

**Age-aware gap kinds** (temporal sibling of paid / verified_zero / unavailable):
`subsidyGapKind` → `too_soon` | `not_published` | (worker) `unavailable`. Lag table
`SUBSIDY_STAGE_EXPECT_LAG_DAYS` (board ~60d, closing ~180d, project_record ~90d).
Demo/backtest notices must be **aged** (2022–2024 hearings) so later stages read
`not_published`, not “could not reach.” Young hearings use “check back” copy.
Characterization: `test/subsidy_lifecycle.test.mjs`, `test/ida_notice_defects.test.mjs`.
Aged demo ids: `20220525018`, `20231004016`, `20240617012`.

## Checkbook Contracts row identity

Checkbook's Contracts domain returns **multiple rows per `prime_contract_id`** (one Prime Vendor row with amounts, plus Sub Vendor / expense-category slices with $0 on prime fields). Lifecycle assembly collapses rows with `aggregateContractsById` before `classifyStage` — one distinct id = matched; ≥2 distinct ids = ambiguous. Field case: notice `20231222103` / `CT107120248803393`. Do not count raw Contracts rows as separate contracts. Spending rows stay uncollapsed (many payments per contract is normal). Pure lib: `worker/src/lib/checkbook_lifecycle.mjs`.

## Paid-to-date one-owner (payments card ↔ Follow-the-Dollars)

Both surfaces use the same resolution (`lifecycleResolvedPayment` in `site/index.html`; server `recoverPaymentFromRegisteredJoin` after PASSPort fill). Prefer spending-feed totals; fall back to registration `spent_to_date` when the join has it. **"Unavailable" only when neither path has a figure** — never invent confident $0 over a spending-error when registration spent is also 0. Field case: notice `20240723114` (PASSPort registered $4.02M paid while payment stage was unknown). Characterization: `test/lifecycle_coherence_field_cases.test.mjs`.

## Notice payment panel (deep link + vendor match)

- Payments-card → dollars: `#notice/<id>?focus=follow-the-dollars` (never bare `#follow-the-dollars` — applyHash falls through to Money). Scroll after lifecycle render via `scrollToLifecycleFocus`.
- Outbound Checkbook: `checkbookSearchUrl({contractId, pin, vendor})` → smart_search when a term exists.
- Vendor mismatch: `vendorNamesMatch` (vendorStem + truncation/token overlap). HNTB truncation must not warn; true mismatches still do. Soft variant copy: `lifecycle_dollars_vendor_variant_html`.
- Payment honesty: Checkbook Spending rejects `pin` (code 1101) — join by `contract_id` after Contracts. Three states via `payment_state`: `paid` / `verified_zero` / `unavailable` (never confident `$0` on feed error).
- Characterization: `node --test test/lifecycle_coherence_field_cases.test.mjs test/lifecycle_render.test.mjs test/unit.test.mjs` and `cd worker && node --test test/checkbook_lifecycle.test.mjs`.

## Capital Projects planning pointer (`n7gv-k5yt`)

Class-(b) pointer for `procurement-planning-budget` only. Dataset has **no
PIN/EPIN**; agency+name fuzzy join measured **≤1%** on modern Procurement
(2026-07-30) — below usefulness. Do not edge-materialize. Receipt:
`site/data/capital_project_sources/verification_receipts/capital_projects_2026-07-30.json`.
Helpers: `worker/src/lib/capital_projects_join.mjs`.

## Civil Service List closed-exam aggregates (`vx8i-nprf`)

PII hard rule: exam-level group-by only (`list_count`, dates, `title_count`).
Closed-exam exam_no overlap **44.54%** (494/1,109) — ship post-list depth;
open-exam overlap 0%. Artifact:
`site/data/exam_sources/civil_service_list_aggregates.json` joined at build via
`tools/build_staffing_exams.mjs` + `worker/src/lib/civil_service_list_join.mjs`.
UI: `list_joined` outcome view when annual DCAS outcomes are absent.

## Digest watermark recovery (catch-up digests)

**markSeen policy (hard rule):** `markSeen` advances the delivery-adjacent seen set
ONLY after a real send (`if (send && rows.length)`), never on observe. The old
`!capped` gate advanced seen during dry-runs and quiet runs, silently swallowing
fresh notices so the next run treated them as already-seen — the watermark-poisoning
bug. Applies to all three paths: config watches, `processOneSub`, `processAwardSub`.

**Catch-up mode** (`runCatchUpDigests`): when delivery was broken for days, recovery
sends the **missed stream since the lastsent watermark**, not a single post-unclog drip.
Procedure: detect lag (≥ `minLagDays`) → clear seen → recompute query with raised limit
+ `start_date >= watermark` floor → send one clearly-labeled catch-up email → advance
watermark only on success. Tracks `digest_catchup` stats separately from normal volume.

**Triggers:**
- Admin: `POST /admin/digest-catchup` (ADMIN_KEY, body `{ minLagDays?, subKeys? }`)
- Cron: env `DIGEST_CATCH_UP=1` (one-shot; prefer admin for operator control)

**Stats:** `/stats` digests block carries `catch_up_sent_today`,
`catch_up_sent_all_time`, `catch_up_last_run`, `lagging_subs`. Operator can show
catch-up rows via daylog `action: "catch_up"` (and `traffic_class: "catch_up"`).

**Ops correctness (day-scoped recount):** `correctnessCheck` in
`worker/src/lib/digest_ops.mjs` must **not** flag catch-up sends as
`phantom_send` / `count_mismatch` when a focus-day recount is 0 or lower than
the multi-day recovery total. Detect via `action` / `traffic_class` / `mode`
`catch_up` (historical rows may only have `action`). Result includes
`catchUpExempt`. Characterization: `node --test test/digest_ops.test.mjs`.

**Catch-up daylog under queue mode:** `runCatchUpDigests` always merges stamped
daylog entries (`action`/`traffic_class: catch_up` via `toDayLogEntry`) even when
`QUEUE_DIGESTS=true` — queue daily fan-out only seeds the daylog; catch-up is a
separate path and must not skip observability. **Daily lag recovery stamp:**
`processOneSub` / `processAccountRollup` set `traffic_class: "catch_up"` when
lastsent lag is **>1 day** and fresh notices are sent (`isMultiDayLagRecovery`);
email copy stays normal daily (`action: match`). `toRollupDayLogEntry` preserves
the stamp. Without the stamp, desk shows false `phantom_send` for multi-day
recovery under queue mode.

Characterization: `node --test test/markseen_policy.test.mjs test/digest_catchup.test.mjs`.

## Civic-time event contract

Shared event envelope + bounded kind registry for Money/Rules/Land/Meetings.
Clocks: valid, publication, observation, processing — never invent publication from
processing. ADR: `docs/adr/civic-time-event-contract.md`. Pure lib:
`worker/src/lib/civic_time.mjs` (Rules/Land/Meetings adapters; Money production adapter
`mapMoneyLifecycleToCivic` / `attachMoneyCivicEvents` on `computeLifecycle` →
`civic_events` on `/contract-lifecycle`). Metric: `money_spine_adapter_coverage`
(notices with ≥1 Money civic event / procurement lifecycles). Verify:
`node --test worker/test/civic_time_contract.test.mjs worker/test/checkbook_lifecycle.test.mjs && node worker/scripts/civic-time-diff.mjs --fixtures worker/test/fixtures/civic-time --check`.
Digest delivery identity remains `docs/digest-time-ontology.md` (separate concern).

## Subject registry (cross-spine subject_ref)

Shared `kind:id` subject vocabulary + typed links so civic-time, lifecycle, ER source
records, claim layer, and ops action objects resolve the **same** real-world object
without silently rewriting `notice:` into `contract:`. Pure lib:
`worker/src/lib/subject_registry.mjs`. Product surface: `assembleLifecycle` stamps
`subject_refs` + `subject_links` on confident notice↔contract joins. Metric:
`cross_subject_link_rate` on PIN-bearing awards
(`worker/test/fixtures/subject-registry/pin_bearing_awards.json`). ADR:
`docs/adr/subject-registry.md`. Verify:
`node --test worker/test/subject_registry.test.mjs`.

## Ops contract (desk ↔ worker)

Versioned machine-readable ops schema so private desk panels stay mechanically aligned
with the public worker (digest modes, daylog actions/fields, stats metrics, admin routes
+ auth classes, KV prefixes, feature flags). No secrets; never on public `/stats`.

- Pure builder: `worker/src/lib/ops_contract.mjs` → committed fixture
  `worker/ops-contract.v1.json`
- Served: `GET /admin/ops-contract` (`ADMIN_KEY`, fail closed)
- Usage `traffic_class`: `production` | `developer` (`blob7`; public SQL keeps production
  only). Developer key is `ANALYTICS_DEV_KEY` (not `USAGE_KEY` / Haiku meter).
- Verify: `node --test worker/test/ops_contract.test.mjs`

## Digest time ontology

Digest freshness uses semantic delivery keys, not source timestamps: event time controls
actionability, publication/recorded time are provenance, and source identity + actionable state
is the idempotency key. This lets a late Rules/Legistar enrichment notify once without a
republish sending twice. Contract: `docs/digest-time-ontology.md`; characterization:
`node --test worker/test/alert_temporal.test.mjs`.

## Non-Council hearing outcomes (copy)

Non-Council unmatched slots use class-(b) copy naming borough president websites
and community board minutes pages (`meeting_outcomes_non_council_*`). Council
notices keep Legistar class-(a) unmatched copy. Detection: `isCityCouncilNotice`
on `agency_name`.

## Digest rollup + preference center

Account-level digest: when an email has **>1 active watch**, one consolidated
email per day (sections per watch); one email = one send unit. Preference
center: `GET/POST /prefs` (token `sc: "prefs"`). Edits take effect **next daily
cron (~9am ET)**. Unsub: per-watch `{k}` or all-watches `{all:1,e}`. Admin
dry-run: `GET /admin/digest-rollup?key=&email=`. Design:
[`docs/digest-rollup-prefs.md`](docs/digest-rollup-prefs.md). Tests:
`cd worker && node --test test/rollup.test.mjs test/prefs_lib.test.mjs test/prefs.test.mjs test/digest_rollup.test.mjs`.

## Magic-link session + server pins

Digest notice links carry a pins-scoped optin-token (`sc: "pins"`, ~30d) as `?s=`
on `/r/...`. Exchange sets HttpOnly `cs_session` cookie (~14d); token never
forwards to the final cityscroll.org URL. Scope is READ + pin sync +
preference-center bootstrap. Recognized `GET /session` returns the account email
and clean `/prefs` URL; cookie-authenticated `GET /prefs` mints the narrower prefs
token used by its forms. Watch mutations, unsubscribe, and confirm keep purpose
tokens and never accept the session directly.

- Worker: `session.mjs`, `pins.mjs`, pure helpers `lib/session.mjs`
- KV pin store: `pins:<opaqueActorId(email)>` in SUBS (alongside subscriptions)
- Client: `invStore`/`invSave` still localStorage; recognized sessions merge
  (union, dedupe by type+id) then read/write `/pins` with `credentials:include`
- Banner: `#sessionBanner` ("Not you?" → `/session/logout`)
- Characterization: `node --test worker/test/session_pins.test.mjs test/session_pins_client.test.mjs`

## Microsoft Clarity (optional heatmaps)

Dormant until a project id is set. Loader: `site/clarity.js` (all public pages).
Config: `window.CROL_CLARITY_PROJECT_ID`, meta `crol-clarity-project-id`, or
`CONFIGURED_PROJECT_ID` in that file — leave empty to keep off. Skips on DNT/GPC;
masks form inputs; operator must set dashboard Masking mode to **Strict**.
Characterization: `node --test test/clarity.test.mjs`. Privacy copy: About → Privacy.

## Public feedback

Team inbox is **feedback@cityscroll.org** (footer mailto on `site/index.html` /
`site/about.html`, About form one-liner, worker `FEEDBACK_TO` / `DEFAULT_TO`).
`/feedback` is rate-limited + validated; **no Turnstile** on form or handler.
Fails closed without `RESEND_API_KEY` + `FEEDBACK` KV only. Characterization:
`node --test worker/test/feedback.test.mjs test/homepage_cta.test.mjs`.

## Versioned action log

Successful pin/watch interventions and false-split desk dispositions append privacy-safe rows to
D1 `action_log` through `worker/src/lib/action_log.mjs`; no actor, email, IP, cookie, account, or
session identifier is accepted. Desk evidence keeps operator-facing actor/note fields separately;
the product log only records pair id + enumerated decision. Same/different review actions export
to gold-ready candidates via `tools/export_review_actions_to_gold.mjs` (never overwrites
`gold_vN.jsonl`). Contract and characterization: `docs/action-log.md`,
`node --test worker/test/action_log.test.mjs worker/test/false_split_evidence.test.mjs
test/review_action_export.test.mjs`.

## Entity resolution (foundation)

Link-not-merge taxonomy ADR: [`docs/adr/entity-resolution-taxonomy.md`](docs/adr/entity-resolution-taxonomy.md).
Full five-table sketch: [`docs/entity-resolution/schema-sketch.sql`](docs/entity-resolution/schema-sketch.sql).
No LLM matching as primary matcher. No public consumer reads link tables yet.

**source_records dual-write (er-02):** migration `worker/migrations/0008_source_records.sql`;
flags `CITY_RECORD_SOURCE_RECORD_DUAL_WRITE=true` and `ENTITY_LINK_DUAL_WRITE=true` in the
production Worker vars enable the fail-soft shadow path on City Record ingest; beta explicitly
sets both false. Integration characterization: `node --test worker/test/er_ingest_integration.test.mjs`.
Verify: `node --test worker/test/source_record_dual_write.test.mjs`.

**Source-observation coverage (er-22 + Checkbook contracts/spending):** machine-checked importer
inventory and measured before/after coverage live in `entity_resolution/source_coverage.json`.
PASSPort contracts/RFx use `PASSPORT_SOURCE_RECORD_DUAL_WRITE`; Checkbook Contracts and Spending
request-time XML rows share `CHECKBOOK_SOURCE_RECORD_DUAL_WRITE` (fail-soft; Prime/Sub Vendor
slices and payment documents keep distinct `source_system_id`s via
`worker/src/lib/checkbook_source_records.mjs`). Public reads do not consume the observations.
NYCHA, Legistar, ABO, doing-business, and NYCIDA streams remain inventory gaps. Metric:
`source_coverage` covered/total (5/13 after spending dual-write). Verify:
`node tools/check_er_source_coverage.mjs --matrix entity_resolution/source_coverage.json &&
node --test worker/test/er_source_coverage.test.mjs worker/test/checkbook_source_records.test.mjs`.

**entity_link + resolution_run (er-07):** migration `worker/migrations/0009_entity_link.sql`
(+ `canonical_entity` for link targets). Opt-in shadow writer only for exact-stem
`auto_link` cases (`method=vendor_stem_v1`): pure
`worker/src/lib/entity_link.mjs`; production writes are shadow-only and public reads do not
consume these tables.
Verify: `node --test worker/test/entity_link_schema.test.mjs`.

**Package boundary (er-08):** modular monolith under `entity_resolution/`
(`normalizers`, `candidate_generation`, `features`, `matchers`, `policies`,
`evaluation`, `review`) — in-process only, **no public HTTP ER routes**.
Extract criteria + non-goals: `entity_resolution/README.md`. Verify:
`node --test worker/test/entity_resolution_package.test.mjs`.

**Normalize lib (er-03):** `entity_resolution/normalizers/` owns `vendorStem` (+
agency `canonicalAgency` re-export / `sameAgency`). `worker/src/lib/normalize.mjs`
and `compile.mjs` re-export for call-site stability. Equal/distinct pin table:
`worker/test/fixtures/normalize_pairs.json`. Verify:
`node --test worker/test/vendor_stem.test.mjs worker/test/normalize_fixtures.test.mjs`.

**Agency rename residual (gold false_split):** alias dual names in
`worker/src/lib/agencies.mjs` `GROUPS` so ER stem + identity enrichment share one
`canonical_id` (DoITT→OTI, county DA↔borough DA office, Business→SBS). Keep site
ids stable so `agency_crosswalk.json` keys still match. Borough DAs stay distinct.
Verify: `node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v0.jsonl --blocker token_v0`
→ `false_split=0` `false_merge=0` `recall=1`. Captures:
`python3 tools/capture_agency_false_splits.py`.

Gold set + metrics harness (eval only): `entity_resolution/eval/` —
`gold_v0.jsonl` (versioned; never silent-mutate labels/membership) and
`run_metrics.mjs` (also re-exported from `entity_resolution/evaluation/`). Verify:
`node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v0.jsonl --dry-run`
(prints precision/recall/candidate_recall/unresolved_rate/false_merge/false_split;
nulls OK until matchers).

**Candidate generation v0 (er-05):** offline token/stem blocker
`entity_resolution/eval/blockers/token_v0.mjs` — reused by the package candidate-generation
surface; it remains matcher-neutral and does not merge source rows.
Verify:
`node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v0.jsonl --blocker token_v0`
(`candidate_recall` ∈ [0,1]; blocked-in/out true matches printed).
Characterization: `node --test test/entity_resolution_blocker.test.mjs`.
Details: `entity_resolution/eval/README.md`.

**Silver authority harness (er-11):** `entity_resolution/eval/run_authority.mjs`
derives silver labels from the newest immutable `source_records` snapshots.
Shared PIN/EPIN or contract ids measure `authority_recall`; name-similar rows with
disjoint comparable ids measure `authority_conflict_auto_link_rate`. The committed
fixture is characterization data, not a production measurement. Verify:
`node --test test/entity_resolution_authority.test.mjs`.

**Features + matcher (er-09, extended by er-19):** `entity_resolution/features/` extracts
deterministic family-aware stem/token/authority-key/length signals;
`entity_resolution/matchers/` emits
`same` / `different` / `unresolved` without LLM scoring. PIN and EPIN share one candidate
identifier family; blocked-out true matches remain visible in the metrics report. Verify:
`node --test worker/test/entity_resolution_matcher.test.mjs` and
`node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v0.jsonl --blocker token_v0`.

**Scoped authority keys (er-19):** PIN/EPIN matcher evidence is a complete
`(scheme, issuing authority, value, scope)` tuple from
`entity_resolution/authority_keys/`, never raw-value equality across schemes or scopes.
Parser fixtures: `entity_resolution/eval/fixtures/authority_key_pin_epin_v1.json`.
Verify: `node --test test/authority_key_registry.test.mjs test/entity_resolution_authority.test.mjs`.

**Live false-split desk (er-10):** keyed GET `/admin/possibly-same` reads recent
`source_records`, blocks them with `token_v0`, and excludes pairs sharing a
`canonical_entity_id`; it never writes review or merge state. Pure/read path:
`worker/src/lib/possibly_same.mjs`. Characterization:
`node --test worker/test/possibly_same_admin.test.mjs`.

**False-split evidence tray (er-14):** the same authenticated route renders source-linked
records and accepts `same` / `different` / `defer` dispositions. Migration
`worker/migrations/0010_false_split_disposition.sql` makes those events append-only;
they never update `entity_link`. Characterization:
`node --test worker/test/false_split_evidence.test.mjs`.

**Assertion evidence rail (er-18):** conflicting amount/date values in the tray retain
their exact publisher field and value as source assertions; normalization and conflict
detection are separately labeled CityScroll interpretations and never select a winner.
Pure model: `entity_resolution/review/assertion_evidence.mjs`. Characterization:
`node --test test/entity_resolution_assertion_evidence.test.mjs`.

**Evidence claim layer (public):** source assertion ≠ CityScroll interpretation ≠
derived conclusion. Charter: `docs/adr/evidence-assertion-layer.md`. Shared builders:
`worker/src/lib/claim_layer.mjs`. First product surface: OCP award side-car disagreements
on notice lifecycle (`lifecycleOcpAwardHTML` + `corroborateAward` claim_layer rows).
Dossier display name is a `derived_conclusion`, not a publisher field. Verify:
`node --test worker/test/claim_layer.test.mjs worker/test/ocp_awards.test.mjs
test/lifecycle_render.test.mjs`. Captures:
`python3 tools/capture_assertion_claim_layer.py`.

**Private evidence workspace (er-17):** the authenticated
`/admin/possibly-same?pair=` view expands a selected pair into its connected candidate
component, grouped into independent publisher rails. It composes the assertion rail and
append-only disposition history without selecting canonical values or changing links.
Pure model: `entity_resolution/review/investigation_workspace.mjs`. Characterization and
capture: `node --test worker/test/private_evidence_workspace.test.mjs`,
`python3 tools/capture_private_evidence_workspace.py`.

**Public entity dossier (er-15):** `GET /entity-dossier?id=` reads canonical entities and
linked immutable source snapshots into a bounded, allowlisted view. Exact source
assertions retain publisher provenance and observation time; disagreements keep every value,
and missing fields mean only “not observed in linked records.” Raw snapshots, content hashes,
matcher internals, and desk review state never cross the publication serializer. Pure model:
`entity_resolution/publication/dossier.mjs`; Worker route/view:
`worker/src/entity_dossier.mjs`. Verify: `node --test worker/test/entity_dossier.test.mjs`.

**Public relationship graph (er-16):** `GET /entity-relationships?id=` projects linked public
procurement observations into allowlisted vendor, agency, solicitation, contract, and award nodes.
Every connection uses a named edge type with publisher provenance, observed time, and public-safe
confidence; unsupported records and relationship types fail closed rather than becoming generic
lines. Traversal is capped at two hops and 25 outgoing edges per node, with explicit truncation.
Pure model: `entity_resolution/publication/relationship_graph.mjs`; Worker route/view:
`worker/src/public_relationship_graph.mjs`. Verify:
`node --test worker/test/public_relationship_graph.test.mjs`; captures:
`python3 tools/capture_public_relationship_graph.py`.

**Clerical audit (er-12):** `tools/export_er_clerical_audit.mjs` emits a
false-split-priority sample (`near_miss` plus `auto_link` control), CSV label
sheet, and receipt under `entity_resolution/eval/audits/<date>/`. Live mode is
read-only and records a `notices_replay` fallback when shadow tables are empty.
Gold promotion only creates a new `gold_vN.jsonl`; it never overwrites a version.
Characterization: `node --test test/entity_resolution_clerical_audit.test.mjs`.

**Entity-centric audit (er-20):** `tools/export_entity_audit_sample.mjs` samples
whole resolved entities from the er-13 component report across false-split,
large-cluster, singleton, low-confidence, authority-key, and control strata.
The label sheet carries first-order inclusion probabilities; weighted rates
fail closed as `insufficient` for undersampled strata. Verify:
`node --test worker/test/entity_audit_sampling.test.mjs`.

**Shadow monitoring (er-23):** `tools/run_er_shadow_monitor.mjs` reads D1 with
bounded `SELECT` queries or the committed fixture and emits provenance-stamped
rates/distributions under `entity_resolution/eval/monitoring/`. Missing
populations are `insufficient`; receipt comparisons refuse changed policy/window
versions. Verify: `node --test test/entity_resolution_shadow_monitor.test.mjs &&
node tools/run_er_shadow_monitor.mjs --fixture`.

## Property location extraction

Site geography for Property Disposition: `site/property_location.mjs`
(`propertyLocationFromRow`). Worker `/property-locations` imports the same
module — keep edge and client in lockstep. Scope text is title +
START_MARKER body chunks only; lease-surrender / voluntary-hearing language
is covered. When markers yield no local signal, a bounded body fallback
accepts **exactly one borough + Block/Lot** (never multi-borough clerk lists
or street addresses from hearing dial-in / office boilerplate). Exemplar
false-negative: notice `20241112003` (Manhattan Block 644 Lot 1). Golden +
unit: `node --test test/contract/property_location_golden.test.mjs
test/contract/property_location.test.mjs`. Feed cards deep-link
`#notice/{id}` (title + Open notice), same pattern as Money dig items.

## Structured notice-body facts

Pure parser: `worker/src/lib/notice_facts.mjs`. It extracts only explicitly labeled
PIN/EPIN values, submission/testimony deadlines, and applicant/owner parties, retaining
the source excerpt for every fact. Ingest stores the full result in `structured_facts`;
only a unique PIN/EPIN or unique submission deadline may fill an absent source column,
so existing alert and contract-spine paths can consume it. Publisher columns always win.
Characterization and real-notice metrics: `node --test test/notice_facts.test.mjs
worker/test/ingest_map.test.mjs`.

## Rules event spine

NYC Rules lifecycle dates remain distinct events in `worker/src/lib/rules.mjs`:
proposal publication, public hearing, comment close, adoption, and effective date.
Date-only fields are New York calendar dates, not inferred clock times; comment close
events carry alert metadata. Digests cite comment-close by `valid_at` from the spine
(`worker/src/lib/alert_temporal.mjs` → `commentCloseValidAt`), not publication or
processing time. The `/rules` read model is `rules:materialized:v2`, and Agency Rules
notice detail owns the public spine (same `.chain` pattern as the Money contract
timeline). Verify:
`node --test worker/test/rules_event_spine.test.mjs test/rules_deadline_render.test.mjs worker/test/alert_temporal.test.mjs && python3 test/functional/19_rules_time_spine.py --screenshots artifacts/cs-time-02`.
Captures: `python3 tools/capture_rule_event_spine.py` (before/after at 390 and 1440).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
