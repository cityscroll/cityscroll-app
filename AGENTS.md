# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.


## PASSPort Public machine path

PASSPort Public has **no Socrata dataset** for contracts/RFx. Stable machine dumps:

- `https://a0333-passportpublic.nyc.gov/dataJs/contractData.js` (`public_ctr_data`)
- `https://a0333-passportpublic.nyc.gov/dataJs/rfxData.js` (`public_rfx_data`)

Edge materialization: `worker/src/passport.mjs` → D1 `passport_contracts` / `passport_rfx`.
Strict EPIN↔PIN join: `worker/src/lib/passport_join.mjs`. Measured rates live in
`site/data/source_contracts.json` (`join_measurement`) and
`site/data/passport_sources/verification_receipts/`.

## Bid Tabulations Historical (`9k82-ys7w`)

Ranked class-(a) bid-count source. **Measured below usefulness** (2026-07-30): strict
PIN↔`bid_number` join is **0%** on Procurement notices since 2025-01-01 and **9.07%** on
2016–2021 overlap (no PIN column; openings end 2021-03-24). Source contract
`bid-tabulations-historical` is **disabled** — no edge materialization. Strategies and
receipts: `worker/src/lib/bid_tabulations_join.mjs`,
`site/data/bid_tabulation_sources/`.

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

## Live-URL smoke target sets

Post-deploy gate: `node tools/live_url_smoke.mjs` (default set includes apex, www, crol-list redirect host, about). Named opt-in sets do not change production routing:

- `--set pages-dev` — parallel host only (or `--base-url https://cityscroll.pages.dev`)
- `--set post-flip` — post-cutover URL matrix **plus** named incident checks (EMAIL HEALTH, STATS SANITY, WORKER ACCESS, HUMAN-PATH JOURNEY in `tools/post_flip_checks.mjs` + `tools/human_path_journey.py`); select only after an owner-authorized flip

Migration value baseline (merge-to-live wall-clock, detection exemplars, rollback estimate): `docs/evidence/hosting-migration-baseline.json`. After cutover, measure against it — do not assert improvements.

Characterization: `node --test test/live_url_smoke.test.mjs test/post_flip_checks.test.mjs`. Operator flip procedure lives outside this public tree.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
