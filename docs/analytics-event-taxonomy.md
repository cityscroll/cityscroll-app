# CityScroll aggregate event taxonomy

Version: **1.3.0**
Dataset: **`crol_usage_events_v1`**
Retention: **90 days**
Initial measured-since boundary: **2026-07-27**
Primary-document attribution cutover: **2026-08-05**

This is the precise inventory for first-party usage events. It is deliberately an aggregate
measurement system, not a visitor analytics system: there is no visitor or device identifier, no
cookie, no fingerprint, and no user profile.

## Dataset schema

Each accepted event produces one Workers Analytics Engine data point:

| Column | Meaning | Allowed grain |
|---|---|---|
| `blob1` | event | One of the event names below |
| `blob2` | lens | `money`, `people`, `land`, `property`, `rules`, `meetings`, `alerts`, or `none` |
| `blob3` | detail | Event-specific small enumeration below, or `none` |
| `blob4` | geography of interest | NYC borough selected in a search, or `none`; never inferred visitor location |
| `blob5` | surface | `home`, `now`, `near-you`, `following`, `browse`, `stats`, `about`, `data`, `api`, `changelog`, `standards`, `digest`, or `email` as allowed per event |
| `blob6` | taxonomy version | `1.3.0` (the reader also accepts compatible `1.0.0`, `1.1.0`, and `1.2.0` rows) |
| `blob7` | traffic class | `production` (default) or `developer`; omitted on pre-traffic_class rows |
| `double1` | count | Always `1` |
| `index1` | sampling key | Event name |
| `timestamp` | event time | Added by Analytics Engine |

## Events

| Event | What one point means | Dimensions |
|---|---|---|
| `page_view` | One HTML page loaded. | `surface` |
| `lens_open` | One primary lens tab selected. | `lens`; `surface=home` |
| `scenario_open` | One task-first scenario route selected. This records the visitor's declared task, not an inferred identity. | `lens`; `detail=city-work\|neighborhood\|hearings\|city-career\|subsidies-land-use\|legal-compliance`; `surface=home` |
| `search_run` | One user-initiated filter, preset, or natural-language search. | `lens`; `detail=filters\|preset\|natural-language`; optional selected borough; `surface=home\|api` |
| `deep_link_open` | One permalink opened in the browser. | optional `lens`; `detail=notice\|agency\|vendor\|search\|investigation`; `surface=home\|digest` |
| `export` | One export action started. | optional `lens`; `detail=csv\|xlsx\|print\|ics\|json`; `surface=home` |
| `alert_start` | One alert preview or subscribe action started. | optional `lens`; `detail=preview\|subscribe`; `surface=home` |
| `alert_confirmed` | One double-opt-in subscription was confirmed. | optional `lens`; `surface=email\|api` |
| `digest_sent` | One digest email was sent. | optional `lens`; `surface=email` |
| `digest_link_open` | One notice link in a digest was followed. | optional `lens`; `detail=notice`; `surface=digest` |
| `feed_fetch` | One origin request for a feed completed the event-counting path. | `detail=atom\|json\|ics`; `surface=api` |
| `saved_search_check` | One accepted batch saved-search check. | `surface=api` |
| `investigation_share` | One read-only investigation link was created or copied. | `detail=create\|copy`; `surface=home\|api` |
| `action_opened` | One matter action was opened. | `detail=direct\|official-handoff`; `surface=home` |
| `outcome_prompted` | One optional self-report prompt was shown after an official handoff or a passed source-grounded action. | `detail=official-handoff\|passed-action`; `surface=home` |
| `outcome_dismissed` | One optional self-report prompt was explicitly dismissed without an outcome choice. | `detail=official-handoff\|passed-action`; `surface=home` |
| `outcome_recorded` | One voluntary post-action self-report was recorded. This is analytically separate from official receipt-backed outcomes. | `detail=submitted\|attended\|bid\|won\|not-useful`; `surface=home` |

## Data that is never written

- IP address or Cloudflare location of the visitor
- User agent, browser features, or device identifier
- Cookie, local-storage identifier, session identifier, account, or email address
- Raw search text, filter keyword, address, entity name, notice id, or investigation id
- Referrer URL or outbound destination URL
- A row keyed to a person

Declared-interest routing compiles subscriber-selected topics, places, and actions into standing
watches. Aggregate routing research publishes denominators and category totals.

The intake rejects unknown events and dimensions. Payloads are capped at 1 KiB. Browser delivery is
fail-soft, so analytics can never block the action being measured.

Clean `/now/`, `/near-you/`, `/following/`, and `/browse/` routes receive distinct page-view
surfaces beginning with the 2026-08-05 taxonomy cutover. Nested document routes keep their parent
surface. Earlier page views remain readable as `home (before primary-document attribution)`;
CityScroll does not infer how many of those historical `home` rows belonged to the homepage or to
one of the four documents.

Outcome-loop completion is characterized only in aggregate: `outcome_recorded` divided by
`outcome_prompted` for the same rolling window. Aggregate abandonment is prompted minus recorded;
`outcome_dismissed` identifies the explicit “Not now” subset. These are unlinked counts, not a
funnel keyed to a visitor or notice, so they cannot attribute a response to an official record.

