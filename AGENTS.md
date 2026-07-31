# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## PR and CI preflight

- Run `./tools/preflight-required-checks.sh` before creating or handing back a PR URL and
  before opening a pull request. CI still runs the full accessibility and runtime
  stray-English work after Unit checks.

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

**Self-merge / merge queue:** main’s ruleset requires four named checks (see
`update-changelog.yml` `REQUIRED_CHECKS` and `repos/.../rules/branches/main`). Changelog-only
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
forwards to the final cityscroll.org URL. Scope is READ + pin sync only —
unsubscribe/confirm keep purpose tokens and never accept the session.

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

## Entity resolution (foundation)

Link-not-merge taxonomy ADR: [`docs/adr/entity-resolution-taxonomy.md`](docs/adr/entity-resolution-taxonomy.md).
Unapplied D1 sketch (five tables): [`docs/entity-resolution/schema-sketch.sql`](docs/entity-resolution/schema-sketch.sql).
No production migration or runtime merge until later dual-write cards; no LLM matching as primary matcher.

**Normalize lib (er-03):** pure `worker/src/lib/normalize.mjs` owns `vendorStem` (+ agency
`canonicalAgency` re-export / `sameAgency`). `compile.mjs` re-exports `vendorStem` for
call-site stability. Equal/distinct pin table:
`worker/test/fixtures/normalize_pairs.json`. Verify:
`node --test worker/test/vendor_stem.test.mjs worker/test/normalize_fixtures.test.mjs`.

Gold set + metrics harness (eval only): `entity_resolution/eval/` —
`gold_v0.jsonl` (versioned; never silent-mutate labels/membership) and
`run_metrics.mjs`. Verify:
`node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v0.jsonl --dry-run`
(prints precision/recall/candidate_recall/unresolved_rate/false_merge/false_split;
nulls OK until matchers). Details: `entity_resolution/eval/README.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
