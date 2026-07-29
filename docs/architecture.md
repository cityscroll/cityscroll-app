---
summary: >-
  CROL-List is a dependency-free static site (`index.html`) plus a Cloudflare
  Worker backend that makes NYC's City Record searchable by interest: seven
  lenses (Money/People/Land/Property/Rules/Meetings plus an alert system) over
  live Socrata open-data APIs, with a Wave-5 forecasting layer that predicts
  contract renewals from Checkbook NYC durations and Charter §112 MOCS plans,
  and labels separately sourced public-authority awards on agency profiles.
  The core site works without the worker; the worker adds Checkbook lookups,
  email alerts, feeds, plain-English search, forecasting, precomputed vendor
  identity headers, resilient public stats, and aggregate first-party usage
  analytics. A D1 mirror of
  recent notices (daily ingest; Socrata stays the source of truth) backs alert
  matching and server-side search. A daily KV materialized view joins rules
  hearings with public meetings and keeps affected geography separate from venue.
  Daily, versioned KV buckets let a complete
  vendor profile paint from one edge read; new front doors: subscribe-by-inbound-email
  and an MCP endpoint for AI assistants (both spend-metered), plus a public
  data.html page of live dataset aggregates. Digest delivery fans out through
  a Cloudflare Queue (per-subscriber retries, DLQ; daily send caps unchanged).
  The source vault retains approved public documents by content hash and
  preserves their official source links.
updated: 2026-07-29
sources:
  - README.md
  - MISSION.md
  - external_awards.js
  - staffing.js
  - i18n.js
  - tools/build_staffing_exams.mjs
  - tools/stamp_i18n_assets.py
  - .github/workflows/deploy-pages.yml
  - worker/wrangler.toml
  - worker/src/worker.mjs
sources_hash: cb37ec92e8ddf292d42936b4f73d92767ef7208b8773ccaf0af693c9e979e465
---

# crol-list — architecture

## What & why

The NYC City Record publishes every agency contract, hearing, rule change, rezoning, and property disposition — by City Charter §1066 — but the raw record is hard to follow by interest. CROL-List re-stitches it into seven navigable lenses, adds cross-references to Checkbook NYC (contract payments and NYCHA contracts), official NYS Authorities Budget Office award filings, ZAP (rezoning detail), and BBL lookups, delivers standing watches as email digests, and — since Wave 5 — forecasts upcoming solicitations up to 6 months out by fusing historical award durations with agencies' published §112 procurement plans. The constraint is no accounts, no per-user tracking, no hard backend dependency — every feature degrades gracefully when the worker is absent.

## System map

```
Browser (crol-list.org — static on GitHub Pages)
  index.html  (inline CSS + vanilla JS, ~100% of the feature surface)
        ├──►  data/staffing_exams.json (build-time materialized DCAS exam view)
        │  most queries go direct — CORS-open, no key needed
        ├──►  NYC Open Data / Socrata SODA (City Record dg92-zbpx, payroll, civil service, ZAP)
        ├──►  NYS Open Data / Socrata SODA (ABO awards 8w5p-k45m, d84c-dk28)
        ├──►  NYC GeoSearch / MapPLUTO (BBL lookups, rezoning polygons)
        │
        │  secret / server-side routes only
        ▼
  api.crol-list.org  (Cloudflare Worker "crol-worker" — worker/ in this repo;
                      workers.dev alias kept alive for in-flight confirm links)
        ├──  /nl                plain-English → lens filters (Claude Haiku, NL_METER-capped)
        ├──  /mcp               MCP for AI assistants: search/get/preview_watch/create_watch (metered)
        ├──  /checkbook         Checkbook NYC proxy + expiration pipeline (fc:* cache)
        ├──  /forecast          unified forecast timeline (expirations + §112 MOCS plans)
        ├──  /subscribe /confirm /unsubscribe   double-opt-in email (Turnstile-gated)
        ├──  /feedback          operator feedback form (Turnstile-gated, fails closed)
        ├──  /feed.xml /feed.json /feed.ics     standing feeds from any saved search
        ├──  /batch             watchlist cross-reference
        ├──  /agencies          public raw-name → canonical-name crosswalk (JSON/CSV)
        ├──  /vendor-profile    ≤24h complete vendor-profile projection (KV; live fallback on miss)
        ├──  /hearings          daily rules/meetings view with affected area + venue
        ├──  /source-vault/*    eligible public documents (R2; manifest gated)
        ├──  /inv[/<id>]        investigation snapshots + entity forecast metadata
        ├──  /priorcycle/<id>   precomputed prior-cycle + near-match sets (D1-cached, compute-on-miss)
        ├──  /stats /usage      public aggregate counters / keyed usage report
        ├──  /events            bounded aggregate usage events (no visitor identifiers)
        ├──  /r/<kind>/<id>     count-only digest click-through → 302
        └──  /admin/subs /admin/feedback        keyed operator views

Inbound email (Email Routing: subscribe@crol-list.org → this worker): plain
  English → LLM-parsed watch → double-opt-in confirm reply (metered, loop-guarded)
Cron (daily 13:00 UTC): (1) Socrata→D1 ingest refresh (fail-soft), (2) prior-cycle
  pre-warm for the freshly-ingested Award notices (bounded, fail-soft), (3) rebuild
  the location-aware hearings view, (4) rebuild versioned vendor-profile KV
  buckets (identity, agency rollup, 15 recent notices, and forecasts), then (5) digest
  fan-out — QUEUE_DIGESTS=true enqueues one job per subscription to
  Queue crol-digests (consumer sends with retries, poison → crol-digests-dlq);
  send caps unchanged: MAX_PER_RUN=25 / MAX_SENDS_PER_DAY=50 via Resend
KV: SUBS · NL_METER · ALERT_STATE (incl. fc:/plan: forecast cache) · FEEDBACK
D1: crol-notices — mirror of recent City Record notices + ingest cursor
     + prior_cycle_matches (precomputed prior-cycle/near-match cache)
R2: SOURCE_VAULT — content-addressed custody for approved public documents
Analytics Engine: crol_usage_events_v1 — versioned aggregate page/click/search
  events; enumerated dimensions only, with no cookies or visitor identifiers
```

