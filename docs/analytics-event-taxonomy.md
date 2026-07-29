# CROL-List aggregate event taxonomy

Version: **1.1.0**
Dataset: **`crol_usage_events_v1`**
Retention: **90 days**
Initial measured-since boundary: **2026-07-27**

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
| `blob5` | surface | `home`, `stats`, `about`, `data`, `api`, `changelog`, `standards`, `digest`, or `email` as allowed per event |
| `blob6` | taxonomy version | `1.1.0` (the reader also accepts compatible `1.0.0` rows) |
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
| `outcome_recorded` | One voluntary post-deadline outcome was recorded. | `detail=submitted\|attended\|bid\|won\|not-useful`; `surface=home` |

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

## 

Analytics writes are fail-closed behind the `ANALYTICS_ENVIRONMENT` runtime binding. The shared
event writer emits only when that value is exactly `production`; a missing value, `development`,
or `preview` drops the event. 
binding so code-only deploys retain it:

```sh

# Enter: production
```

Do not set that binding in `wrangler dev` or preview environments. Their missing binding drops
browser and Worker-generated events by default. Unit tests use an in-memory Analytics Engine mock
and never contact production.

Developers who must inspect the production site can exclude a short session with a timestamped
HMAC token. Configure a random secret of at least 32 characters only on the production Worker:

```sh
npx wrangler secret put ANALYTICS_DEV_KEY
```

Keep the same value in an approved operator credential store; never commit it. From `worker/`,
provide that value to the token helper on standard input:

```sh
 < "$ANALYTICS_DEV_KEY_FILE"
```

The helper prints a small browser-console statement. Paste it on the site before testing:

```js

```

Remove it when finished:

```js

```

`analytics.js` forwards this value without interpreting it. The Worker accepts only
`v1.<unix-seconds>.<HMAC-SHA256>` tokens signed with `ANALYTICS_DEV_KEY`, with a five-minute age
limit and 30-second clock-skew allowance. Valid tokens suppress the write. Missing, expired,
malformed, or incorrectly signed tokens count normally. All accepted event requests return the
same empty HTTP 204 response, so token validity is not exposed as a response oracle. The token
itself is never written to Analytics Engine.

## Aggregation and reading

The public Worker queries one 90-day grouped time series through the Analytics Engine SQL API and
builds the public cuts in `GET /stats`: 7- and 30-day activity, lens interest, search
activity, scenario interest, deep links, exports, confirmed watches, selected borough interest,
and daily growth. Version 1.1.0 is additive; queries include compatible 1.0.0 rows so the existing
rolling window remains continuous.
Queries use `sum(_sample_interval * double1)`, so adaptive sampling remains represented in totals.
The public response is edge-cached for about 15 minutes.

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
`/stats` response is cached for 15 minutes, so a continuously requested dashboard needs at most
about 2,880 SQL reads in a 30-day month, far below the included million. One accepted site event
uses one write.

Platform constraints applied here: at most 20 blobs, 20 doubles, one index, 16 KiB of blob data,
and 250 data points per Worker invocation. CROL-List uses six short blobs, one double, one index,
and one point per invocation.

Sources:

- [Workers Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)
- [Workers Analytics Engine limits and retention](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- [SQL API and sampling-aware aggregation](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
- [Querying Analytics Engine from a Worker](https://developers.cloudflare.com/analytics/analytics-engine/worker-querying/)
