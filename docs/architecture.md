---
summary: >-
  CityScroll is a dependency-free static site (`site/index.html`) plus a Cloudflare
  Worker backend that makes NYC's City Record searchable by interest: seven
  lenses (Money/People/Land/Property/Rules/Meetings plus an alert system) over
  live Socrata open-data APIs, with a Wave-5 forecasting layer that estimates
  contract renewals from Checkbook NYC durations,
  and labels separately sourced public-authority awards on agency profiles.
  The core site works without the worker; the worker adds Checkbook lookups,
  email alerts, feeds, plain-English search, forecasting, precomputed vendor
  identity headers, resilient public stats, aggregate first-party usage
  analytics, and a Wave-4 process-spine layer (`process_id` / `project_id` /
  `event_id`) for contract-lifecycle joins with confidence checks.
  A D1 mirror of
  recent notices (daily ingest; Socrata stays the source of truth) backs alert
  matching and server-side search. Daily KV materialized views join rules
  hearings with public meetings while keeping affected geography separate from
  venue, and add extracted property-site geography plus resolved map geometry to
  Property Disposition notices.
  Daily, versioned KV buckets let a complete
  vendor profile paint from one edge read; new front doors: subscribe-by-inbound-email
  and an MCP endpoint for AI assistants (both spend-metered), plus a public
  data.html page of live dataset aggregates. Digest delivery fans out through
  a Cloudflare Queue (per-subscriber retries, DLQ; daily send caps unchanged).
  The source vault retains approved public documents by content hash and
  preserves their official source links.
  A public Cloudflare Pages beta lane provides stable draft-PR preview aliases
  and an owner-triggered pointer to one exact reviewed commit without changing
  the stable GitHub Pages host.
updated: 2026-07-30
sources:
  - README.md
  - MISSION.md
  - site/external_awards.js
  - site/staffing.js
  - site/i18n.js
  - site/location_extract.mjs
  - site/property_location.mjs
  - site/rule_location.mjs
  - site/beta_flags.js
  - site/beta-flags.json
  - site/CNAME
  - site/robots.txt
  - site/sitemap.xml
  - site/_config.yml
  - tools/build_staffing_exams.mjs
  - site/data/source_contracts.json
  - docs/data-sources.md
  - tools/source_contracts.mjs
  - tools/generate_source_docs.mjs
  - tools/verify_source_contracts.mjs
  - test/fixtures/source_contracts/source-shapes.json
  - tools/stamp_i18n_assets.py
  - tools/ensure_beta_pages.mjs
  - .github/actions/build-site/action.yml
  - .github/workflows/deploy-pages.yml
  - .github/workflows/deploy-worker.yml
  - .github/workflows/deploy-beta-preview.yml
  - .github/workflows/promote-beta.yml
  - .github/workflows/deploy-worker-beta.yml
  - .github/workflows/ci.yml
  - .github/workflows/source-contracts-live.yml
  - tools/live_url_smoke.mjs
  - test/live_url_smoke.test.mjs
  - worker/wrangler.toml
  - worker/src/events.mjs
  - worker/src/worker.mjs
  - worker/src/alerts.mjs
  - worker/src/checkbook.mjs
  - worker/src/lib/analytics.mjs
  - worker/src/inv.mjs
  - worker/src/mocs_plan.mjs
  - worker/src/property.mjs
  - worker/src/suggest.mjs
  - worker/src/lib/process_spine.mjs
  - worker/src/lib/forecast_score.mjs
  - worker/src/vendor_profile.mjs
  - docs/analytics-event-taxonomy.md
  - worker/src/lib/hearings.mjs
  - worker/src/lib/civic_scope.mjs
  - worker/src/lib/cafe_consent.mjs
  - docs/civic-scope-schema.md
  - test/contract/fixtures/dining_out_nyc.json
  - worker/src/mirror.mjs
  - worker/src/lib/cors.mjs
  - test/process-spine.test.mjs
  - test/fixtures/wave4/generated/process_spine.json
  - test/fixtures/wave4/generated/unresolved-joins.json
  - test/fixtures/wave4/generated/ocds-gap-table.json
sources_hash: 91d912264dfae360ae14a1c84f57838954b054fd1e5b68dca184b41f8db63890
---

# crol-list — architecture

## What & why