Bottom-up, the way it's built: public Socrata feeds and Checkbook are the ground truth. `index.html` queries the CORS-open Socrata feeds directly; the Staffing career guide is the exception, using one committed materialized view built from DCAS schedules, NOEs, and Open Data so opening it never fans out to upstream APIs. The worker proxies Checkbook and also holds secrets (Claude, Resend), shared state (subscriptions, counters), and scheduled work (the digest cron). The Wave-5 forecasting layer sits inside the worker because it needs both a cache and the cron.

## Data stores & schemas

- **KV `SUBS`** — confirmed subscriptions: `sub:<token>` → `{email, lens, filters, frequency}`, plus per-IP/per-address rate-limit counters for `/subscribe`.
- **KV `NL_METER`** — daily spend metering for `/nl` (the denial-of-wallet ceiling on the only Claude-billed route).
- **KV `ALERT_STATE`** — digest/cron bookkeeping plus read models: `hearings:location:v1` → rules hearings and public meetings normalized into separate affected-area and venue fields (addresses resolved through NYC GeoSearch), `fc:<stem>` → computed contract-expiration forecasts (from Checkbook award durations), `plan:<stem>` → parsed §112 MOCS plan rows (Socrata `whpb-ebtd`), and versioned `vp:v1:*` whole-profile buckets behind `/vendor-profile`; stale or missing views retain live Socrata fallbacks.
- **KV `FEEDBACK`** — stored feedback rows (`fb:<ts>:<rand>`) + rate-limit counters.
- **`index.html` localStorage** — client-side only: investigation workspace (pinned notices + notes), query cache, saved searches, plain/rigor toggle.
- **D1 `crol-notices`** — mirror of recent notices (`notices` table: parsed columns + honest-data fields `contract_amount_valid`, `due_year`, plus the raw source row for schema-drift recovery), `ingest_state` (Socrata ingest cursor), and `prior_cycle_matches` (per-notice precomputed `{strict, near, eligibleCount}` prior-cycle match sets — the cache behind `GET /priorcycle/<id>`; compute-on-miss, cron pre-warms freshly-ingested Award notices, ranked by `worker/src/lib/prior_cycle.mjs`, a hand-synced dual implementation of index.html's matchers). Refreshed by the daily cron (`worker/src/ingest.mjs`); Socrata remains the source of truth.
- **R2 `SOURCE_VAULT`** — content-addressed custody for approved public documents. Each object carries provenance, eligibility, and its official source URL.
- **Analytics Engine `crol_usage_events_v1`** — first-party aggregate page, lens, search, deep-link, export, alert, feed, and investigation events. The versioned schema in `docs/analytics-event-taxonomy.md` permits only bounded enumerations; it stores no query text, email, IP address, cookie, fingerprint, or visitor identifier. `/stats` reads sampling-aware 7/30-day aggregates through Cloudflare's SQL API.
- **`data/`** — committed product data, including Staffing role chips and `staffing_exams.json`,
  a build-time view of current DCAS exam schedules, notices, and active-list totals. Wave 4
  transforms use deterministic test datasets under `test/fixtures/wave4/`; joined production
  records feed their product views.

## Serving & deploy

- `index.html` is built and served as a GitHub Pages static site at `crol-list.org` (CNAME in repo) — the canonical domain; every page's `<link rel="canonical">` points here regardless of which domain served the request. The Pages workflow derives one cache stamp from `i18n.js` plus every shipping dictionary, writes it only into the deployment artifact, verifies the result, and then publishes it.
- Worker deployed via `wrangler deploy` from `worker/` to the custom domain `api.crol-list.org` (workers.dev alias intentionally kept alive). Changes under `worker/**` deploy from `main` through `.github/workflows/deploy-worker.yml`; a manual Wrangler deploy remains the emergency path. Cron trigger `0 13 * * *` (~9am ET). D1 schema versioned in `worker/migrations/`, applied with `wrangler d1 migrations apply crol-notices --remote`.
- `cityscroll.org` / `www.cityscroll.org` — a parallel serving domain (same Cloudflare account, custom-domain routes in `worker/wrangler.toml`). Since GitHub Pages only virtual-hosts the one domain configured in its own settings, the worker answers these two hosts itself by reverse-proxying the static site straight from `crol-list.org` byte-for-byte (`worker/src/mirror.mjs`), so the mirror can never drift and the canonical tag rides along unchanged. `crol-list.org` stays canonical; this is infrastructure only, not a redirect or a content fork.
- Secrets via `wrangler secret put`: `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `TURNSTILE_SECRET`, `TOKEN_SECRET`, `USAGE_KEY`, `ANALYTICS_READ_TOKEN`, `ANALYTICS_DEV_KEY`, and the production-only `ANALYTICS_ENVIRONMENT` runtime gate. The analytics read token is scoped to Account Analytics Read; the developer key authenticates short-lived HMAC exclusions, while a missing/non-production runtime gate drops writes. Spend guards are vars in `wrangler.toml`: `MAX_PER_RUN=25`, `MAX_SENDS_PER_DAY=50` (under Resend's free 100/day); `/subscribe` and `/feedback` fail closed (503) if their secrets are absent.
- GitHub Actions runs the test suite on pull requests, builds and deploys the static site after merge, and deploys Worker changes when `worker/**` changes.

## Surface

- **Seven lenses:** Money (RFP→Award pipeline + forecast timeline), Staffing (plain-language civil-service guide + open/upcoming exam explorer + title decoder/payroll), Land (rezonings + map), Property (asset lifecycle), Rules, Meetings, Alerts (subscriptions + watchlist).
- **Location-aware hearings:** Meetings joins public-meeting notices with dated rules hearings, offers rolling week/month filters plus affected borough and neighborhood controls, and groups unlocated notices visibly instead of dropping them. Hearing cards render affected area and venue as independent facts; location-aware meeting watches replay the same distinction in digest matching.
- **Forecasting UI:** vertical timeline widget on vendor/agency profile panels — official §112 plan entries and calculated expirations carry distinct badges.
- **Vendor profiles:** in response to user feedback, identity, top-agency chips, 15 recent notices, and forecasts now paint together from one daily precomputed KV projection. Full-text mentions stay behind an explicit disclosure because joining every vendor stem against the recent text corpus is disproportionate; missing or stale projection records use the original live Socrata resolver.
- **External awards:** nine mapped public-authority profiles show up to eight recent awards from official annual ABO filings (`8w5p-k45m` / `d84c-dk28`) with source and lag labels. NYCHA solicitation details use exact-PIN Checkbook `Contracts_NYCHA` candidates only when the contract date is later than the solicitation date; matches remain separate from City Record rows.
- **API:** `api.html` documents all worker routes and hosts the live batch cross-reference tool. `GET /agencies` publishes the City Record agency-name reconciliation as cached, CORS-open JSON or CSV; `/api` on the worker 302s to the documentation.
- **MCP:** `POST /mcp` — `search_notices` / `get_notice` (D1 mirror) + `preview_watch` / `create_watch` (LLM, metered; double opt-in preserved). Optional bearer token; per-IP daily ceiling.
- **Subscribe by email:** `subscribe@crol-list.org` (Email Routing → the worker's `email()` handler) — plain English → LLM-parsed watch → confirm reply. Metered + per-sender-limited + loop-guarded.
- **The Data:** `data.html` — live dataset aggregates (sections, monthly volume, procurement mix, top agencies/vendors by cleaned dollars), browser→Socrata direct, honesty rules applied.
- **Feeds:** `/feed.xml`, `/feed.json`, `/feed.ics` — any saved search as a standing feed.
- **CLI:** none; the worker is deployed via `wrangler deploy`.

## Seams

- **Consumes:** NYC Open Data Socrata SODA (City Record `dg92-zbpx`, MOCS plans `whpb-ebtd`, payroll `k397-673e`, annual exam schedule `4ptz-hmtc`, active civil-service lists `vx8i-nprf`, ZAP `hgx4-8ukb`), current DCAS exam schedules and NOEs, NYS Open Data Socrata SODA (Authorities Budget Office local-authority awards `8w5p-k45m`, local-development-corporation awards `d84c-dk28`), Checkbook NYC API (`Contracts`, `Contracts_NYCHA`), NYC GeoSearch / MapPLUTO, DOB job filings, Anthropic Claude Haiku (`/nl`), Resend (email), Cloudflare Turnstile, Cloudflare KV + R2 + Analytics Engine + Cron Triggers.
- **Feeds:** subscriber inboxes (daily/weekly digests + forecast early warnings); public stats at `crol-list.org/stats.html`; RSS/Atom/JSON Feed/iCal consumers.
- **Sister repo (archived):** `crol-worker` — pre-move history of the worker before it was open-sourced into this monorepo (2026-07-02).

## TL;DR

1 static site (`index.html` + `data.html`) + 1 Cloudflare Worker, 7 lenses, public and operator API routes plus an inbound-email handler and queue consumer, 1 daily cron (ingest → cache precomputation → queue fan-out), 4 KV namespaces + 1 D1 database (notices mirror + prior-cycle cache) + 1 R2 source vault + 1 Analytics Engine dataset + 2 queues, 6 secrets, 2 hard send caps — under one hard rule: no accounts, cookies, fingerprinting, or visitor profiles, and no hard backend dependency; everything degrades gracefully when the worker is absent.

1. A visitor loads `index.html` (inline CSS + vanilla JS) served static from GitHub Pages at `crol-list.org` — no backend required.
2. Picking a lens fires queries direct from the browser to CORS-open public APIs: Socrata SODA for City Record notices and ABO awards, plus GeoSearch/MapPLUTO for BBL and rezoning geometry. Checkbook queries use the schema-agnostic worker proxy.
3. Server-only features route to `api.crol-list.org`: `/nl` (plain English → filters via Claude Haiku, metered by `NL_METER`), `/subscribe`→`/confirm`→`/unsubscribe` (double-opt-in, Turnstile-gated, fails closed), feeds, `/batch`, `/agencies`, `/inv`, `/stats`, `/feedback`, keyed `/admin/*` and `/usage`.
4. The forecasting layer (`/checkbook` + `/forecast`) parses historical Checkbook NYC award term lengths into projected expirations (`fc:<stem>` in `ALERT_STATE`) and merges them with scraped Charter §112 MOCS agency plans (`plan:<stem>`) into one chronological timeline, rendered as the profile-page timeline widget.
5. Subscriptions land in KV `SUBS`; legacy aggregate integers accrue in stats counters, while bounded page and interaction events accrue in Analytics Engine without visitor identifiers. The only personal data is the double-opted-in subscription email.
6. The daily cron (13:00 UTC) first refreshes the D1 notices mirror from Socrata (cursored, fail-soft — a failed ingest never blocks alerts), pre-warms prior-cycle match sets for freshly-ingested Award notices, rebuilds the versioned whole-profile vendor projection in KV, then replays active subscriptions and forecast milestones, sending digests and early-warning emails via Resend — hard-capped at 25/run, 50/day. Each cache job is fail-soft; Money digests exclude data-entry-error amounts (≥ $10B) and label rolling year-2090 deadlines honestly.
7. GitHub Pages serves the static site; Worker changes deploy automatically from `main`, with manual `wrangler deploy` retained as an emergency path.

## Check yourself

**Q:** Where does the Wave-5 forecast data live, and what are its two ingredients?
**A:** In KV `ALERT_STATE` under `fc:<stem>` (expirations calculated from historical Checkbook NYC award durations) and `plan:<stem>` (agency procurement schedules parsed from the Charter §112 MOCS Socrata dataset `whpb-ebtd`). `/forecast` merges both into one chronological timeline.

**Q:** The Cloudflare Worker is down or never deployed — what still works for a visitor?
**A:** The core search, CORS-open Socrata data (including ABO authority awards), maps, and local workspace still work. Worker-backed extras go dark — email alerts, feeds, `/nl` search, forecasting, stats, Checkbook payment lookups, and NYCHA contract matches.

**Q:** What stops a hostile script from running up the bill on the paid routes?
**A:** Layered ceilings that fail closed: `/nl` is metered per-day in KV `NL_METER`; email sends are hard-capped by `MAX_PER_RUN=25` / `MAX_SENDS_PER_DAY=50` (under Resend's free tier); `/subscribe` and `/feedback` are Turnstile-gated with per-IP/per-address rate-limit counters and return 503 if their secrets are missing.
