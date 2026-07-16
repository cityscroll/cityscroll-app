---
summary: >-
  CROL-List is a dependency-free static site (`index.html`) plus a Cloudflare
  Worker backend that makes NYC's City Record searchable by interest: seven
  lenses (Money/People/Land/Property/Rules/Meetings plus an alert system) over
  live Socrata open-data APIs, with a Wave-5 forecasting layer that predicts
  contract renewals from Checkbook NYC durations and Charter §112 MOCS plans,
  and labels separately sourced public-authority awards on agency profiles.
  The core site works without the worker; the worker adds Checkbook lookups,
  email alerts, feeds, plain-English search, forecasting, and the stats counter. A D1 mirror of
  recent notices (daily ingest; Socrata stays the source of truth) backs alert
  matching and server-side search; new front doors: subscribe-by-inbound-email
  and an MCP endpoint for AI assistants (both spend-metered), plus a public
  data.html page of live dataset aggregates. Digest delivery fans out through
  a Cloudflare Queue (per-subscriber retries, DLQ; daily send caps unchanged).
updated: 2026-07-16
sources:
  - README.md
  - MISSION.md
  - external_awards.js
  - worker/wrangler.toml
  - worker/src/worker.mjs
sources_hash: 711e684f466d2144bccf55fd571bdb061ee3b7abf5891a27d962b4367e5f5ecc
---

# crol-list — architecture

## What & why

The NYC City Record publishes every agency contract, hearing, rule change, rezoning, and property disposition — by City Charter §1066 — but the raw record is hard to follow by interest. CROL-List re-stitches it into seven navigable lenses, adds cross-references to Checkbook NYC (contract payments and NYCHA contracts), official NYS Authorities Budget Office award filings, ZAP (rezoning detail), and BBL lookups, delivers standing watches as email digests, and — since Wave 5 — forecasts upcoming solicitations up to 6 months out by fusing historical award durations with agencies' published §112 procurement plans. The constraint is no accounts, no per-user tracking, no hard backend dependency — every feature degrades gracefully when the worker is absent.

## System map

```
Browser (crol-list.org — static on GitHub Pages)
  index.html  (inline CSS + vanilla JS, ~100% of the feature surface)
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
        ├──  /inv[/<id>]        investigation snapshots + entity forecast metadata
        ├──  /priorcycle/<id>   precomputed prior-cycle + near-match sets (D1-cached, compute-on-miss)
        ├──  /stats /usage      public aggregate counters / keyed usage report
        ├──  /r/<kind>/<id>     count-only digest click-through → 302
        └──  /admin/subs /admin/feedback        keyed operator views

Inbound email (Email Routing: subscribe@crol-list.org → this worker): plain
  English → LLM-parsed watch → double-opt-in confirm reply (metered, loop-guarded)
Cron (daily 13:00 UTC): (1) Socrata→D1 ingest refresh (fail-soft), (2) prior-cycle
  pre-warm for the freshly-ingested Award notices (bounded, fail-soft), then
  (3) digest fan-out — QUEUE_DIGESTS=true enqueues one job per subscription to
  Queue crol-digests (consumer sends with retries, poison → crol-digests-dlq);
  send caps unchanged: MAX_PER_RUN=25 / MAX_SENDS_PER_DAY=50 via Resend
KV: SUBS · NL_METER · ALERT_STATE (incl. fc:/plan: forecast cache) · FEEDBACK
D1: crol-notices — mirror of recent City Record notices + ingest cursor
     + prior_cycle_matches (precomputed prior-cycle/near-match cache)
```

Bottom-up, the way it's built: public Socrata feeds and Checkbook are the ground truth. `index.html` queries the CORS-open Socrata feeds directly; the worker proxies Checkbook and also holds secrets (Claude, Resend), shared state (subscriptions, counters), and scheduled work (the digest cron). The Wave-5 forecasting layer sits inside the worker because it needs both a cache and the cron.

## Data stores & schemas

