---
summary: >-
  CROL-List is a dependency-free static site (`index.html`) plus a Cloudflare
  Worker backend that makes NYC's City Record searchable by interest: seven
  lenses (Money/People/Land/Property/Rules/Meetings plus an alert system) over
  live Socrata open-data APIs. The site works fully without the worker; the
  worker adds email alerts, feeds, plain-English search, and the stats counter.
updated: 2026-07-05
sources:
  - README.md
  - MISSION.md
sources_hash: 3ef8d2f0a11d42e7d8121aacf3de335a5c47fca9bd40846aa66c1ba0c180ee1e
---

# crol-list — architecture

## What & why

The NYC City Record publishes every agency contract, hearing, rule change, rezoning, and property disposition — by City Charter §1066 — but the raw record is hard to follow by interest. CROL-List re-stitches it into seven navigable lenses, adds cross-references to Checkbook NYC (contract payments), ZAP (rezoning detail), and BBL lookups, and delivers standing watches as email digests so subscribers learn about matching notices the morning after publication. The constraint is no accounts, no per-user tracking, no hard backend dependency — every feature degrades gracefully when the worker is absent.

## System map

```
Browser (crol-list.org — static on GitHub Pages)
  index.html  (inline CSS + vanilla JS, ~100% of the feature surface)
        │  most queries go direct — CORS-open, no key needed
        ├──►  NYC Open Data / Socrata SODA (City Record notices)
        ├──►  Checkbook NYC API (contract payments by PIN)
        ├──►  NYC GeoSearch / MapPLUTO (BBL lookups, rezoning polygons)
        │
        │  secret / server-side routes only
        ▼
  api.crol-list.org  (Cloudflare Worker — worker/ in this repo)
        ├──  /nl        plain-English → lens filters (Claude Haiku)
        ├──  /subscribe /confirm /unsubscribe  (double-opt-in email)
        ├──  /feed.xml /feed.json /feed.ics    (standing feeds)
        ├──  /batch     watchlist cross-reference
        ├──  /inv[/<id>]  investigation snapshots (KV, 90-day TTL)
        ├──  /stats     public aggregate counters
        └──  /r/<kind>/<id>  count-only digest click-through → 302

Cron trigger (Cloudflare): daily digest — replays active subscriptions, sends email via Resend
KV namespaces: SUBS (subscriptions), stats counters
```

## Data stores & schemas

- **Cloudflare KV `SUBS`** — active subscriptions: `sub:<token>` → `{email, lens, filters, frequency}`, `inv:<id>` → investigation snapshot JSON.
- **KV stats counters** — aggregate integers: digests sent, click-throughs, feed hits, NL calls (no personal data).
- **`index.html` localStorage** — client-side only: investigation workspace (pinned notices + notes), read-side query cache, saved searches, plain/rigor toggle state.
- **`data/`** — committed seed data for People lens role chips (instant, no network).

## Serving & deploy

- `index.html` served as a GitHub Pages static site at `crol-list.org`.
- Worker deployed via `wrangler deploy` from `worker/` to `api.crol-list.org` (Cloudflare Workers + KV + Cron Triggers). Secrets: `ANTHROPIC_API_KEY`, `TURNSTILE_SECRET`, `TOKEN_SECRET`, `RESEND_API_KEY`.
- No CI/CD pipeline; deploy is manual from the MacBook.

## Surface

- **Seven lenses:** Money (RFP→Award pipeline), People (title decoder + payroll), Land (rezonings + map), Property (asset lifecycle), Rules (agency regulations), Meetings (public hearings), Alerts (subscriptions + watchlist).
- **API:** `api.html` documents all worker routes and hosts the live batch cross-reference tool.
- **Feeds:** `/feed.xml`, `/feed.json`, `/feed.ics` — any saved search as a standing feed.
- **CLI:** none; the worker is deployed via `wrangler deploy`.

## Seams

- **Consumes:** NYC Open Data Socrata SODA, Checkbook NYC API, NYC GeoSearch / MapPLUTO / ZAP, Anthropic Claude Haiku (NL search), Resend (email digest), Cloudflare Turnstile (spam gate), Cloudflare KV, Cloudflare Cron Triggers.
- **Feeds:** subscriber email inboxes (daily/weekly digests); public stats at `crol-list.org/stats.html`; RSS/Atom/JSON Feed/iCal consumers.
- **Sister repo (archived):** `crol-worker` — pre-move history of the worker before it was open-sourced into this monorepo (2026-07-02).
