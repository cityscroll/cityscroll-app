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
| `/subscribe` | POST | Double-opt-in signup (Turnstile + per-IP/per-address rate limits); emails a signed [`optin-token`](https://github.com/jimdc/optin-token) confirm link, stores nothing until clicked | fails closed 503 until `TURNSTILE_SECRET` + `TOKEN_SECRET` + `RESEND_API_KEY` + `SUBS` |
| `/confirm` | GET | Verifies the `optin-token`, writes the ACTIVE sub to KV | `TOKEN_SECRET` + `SUBS` |
| `/unsubscribe` | GET/POST | Removes a sub; POST = RFC 8058 one-click (`optin-token`) | `TOKEN_SECRET` + `SUBS` |
| `/feedback` | POST | Stores + emails operator feedback (Turnstile, rate-limited; rows keep IP+UA) | fails closed 503 |
| `/batch` | POST | Watchlist cross-reference: `{names:[…]}` (≤10) → per-name award/mention counts + vendor-profile links; 30/day/IP | none |
| `/agencies` | GET | Public City Record agency-name crosswalk: one row per distinct source string → site id, preferred name, and full variant group. JSON by default; `?format=csv` for CSV; CORS-open and edge-cached one day | none |
| `/inv` · `/inv/<id>` | POST/GET | Share an investigation snapshot (clamped, ≤32KB, 90-day TTL, 10/day/IP; SUBS KV `inv:` prefix) | none |
| `/priorcycle/<request_id>` | GET | **Precomputed prior-cycle + near-match sets** for an Award notice (Phase 1a — the server side of moving index.html's two live SODA panels off the client; Phase 1b swaps the client to this). Ranked by `src/lib/prior_cycle.mjs`, a hand-synced dual implementation of index.html's matchers (cross-check test fails on divergence); cached in D1 `prior_cycle_matches`, compute-on-miss, cron pre-warms fresh Award notices; validated id, edge-cached 5 min | none |
| `/stats` | GET | **Public outcome counters** (R·B): active subscriptions (count only), digests sent (today/7d/all-time/by-topic), digest-link clicks, feed/batch/share activity, NL calls (today/7d/all-time/by-lens for both windows), and a day-by-day `history` block for digests + NL calls + active-watch snapshots — aggregate integers, no personal data; edge-cached 15 min. All-time totals fold in pre-counter history recovered from an older short-lived counter where available (see `mergeRecoveredAllTime` in `lib/stats.mjs`), and every all-time/breakdown figure has an honest `live_from` boundary in `history` rather than claiming "since launch." | none |
| `/events` | POST | Bounded first-party event intake. Accepts only the enumerations in `../docs/analytics-event-taxonomy.md`, caps payloads at 1 KiB, and writes one aggregate Analytics Engine point with no visitor identifier. | allowed site origin + production runtime binding + `USAGE_ANALYTICS` |
| `/r/<kind>/<request_id>` | GET | **Count-only digest click-through** (R·B tier 3, team-approved 2026-07-02): bumps a per-day counter (`stats:click`, `stats:click.<kind>`) and 302s to `crol-list.org/#notice/<id>`. Validated slug+id only — the path never carries a URL, so it cannot be an open redirect. No per-recipient tracking; digests disclose this in the footer | none |
| `/api` | GET | 302 → crol-list.org/api.html (the API docs) | none |
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
`CROL-List <alerts@crol-list.org>`, domain verified in Resend, DMARC passing); To is only
ever the subscriber's own opted-in address. Never sends as a person.

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

`/nl` is the only endpoint that spends money, so it's layered: CORS allowlist
(crol-list.org + legacy origins + localhost), 600-char input cap, a **hard daily ceiling**
(`MAX_CALLS_PER_DAY=300`, KV counter in `NL_METER`), tiny `max_tokens`, and
`{degraded:true}` on every failure path — worst case a few tens of cents/day by
construction. Alert sending is bounded by `MAX_PER_RUN=25` and `MAX_SENDS_PER_DAY=50`
(under Resend's free 100/day) via the [`sendcap`](https://github.com/jimdc/sendcap) spend
guard; capped watches **defer** to the next run rather than dropping notices. Subscribe/feedback
have Turnstile + per-IP/per-address daily rate limits and fail closed when unconfigured. Feeds
hold no key and are edge-cached.

## Storage — Cloudflare KV + D1 + Analytics Engine (no R2)

`NL_METER` (NL daily counters) · `ALERT_STATE` (seen-IDs, send counters — 40-day TTL so /stats can window them, last-sent dates, `stats:<metric>:<day>` outcome counters,
`stats:catday:<metric>:<category>:<day>` windowed per-category counters (e.g. NL calls by lens, last 7 days), and the
permanent `hist:<metric>:<day>` / `hist:era:<metric>` counters behind /stats' day-by-day history — including `hist:watches_active:<day>`, a once-daily gauge SNAPSHOT of active-subscription
count rather than an event count, written by the cron job, not incremented — see `scripts/backfill-history.mjs` and `AGENTS.md`) ·
`SUBS` (confirmed subs + subscribe rate limits) · `FEEDBACK` (feedback rows + rate limits).

D1 (`crol-notices`, schema versioned in `migrations/`): the `notices` mirror + ingest cursor
(daily cron, `ingest.mjs`; Socrata stays the source of truth) and `prior_cycle_matches` (the
`/priorcycle` precompute cache). Schema detail lives in `../docs/architecture.md`.

Analytics Engine (`crol_usage_events_v1`) holds the rolling 90-day interaction taxonomy described
in `../docs/analytics-event-taxonomy.md`. Writes use the `USAGE_ANALYTICS` binding. `/stats`
queries the SQL API with `ANALYTICS_READ_TOKEN` (), then edge-caches
the response for 15 minutes. The paid-plan allowance is 10 million writes and 1 million reads per
month; the worst-case cached dashboard read rate is about 2,880 per 30-day month. Current pricing,
limits, and source links are kept in the taxonomy document.

Writes also require `ANALYTICS_ENVIRONMENT` to equal `production`. Keep it unset in local and
preview Workers so they drop events by default. Production stores it as a Wrangler secret binding
so code-only deployments retain it. `ANALYTICS_DEV_KEY` authenticates five-minute HMAC exclusion
tokens for production-site testing; invalid or missing tokens count normally and receive the same
response. 

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
CROL_WORKER_URL=https://api.crol-list.org npm run test:live   # live e2e over every public route
#   (defaults to the workers.dev alias — doubling as a regression check that the alias stays up)
```

Secrets (`wrangler secret put`): `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `TOKEN_SECRET`,
`TURNSTILE_SECRET`, `USAGE_KEY`, `ADMIN_KEY`, `BOARD_HOOK_SECRET`, `GITHUB_BOT_TOKEN`,
`BOARDNOTIFY_APP_ID`, `BOARDNOTIFY_APP_PRIVATE_KEY`, `BOARDNOTIFY_INSTALLATION_ID`,
`ANALYTICS_READ_TOKEN` (; the analytics section of `/stats` reports
unavailable rather than failing the endpoint when unset), `ANALYTICS_DEV_KEY` (random, at least
32 characters), and `ANALYTICS_ENVIRONMENT` (enter `production` only on the live Worker).
The last binding is intentionally absent from `wrangler.toml`, local development, and preview
deployments. All six
board-notify secrets are optional — see "Board notifications" above). Vars (in
`wrangler.toml`): `ALERTS_LIVE` (master switch — anything but `"true"` = dry-run),
`ALERTS_FROM`, `MAX_PER_RUN`, `MAX_SENDS_PER_DAY`, `HEARTBEAT_DAYS`, `FEEDBACK_TO`,
`BOARD_PROJECT_IDS`, `BOARD_ORG`, `BOARD_URL`, `BOARD_HOOK_DRY`, `BOARD_HOOK_MAX_PER_DAY`,
`BOARDNOTIFY_CC`. Fire the cron locally by hitting `/__scheduled` under `wrangler dev`.

### Automatic deploys

`.github/workflows/deploy-worker.yml` deploys the Worker automatically on every push to `main`
that touches `worker/**` (also runnable by hand via `workflow_dispatch` for a re-run without a
new commit). It's a **code-only** deploy — plain `wrangler deploy` via `cloudflare/wrangler-action`,
no `secrets:`/`vars:` inputs — because Cloudflare will silently overwrite a live secret with a
`[vars]` entry of the same name on deploy; keep secrets going through `wrangler secret put` by
hand (above) and never add one to `wrangler.toml`'s `[vars]` block or to the workflow. A
`concurrency: worker-deploy` group (no cancel-in-progress) makes two quick merges deploy in
order rather than racing. `npx wrangler deploy` from a laptop remains the escape hatch for an
emergency deploy outside the merge flow.

Requires a `CLOUDFLARE_API_TOKEN` repo secret — a token scoped to **** on
the target account only (least privilege; no zone/DNS/account-wide permissions needed for a
code deploy). No separate account-id secret: `wrangler.toml` doesn't set `account_id`, so
wrangler resolves the account from the token itself. Create/rotate it at
https://dash.cloudflare.com/profile/api-tokens ("Edit Cloudflare Workers" template, scoped down
to this account) and update the repo secret at Settings → Secrets and variables → Actions.

## History

Originally Netlify Functions + Blobs; migrated to Cloudflare Workers + KV (free deploys —
Netlify billed 15 credits per production deploy against a shared pool; background:
`../`). The `netlify/` directory is legacy.
Moving both repos into a shared GitHub org remains a deferred governance call, not a code one.