- **KV `SUBS`** — confirmed subscriptions: `sub:<token>` → `{email, lens, filters, frequency}`, plus per-IP/per-address rate-limit counters for `/subscribe`.
- **KV `NL_METER`** — daily spend metering for `/nl` (the denial-of-wallet ceiling on the only Claude-billed route).
- **KV `ALERT_STATE`** — digest/cron bookkeeping plus the forecast cache: `fc:<stem>` → computed contract-expiration forecasts (from Checkbook award durations), `plan:<stem>` → parsed §112 MOCS plan rows (Socrata `whpb-ebtd`).
- **KV `FEEDBACK`** — stored feedback rows (`fb:<ts>:<rand>`) + rate-limit counters.
- **`index.html` localStorage** — client-side only: investigation workspace (pinned notices + notes), query cache, saved searches, plain/rigor toggle.
- **D1 `crol-notices`** — mirror of recent notices (`notices` table: parsed columns + honest-data fields `contract_amount_valid`, `due_year`, plus the raw source row for schema-drift recovery), `ingest_state` (Socrata ingest cursor), and `prior_cycle_matches` (per-notice precomputed `{strict, near, eligibleCount}` prior-cycle match sets — the cache behind `GET /priorcycle/<id>`; compute-on-miss, cron pre-warms freshly-ingested Award notices, ranked by `worker/src/lib/prior_cycle.mjs`, a hand-synced dual implementation of index.html's matchers). Refreshed by the daily cron (`worker/src/ingest.mjs`); Socrata remains the source of truth.
- **`data/`** — committed seed data for People-lens role chips (instant, no network).

## Serving & deploy

- `index.html` served as a GitHub Pages static site at `crol-list.org` (CNAME in repo).
- Worker deployed via `wrangler deploy` from `worker/` to the custom domain `api.crol-list.org` (workers.dev alias intentionally kept alive). Cron trigger `0 13 * * *` (~9am ET). D1 schema versioned in `worker/migrations/`, applied with `wrangler d1 migrations apply crol-notices --remote`.
- Secrets via `wrangler secret put`: `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `TURNSTILE_SECRET`, `TOKEN_SECRET`, `USAGE_KEY`. Spend guards are vars in `wrangler.toml`: `MAX_PER_RUN=25`, `MAX_SENDS_PER_DAY=50` (under Resend's free 100/day); `/subscribe` and `/feedback` fail closed (503) if their secrets are absent.
- No CI/CD pipeline; deploy is manual from the MacBook.

## Surface

- **Seven lenses:** Money (RFP→Award pipeline + forecast timeline), People (title decoder + payroll), Land (rezonings + map), Property (asset lifecycle), Rules, Meetings, Alerts (subscriptions + watchlist).
- **Forecasting UI:** vertical timeline widget on vendor/agency profile panels — official §112 plan entries and calculated expirations carry distinct badges.
- **External awards:** nine mapped public-authority profiles show up to eight recent awards from official annual ABO filings (`8w5p-k45m` / `d84c-dk28`) with source and lag labels. NYCHA solicitation details use exact-PIN Checkbook `Contracts_NYCHA` candidates only when the contract date is later than the solicitation date; matches remain separate from City Record rows.
- **API:** `api.html` documents all worker routes and hosts the live batch cross-reference tool; `/api` on the worker 302s there.
- **MCP:** `POST /mcp` — `search_notices` / `get_notice` (D1 mirror) + `preview_watch` / `create_watch` (LLM, metered; double opt-in preserved). Optional bearer token; per-IP daily ceiling.
- **Subscribe by email:** `subscribe@crol-list.org` (Email Routing → the worker's `email()` handler) — plain English → LLM-parsed watch → confirm reply. Metered + per-sender-limited + loop-guarded.
- **The Data:** `data.html` — live dataset aggregates (sections, monthly volume, procurement mix, top agencies/vendors by cleaned dollars), browser→Socrata direct, honesty rules applied.
- **Feeds:** `/feed.xml`, `/feed.json`, `/feed.ics` — any saved search as a standing feed.
- **CLI:** none; the worker is deployed via `wrangler deploy`.

## Seams

- **Consumes:** NYC Open Data Socrata SODA (City Record `dg92-zbpx`, MOCS plans `whpb-ebtd`, payroll `k397-673e`, civil service `vx8i-nprf`, ZAP `hgx4-8ukb`), NYS Open Data Socrata SODA (Authorities Budget Office local-authority awards `8w5p-k45m`, local-development-corporation awards `d84c-dk28`), Checkbook NYC API (`Contracts`, `Contracts_NYCHA`), NYC GeoSearch / MapPLUTO, DOB job filings, Anthropic Claude Haiku (`/nl`), Resend (email), Cloudflare Turnstile, Cloudflare KV + Cron Triggers.
- **Feeds:** subscriber inboxes (daily/weekly digests + forecast early warnings); public stats at `crol-list.org/stats.html`; RSS/Atom/JSON Feed/iCal consumers.
- **Sister repo (archived):** `crol-worker` — pre-move history of the worker before it was open-sourced into this monorepo (2026-07-02).

## TL;DR

1 static site (`index.html` + `data.html`) + 1 Cloudflare Worker (21 source modules + 19 lib), 7 lenses, 19 worker routes + an inbound-email handler + a queue consumer, 1 daily cron (ingest → prior-cycle pre-warm → queue fan-out), 4 KV namespaces + 1 D1 database (notices mirror + prior-cycle cache) + 2 queues, 5 secrets, 2 hard send caps — under one hard rule: no accounts, no tracking, no hard backend dependency; everything degrades gracefully when the worker is absent.

1. A visitor loads `index.html` (inline CSS + vanilla JS) served static from GitHub Pages at `crol-list.org` — no backend required.
2. Picking a lens fires queries direct from the browser to CORS-open public APIs: Socrata SODA for City Record notices and ABO awards, plus GeoSearch/MapPLUTO for BBL and rezoning geometry. Checkbook queries use the schema-agnostic worker proxy.
3. Server-only features route to `api.crol-list.org`: `/nl` (plain English → filters via Claude Haiku, metered by `NL_METER`), `/subscribe`→`/confirm`→`/unsubscribe` (double-opt-in, Turnstile-gated, fails closed), feeds, `/batch`, `/inv`, `/stats`, `/feedback`, keyed `/admin/*` and `/usage`.
4. The forecasting layer (`/checkbook` + `/forecast`) parses historical Checkbook NYC award term lengths into projected expirations (`fc:<stem>` in `ALERT_STATE`) and merges them with scraped Charter §112 MOCS agency plans (`plan:<stem>`) into one chronological timeline, rendered as the profile-page timeline widget.
5. Subscriptions land in KV `SUBS`; aggregate integers accrue in stats counters — no personal data beyond the double-opted-in email itself.
6. The daily cron (13:00 UTC) first refreshes the D1 notices mirror from Socrata (cursored, fail-soft — a failed ingest never blocks alerts), pre-warms prior-cycle match sets for the freshly-ingested Award notices (bounded, fail-soft; anything unwarmed computes lazily on first `/priorcycle/<id>` request), then replays active subscriptions and forecast milestones, sending digests and early-warning emails via Resend — hard-capped at 25/run, 50/day. Money digests exclude data-entry-error amounts (≥ $10B) and label rolling year-2090 deadlines honestly.
7. Deploy is manual from the MacBook: `index.html` to GitHub Pages, worker via `wrangler deploy`. There is no CI/CD.

## Check yourself

**Q:** Where does the Wave-5 forecast data live, and what are its two ingredients?
**A:** In KV `ALERT_STATE` under `fc:<stem>` (expirations calculated from historical Checkbook NYC award durations) and `plan:<stem>` (agency procurement schedules parsed from the Charter §112 MOCS Socrata dataset `whpb-ebtd`). `/forecast` merges both into one chronological timeline.

**Q:** The Cloudflare Worker is down or never deployed — what still works for a visitor?
**A:** The core search, CORS-open Socrata data (including ABO authority awards), maps, and local workspace still work. Worker-backed extras go dark — email alerts, feeds, `/nl` search, forecasting, stats, Checkbook payment lookups, and NYCHA contract matches.

**Q:** What stops a hostile script from running up the bill on the paid routes?
**A:** Layered ceilings that fail closed: `/nl` is metered per-day in KV `NL_METER`; email sends are hard-capped by `MAX_PER_RUN=25` / `MAX_SENDS_PER_DAY=50` (under Resend's free tier); `/subscribe` and `/feedback` are Turnstile-gated with per-IP/per-address rate-limit counters and return 503 if their secrets are missing.
