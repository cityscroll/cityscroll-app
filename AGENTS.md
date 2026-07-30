# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.


## README live screenshots

`tools/capture_readme_screens.py` → `docs/readme/*.png` (linked from root `README.md`).
Captures the live site. Each frame waits on data-bearing selectors (not network-idle /
fixed sleep) and **fails if a skeleton is still visible** (`.today-skeleton`, `.empty.skel`,
`.skl`). Homepage must clear Today's Edition (`#todaystrip[aria-busy=false]` + `#tdate` /
`#tbig` / `#tcards`) and the default Contracts list (`#list .row`). Data page must clear
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
`0005_subsidy_lifecycle.sql`). Characterization: `test/subsidy_lifecycle.test.mjs`,
`test/ida_notice_defects.test.mjs`.

## Notice payment panel (deep link + vendor match)

- Payments-card → dollars: `#notice/<id>?focus=follow-the-dollars` (never bare `#follow-the-dollars` — applyHash falls through to Money). Scroll after lifecycle render via `scrollToLifecycleFocus`.
- Outbound Checkbook: `checkbookSearchUrl({contractId, pin, vendor})` → smart_search when a term exists.
- Vendor mismatch: `vendorNamesMatch` (vendorStem + truncation/token overlap). HNTB truncation must not warn; true mismatches still do. Soft variant copy: `lifecycle_dollars_vendor_variant_html`.
- Payment honesty: Checkbook Spending rejects `pin` (code 1101) — join by `contract_id` after Contracts. Three states via `payment_state`: `paid` / `verified_zero` / `unavailable` (never confident `$0` on feed error).
- Characterization: `node --test test/lifecycle_coherence_field_cases.test.mjs test/lifecycle_render.test.mjs test/unit.test.mjs` and `cd worker && node --test test/checkbook_lifecycle.test.mjs`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
