# Scheduled refresh PR → Worker-cron inventory

Scout. Recommends work; does not authorize product changes.

**Question:** the captain wants live-derived state updated by the Worker's own `scheduled()` cron (the PR 1188 preset-fallback pattern), not by a GitHub Action that opens and auto-merges a PR. He thought that was already the standard. It is not.

**Answer:** six scheduled workflows still regenerate committed files and open+queue a PR. One former offender is already on KV. One other scheduled job already writes the Worker directly and should stay that way. Everything else under `.github/workflows/` is a monitor, deploy, or manual tranche — fine as-is.

Authoritative HTML briefing: firstmate home
`/Users/openclaw/zhongjun/data/automation-pr-to-worker-cron-inventory/report.html`.

## Reference pattern (already done)

PR [#1188](https://github.com/cityscroll/cityscroll-app/pull/1188) deleted `.github/workflows/refresh-preset-fallback.yml` and `site/data/preset-validation.json`.

- **Write:** `runSuggestionValidation` on the 13:00 UTC cron in `worker/src/worker.mjs` → `ALERT_STATE` keys `suggestions:validated` and `preset:fallback` (`worker/src/lib/preset_fallback_kv.mjs`).
- **Read:** `GET /suggestions`. Site cannot see KV; it uses the Worker endpoint or its in-code floor.
- **Cold KV:** in-code `FALLBACK_INDICES` / `NL_SUGGESTIONS_FALLBACK`. Missing, empty, unparseable, or stale KV never blanks chips.
- **Proof:** `test/refresh_preset_fallback_workflow.test.mjs` asserts the workflow file is gone.

That is the target shape: Worker cron writes a bounded cache; request path reads KV; committed or in-code last-resort remains.

## Why the remaining PR loops exist

GitHub is used as a CDN for JSON (and some HTML) that both Pages and the Worker compile-time-import. Age gates on those committed files then *require* a daily or weekly PR:

| Gate | Bound | Effect |
| --- | --- | --- |
| `LAND_LOOKUP_MAX_AGE_MS` (`warehouse/lib/zap_freshness.mjs`) | 36 hours | land ZAP `--check` fails unless git moves almost daily |
| Serve contract `zap_projects.max_age_days` | 7 days | second land ratchet |
| `STAFFING_EXAMS_MAX_AGE_DAYS` | 7 days | staffing `--check` fails inside a week |
| Serve contract `doing_business` / `payroll_title` | 180 days | weekly jobs are slack; they have not opened a PR since at least 2026-07-01 |
| Land upcoming-hearings job | `generated_at` must advance | **every successful run opens a PR**, even when the hearing set is unchanged |

The PAT `REFRESH_PR_TOKEN` exists because `GITHUB_TOKEN` PRs cannot retrigger required checks (anti-recursion). Worker-cron self-update deletes that whole class of merge-queue machinery for these datasets.

Churn since 2026-07-01 (this worktree's `git log`):

| Automation | Merged refresh PRs |
| --- | ---: |
| preset fallback (retired by #1188) | 17 |
| land ZAP freshness | 6 |
| land upcoming hearings | 5 |
| staffing exams | 5 |
| doing-business / payroll / geocoder | 0 |

## KV and cron constraints (do not fight these)

- **Namespaces already bound:** `NL_METER`, `ALERT_STATE`, `SUBS`, `FEEDBACK` (`worker/wrangler.toml`). Production cron products already live on `ALERT_STATE` (`hearings:location:v1`, `property:location:v1`, `rules:materialized:v2`, `zap-outcome:v1:…`, `suggestions:validated`, `preset:fallback`, vendor-profile buckets, …).
- **Do not create a new KV namespace.** `wrangler kv namespace create` needs account KV-admin. The same auth-10000 wall parked cs-07; the PR 1188 brief already chose “reuse `ALERT_STATE` + a key prefix.” Existing deploy credentials can *write keys* to bound namespaces. They cannot reliably *create* namespaces.
- **Value ceiling:** 25 MiB per KV value. All six artifacts except the address-index fit. The address-index is 53 MiB across 64 shards — not a KV candidate.
- **Beta Worker has no KV bindings.** Any KV read path must keep a committed or in-code last-resort so beta and a cold namespace do not 500.
- **Cron budget:** triggers are `0 10 * * *` (digest rehearsal) and `0 13 * * *` (delivery, then advisory refreshes). The 13:00 chain already does notice ingest, PASSPort, ZAP outcome prewarm (cap **200**), rules, meetings, vendors, suggestions. Land/staffing refreshes today run on GitHub at 07:41–08:23 UTC so they are not stuck behind digest. A third trigger such as `0 8 * * *` is allowed (no new namespace) and is the honest home for land/staffing KV writes.
- **ZAP prewarm vs hearings universe:** `ZAP_PREWARM_MAX = 200`; today's hearings snapshot listed **235** sell-facing projects. A hearings KV built only from the current prewarm set would miss ~35 projects unless the cap is raised (code already allows 500).
- **Pages first-paint** still reads `site/data/*.json`. Moving freshness to KV means: static JSON becomes the last-resort floor; live path hydrates from a Worker route. Same hybrid as money default open / suggestions.

Fallback when a job **cannot** fit Worker CPU/subrequests (Python/PDF, 45-minute polite sweep): GitHub computes, then `POST /admin/…` into KV — the attachment-metadata pattern. That stops the PR. Prefer Worker cron when the fetch is SODA-or-ZAP-sized.

## Per-automation inventory and design

### 1. `land-zap-freshness-refresh` — recommended: **edge-KV** (runtime) + committed last-resort

| | |
| --- | --- |
| Cadence | Daily 07:41 UTC + `workflow_dispatch` |
| Mechanism | `peter-evans/create-pull-request` → `automation/land-zap-freshness-refresh` → `gh pr merge --auto` |
| Live source | SODA `hgx4-8ukb` (ZAP projects) |
| Writes | `site/data/zap_projects_warehouse_lookup.json` (284 KB, 238 rows); worker twin; `worker/src/data/keyword_search_index.json` (**10.6 MB**); `site/data/land_default_ulurp.json` (243 KB, 40 default rows) |
| Current reads | Worker compile-time import (`worker/src/lib/zap_warehouse_lookup.mjs`, `worker/src/search.mjs`); site fetch `data/zap_projects_warehouse_lookup.json`; build-time consumers (district activity, constellation, process conformance) |

**Design.** Split the four files; do not KV the whole keyword index.

- **ZAP lookup → `ALERT_STATE` `zap:projects-lookup:v1`.** Cron: SODA sell-facing page (already `listPrewarmProjectIds`). Read: `lookupZapFromWarehouseMaterialization` tries KV then the committed twin. Site: `GET /zap-projects-lookup` or reuse `/zap-outcomes` list. Keep the committed JSON as last-resort and as the Pages/build input. Relax `LAND_LOOKUP_MAX_AGE_MS` so it applies to the **KV** clock, not git, or the 36-hour gate will keep forcing PRs.
- **Keyword index: do not put 10.6 MB on every `/search` KV read.** Land family is 258 KB; procurements alone are 5.1 MB. Land already miss-fills canaries from live SODA (`site/land_keyword_soda_missfill.mjs`). Drop the keyword-index file from this daily PR. Optional later: `keyword:family:land` only.
- **`land_default_ulurp.json`:** 40-row first-paint snapshot. Keep committed last-resort; live Land list already hydrates. Stop rewriting it daily.

Effort/risk: **M / medium.** Many compile-time imports and build-time consumers. Beta has no KV.

### 2. `land-upcoming-hearings` — recommended: **edge-KV** (highest-churn daily)

| | |
| --- | --- |
| Cadence | Daily 08:17 UTC + `workflow_dispatch` |
| Mechanism | PR branch `automation/land-upcoming-hearings` + auto-merge. Job **requires** `generated_at` to advance, so a quiet day still opens a PR. |
| Live source | ZAP API dispositions/milestones for every sell-facing Open Data project (today 235 listed, 234 fetched, 350 ms polite delay) |
| Writes | `site/data/land_upcoming_hearings.json` (250 KB, 182 upcoming); `warehouse/receipts/proof/land_upcoming_hearings_latest.json` |
| Current reads | `site/app/land.mjs` (`LAND_UPCOMING_HEARINGS_URL`); `site/now_view.mjs`; land `status=hearings` filter; build `--check` in Pages |

**Design.** Worker already stamps `hearing_logistics` on each `zap-outcome:v1:{id}` during `refreshZapOutcomes`. Project the upcoming-hearings snapshot from those records plus the SODA sell-facing id list.

- KV key: `land:upcoming-hearings:v1`
- Read: `GET /land-upcoming-hearings` (mirror `GET /hearings` → `hearings:location:v1`); site swaps the static URL for the Worker route, committed JSON remains the floor
- Raise `ZAP_PREWARM_MAX` from 200 to cover the live sell-facing count (235 today; hard cap in code is 500), or the projection is silently short
- Prefer a morning cron (`0 8 * * *`) so today's hearings are not waiting on 13:00 digest
- If a full polite ZAP sweep still cannot fit cron CPU/subrequests: GitHub `--live` sweep `POST /admin/land-upcoming-hearings` into the same KV key (attachment-metadata pattern). That still kills the PR. Do not keep the `generated_at`-must-advance merge.

Receipt JSON can stay a GH Actions artifact; it does not need git.

Effort/risk: **M / medium.** Cap gap and cron budget are the real risks, not payload size.

### 3. `staffing-exams-refresh` — recommended: **edge-KV for JSON**; HTML stays generated, not a daily PR

| | |
| --- | --- |
| Cadence | Daily 08:23 UTC |
| Mechanism | PR branch `automation/staffing-exams-refresh` + auto-merge |
| Live source | DCAS schedule SODA `4ptz-hmtc`; Civil Service List `vx8i-nprf` **group-by only**; OASys `GetActiveExams` |
| Writes | `site/data/staffing_exams.json` (1.3 MB, 228 exams); exam_sources snapshots + receipts; **228 committed** `site/exams/<id>/index.html` (2.3 MB) |
| Current reads | site `data/staffing_exams.json`; Worker `compile.mjs` fetches `https://cityscroll.org/data/staffing_exams.json`; Pages `handleExam` serves static HTML; constellation exam links |

**Design.** The JSON is a bounded live cache. The HTML is a document tree.

- JSON → `ALERT_STATE` `staffing:exams:v1` (plus OASys map as a field or `staffing:oasys-map:v1`)
- Cron: SODA group-by + schedule + GetActiveExams (no roster/PII). Fits Worker.
- Read: Worker `/staffing-exams` (or compile reads KV directly); site hydrates from that route; committed `staffing_exams.json` is the 7-day-or-older floor
- HTML: do **not** KV 228 pages. Two honest options: (a) `handleExam` edge-renders from the KV JSON the way notices are edge-rendered — then stop committing `site/exams/**`; (b) keep HTML as a deploy/build artifact generated at Pages build from last-known JSON, not a daily PR. (a) is the real worker-cron end state; (b) is the smaller interim.
- Do not daily-PR because `generated_at` ticked. Hash `exams[]` (ids + windows + fees) and skip when unchanged.

Effort/risk: **L / medium-high.** JSON-to-KV is medium. Edge-rendered exam documents is a product slice. Age gate must move from git onto the KV clock or `--check` will keep failing PRs.

### 4. `doing-business-warehouse-lookup` — recommended: **edge-KV** (low urgency)

| | |
| --- | --- |
| Cadence | Weekly Monday 07:41 UTC |
| Mechanism | PR + auto-merge when git diff is non-empty |
| Live source | SODA `72mk-a8z7` (~10.8k rows, 3 pages) |
| Writes | site + worker twins (2.1 MB each); speed receipt |
| Current reads | `attachDoingBusinessFromWarehouse` compile-time import; `refreshVendorProfiles` already runs on 13:00 cron |
| Churn | **0** refresh PRs since 2026-07-01 (180-day age) |

**Design.** Fold the three-page SODA catalog into `refreshVendorProfiles` (or a sibling 13:00 step). KV key `doing-business:lookup:v1`. Keep the committed 2.1 MB twin as last-resort until the first successful KV write; then it can freeze. Canary `CAMBA  INC` stays a serve-gate on the KV payload.

Fits KV (2.1 MB ≪ 25 MB). Removing the twin later shrinks the Worker bundle.

Effort/risk: **S / low.** Weekly and quiet; migrate after the daily land jobs so the cron chain is proven.

### 5. `payroll-title-warehouse-lookup` — recommended: **edge-KV** (first slice)

| | |
| --- | --- |
| Cadence | Weekly Tuesday 07:47 UTC |
| Mechanism | PR + auto-merge on diff |
| Live source | SODA `k397-673e` **group-by** (title count + min/max/avg base; never the 6.8M employee file) |
| Writes | site + worker twins (224 KB); speed receipt |
| Current reads | `worker/src/lib/suggestions.mjs` compile-time import `payroll_title_warehouse_lookup.json` — already on the suggestion cron path |
| Churn | **0** since 2026-07-01 (180-day age; fiscal-year publisher) |

**Design.** Closest remaining analog to PR 1188. Fetch the group-by inside `runSuggestionValidation` or a 13:00 sibling. KV key `payroll:title-mart:v1`. Suggestions read KV then the committed twin. Canaries `POLICE OFFICER` / `FIREFIGHTER`. In-code last-resort can stay the committed JSON until KV is warm.

Effort/risk: **S / low.** Do this first.

### 6. `geocoder-address-index` — recommended: **keep committed** (git is the right home)

| | |
| --- | --- |
| Cadence | Daily 09:47 UTC |
| Mechanism | PR + auto-merge on diff (already gates on real change) |
| Live source | DCP PAD zip `bc8t-ecyu` (source version `26b`, publisher `updated_at` 2026-07-07) |
| Writes | `site/data/address-index/*.json` — **64 shards + manifest, 53 MB**, ~1.17M ranges |
| Current reads | `site/precomputed_address_geocoder.mjs` — snapshot-only citywide exact full-address → BBL; browser fetches shards from Pages |

**Design.** Not a KV cache. Too large, structurally sharded for static hosting (`MAX_SHARD_BYTES` 20 MB), versioned official snapshot, read by the browser with no Worker in the path.

Keep the PR (or switch to direct-commit-to-main if CI on a 53 MB diff is the pain). Optional: drop cadence to weekly/monthly; skip unless `source.version` / zip sha256 changes. Do not invent a KV namespace or R2 bucket for this without a separate product card.

Effort/risk: **n/a / low** if left alone. Cadence drop is a one-line cron edit.

## Already on the right side of the line (fine as-is)

| Workflow | Schedule | Why it is not a refresh-PR problem |
| --- | --- | --- |
| `refresh-preset-fallback` | *deleted* | PR 1188. Reference implementation. |
| `attachment-metadata` | Daily 07:41 UTC | Python T0/T1/T2 collector **POSTs** `https://api.cityscroll.org/admin/attachment-metadata`. Artifact-only receipts. Compute cannot move to Worker (binaries, polite delay, pypdf). Pattern to copy when cron cannot host the fetch. |
| `architecture-reconciliation` | Daily 06:17 UTC | `--check` + artifact. No git write. |
| `cutover-regression` | 01:17 / 09:17 / 17:17 UTC | Production monitor. |
| `surface-load-live` | Daily 09:07 UTC | Playwright sample → flywheel artifact. |
| `multi-flywheel` | Hourly :17 | Fixture emit → artifact. |
| `merge-pipeline-guard` | Every 10 min | Merge-queue ops, not civic data. |
| `action-links-live` | GH schedule retired | Independent runner `tools/external_schedule_runner.mjs`. |
| `digest-shadow-monitor` | GH schedule retired | Same independent runner. |
| `source-contracts-live` | `workflow_dispatch` only | Manual Legistar tranche; commits to the current branch. Reviewed sample, not a live cache. |
| `update-changelog` | on merged PR | Writes `bot/changelog-update` only. Not a civic read model. |
| deploy / ci / promote-beta / rerun-stale-pr-checks | n/a | Ship and gate. |

`tools/external_schedule_jobs.json` still lists land-zap, land-upcoming, staffing, attachment-metadata, surface-load, multi-flywheel as `follow_up_jobs`. Attachment-metadata and the two monitors are already off the PR path. Do not migrate the monitors onto Worker cron.

## Do not add a seventh PR loop

`warehouse/lib/serve_publish_contract.mjs` `city_record_pin_chain` is aged 180 days with the comment “No daily refresh workflow yet.” If that lookup needs freshness, write it from the existing notice-ingest cron into `ALERT_STATE` (or D1). Do not copy `peter-evans/create-pull-request`.

## Recommended order

1. **Payroll title mart** — smallest, already on the suggestion cron, exact analog of #1188. Proves “SODA group-by → `ALERT_STATE` → last-resort twin” without touching land.
2. **Land upcoming hearings** — worst daily PR (forced `generated_at`). Derive from `zap-outcome:v1:*`; raise prewarm cap; morning cron.
3. **Land ZAP lookup** — KV the 284 KB sell-facing table; stop daily keyword-index and default-ULURP rewrites; move the 36-hour gate onto the KV clock.
4. **Doing Business** — weekly, quiet, 2.1 MB, vendor-profile cron already exists.
5. **Staffing exams JSON** — then, separately, stop committing `site/exams/**` by edge-rendering `handleExam`.
6. **Geocoder** — leave committed. Optional cadence/version-gate only.

Genuinely fine as-is: attachment-metadata, all monitors, changelog bot branch, manual source-contracts tranche, geocoder (as a committed snapshot).

## Per-automation table

| Name | Data | Current mechanism | Target | Effort / risk |
| --- | --- | --- | --- | --- |
| refresh-preset-fallback | suggestion chips | *removed* (#1188) | **keep-as-is** (edge-KV done) | — |
| payroll-title-warehouse-lookup | FY title census 224 KB, SODA `k397-673e` | weekly PR on diff | **edge-KV** `payroll:title-mart:v1` | S / low |
| land-upcoming-hearings | 250 KB hearings snapshot, ZAP API | daily PR, `generated_at` forced | **edge-KV** `land:upcoming-hearings:v1` | M / medium |
| land-zap-freshness-refresh | 284 KB ZAP lookup + 10.6 MB keyword index + 40-row ULURP snap | daily PR | **edge-KV** lookup only; index/snap stay committed last-resort | M / medium |
| doing-business-warehouse-lookup | 2.1 MB stem index, SODA `72mk-a8z7` | weekly PR on diff | **edge-KV** `doing-business:lookup:v1` | S / low |
| staffing-exams-refresh | 1.3 MB JSON + 228 HTML docs | daily PR | **edge-KV** JSON; HTML edge-render or build artifact | L / medium-high |
| geocoder-address-index | 53 MB PAD shards | daily PR on real change | **keep-as-is** (committed snapshot) | n/a / low |
| attachment-metadata | T0/T1/T2 rows in Worker | daily GH → admin POST | **keep-as-is** | — |
| monitors, changelog, manual tranche, deploy | n/a | no civic PR loop | **keep-as-is** | — |

## Implementation notes for whoever picks this up

- Fail-soft: a failed cron leaves yesterday's KV; never overwrite with empty.
- Last-resort: committed twin or in-code floor. Prove with a test that empty/failed KV uses the floor (copy `worker/test/suggestions.test.mjs`).
- Delete the workflow only after the runtime path is green — same as #1188.
- Site cannot read KV. Always a Worker GET (or keep static last-resort).
- Do not `wrangler kv namespace create`. Prefix `ALERT_STATE`.
- Direct-commit-to-main is an honest *interim* only for datasets that must stay in git (geocoder; maybe exam HTML before edge-render). It is not the destination for live caches.
- This scout does not change product code.
