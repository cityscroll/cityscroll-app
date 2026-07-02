# crol-worker

The thin serverless backend for **[CROL-List](https://crol-list.org)** — a single
**Cloudflare Worker** at `https://api.crol-list.org` (custom domain; `crol-worker.crol-worker.workers.dev` remains an alias). CROL-List itself is
100% static (one `index.html` on GitHub Pages, no keys); everything that needs a held secret,
a CORS shim, a schedule, or server-side rendering lives here. The site works fully without
the worker — every feature degrades gracefully when it's absent.

> Maintenance rule: this README is updated with every significant feature change — if a
> route, cron behavior, or defense changes, its description lands here in the same session.
> (It previously went stale enough to still describe the retired Netlify deployment; don't
> let that happen again.)

## How it all plugs together

```
   Browser (crol-list.org, static on GitHub Pages)
        │
        │  most queries go straight to NYC Open Data (CORS-open, no key)
        ├───────────────────────────►  Socrata SODA / GeoSearch / MapPLUTO
        │
        │  the rest go to the worker (const API in index.html)
        ▼
   crol-worker (Cloudflare Worker + KV + Cron Triggers)
```

The frontend knows the worker by a single constant in `crol-list/index.html`:
`const API = "https://api.crol-list.org"`. Empty string = pure
client-side (NL search uses the on-device heuristic, subscriptions/feeds are hidden).

## Routes

| Route | Method | Purpose | Gating / secret |
|---|---|---|---|
| `/nl` | POST | Claude Haiku decodes English → lens filters | `ANTHROPIC_API_KEY`; degrades to `{degraded:true}` |
| `/checkbook` | POST | CORS proxy to checkbooknyc.com/api | none |
| `/feed.xml` `/feed.json` `/feed.ics` | GET | **Any saved search as a standing feed** — Atom / JSON Feed 1.1 / subscribable calendar. Params: `lens=money\|land\|property\|rules\|meetings`, `q=`, `agency=`, `min=`. Same `compileSub()` queries the cron replays; entry links land on `crol-list.org/#notice/<id>` permalinks; edge-cached 15 min; no paid key on the path | none |
| `/subscribe` | POST | Double-opt-in signup (Turnstile + per-IP/per-address rate limits); emails a signed confirm link, stores nothing until clicked | fails closed 503 until `TURNSTILE_SECRET` + `TOKEN_SECRET` + `RESEND_API_KEY` + `SUBS` |
| `/confirm` | GET | Verifies the token, writes the ACTIVE sub to KV | `TOKEN_SECRET` + `SUBS` |
| `/unsubscribe` | GET/POST | Removes a sub; POST = RFC 8058 one-click | `TOKEN_SECRET` + `SUBS` |
| `/feedback` | POST | Stores + emails operator feedback (Turnstile, rate-limited; rows keep IP+UA) | fails closed 503 |
| `/batch` | POST | Watchlist cross-reference: `{names:[…]}` (≤10) → per-name award/mention counts + vendor-profile links; 30/day/IP | none |
| `/inv` · `/inv/<id>` | POST/GET | Share an investigation snapshot (clamped, ≤32KB, 90-day TTL, 10/day/IP; SUBS KV `inv:` prefix) | none |
| `/stats` | GET | **Public outcome counters** (R·B): active subscriptions (count only), digests sent (today/7d), digest-link clicks, feed/batch/share activity, NL calls — aggregate integers, no personal data; edge-cached 15 min | none |
| `/r/<kind>/<request_id>` | GET | **Count-only digest click-through** (R·B tier 3, team-approved 2026-07-02): bumps a per-day counter (`stats:click`, `stats:click.<kind>`) and 302s to `crol-list.org/#notice/<id>`. Validated slug+id only — the path never carries a URL, so it cannot be an open redirect. No per-recipient tracking; digests disclose this in the footer | none |
| `/api` | GET | 302 → crol-list.org/api.html (the API docs) | none |
| `/admin/subs` `/admin/feedback` | GET | Operator reads (redacted) | `ADMIN_KEY` → 404 if unset |
| `/usage` | GET | Read-only Haiku spend report | `USAGE_KEY` → 404 if unset |
| `/` `/health` | GET | liveness | none |

## The daily digest (cron `0 13 * * *` ≈ 9am ET; LIVE since 2026-07-01)

`scheduled` → `runAlerts()`: replays every confirmed subscription from `SUBS` KV via
`lib/compile.mjs` `compileSub()` — a **deterministic** SODA/ZAP query per `{lens, filter}`,
no model call at cron time — diffs against per-watch seen-IDs in `ALERT_STATE`, and emails
only NEW notices via Resend. Cron-replayable lenses: **money** (awards ≥ threshold / RFP
keywords), **land** (rezonings), **property / rules / meetings** (City Record section
queries; meetings = upcoming events only), and **entity** (follow a vendor — name-stem
resolved via a postFilter — or an agency across all sections). `people` compiles to `null` and is
skipped. Weekly subs fire Mondays. The **confidence layer** (`lib/digest.mjs`) breaks silence
deliberately — weekly empty check-ins and a "still watching" heartbeat after
`HEARTBEAT_DAYS=14` quiet days — so a quiet inbox never looks broken. Digest items link to
the site's `#notice/<id>` permalinks.

**Email identity:** From is always the app's own (`ALERTS_FROM` =
`CROL-List <alerts@crol-list.org>`, domain verified in Resend, DMARC passing); To is only
ever the subscriber's own opted-in address. Never sends as a person.