The reader self-report prompt is retired as of 2026-08-06. The event definitions and aggregate
fields remain dormant for a future purposeful re-enable. Re-enable only when current traffic makes
it possible to answer a concrete question, such as: “Among readers who open an official action,
what share report submitting, attending, bidding, or winning?”

## Development and preview traffic

Analytics writes are fail-closed behind the `ANALYTICS_ENVIRONMENT` runtime binding. The shared
event writer emits only when that value is exactly `production`; a missing value, `development`,
or `preview` drops the event. Production sets `ANALYTICS_ENVIRONMENT = "production"` in
`worker/wrangler.toml` `[vars]` so a deploy cannot silently drop every event. The beta Worker
environment overrides it to `preview`. Local `wrangler dev` still fails closed when the
`USAGE_ANALYTICS` binding is absent. Unit tests use an in-memory Analytics Engine mock and never
contact production.

A short-lived developer exclusion token stamps `traffic_class=developer` while someone inspects
the live site. `analytics.js` may forward a browser-held value without interpreting it. The Worker
accepts only `v1.<unix-seconds>.<HMAC-SHA256>` tokens signed with `ANALYTICS_DEV_KEY`, with a
five-minute age limit and 30-second clock-skew allowance. Valid tokens set
`traffic_class=developer` and skip production dual-write counters and Analytics Engine points
that feed authenticated `/admin/stats`. Missing, expired, malformed, or incorrectly signed tokens count as
`production`. Non-production `ANALYTICS_ENVIRONMENT` values also classify as developer and fail
closed on the writer. All accepted event requests return the same empty HTTP 204 response, so
token validity is not exposed as a response oracle. The token itself is never written to Analytics
Engine. Never commit signing material.

Configure the signing secret with `wrangler secret put ANALYTICS_DEV_KEY` (minimum 32 characters).
That secret is the **developer key** documented in the ops contract (`GET /admin/ops-contract` /
`worker/ops-contract.v1.json`). It is distinct from `USAGE_KEY` (Haiku `/usage` spend report only)
and from `ADMIN_KEY` (operator admin routes). Private operational SQL keeps rows where `blob7` is
null, empty, or `production`, so pre-traffic_class history stays continuous.

## Aggregation and reading

The Worker queries one 90-day grouped time series through the Analytics Engine SQL API and
builds authenticated cuts in `GET /admin/stats`: 7- and 30-day activity, lens interest, search
activity, scenario interest, deep links, exports, confirmed watches, selected borough interest,
daily growth, and aggregate action/outcome totals. Version 1.3.0 is additive; queries include
compatible 1.0.0, 1.1.0, and 1.2.0 rows so the existing rolling window remains continuous.
Queries use `sum(_sample_interval * double1)`, so adaptive sampling remains represented in totals.
The private response is not cached. Analytics Engine ingestion can still delay a newly accepted
`POST /events`; durable Worker counters provide immediate continuity where available.

When `ANALYTICS_READ_TOKEN` is missing, the Analytics Engine SQL path alone would report
`unavailable_reason=not-configured`. `/admin/stats` then reconciles Site totals against the durable
Worker stores (`ALERT_STATE` and `NL_METER` — the same namespaces used before and after the
cityscroll.org domain flip): page views and dual-written usage events from `POST /events`,
searches from the NL meter, digest-link clicks and investigation shares from outcome counters,
and day-by-day growth from the existing history series. `usage.available` is true whenever any
of those continuous stores has counts, so a missing SQL credential or an empty Analytics Engine
dataset cannot reset accumulated totals to zero. Analytics Engine remains the preferred source
when configured and populated; reconciliation takes the max per field.

Analytics Engine retention is three months, so these event metrics are rolling-window measures,
not lifetime user counts. Existing longer-lived operational counters retain their own explicit
measured-since boundaries.

The initial measured-since date predates the authenticated developer exclusion. Counts collected
before that control is deployed may include development checks against the production site; no
trustworthy retrospective subtraction is possible.

## Budget

Cloudflare’s current published Workers Paid allowance includes **10 million data points written
per month** and **1 million SQL read queries per month**; overages are listed as $0.25 per
additional million writes and $1.00 per additional million reads. Cloudflare also says Analytics
Engine usage is not currently billed, while the published prices describe future billing. The
Normal authenticated desk use needs far fewer than the included SQL reads. The public `/stats`
cache no longer triggers Analytics Engine reads. One accepted site event uses one write.

Platform constraints applied here: at most 20 blobs, 20 doubles, one index, 16 KiB of blob data,
and 250 data points per Worker invocation. CityScroll uses seven short blobs, one double, one index,
and one point per invocation.

Sources:

- [Workers Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)
- [Workers Analytics Engine limits and retention](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- [SQL API and sampling-aware aggregation](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
- [Querying Analytics Engine from a Worker](https://developers.cloudflare.com/analytics/analytics-engine/worker-querying/)
