# crol-worker

The thin serverless backend for **[CityScroll](https://cityscroll.org)** — a single
**Cloudflare Worker** at `https://api.cityscroll.org` (custom domain; `crol-worker.crol-worker.workers.dev` remains an alias). CityScroll itself is
100% static (one `index.html` on GitHub Pages, no keys); everything that needs a held secret,
a CORS shim, a schedule, or server-side rendering lives here. The site works fully without
the worker — every feature degrades gracefully when it's absent.

The same worker answers the canonical `cityscroll.org` / `www.cityscroll.org` site
hosts by reverse-proxying the GitHub Pages origin at `crol-list.org` byte-for-byte
(`src/mirror.mjs`). The old hostname's direct-visitor redirect excludes Worker
subrequests, preventing a mirror loop. CORS allowlists use CityScroll by default
while retaining the old origins for compatibility.

> Maintenance rule: this README is updated with every significant feature change — if a
> route, cron behavior, or defense changes, its description lands here in the same session.
> (It previously went stale enough to still describe the retired Netlify deployment; don't
> let that happen again.)

## How it all plugs together

```
   Browser (cityscroll.org, mirrored from static GitHub Pages)
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

| Route | Method | Purpose | Gating / secret |
|---|---|---|---|
| `/nl` | POST | Claude Haiku decodes English → lens filters | `ANTHROPIC_API_KEY`; degrades to `{degraded:true}` |
| `/checkbook` | POST | CORS proxy to checkbooknyc.com/api | none |
| `/feed.xml` `/feed.json` `/feed.ics` | GET | **Any saved search as a standing feed** — Atom / JSON Feed 1.1 / subscribable calendar. Params: `lens=money\|land\|property\|rules\|meetings`, `q=`, `agency=`, `min=`. Same `compileSub()` queries the cron replays; entry links land on `cityscroll.org/#notice/<id>` permalinks; edge-cached 15 min; no paid key on the path. Calendar UIDs retain the `@crol-list` namespace so existing subscribers do not receive duplicate events | none |
| `/subscribe` | POST | Double-opt-in signup (per-IP/per-address rate limits; no CAPTCHA on this path); emails a signed [`optin-token`](https://github.com/jimdc/optin-token) confirm link, stores nothing until clicked | fails closed 503 until `TOKEN_SECRET` + `RESEND_API_KEY` + `SUBS` |
| `/confirm` | GET | Verifies the `optin-token`, writes the ACTIVE sub to KV | `TOKEN_SECRET` + `SUBS` |
| `/unsubscribe` | GET/POST | Removes a sub; POST = RFC 8058 one-click (`optin-token`) | `TOKEN_SECRET` + `SUBS` |
| `/feedback` | POST | Stores + emails operator feedback (Turnstile, rate-limited; rows keep IP+UA) | fails closed 503 |
| `/batch` | POST | Watchlist cross-reference: `{names:[…]}` (≤10) → per-name award/mention counts + vendor-profile links; 30/day/IP | none |
| `/agencies` | GET | Public City Record agency-name crosswalk: one row per distinct source string → site id, preferred name, and full variant group. JSON by default; `?format=csv` for CSV; CORS-open and edge-cached one day | none |
| `/property-locations` | GET | Daily Property Disposition projection with extracted site addresses, boroughs, tax lots, BBLs, and resolved map geometry; CORS-open and edge-cached 30 minutes | none |
| `/inv` · `/inv/<id>` | POST/GET | Share an investigation snapshot (clamped, ≤32KB, 90-day TTL, 10/day/IP; SUBS KV `inv:` prefix) | none |
| `/priorcycle/<request_id>` | GET | **Precomputed prior-cycle + near-match sets** for an Award notice (Phase 1a — the server side of moving index.html's two live SODA panels off the client; Phase 1b swaps the client to this). Ranked by `src/lib/prior_cycle.mjs`, a hand-synced dual implementation of index.html's matchers (cross-check test fails on divergence); cached in D1 `prior_cycle_matches`, compute-on-miss, cron pre-warms fresh Award notices; validated id, edge-cached 5 min | none |
| `/translate/<request_id>?lang=` | GET | **Informal notice translation** — original English remains the official record on the client; this returns an optional unofficial title+description aid. Glossary-pinned Haiku call on first miss only; D1 `notice_translations` + edge cache thereafter (no per-pageview upstream). Amounts, dates, PINs, Request IDs, agency names, and addresses must appear verbatim or the response is `{ok:false}` and nothing is cached. Daily ceiling `TRANSLATE_MAX_CALLS_PER_DAY` (default 150) on NEW translations only; cache hits never spend the meter | `ANTHROPIC_API_KEY` for first compute; degrades to `{ok:false}` |
| `/stats` | GET | **Public outcome counters** (R·B): active subscriptions (count only), digests sent (today/7d/all-time/by-topic), digest-link clicks, feed/batch/share activity, NL calls (today/7d/all-time/by-lens for both windows), and a day-by-day `history` block for digests + NL calls + active-watch snapshots — aggregate integers, no personal data; edge-cached 15 min. All-time totals fold in pre-counter history recovered from an older short-lived counter where available (see `mergeRecoveredAllTime` in `lib/stats.mjs`), and every all-time/breakdown figure has an honest `live_from` boundary in `history` rather than claiming "since launch." | none |
| `/events` | POST | Bounded first-party event intake. Accepts only the enumerations in `../docs/analytics-event-taxonomy.md`, caps payloads at 1 KiB, and writes one aggregate Analytics Engine point with no visitor identifier. | allowed site origin + production runtime binding + `USAGE_ANALYTICS` |
| `/r/<kind>/<request_id>` | GET | **Count-only digest click-through** (R·B tier 3, team-approved 2026-07-02): bumps a per-day counter (`stats:click`, `stats:click.<kind>`) and 302s to `cityscroll.org/#notice/<id>`. Validated slug+id only — the path never carries a URL, so it cannot be an open redirect. No per-recipient tracking; digests disclose this in the footer | none |
| `/api` | GET | 302 → cityscroll.org/api.html (the API docs) | none |
| `/admin/subs` `/admin/feedback` | GET | Operator reads (redacted) | `ADMIN_KEY` → 404 if unset |
| `/admin/suggest-refresh` | POST | Runs the suggestion-chip validation (`/suggestions`' cron pipeline) on demand instead of waiting for the 13:00 UTC cron; returns the same summary JSON, fail-soft identical to the cron path | `ADMIN_KEY` → 404 if unset |
| `/usage` | GET | Read-only Haiku spend report | `USAGE_KEY` → 404 if unset |
| `/board-hook` | POST | **Board notifications** — see below | HMAC (`BOARD_HOOK_SECRET`) fails closed; fails closed 503 with no bot/App token configured |
| `/` `/health` | GET | liveness | none |

## The daily digest (cron `0 13 * * *` ≈ 9am ET; LIVE since 2026-07-01)

Before the digest run, the same cron refreshes the D1 notices mirror from Socrata
(`ingest.mjs`, cursored, fail-soft) and pre-warms prior-cycle match sets for the
freshly-ingested Award notices (`prior_cycle.mjs`, bounded — never a full-corpus backfill;
anything unwarmed fills lazily on its first `/priorcycle/<id>` request).

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
use per-IP/per-address daily rate limits (`/feedback` still requires Turnstile) and fail closed when unconfigured. Feeds
hold no key and are edge-cached.

## Storage — Cloudflare KV + D1 + Analytics Engine (no R2)

`NL_METER` (NL daily counters) · `ALERT_STATE` (seen-IDs, send counters — 40-day TTL so /stats can window them, last-sent dates, `stats:<metric>:<day>` outcome counters,
`stats:catday:<metric>:<category>:<day>` windowed per-category counters (e.g. NL calls by lens, last 7 days), and the
permanent `hist:<metric>:<day>` / `hist:era:<metric>` counters behind /stats' day-by-day history — including `hist:watches_active:<day>`, a once-daily gauge SNAPSHOT of active-subscription
count rather than an event count, written by the cron job, not incremented — see `scripts/backfill-history.mjs`) ·
`SUBS` (confirmed subs + subscribe rate limits) · `FEEDBACK` (feedback rows + rate limits).

D1 (`crol-notices`, schema versioned in `migrations/`): the `notices` mirror + ingest cursor
(daily cron, `ingest.mjs`; Socrata stays the source of truth) and `prior_cycle_matches` (the
`/priorcycle` precompute cache). Schema detail lives in `../docs/architecture.md`.

Analytics Engine (`crol_usage_events_v1`) holds the rolling 90-day interaction taxonomy described
in `../docs/analytics-event-taxonomy.md`. Writes use the `USAGE_ANALYTICS` binding. `/stats`
queries the SQL API with `ANALYTICS_READ_TOKEN`, then edge-caches the response for 15 minutes
(that is the documented latency for an accepted event to appear). Writes also require
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
`TOKEN_SECRET`, `TURNSTILE_SECRET`, `USAGE_KEY`, `ADMIN_KEY`, `BOARD_HOOK_SECRET`,
`GITHUB_BOT_TOKEN`, `BOARDNOTIFY_APP_ID`, `BOARDNOTIFY_APP_PRIVATE_KEY`,
`BOARDNOTIFY_INSTALLATION_ID`, `ANALYTICS_READ_TOKEN`, and `ANALYTICS_DEV_KEY`. Board-notify
secrets are optional — see "Board notifications" above. Vars (in `wrangler.toml`):
`ANALYTICS_ENVIRONMENT` (`production` on the live Worker; beta overrides to `preview`),
`ALERTS_LIVE` (master switch — anything but `"true"` = dry-run: still **renders** each
digest and logs the full HTML + headers, but never calls Resend and never bumps send
counters / last-sent clocks), `ALERTS_FROM`, `ALERTS_REPLY_TO`, `MAX_PER_RUN`,
`MAX_SENDS_PER_DAY`, `HEARTBEAT_DAYS`, `FEEDBACK_TO`, `BOARD_PROJECT_IDS`, `BOARD_ORG`,
`BOARD_URL`, `BOARD_HOOK_DRY`, `BOARD_HOOK_MAX_PER_DAY`, `BOARDNOTIFY_CC`. Fire the cron
locally by hitting `/__scheduled` under `wrangler dev`.

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