The NYC City Record publishes every agency contract, hearing, rule change, rezoning, and property disposition — by City Charter §1066 — but the raw record is hard to follow by interest. CityScroll re-stitches it into seven navigable lenses, adds cross-references to Checkbook NYC (contract payments and NYCHA contracts), official NYS Authorities Budget Office award filings, ZAP (rezoning detail), and BBL lookups, delivers standing watches as email digests, and estimates contract-renewal timing from historical Checkbook terms. The constraint is no accounts, no per-user tracking, no hard backend dependency — every feature degrades gracefully when the worker is absent.

## System map

```
Browser (cityscroll.org — canonical Worker mirror of static GitHub Pages)
  site/index.html  (inline CSS + vanilla JS, ~100% of the feature surface)
        ├──►  site/data/staffing_exams.json (build-time materialized DCAS exam view)
        │  most queries go direct — CORS-open, no key needed
        ├──►  NYC Open Data / Socrata SODA (City Record dg92-zbpx, payroll, civil service, ZAP)
        ├──►  NYS Open Data / Socrata SODA (ABO awards 8w5p-k45m, d84c-dk28, ehig-g5x3)
        ├──►  NYC GeoSearch / MapPLUTO (BBL lookups, rezoning polygons)
        │
        │  secret / server-side routes only
        ▼
  api.cityscroll.org  (Cloudflare Worker "crol-worker" — worker/ in this repo;
                      api.crol-list.org and workers.dev aliases kept alive for in-flight confirm links)
        ├──  /nl                plain-English → lens filters (Claude Haiku, NL_METER-capped)
        ├──  /mcp               MCP for AI assistants: search/get/preview_watch/create_watch (metered)
        ├──  /checkbook         Checkbook NYC proxy + expiration pipeline (fc:* cache)
        ├──  /forecast          Checkbook contract-expiration estimate timeline
        ├──  /subscribe /confirm /unsubscribe   double-opt-in email (Turnstile-gated)
        ├──  /feedback          operator feedback form (Turnstile-gated, fails closed)
        ├──  /feed.xml /feed.json /feed.ics     standing feeds from any saved search
        ├──  /batch             watchlist cross-reference
        ├──  /agencies          public raw-name → canonical-name crosswalk (JSON/CSV)
        ├──  /vendor-profile    ≤24h complete vendor-profile projection (KV; live fallback on miss)
        ├──  /hearings          daily rules/meetings view with affected area + venue
        ├──  /property-locations daily Property view with site evidence + resolved geometry
        ├──  /source-vault/*    eligible public documents (R2; manifest gated)
        ├──  /inv[/<id>]        investigation snapshots + entity forecast metadata
        ├──  /priorcycle/<id>   precomputed prior-cycle + near-match sets (D1-cached, compute-on-miss)
        ├──  /translate/<id>    informal notice translation (on-demand, D1+edge cached, invariant-checked)
        ├──  /stats /usage      public aggregate counters / keyed usage report
        ├──  /events            bounded aggregate usage events (no visitor identifiers)
        ├──  /r/<kind>/<id>     count-only digest click-through → 302
        └──  /admin/subs /admin/feedback        keyed operator views

Inbound email (Email Routing: subscribe@crol-list.org → this worker): plain
English → LLM-parsed watch → double-opt-in confirm reply (metered, loop-guarded).
Outbound worker email to users comes from `alerts@cityscroll.org` (set by `ALERTS_FROM`).

Cron (daily 13:00 UTC): (1) Socrata→D1 ingest refresh (fail-soft), (2) prior-cycle
  pre-warm for the freshly-ingested Award notices (bounded, fail-soft), (3) rebuild
  the location-aware hearings view, (4) rebuild the location-aware Property view,
  (5) rebuild versioned vendor-profile KV buckets (identity, agency rollup, 15
  recent notices, and forecasts), then (6) digest
  fan-out — QUEUE_DIGESTS=true enqueues one job per subscription to
  Queue crol-digests (consumer sends with retries, poison → crol-digests-dlq);
  send caps unchanged: MAX_PER_RUN=25 / MAX_SENDS_PER_DAY=50 via Resend
KV: SUBS · NL_METER · ALERT_STATE (incl. fc: renewal-estimate cache) · FEEDBACK
D1: crol-notices — mirror of recent City Record notices + ingest cursor
     + prior_cycle_matches (precomputed prior-cycle/near-match cache)
R2: SOURCE_VAULT — content-addressed custody for approved public documents
Analytics Engine: crol_usage_events_v1 — versioned aggregate page/click/search
  events; enumerated dimensions only, with no cookies or visitor identifiers

Public review channel (Cloudflare Pages project "crol-list-beta")
  draft PR + preview:beta label → stable pr-<number> alias
  owner workflow + exact SHA → beta production pointer → beta.cityscroll.org
  optional owner workflow + exact SHA → isolated api-beta.cityscroll.org Worker
  same verified Jekyll + deploy-time i18n stamp pipeline as stable
```