## Defense in depth (denial-of-wallet & abuse)

`/nl` is the only endpoint that spends money, so it's layered: CORS allowlist
(crol-list.org + legacy origins + localhost), 600-char input cap, a **hard daily ceiling**
(`MAX_CALLS_PER_DAY=300`, KV counter in `NL_METER`), tiny `max_tokens`, and
`{degraded:true}` on every failure path — worst case a few tens of cents/day by
construction. Alert sending is bounded by `MAX_PER_RUN=25` and `MAX_SENDS_PER_DAY=50`
(under Resend's free 100/day); capped watches **defer** to the next run rather than dropping
notices. Subscribe/feedback have Turnstile + per-IP/per-address daily rate limits and fail
closed when unconfigured. Feeds hold no key and are edge-cached.

## Storage — Cloudflare KV (no D1/R2)

`NL_METER` (NL daily counters) · `ALERT_STATE` (seen-IDs, send counters — 40-day TTL so /stats can window them, last-sent dates, and `stats:<metric>:<day>` outcome counters) ·
`SUBS` (confirmed subs + subscribe rate limits) · `FEEDBACK` (feedback rows + rate limits).

## Develop, test, deploy

```sh
npm install
npm test                  # node --test — 97 unit tests, no network
npm run dev               # wrangler dev → http://localhost:8787 (secrets in .dev.vars)
npx wrangler deploy       # deploy (free); cron + KV bindings come from wrangler.toml
CROL_WORKER_URL=https://api.crol-list.org npm run test:live   # live e2e over every public route
#   (defaults to the workers.dev alias — doubling as a regression check that the alias stays up)
```

Secrets (`wrangler secret put`): `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `TOKEN_SECRET`,
`TURNSTILE_SECRET`, `USAGE_KEY`, `ADMIN_KEY`. Vars (in `wrangler.toml`): `ALERTS_LIVE`
(master switch — anything but `"true"` = dry-run), `ALERTS_FROM`, `MAX_PER_RUN`,
`MAX_SENDS_PER_DAY`, `HEARTBEAT_DAYS`, `FEEDBACK_TO`. Fire the cron locally by hitting
`/__scheduled` under `wrangler dev`.

## History

Originally Netlify Functions + Blobs; migrated to Cloudflare Workers + KV (free deploys —
Netlify billed 15 credits per production deploy against a shared pool; background:
`../`). The `netlify/` directory is legacy.
Moving both repos into a shared GitHub org remains a deferred governance call, not a code one.
