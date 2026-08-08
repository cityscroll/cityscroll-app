# crol-worker

The thin serverless backend for **[CityScroll](https://cityscroll.org)** — a single
**Cloudflare Worker** at `https://api.cityscroll.org` (custom domain; `crol-worker.crol-worker.workers.dev` remains an alias). CityScroll itself is
100% static (one `index.html` on GitHub Pages, no keys); everything that needs a held secret,
a CORS shim, a schedule, or server-side rendering lives here. The site works fully without
the worker — every feature degrades gracefully when it's absent.

Cloudflare Pages remains the origin for the canonical `cityscroll.org` / `www.cityscroll.org`
site hostnames. Bounded Worker zone routes serve the dynamic `/near-you*`, `/following*`,
and `/prefs*` documents on `cityscroll.org`; all other site paths retain the Pages origin.
The Worker custom domains are `api.cityscroll.org` and the compatibility alias
`api.crol-list.org`. CORS allowlists retain the old origins for compatibility.

> Maintenance rule: this README is updated with every significant feature change — if a
> route, cron behavior, or defense changes, its description lands here in the same session.
> (It previously went stale enough to still describe the retired Netlify deployment; don't
> let that happen again.)

## How it all plugs together

```
   Browser (cityscroll.org, served by Cloudflare Pages)
        │
        │  most queries go straight to NYC Open Data (CORS-open, no key)
        ├───────────────────────────►  Socrata SODA / GeoSearch / MapPLUTO
        │
        │  the rest go to the worker (const API in index.html)
        ▼
   crol-worker (Cloudflare Worker + KV + Cron Triggers)
```

The frontend defaults to `https://api.cityscroll.org` through `window.CROL_API_ORIGIN`.
Review builds set that value to `https://api-beta.cityscroll.org` before page scripts
run. An unavailable Worker leaves the site in its client-side degraded mode.

The beta Worker is a separate, manually deployed Wrangler environment. It
inherits no production secrets, storage bindings, queues, or cron trigger;
stateful and delivery routes fail closed. Its CORS policy accepts beta review
origins only when `DEPLOYMENT_CHANNEL=beta`, while the production environment
continues to reject those origins. See `../docs/beta-channel.md`.

## Routes

Reader-facing HTML uses canonical `cityscroll.org` paths. Existing API-host links for
`/near-you`, `/following`, and `/prefs` permanently redirect to their canonical equivalents.

| Route | Method | Purpose | Gating / secret |
|---|---|---|---|
| `/nl` | POST | Claude Haiku decodes English → lens filters | `ANTHROPIC_API_KEY`; degrades to `{degraded:true}` |
| `/checkbook` | POST | CORS proxy to checkbooknyc.com/api | none |
| `/feed.xml` `/feed.json` `/feed.ics` | GET | **Any saved search as a standing feed** — Atom / JSON Feed 1.1 / subscribable calendar. Params: `lens=money\|land\|property\|rules\|meetings`, `q=`, `agency=`, `min=`. Same `compileSub()` queries the cron replays; entry links land on `cityscroll.org/#notice/<id>` permalinks; edge-cached 15 min; no paid key on the path. Calendar UIDs retain the `@crol-list` namespace so existing subscribers do not receive duplicate events | none |
| `/subscribe` | POST | Double-opt-in signup (per-IP/per-address rate limits; no CAPTCHA on this path); emails a signed [`optin-token`](https://github.com/jimdc/optin-token) confirm link, stores nothing until clicked | fails closed 503 until `TOKEN_SECRET` + `RESEND_API_KEY` + `SUBS` |
| `/confirm` | GET | Verifies the `optin-token`, writes the ACTIVE sub to KV | `TOKEN_SECRET` + `SUBS` |
| `/unsubscribe` | GET/POST | Removes one watch (`{k}`) or all watches for an email (`{all:1,e}`); POST = RFC 8058 one-click | `TOKEN_SECRET` + `SUBS` |
| `/prefs` | GET/POST | **Preference center** — magic-link list/edit/pause/delete watches for one email; changes take effect next daily cron (~9am ET) | `TOKEN_SECRET` + `SUBS` |
| `/feedback` | POST | Stores + emails operator feedback (rate-limited; rows keep IP+UA; notifies `FEEDBACK_TO`, default `feedback@cityscroll.org`) | fails closed 503 without `RESEND_API_KEY` + `FEEDBACK` |
| `/batch` | POST | Watchlist cross-reference: `{names:[…]}` (≤10) → per-name award/mention counts + vendor-profile links; 30/day/IP | none |
| `/agencies` | GET | Public City Record agency-name crosswalk: one row per distinct source string → site id, preferred name, and full variant group. JSON by default; `?format=csv` for CSV; CORS-open and edge-cached one day | none |
| `/property-locations` | GET | Daily Property Disposition projection with extracted site addresses, boroughs, tax lots, BBLs, and resolved map geometry; CORS-open and edge-cached 30 minutes | none |
| `/meeting.ics?id=<request_id>` | GET | One meeting calendar event served from the daily `/hearings` materialization; includes the published New York venue, remote join URL, dial-in details, and timezone-aware event time when available | none |
| `/entity-dossier?id=` | GET | **Foundation surface (not yet live for demo subject ids):** read-only dossier when a published `canonical_entity` exists; otherwise **404** with `public_status: "not_yet_public"` (subject-registry on lifecycles remains live). Linked assertions, disagreement/missingness, link-confidence bands when resolved; HTML default / JSON via `Accept` or `?format=json`; edge-cached 5 minutes on 200 | none; `DB` |
| `/inv` · `/inv/<id>` | POST/GET | Share an investigation snapshot (clamped, ≤32KB, 90-day TTL, 10/day/IP; SUBS KV `inv:` prefix) | none |
| `/priorcycle/<request_id>` | GET | **Precomputed prior-cycle + near-match sets** for an Award notice (Phase 1a — the server side of moving index.html's two live SODA panels off the client; Phase 1b swaps the client to this). Ranked by `src/lib/prior_cycle.mjs`, a hand-synced dual implementation of index.html's matchers (cross-check test fails on divergence); cached in D1 `prior_cycle_matches`, compute-on-miss, cron pre-warms fresh Award notices; validated id, edge-cached 5 min | none |
| `/translate/<request_id>?lang=` | GET | **Informal notice translation** — original English remains the official record on the client; this returns an optional unofficial title+description aid. Glossary-pinned Haiku call on first miss only; D1 `notice_translations` + edge cache thereafter (no per-pageview upstream). Amounts, dates, PINs, Request IDs, agency names, and addresses must appear verbatim or the response is `{ok:false}` and nothing is cached. Daily ceiling `TRANSLATE_MAX_CALLS_PER_DAY` (default 150) on NEW translations only; cache hits never spend the meter | `ANTHROPIC_API_KEY` for first compute; degrades to `{ok:false}` |
| `/stats` | GET | **Public corpus and coverage facts** (`public-stats.v2`): official City Record notice count and date range, primary public source systems, and language coverage. Product usage, subscriptions, sends, and daily series are intentionally absent; edge-cached 15 min. | none |
| `/events` | POST | Bounded first-party event intake. Accepts only the enumerations in `../docs/analytics-event-taxonomy.md`, caps payloads at 1 KiB, and writes one aggregate Analytics Engine point with no visitor identifier. | allowed site origin + production runtime binding + `USAGE_ANALYTICS` |
| `/r/<kind>/<request_id>` | GET | **Count-only digest click-through** (R·B tier 3, team-approved 2026-07-02): bumps a per-day counter (`stats:click`, `stats:click.<kind>`) and 302s to `cityscroll.org/#notice/<id>`. Validated slug+id only — the path never carries a URL, so it cannot be an open redirect. No per-recipient tracking; digests disclose this in the footer | none |
| `/api` | GET | 302 → cityscroll.org/api.html (the API docs) | none |
| `/admin/subs` `/admin/feedback` | GET | Operator reads (redacted) | `ADMIN_KEY` → 404 if unset |
| `/admin/ops-contract` | GET | **Versioned ops contract** (`ops-contract.v1`) — digest modes, daylog actions/fields, stats metrics (incl. developer-traffic exclusion), admin routes + auth classes, KV key prefixes, feature flags. No secrets. Desk panels pin `min_compatible_version` against this document (or the committed fixture `worker/ops-contract.v1.json`). Never served on public `/stats` | `ADMIN_KEY` → 404 if unset |
| `/admin/stats` | GET | **Private product activity and delivery operations** formerly returned by public `/stats`: subscriptions, sends, searches, visits, interaction breakdowns, and daily history. JSON by default; `?view=html` renders the responsive desk panel. | `ADMIN_KEY` → 404 if unset |
| `/admin/possibly-same` | GET | Read-only desk review of candidates blocked from recent `source_records`, excluding pairs already joined to one canonical entity; `Accept: application/json` returns the shaped cards | `ADMIN_KEY` → 404 if unset; `DB` |
| `/admin/digest-rollup` | GET | Dry-run account digest for `?email=` (no Resend); shows rollup vs single and day-log preview | `ADMIN_KEY` → 404 if unset |
| `/admin/digest-shadow` | GET/POST | **06:00 ET digest rehearsal**. GET returns the latest/dated machine-readable run summary, scoped hold state, and optional `?digest=` preview. GET also accepts the read-only `SHADOW_STATUS_KEY` (constant-time, scoped to this one route) so an ops proxy can read the status without `ADMIN_KEY` custody. `NEEDS_ATTENTION` returns HTTP 503 with structured redlines. POST re-runs the delivery-free build after a repair (always requires `ADMIN_KEY`); `{ "action":"override-hold", "digest_ids":[…], "reason":"…" }` releases only named affected digests | GET: `ADMIN_KEY` or `SHADOW_STATUS_KEY` → 404 if neither is set; POST: `ADMIN_KEY`; `DB` |
| `/admin/digest-send-test` | POST | Evaluate or send one allowlisted address through the normal digest path; `live` is opt-in and `advanceState` defaults false | operator probe key (`ADMIN_KEY` or `ANALYTICS_DEV_KEY`) → 404 if neither is set; recipient allowlist |
| `/admin/suggest-refresh` | POST | Runs the suggestion-chip validation (`/suggestions`' cron pipeline) on demand instead of waiting for the 13:00 UTC cron; returns the same summary JSON, fail-soft identical to the cron path | `ADMIN_KEY` → 404 if unset |
| `/usage` | GET | Read-only Haiku spend report | `USAGE_KEY` → 404 if unset |
| `/board-hook` | POST | **Board notifications** — see below | HMAC (`BOARD_HOOK_SECRET`) fails closed; fails closed 503 with no bot/App token configured |
| `/` `/health` | GET | liveness | none |

## The daily digest (shadow `0 10 * * *` ≈ 6am ET; send `0 13 * * *` ≈ 9am ET)

The 06:00 ET shadow run forces the real account digest builders inline against live data with
delivery, queue fan-out, watermarks, send counters, and search-health state advancement disabled.
Every email that would be eligible under the production queue/day-cap semantics is fully rendered
and stored in D1. The private `/admin/digest-shadow` contract reports digest/item/watch counts,
deltas from the prior send, rendered-preview metadata, and structured redlines (`code`, masked
digest/watch id, reason, evidence). Render failures, historically-active watches going to zero,
aggregate collapse/explosion, count/list mismatch, and malformed unsubscribe/context links all
produce `NEEDS_ATTENTION` and HTTP 503.

The scheduled `digest-shadow-monitor.yml` polls after both rehearsal and delivery, and opens or
updates a repair issue when the run is redlined, missing, stale, or has an open degraded-path
receipt. Shadow failures never send operator
email; the authenticated admin endpoint remains the canonical machine-readable status surface.
The repair protocol is to diagnose the listed `affected_digest_ids`, apply the repair, then use
authenticated `POST /admin/digest-shadow` to re-render the full set before 09:00. At 12:45 UTC
(15 minutes before the
configured 13:00 UTC delivery cron), any digest IDs still named by a redlined run receive a
`digest-shadow-hold.v1` delivery lease. The producer and queue consumer both enforce that lease;
unrelated digests remain eligible. A `READY` rerun releases all leases and clears overrides.

The failure boundary is deliberately narrow: a redline is fail-closed only for its
`affected_digest_ids`. Hold-store reads get three bounded attempts (250 ms then 1 s backoff), then
use that day's last persisted hold state when one is usable. Without a last-known state, a missing
or unavailable run stays fail-open with a loud `digest-shadow-degraded-decision.v1` receipt while
the latest `READY` rehearsal is less than three calendar days old. At the three-day boundary the
policy holds every digest; the next `READY` rehearsal runs watermark catch-up before normal
delivery and closes the receipt. `/admin/digest-shadow` exposes the receipt and returns HTTP 503
while attention is open; the daylog carries the same collapsed decision for the operations line.
Run-level redlines without named digest scope remain fail-open. Named holds expire at 14:00 UTC; a
queue message found held is acknowledged as `skipped:shadow-hold`, never retried into an accidental
later send. The authenticated override body above requires a reason and can release only IDs named
by that day's run.

Before the digest run, the same cron refreshes the D1 notices mirror from Socrata
(`ingest.mjs`, cursored, fail-soft) and pre-warms prior-cycle match sets for the
freshly-ingested Award notices (`prior_cycle.mjs`, bounded — never a full-corpus backfill;
anything unwarmed fills lazily on its first `/priorcycle/<id>` request).

`scheduled` → `runAlerts()`: replays every confirmed subscription from `SUBS` KV via
`lib/compile.mjs` `compileSub()` — a **deterministic** SODA/ZAP query per `{lens, filter}`,
no model call at cron time — diffs against per-watch seen-IDs in `ALERT_STATE`, and emails
only NEW notices via Resend.

**Account-level rollup:** when an email has more than one active (non-paused) watch, the run
sends **one consolidated email** with a section per watch that has content (or a quiet
summary). One rollup email counts as **one send unit** toward `MAX_PER_RUN` /
`MAX_SENDS_PER_DAY`. Single-watch addresses keep the per-watch email shape. Queue mode
enqueues one job per account (`type: rollup|sub`), not one job per watch for multi-watch
accounts. Footers link to the **preference center** (`/prefs`) and support per-watch or
all-watches unsubscribe. A recognized `cs_session` cookie is shared across the API and
canonical `cityscroll.org` document routes; `/following/#your-following` mints narrower
purpose tokens into its inline management forms without exposing them in URLs. Preference
edits take effect on the **next daily cron** (~9am ET).
Design notes: [`docs/digest-rollup-prefs.md`](../docs/digest-rollup-prefs.md). Operator
dry-run: `GET /admin/digest-rollup?key=…&email=…`.
Test-send evaluation (no Resend):
`curl -X POST 'https://api.cityscroll.org/admin/digest-send-test?key=…' -H 'content-type: application/json' --data '{"email":"allowlisted-address@example.com"}'`.
Add `"live":true` to send once. `"advanceState":true` is required to update seen/last-sent watermarks.
The route accepts an **operator probe key** from either `ADMIN_KEY` or `ANALYTICS_DEV_KEY` via
`?key=` or `Authorization: Bearer`. `ANALYTICS_DEV_KEY` is the same developer-exclusion class
used for analytics testing, not a Cloudflare product credential; configure it with
`wrangler secret put ANALYTICS_DEV_KEY`. Live sends with the default `advanceState:false` do not
update seen/last-sent watermarks or private digest statistics.

Cron-replayable lenses: **money** (awards ≥ threshold / RFP
keywords), **land** (rezonings), **property / rules / meetings** (City Record section
queries; meetings = upcoming events only), and **entity** (follow a vendor — name-stem
resolved via a postFilter — or an agency across all sections). `people` compiles to `null` and is
skipped. Weekly subs fire Mondays. The **confidence layer** (`lib/digest.mjs`) breaks silence
deliberately — weekly empty check-ins and a "still watching" heartbeat after
`HEARTBEAT_DAYS=14` quiet days — so a quiet inbox never looks broken. Digest items link to
the site's `#notice/<id>` permalinks.

**Email identity:** From is always the app's own (`ALERTS_FROM` =
`CityScroll <alerts@cityscroll.org>`, domain verified in Resend); Reply-To is
`ALERTS_REPLY_TO` (`alerts@crol-list.org`) because cityscroll.org has no apex MX and
replies to the From address would bounce — crol-list.org still has Cloudflare email
routing. To is only ever the subscriber's own opted-in address. Never sends as a
person. The sending domain is managed separately from the public website hostnames.

## Board notifications

The maintainers' own board-status notifications (`/board-hook`, GitHub Projects → issue
comments) run on [`board-notify`](https://github.com/jimdc/board-notify), a separate
open-source package — everything about how it works (auth, HMAC, cc-roster, daily cap)
is documented in that project's own README, not here. It's an **optional** dependency:
this instance is scoped to project id `PVT_kwDOEgVDsM4BdE22` in the `cityscroll` org
(set via `BOARD_PROJECT_IDS` / `BOARD_ORG` in `wrangler.toml`), but if you fork crol-list
and never configure its secrets, `/board-hook` fails closed with no effect on anything
else — you can ignore it entirely or point it at your own board.

## Defense in depth (denial-of-wallet & abuse)

`/nl` is the only endpoint that spends money, so it's layered: a centralized CORS allowlist
(stable sites + legacy origins + localhost; review origins only in beta), 600-char input cap, a **hard daily ceiling**
(`MAX_CALLS_PER_DAY=300`, KV counter in `NL_METER`), tiny `max_tokens`, and
`{degraded:true}` on every failure path — worst case a few tens of cents/day by
construction. Alert sending is bounded by `MAX_PER_RUN=25` and `MAX_SENDS_PER_DAY=50`
(under Resend's free 100/day) via the [`sendcap`](https://github.com/jimdc/sendcap) spend
guard; capped watches **defer** to the next run rather than dropping notices. Subscribe/feedback
use per-IP/per-address daily rate limits (no CAPTCHA on either path) and fail closed when unconfigured. Feeds
hold no key and are edge-cached.

## Storage — Cloudflare KV + D1 + Analytics Engine (no R2)

`NL_METER` (NL daily counters) · `ALERT_STATE` (seen-IDs, send counters — 40-day TTL so `/admin/stats` can window them, last-sent dates, `stats:<metric>:<day>` outcome counters,
`stats:catday:<metric>:<category>:<day>` windowed per-category counters (e.g. NL calls by lens, last 7 days), and the
permanent `hist:<metric>:<day>` / `hist:era:<metric>` counters behind `/admin/stats` day-by-day history — including `hist:watches_active:<day>`, a once-daily gauge SNAPSHOT of active-subscription
count rather than an event count, written by the cron job, not incremented — see `scripts/backfill-history.mjs`) ·
`SUBS` (confirmed subs + subscribe rate limits) · `FEEDBACK` (feedback rows + rate limits).

D1 (`crol-notices`, schema versioned in `migrations/`): the `notices` mirror + ingest cursor
(daily cron, `ingest.mjs`; Socrata stays the source of truth) and `prior_cycle_matches` (the
`/priorcycle` precompute cache), plus private `digest_shadow_runs` summaries and
`digest_shadow_previews` rendered email buffers. `notices_fts` is an external-content FTS5 index
over `notices.haystack`; triggers keep it current and migration `0016_notice_fts.sql` can rebuild
it deterministically. Schema detail lives in `../docs/architecture.md`.

### Ranked notice search and D1 export

`search_notices` on `/mcp` is the first and only FTS5/BM25 route. Its section, agency, category,
notice-type, honest amount, deadline, and date predicates remain inside the ranked SQL query and
therefore apply before `ORDER BY bm25(...)` and `LIMIT`. A missing FTS5 table/module activates the
existing `haystack LIKE` query; unrelated database errors still surface. Each route call emits one
`notice-search:` JSON log with only route, method, fallback reason, duration, rows read, and result
count—never query text, IP, or notice identifiers. Before another route adopts ranked search,
retain a dated production sample and report p95 `duration_ms` plus the rows-read distribution.

D1 cannot export a database containing virtual tables. The recovery rehearsal is:

```bash
cd worker
npx wrangler d1 execute crol-notices --remote --file=sql/notice_fts_export_prepare.sql
npx wrangler d1 export crol-notices --remote --output=./crol-notices.sql
npx wrangler d1 execute crol-notices --remote --file=migrations/0016_notice_fts.sql
# Import crol-notices.sql into the recovery database, then execute 0016 there too.
```

The prepare step deliberately removes only the FTS table and its three triggers. Replay `0016`
immediately on the live database after export; ranked requests use the controlled legacy fallback
while the index is absent. `node --test test/notices_search.test.mjs` rehearses ordinary-table
export/import plus index recreation and checks equivalent ranked results.

Analytics Engine (`crol_usage_events_v1`) holds the rolling 90-day interaction taxonomy described
in `../docs/analytics-event-taxonomy.md`. Writes use the `USAGE_ANALYTICS` binding. Authenticated
`/admin/stats` queries the SQL API with `ANALYTICS_READ_TOKEN` and returns a private no-store
response. Writes also require
`ANALYTICS_ENVIRONMENT` to equal `production` — set in production `[vars]` in `wrangler.toml`;
the beta environment overrides it to `preview`. Local `wrangler dev` drops events when the
Analytics Engine binding is absent. `page_view` events also bump a KV fallback so page-view
totals remain visible when SQL read credentials are missing. `ANALYTICS_DEV_KEY` authenticates
short-lived HMAC exclusion tokens for live-site testing; invalid or missing tokens count
normally and receive the same response.

## Dependencies — three libraries extracted from this worker

This worker is otherwise dependency-free; its only runtime deps are small, general-purpose
libraries that were **extracted out of it** so anyone can reuse them, then pulled back in — so
each piece of logic now lives (and is exhaustively unit-tested) in its own package instead of
inline here:

- **[`optin-token`](https://github.com/jimdc/optin-token)** — the double-opt-in confirmation
  tokens (`signToken`/`verifyToken` behind `/subscribe`, `/confirm`, `/unsubscribe`) and the
  `List-Unsubscribe` / RFC 8058 one-click headers on every digest. Web Crypto only, which is why
  it bundles for Workers with no `nodejs_compat`.
- **[`sendcap`](https://github.com/jimdc/sendcap)** — the alert-mailer spend guard (`MAX_PER_RUN`
  + `MAX_SENDS_PER_DAY`). A pure "may I make one more paid send?" decision.
- **[`board-notify`](https://github.com/jimdc/board-notify)** — the `/board-hook` bridge (see
  "Board notifications" above). Unlike the other two, this one is genuinely **optional** —
  crol-list ships and works fully with it unconfigured; it exists so the maintainers don't have
  to keep a private fork of GitHub-board-notification logic inside a public clone's worker.

`optin-token` and `sendcap` are published on npm — [`optin-token`](https://www.npmjs.com/package/optin-token)
and [`@jimdc/sendcap`](https://www.npmjs.com/package/@jimdc/sendcap) (scoped because npm's
name-similarity filter reserves the bare `sendcap`) — pulled in as `^1.0.0` deps. `board-notify`
isn't on npm yet, so it's pinned to a commit SHA via a `github:` dependency instead. The tests
under `test/token.*`, `test/unsub.*`, `test/caps.*`, and `test/board_hook_integration.*` are
**integration regression guards** over these packages — they fail here if a swap ever regresses
crol's contract, not reimplementations of the packages' own unit suites.

## Develop, test, deploy

```sh
npm install               # pulls wrangler + optin-token, sendcap, board-notify
npm test                  # node --test — 323 unit tests, no network
npm run dev               # wrangler dev → http://localhost:8787; analytics drops by default
npx wrangler deploy       # deploy (free); cron + KV bindings come from wrangler.toml
CROL_WORKER_URL=https://api.cityscroll.org npm run test:live   # live e2e over every public route
#   (defaults to the workers.dev alias — doubling as a regression check that the alias stays up)
```

Secrets (set outside the repository via Wrangler): `ANTHROPIC_API_KEY`, `RESEND_API_KEY`,
`TOKEN_SECRET`, `TURNSTILE_SECRET`, `USAGE_KEY`, `ADMIN_KEY`, `SHADOW_STATUS_KEY`,
`BOARD_HOOK_SECRET`, `GITHUB_BOT_TOKEN`, `BOARDNOTIFY_APP_ID`, `BOARDNOTIFY_APP_PRIVATE_KEY`,
`BOARDNOTIFY_INSTALLATION_ID`, `ANALYTICS_READ_TOKEN`, and `ANALYTICS_DEV_KEY`. `SHADOW_STATUS_KEY`
is an optional read-only secret accepted **only** on `GET /admin/digest-shadow`; when absent, that
route falls back to `ADMIN_KEY` as before. Board-notify
secrets are optional — see "Board notifications" above. Vars (in `wrangler.toml`):
`ANALYTICS_ENVIRONMENT` (`production` on the live Worker; beta overrides to `preview`),
`ALERTS_LIVE` (master switch — anything but `"true"` = dry-run: still **renders** each
digest and logs the full HTML + headers, but never calls Resend and never bumps send
counters / last-sent clocks), `ALERTS_FROM`, `ALERTS_REPLY_TO`, `MAX_PER_RUN`,
`MAX_SENDS_PER_DAY`, `HEARTBEAT_DAYS`, `FEEDBACK_TO`, `BOARD_PROJECT_IDS`, `BOARD_ORG`,
`BOARD_URL`, `BOARD_HOOK_DRY`, `BOARD_HOOK_MAX_PER_DAY`, `BOARDNOTIFY_CC`. Fire a cron
locally by hitting `/__scheduled?cron=0+10+*+*+*` or `/__scheduled?cron=0+13+*+*+*` under
`wrangler dev`.

### Automatic deploys

`.github/workflows/deploy-worker.yml` deploys the Worker automatically on every push to `main`
that touches `worker/**` (also runnable by hand via `workflow_dispatch` for a re-run without a
new commit). Each deploy **applies pending D1 migrations** (`wrangler d1 migrations apply
crol-notices --remote`) before `wrangler deploy`, so schema changes under `migrations/` land
with the code that needs them. Skipping that step left the PASSPort tables uncreated and every
lifecycle PASSPort lookup returning `lookup_status=error`. The deploy is still **code-only**
for secrets — no `secrets:`/`vars:` inputs on the action — because Cloudflare will silently
overwrite a live secret with a `[vars]` entry of the same name on deploy; keep secrets going
through `wrangler secret put` by hand (above) and never add one to `wrangler.toml`'s `[vars]`
block or to the workflow. A `concurrency: worker-deploy` group (no cancel-in-progress) makes
two quick merges deploy in order rather than racing. `npx wrangler deploy` from a laptop
remains the escape hatch for an emergency deploy outside the merge flow (pair it with
`npx wrangler d1 migrations apply crol-notices --remote` when schema changed).

Requires a `CLOUDFLARE_API_TOKEN` repository secret for GitHub Actions. Prefer a
least-privilege token limited to Workers deploys on this account. `wrangler.toml` does not set
`account_id`, so wrangler resolves the account from the token itself.

## History

Originally Netlify Functions + Blobs; migrated to Cloudflare Workers + KV for free deploys
(Netlify production deploys drew from a shared credit pool). The `netlify/` directory is legacy.