Bottom-up, the way it's built: public Socrata feeds and Checkbook are the ground truth. `site/index.html` queries the CORS-open Socrata feeds directly; the Staffing career guide is the exception, using one committed materialized view built from DCAS schedules, NOEs, and Open Data so opening it never fans out to upstream APIs. The worker proxies Checkbook and also holds secrets (Claude, Resend), shared state (subscriptions, counters), and scheduled work (the digest cron). The Wave-5 forecasting layer sits inside the worker because it needs both a cache and the cron.

## Data stores & schemas

- **KV `SUBS`** — confirmed subscriptions: `sub:<token>` → `{email, lens, filters, frequency}`, plus per-IP/per-address rate-limit counters for `/subscribe`.
- **KV `NL_METER`** — daily spend metering for `/nl` (the denial-of-wallet ceiling on the only Claude-billed route).
- **KV `ALERT_STATE`** — digest/cron bookkeeping plus read models: `hearings:location:v1` → rules hearings and public meetings normalized into separate affected-area and venue fields (subject addresses may carry coordinates/BBL for place mapping), `property:location:v1` → Property Disposition notices with extracted site addresses/tax lots/BBLs and NYC GeoSearch geometry, `fc:<stem>` → estimated contract expirations from Checkbook contract terms, and versioned `vp:v1:*` whole-profile buckets behind `/vendor-profile`; stale or missing location views retain live Socrata fallbacks. The daily cleanup removes retired `plan:` keys so disabled MOCS rows cannot reappear.
- **KV `FEEDBACK`** — stored feedback rows (`fb:<ts>:<rand>`) + rate-limit counters.
- **`site/index.html` localStorage** — client-side only: investigation workspace (pinned notices + notes), query cache, saved searches, plain/rigor toggle.
- **Public beta flag localStorage** — one registered, default-off experiment slug selected by `?beta=<slug>`; `?beta=0` clears it. The registry enforces a removal date and on/off tests. It is presentation state only, never access control.
- **Wave-4 process-spine contracts** — required process-spine fixtures and matching code live in `test/fixtures/wave4/generated/` and `worker/src/lib/process_spine.mjs`; PR and CI tests validate confidence gates and required fields via `test/process-spine.test.mjs`.
- **D1 `crol-notices`** — mirror of recent notices (`notices` table: parsed columns + honest-data fields `contract_amount_valid`, `due_year`, plus the raw source row for schema-drift recovery), `ingest_state` (Socrata ingest cursor), `prior_cycle_matches` (per-notice precomputed `{strict, near, eligibleCount}` prior-cycle match sets — the cache behind `GET /priorcycle/<id>`; compute-on-miss, cron pre-warms freshly-ingested Award notices, ranked by `worker/src/lib/prior_cycle.mjs`, a hand-synced dual implementation of `site/index.html`'s matchers), and `notice_translations` (informal per-`(request_id, lang)` translations behind `GET /translate/<id>?lang=`; compute-on-miss, edge-cached, invariant-checked so amounts/dates/PINs/agencies/addresses survive verbatim or the translation is not shown). Refreshed by the daily cron (`worker/src/ingest.mjs`); Socrata remains the source of truth. English notice text remains the official record.
- **R2 `SOURCE_VAULT`** — content-addressed custody for approved public documents. Each object carries provenance, eligibility, and its official source URL.
- **Analytics Engine `crol_usage_events_v1`** — first-party aggregate page, lens, search, deep-link, export, alert, feed, and investigation events. The versioned schema in `docs/analytics-event-taxonomy.md` permits only bounded enumerations; it stores no query text, email, IP address, cookie, fingerprint, or visitor identifier. `/stats` reads sampling-aware 7/30-day aggregates through Cloudflare's SQL API.
- **`site/data/`** — committed product data, including Staffing role chips and `staffing_exams.json`,
  a build-time view of current DCAS exam schedules, notices, and active-list totals. Wave 4
  transforms use deterministic test datasets under `test/fixtures/wave4/`; joined production
  records feed their product views.

## Serving & deploy

- The public tree under `site/` is built as a GitHub Pages artifact whose origin hostname remains `crol-list.org` (from `site/CNAME`). The canonical public site is `cityscroll.org`; every page's canonical and Open Graph URL points there. The Pages workflow derives one cache stamp from `site/i18n.js` plus every shipping dictionary, writes it only into the deployment artifact, verifies the result, and then publishes it.
- Cloudflare Pages hosts public review artifacts only. Draft pull requests opt in with `preview:beta` and receive a stable `pr-<number>.crol-list-beta.pages.dev` alias plus an immutable URL. The manually triggered promotion workflow deploys one explicit commit to the Pages production branch named `beta`; `beta.cityscroll.org` is therefore a moving pointer, not a long-lived source branch. Re-running the workflow with the prior SHA is the deterministic rollback. Review artifacts keep stable canonical links and add no-index headers, channel/commit metadata, a visible experimental banner, and a stable-site escape link.
- Review artifacts select `api-beta.cityscroll.org` before page scripts run and never fall back to production. That Worker is an optional, manually deployed exact-commit environment with no inherited production secrets, storage, queues, or cron. Its browser routes accept beta Pages origins only under the beta runtime gate; paid, stateful, delivery, and write behavior fails closed when unconfigured.
- Worker deployed via `wrangler deploy` from `worker/` to the canonical custom domains `api.cityscroll.org` and `www.cityscroll.org`; `api.crol-list.org` and workers.dev remain compatibility aliases for existing clients and in-flight confirmation links. Changes under `worker/**` deploy from `main` through `.github/workflows/deploy-worker.yml`; a manual Wrangler deploy remains the emergency path. Cron trigger `0 13 * * *` (~9am ET). D1 schema versioned in `worker/migrations/`, applied with `wrangler d1 migrations apply crol-notices --remote`.
- `cityscroll.org` / `www.cityscroll.org` are the canonical site hosts (custom-domain routes in `worker/wrangler.toml`). The Worker normally reverse-proxies the GitHub Pages origin at `crol-list.org` byte-for-byte (`worker/src/mirror.mjs`). Origin redirects are manual; a redirect back to CityScroll trips a circuit breaker and retries through GitHub's public repository source seam.
- Direct visitors to `crol-list.org` / `www.crol-list.org` receive a 301 to the matching CityScroll path and query. The mirror's independent redirect-loop failover keeps the canonical site available if an origin fetch is redirected back at the Worker. Fragments remain client-side and are retained by conforming browsers.
- New feed, confirmation, redirect, and API URLs mint on CityScroll. Existing calendar UIDs retain `@crol-list` and Atom entries retain `tag:crol-list.org,2026:` so calendar and feed clients do not create duplicates. Outbound alerts are sent from `alerts@cityscroll.org`; inbound operational routing remains on `@crol-list.org` (`subscribe@`, `feedback@`) unless separately redirected by provider policy.
- Secrets are stored outside the repository (Wrangler secret bindings). Bindings referenced by code include `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `TURNSTILE_SECRET`, `TOKEN_SECRET`, `USAGE_KEY`, `ANALYTICS_READ_TOKEN`, and `ANALYTICS_DEV_KEY`. The production analytics write gate `ANALYTICS_ENVIRONMENT=production` is a non-secret var in `wrangler.toml` (beta overrides it to `preview`); a missing or non-production value drops Analytics Engine writes. The developer key authenticates short-lived HMAC exclusions. Spend guards are vars in `wrangler.toml`: `MAX_PER_RUN=25`, `MAX_SENDS_PER_DAY=50` (under Resend's free 100/day); `/subscribe` and `/feedback` fail closed (503) if their secrets are absent.
- GitHub Actions is path-filtered in `CI` using `dorny/paths-filter`; worker/docs/frontend jobs run only when their lanes changed.
  PR and merge tests include source-contract verification against committed fixtures:
  `tools/verify_source_contracts.mjs`, plus a blocking 20-sample p95 browser-performance
  contract against hermetic data fixtures.
  A separate daily workflow (`source-contracts-live.yml`) probes live sources and opens/updates an issue on drift.
  Actions also builds and deploys the stable site after merge, publishes explicitly labeled draft
  previews, promotes exact commits to beta only on manual dispatch, and deploys Worker changes
  when `worker/**` changes.
  After every site or worker deploy on `main`, `tools/live_url_smoke.mjs` probes the live public
  apex hosts (`cityscroll.org`, `crol-list.org`) plus a deep route for HTTP 200 with real page
  content (cache-busted; bounded retry for Pages/Fastly redirect-cache lag). A redirect loop,
  non-200, empty body, or error shell fails the deploy workflow with URL and status-chain
  diagnostics instead of reporting a green deploy.

## Surface

- **Seven lenses:** Money (RFP→Award pipeline + forecast timeline), Staffing (plain-language civil-service guide + open/upcoming exam explorer + title decoder/payroll), Land (rezonings + map), Property (asset lifecycle), Rules, Meetings, Alerts (subscriptions + watchlist).
- **Location-aware hearings:** Meetings joins public-meeting notices with dated rules hearings, offers rolling week/month filters plus affected borough and neighborhood controls, and groups unlocated notices visibly instead of dropping them. Hearing cards render affected area and venue as independent facts; location-aware meeting watches replay the same distinction in digest matching.
- **Location-aware Property and Rules:** Property notices share the hearing extractor's geography primitives but use property-specific evidence scoping so agency/contact addresses cannot become site addresses. The lens offers borough, neighborhood, and coarse near-me filters; cards show addresses, tax lots, BBLs, and map links only when supported, with an explicit fallback for notices that state no location. Rules remain citywide by default, while explicitly borough/district-scoped rules and dated rule hearings display their supported affected-area chips.
- **Civic scope (topic vs place):** `worker/src/lib/civic_scope.mjs` models the distinction the separate Rules and Meetings pipelines cannot express alone—topic-scoped citywide rules versus place-scoped cafe consent hearings—using Dining Out NYC as the characterization case (`docs/civic-scope-schema.md`). Place pins carry coordinates/BBL/community and council districts when geocoded; each record links official action routes and an explicit outcome (or the absence of one).
- **Forecasting UI:** vertical timeline widget on vendor/agency profile panels for Checkbook-based contract-expiration estimates, labeled separately from active solicitations.
- **Vendor profiles:** in response to user feedback, identity, top-agency chips, 15 recent notices, and forecasts now paint together from one daily precomputed KV projection. Full-text mentions stay behind an explicit disclosure because joining every vendor stem against the recent text corpus is disproportionate; missing or stale projection records use the original live Socrata resolver.
- **External awards:** 13 City Record agency aliases map to 12 distinct ABO authorities across local-authority, local-development-corporation, and state-authority filings (`8w5p-k45m`, `d84c-dk28`, `ehig-g5x3`). Profiles show up to eight recent awards with source and lag labels. NYCHA solicitation details use exact-PIN Checkbook `Contracts_NYCHA` candidates only when the contract date is later than the solicitation date; matches remain separate from City Record rows.
- **API:** `api.html` documents all worker routes and hosts the live batch cross-reference tool. `GET /agencies` publishes the City Record agency-name reconciliation as cached, CORS-open JSON or CSV; `/api` on the worker 302s to the documentation.
- **MCP:** `POST /mcp` — `search_notices` / `get_notice` (D1 mirror) + `preview_watch` / `create_watch` (LLM, metered; double opt-in preserved). Optional bearer token; per-IP daily ceiling.
- **Subscribe by email:** `subscribe@crol-list.org` (Email Routing → the worker's `email()` handler) — plain English → LLM-parsed watch → confirm reply. Metered + per-sender-limited + loop-guarded.
- **The Data:** `site/data.html` — live dataset aggregates (sections, monthly volume, procurement mix, top agencies/vendors by cleaned dollars), browser→Socrata direct, honesty rules applied.
- **Feeds:** `/feed.xml`, `/feed.json`, `/feed.ics` — any saved search as a standing feed.
- **CLI:** none; the worker is deployed via `wrangler deploy`.

## Seams

- **Consumes:** NYC Open Data Socrata SODA (City Record `dg92-zbpx`, payroll `k397-673e`, annual exam schedule `4ptz-hmtc`, active civil-service lists `vx8i-nprf`, ZAP `hgx4-8ukb`), current DCAS exam schedules and NOEs, NYS Open Data Socrata SODA (Authorities Budget Office local-authority awards `8w5p-k45m`, local-development-corporation awards `d84c-dk28`, state-authority awards `ehig-g5x3`), Checkbook NYC API (`Contracts`, `Contracts_NYCHA`), NYC GeoSearch / MapPLUTO, DOB job filings, Anthropic Claude Haiku (`/nl`), Resend (email), Cloudflare Turnstile, Cloudflare KV + R2 + Analytics Engine + Cron Triggers. MOCS Local Law 63 spreadsheets are documented but disabled until they have a stable machine contract.
- **Feeds:** subscriber inboxes (daily/weekly digests + forecast early warnings); public stats at `cityscroll.org/stats.html`; RSS/Atom/JSON Feed/iCal consumers.
- **Sister repo (archived):** `crol-worker` — pre-move history of the worker before it was open-sourced into this monorepo (2026-07-02).

## TL;DR

1 static site (`site/index.html` + `site/data.html`) + 1 Cloudflare Worker, 7 lenses, public and operator API routes plus an inbound-email handler and queue consumer, 1 daily cron (ingest → cache precomputation → queue fan-out), 4 KV namespaces + 1 D1 database (notices mirror + prior-cycle cache) + 1 R2 source vault + 1 Analytics Engine dataset + 2 queues, 6 secrets, 2 hard send caps — under one hard rule: no accounts, cookies, fingerprinting, or visitor profiles, and no hard backend dependency; everything degrades gracefully when the worker is absent.

1. A visitor loads `site/index.html` (inline CSS + vanilla JS) at canonical `cityscroll.org`, mirrored from the static GitHub Pages origin — no application backend required.
2. Picking a lens fires queries direct from the browser to CORS-open public APIs: Socrata SODA for City Record notices and ABO awards, plus GeoSearch/MapPLUTO for BBL and rezoning geometry. Checkbook queries use the schema-agnostic worker proxy.
3. Server-only features route to `api.cityscroll.org`: `/nl` (plain English → filters via Claude Haiku, metered by `NL_METER`), `/subscribe`→`/confirm`→`/unsubscribe` (double-opt-in, Turnstile-gated, fails closed), feeds, `/batch`, `/agencies`, `/inv`, `/stats`, `/feedback`, keyed `/admin/*` and `/usage`.
4. The forecasting layer (`/checkbook` + `/forecast`) parses historical Checkbook NYC contract terms into estimated expirations (`fc:<stem>` in `ALERT_STATE`) and renders them in the profile timeline. Official procurement-plan rows are disabled; the cleanup job removes stale `plan:` keys.
5. Subscriptions land in KV `SUBS`; legacy aggregate integers accrue in stats counters, while bounded page and interaction events accrue in Analytics Engine without visitor identifiers. The only personal data is the double-opted-in subscription email.
6. The daily cron (13:00 UTC) first refreshes the D1 notices mirror from Socrata (cursored, fail-soft — a failed ingest never blocks alerts), pre-warms prior-cycle match sets for freshly-ingested Award notices, rebuilds the hearings, Property, and versioned whole-profile vendor projections in KV, then replays active subscriptions and forecast milestones, sending digests and early-warning emails via Resend — hard-capped at 25/run, 50/day. Each cache job is fail-soft; Money digests exclude data-entry-error amounts (≥ $10B) and label rolling year-2090 deadlines honestly.
7. GitHub Pages serves the static site; Worker changes deploy automatically from `main`, with manual `wrangler deploy` retained as an emergency path.

## Check yourself

**Q:** Where does the renewal-estimate data live, and what is its source?
**A:** In KV `ALERT_STATE` under `fc:<stem>`, calculated from historical Checkbook NYC contract terms. `/forecast` serves only those labeled estimates; MOCS plan rows remain disabled until a stable machine source passes the source-contract verifier.

**Q:** The Cloudflare Worker is down or never deployed — what still works for a visitor?
**A:** The core search, CORS-open Socrata data (including ABO authority awards), maps, and local workspace still work. Worker-backed extras go dark — email alerts, feeds, `/nl` search, forecasting, stats, Checkbook payment lookups, and NYCHA contract matches.

**Q:** What stops a hostile script from running up the bill on the paid routes?
**A:** Layered ceilings that fail closed: `/nl` is metered per-day in KV `NL_METER`; email sends are hard-capped by `MAX_PER_RUN=25` / `MAX_SENDS_PER_DAY=50` (under Resend's free tier); `/subscribe` and `/feedback` are Turnstile-gated with per-IP/per-address rate-limit counters and return 503 if their secrets are missing.
