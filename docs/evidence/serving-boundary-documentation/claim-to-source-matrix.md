# Serving documentation: claim-to-source matrix

This is the audit behind the September 2026 reconciliation of CityScroll's serving
documentation. It records, claim by claim, what the entry-point documents said before, what
they say now, and the exact runtime owner — file, symbol, and branch — each corrected claim
rests on.

The change is documentation only. No runtime behavior, no debt expiry, and no generated
capability metadata was modified.

## Revisions

| Role | Revision | Note |
|---|---|---|
| Pinned audit revision | `3173824eed3f503858b01ae3cd6a0c7e1a705a16` | The revision the original read-only audit inspected. |
| Implementation head | `4e4cacf891099f88d308430a87beaf08c6fc6569` | The revision this reconciliation was written and verified against. |

**Revalidation.** Every audited path was re-derived at the implementation head before editing.
`git diff --stat 3173824eed3f503858b01ae3cd6a0c7e1a705a16..4e4cacf891099f88d308430a87beaf08c6fc6569`
over the audited set is empty: each of the runtime and policy files below has the identical blob
at both revisions, so no audited finding was closed, weakened, or superseded in between, and no
intervening closure needed to be documented.

| Audited path | Blob at both revisions |
|---|---|
| `site/_worker.js` | `13419919bf6c731538a9da241a5b97727e3f1950` |
| `site/pages_edge.mjs` | `03596b112a01562a1f59637cfa81298ab8c28be6` |
| `site/notice-read.mjs` | `8d6a397d90b4c54e4aa4fa654c0fec7d06ce9b44` |
| `worker/src/notice.mjs` | `a48e3f3ab1f560989c68c75a8879fb53b720e015` |
| `capabilities/notice_get.mjs` | `0626933ec5a56db80800f26cb6d7ceb930ca20a2` |
| `architecture/no-live-external-debt.json` | `bcc23475bf2d92b1b95884474b3a7f520110f388` |
| `architecture/resident-read-policy.json` | `8750a97930babedc5234f66488da9ceee0653252` |
| `worker/wrangler.toml` | `b61a049a8b3a355b8341dfee5544d2635baa49a3` |

`worker/README.md`, `ARCHITECTURE.md` and `docs/architecture.md` were likewise byte-identical at
the two revisions, so the wording quoted in the "Before" column is the wording the pinned audit
saw.

## Matrix

### C1 — What serves a reader request

| | |
|---|---|
| **Before** | `worker/README.md` §intro: "CityScroll itself is 100% static (one `index.html` on Cloudflare Pages, no keys)". §"How it all plugs together" drew Browser → Socrata/GeoSearch/MapPLUTO with "most queries go straight to NYC Open Data", and Browser → Worker for "the rest". `docs/architecture.md` §"System map" opened at `Browser (cityscroll.org — Cloudflare Pages production site with Worker routes)` and named no edge handler. `ARCHITECTURE.md` §"Building blocks" listed Site, Worker, Cloudflare state, R2, Warehouse, Entity resolution, Ontology — no Pages-edge entry. |
| **After** | `worker/README.md` §"How it all plugs together"; `ARCHITECTURE.md` §"System context" ¶2 and §"Building blocks" → **Pages edge**; `docs/architecture.md` §"System map" and §"Request flow" step 1. All three now describe the same three seams and the same edge-route set. |
| **Runtime owner** | `site/_worker.js` — the whole file is `export { default } from "./pages_edge.mjs";`. `site/pages_edge.mjs` `export default { async fetch(request, env) }`: rejects a missing `env.ASSETS` with 503, rejects any method other than GET/HEAD with 405, then tests, in order, `assertionTarget`, `safeRegulatoryAgendaItem`, `safeRulemaking`, `safeId`, `safeMandate`, `safeMatter`, `/meeting.ics`, `safeMeeting`, `safeProcurement`, `safeExamNumber`, `safeMonitorPack`, `safeDistrictDigest`, `safeParcel`, `safeCommittee`, `safeAdminCode`, `browseRoute`, `entityDocument`, `isDataHealthPath`, and finally falls through to `env.ASSETS.fetch(request)`. |
| **Why the old text misled** | It predicted a static-asset host in front of one page with a browser that talks to publishers directly. A maintainer tracing a document could not tell that an edge handler renders it, nor that a Worker subrequest sits inside that render. |

### C2 — The bounded Worker routes on the canonical site

| | |
|---|---|
| **Before** | Correct but unsourced in `worker/README.md`; absent from the `docs/architecture.md` system map. |
| **After** | Named in all three documents with the declaring file. |
| **Runtime owner** | `worker/wrangler.toml` `routes`: the API host and its compatibility alias as custom domains, plus zone routes `cityscroll.org/near-you*`, `cityscroll.org/following*`, `cityscroll.org/prefs*`. `workers_dev = true` keeps the `workers.dev` alias. |

### C3 — "The site works fully without the worker"

| | |
|---|---|
| **Before** | `worker/README.md` §intro: "The site works fully without the worker — every feature degrades gracefully when it's absent", and §"How it all plugs together": "An unavailable Worker leaves the site in its client-side degraded mode." |
| **After** | `worker/README.md` §"What stops working when the Worker is unavailable" enumerates what is lost; `ARCHITECTURE.md` §"Goals and constraints" bullet 4 keeps the degradation guarantee and adds "useful is not the same as complete"; `docs/architecture.md` frontmatter `summary` says the shell stays deployable and degrades rather than disappearing, but is not complete without the Worker. |
| **Runtime owner** | Zone routes in `worker/wrangler.toml` have no Pages asset behind them, so `/near-you*`, `/following*`, `/prefs*` have no fallback. Worker-only routes are enumerated in the `worker/README.md` route table. Edge handlers that call `api.cityscroll.org` lose that layer: `site/pages_edge.mjs` `noticeRow()` (`NOTICE_READ_MODEL`) and `handleRulemaking()` (`RULES_READ_MODEL`). |
| **Preserved** | The graceful-degradation claim itself is retained wherever it is true: the static artifact and every edge document that reads only `env.ASSETS` keep serving. |

### C4 — "All resident reads are materialized"

| | |
|---|---|
| **Before** | `docs/architecture.md` frontmatter `summary` and §"What & why": "CityScroll-owned materialized read models are the **exclusive** delivery path for resident and required-CI reads." `ARCHITECTURE.md` §"Goals and constraints" bullet 2 stated the same as accomplished fact and bullet 3 closed with "None permits request-time publisher-data retrieval for a resident read." §"Runtime scenarios" → "A visitor opens a record" ended "…does not trigger a request-time publisher lookup." The retained notice fallback appeared nowhere in either narrative, although `docs/architecture.md` §"Consumes" already referenced the manifest in passing. |
| **After** | The invariant is preserved verbatim and restated as the standing target: `docs/architecture.md` §"Resident-read invariant" keeps "Resident and required-CI reads use CityScroll-owned materializations and never fetch publisher data at request time." A new §"Current recorded exceptions" lists the twenty-one open entries, their runtime owners and their expiry; `ARCHITECTURE.md` §"Goals and constraints" adds the departures bullet, corrects the record scenario, and qualifies the §"Important decisions" → "Materialized resident reads only" entry as target, not completed migration. |
| **Runtime owner** | `architecture/no-live-external-debt.json` — 21 entries, manifest `generated_at: 2026-08-15`, `expires_on: 2026-09-14`. `architecture/resident-read-policy.json` `first_party_routes.temporary_debt` lists `/agencies`, `/batch`, `/externalaward`, `/notice`, `/priorcycle`, `/subsidy-lifecycle`, `/translate`, and sets `temporary_debt_max_days: 30`. `tools/no_live_external_reads.mjs` asserts every entry's expiry is at or before the manifest expiry, that the manifest window is at most `temporary_debt_max_days`, and that today is at or before the manifest expiry. |
| **Not changed** | No expiry was moved, no exception was added, and the generated `/api` capability metadata was not edited. |

### C5 — The notice read sequence

| | |
|---|---|
| **Before** | Not documented in any of the three entry points. `worker/README.md` had no `/notice` row in its route table. The only in-repo statement of the sequence was the comment header of `worker/src/notice.mjs`. |
| **After** | `worker/README.md` §"One notice read, end to end" and the new `/notice?id=<request_id>` route-table row; `docs/architecture.md` §"The notice read, branch by branch"; `ARCHITECTURE.md` §"Runtime scenarios" → "A visitor opens a record" ¶2. |
| **Runtime owner** | `worker/src/notice.mjs` `handleNotice()` → `executeNoticeGet(workerNoticeGet(env))`, over the contract in `capabilities/notice_get.mjs`. |

Branch by branch, at `worker/src/notice.mjs` blob `a48e3f3ab1f560989c68c75a8879fb53b720e015`:

| Branch | Code | Result |
|---|---|---|
| Bad identifier | `handleNotice`: `NOTICE_ID_RE.test(id)` fails (`/^[A-Za-z0-9_-]{1,80}$/` from `capabilities/notice_get.mjs`) | HTTP 400 `{ok:false, reason:"bad-id"}` |
| Edge-cache hit | `handleNotice`: `cache.match(key)` returns a response and `skipCache` is false | stored response returned unchanged |
| **D1 hit** | `workerNoticeGet().execute` → `readMaterialized()` returns `{row}` | `availability:"available"`, `source:"materialized"`, `generated_at = notices.ingested_at`, `civic_time` from `civic_time_events`; HTTP 200, `Cache-Control: public, max-age=60, s-maxage=86400, stale-while-revalidate=604800, stale-if-error=604800` |
| **D1 hit, stale row** | same branch; `stale` is `true` when `ingested_at` is absent or `now - ingested_at > MATERIALIZED_MAX_AGE_MS` (2 × 86 400 000 ms) | the row is **still returned** with `stale:true` — staleness is labelled, never a reason to withhold or to call upstream |
| **Mirror miss** | no `env.DB`, no matching row, or the D1 read throws (caught, comment: "try the public source below") | falls to `readUpstream()`: one `fetch` of `https://data.cityofnewyork.us/resource/dg92-zbpx.json` with `$where request_id=…`, `$limit=1`, `cf:{cacheTtl:300}` |
| Mirror miss, upstream hit | `readUpstream()` returns a row | `availability:"available"`, `source:"public-source-fallback"`, `generated_at:null`, `stale:false`, **no** `civic_time` block; HTTP 200 with the shorter cache policy |
| **Publisher has no such record** | `readUpstream()` returns `null` | `availability:"not_yet_public"`, `error:"not-found"` → HTTP **404** `{ok:false, reason:"not-found", source:"public-source"}` |
| **Publisher unavailable** | `readUpstream()` throws, including on any non-2xx (`City Record HTTP <status>`) | `availability:"unavailable"`, `error:"unavailable"` → HTTP **503** `{ok:false, reason:"unavailable", source:"public-source"}` |

`capabilities/notice_get.mjs` `validateNoticeGetOutput()` enforces these shapes: a non-available
result may not carry a notice, `not_yet_public` must carry `not-found`, and `unavailable` must
carry `unavailable`. Only `source: "materialized"` responses receive the `civic_time` block and
the long edge-cache policy (`handleNotice`, `isMaterialized`).

### C6 — What the two callers do with those terminals

| Caller | Branch | Behavior |
|---|---|---|
| `site/pages_edge.mjs` `noticeRow()` | Worker response `ok` | uses `payload.row` and `payload.civic_time`; carries `cf-cache-status` out as `cache_outcome` |
| | Worker response `404` | returns `{row:null}` → `handleNotice()` renders the notice document with HTTP **404** |
| | any other non-OK status, or the subrequest throws | falls through to the edge's **own** City Record read (line 922, entry `no-live-22`) |
| | that edge read non-OK | throws `City Record HTTP <status>` → `recordRead` rejection handler sets `upstreamFailed` → document rendered with HTTP **503** |
| | that edge read returns an empty array | `{row:null}` → HTTP **404** document |
| `site/notice-read.mjs` `read()` | response has `x.row` | `enrichHearing([x.row])`, attaching `civic_time` when present |
| | response has no `row` (the 404 and 503 bodies both qualify) or the request rejects | `fallback()` — a direct browser `soda()` query (line 47, entry `no-live-20`) |

## Read-back: four cases from the documents alone

An unfamiliar reader should be able to answer these from the corrected documents without opening
the code. Each answer names the document anchor that carries it and the runtime line it must
match.

**1. The notice is in the D1 mirror.**
Served from the mirror. The response is `source: "materialized"` with `generated_at` set to the
row's `ingested_at`, plus the notice's `civic_time` history, at HTTP 200. If the row is older
than two days it is *still served*, labelled `stale: true`; staleness never triggers an upstream
call. — `worker/README.md` §"One notice read, end to end" step 2; `docs/architecture.md`
§"The notice read, branch by branch" step 2. Runtime: `worker/src/notice.mjs` `readMaterialized()`
and the `materialized.row` branch of `workerNoticeGet().execute`.

**2. The notice is not in the mirror.**
One City Record SODA query (`dg92-zbpx`, `$limit=1`) is issued. A hit is returned as
`source: "public-source-fallback"` with `generated_at: null` and no `civic_time`. This is the
retained exception, not the intended path. — `worker/README.md` §"One notice read, end to end"
step 3; `docs/architecture.md` §"The notice read, branch by branch" step 3. Runtime:
`worker/src/notice.mjs` `readUpstream()`.

**3. The publisher is unavailable, or has no such record.**
Two distinct terminals, never collapsed: no matching upstream row is HTTP 404
`{ok:false, reason:"not-found"}`; a failed or non-2xx upstream read is HTTP 503
`{ok:false, reason:"unavailable"}`. Neither is cached as an empty notice. At the document layer
the Pages edge renders a 404 document for the first and — after its own City Record read also
fails — a 503 document for the second. — `worker/README.md` §"One notice read, end to end" step 4
and the caller list beneath it; `docs/architecture.md` §"The notice read, branch by branch" step 4.
Runtime: `worker/src/notice.mjs` `handleNotice()` status mapping, `site/pages_edge.mjs`
`handleNotice()` `upstreamFailed`.

**4. The Worker is down.**
The notice document does not blank. `site/pages_edge.mjs` treats an unusable Worker response as a
degradation and resolves the record from City Record itself; only a simultaneous publisher failure
produces the 503 document. The browser tab degrades the same way through
`site/notice-read.mjs` `read()`. What is genuinely lost is everything with no static or edge
fallback: the `/near-you*`, `/following*` and `/prefs*` zone routes, and the Worker-only routes
(alerts, feeds, subscribe/unsubscribe, `/feedback`, `/nl`, `/search`, `/mcp`, `/batch`,
`/translate`, forecasting, `/vendor-profile`, `/stats`, `/admin/*`). — `worker/README.md`
§"What stops working when the Worker is unavailable"; `ARCHITECTURE.md` §"Goals and constraints"
bullet 4.

## Invariant versus exception, restated

The target is unchanged and is stated verbatim in `docs/architecture.md`
§"Resident-read invariant": *Resident and required-CI reads use CityScroll-owned materializations
and never fetch publisher data at request time.*

The notice path does not meet it yet. The exact departures are `no-live-20`
(`site/notice-read.mjs:47`), `no-live-21` (`site/notice-read.mjs:48`) and `no-live-22`
(`site/pages_edge.mjs:922`), all under migration record `read-core-01`, all expiring
**2026-09-14**, all recorded in `architecture/no-live-external-debt.json`. This reconciliation
documents them; it does not extend them, authorize a new one, or edit the generated `/api`
capability metadata to agree with prose. The metadata already agrees: `capabilities/notice_get.mjs`
declares `freshness.owner` as "materialized notice mirror with public-source fallback" and
`provider.store` as "Cloudflare D1 with City Record fallback".

## Verification

| Check | Command |
|---|---|
| Notice read model contract | `node --test worker/test/notice_read_model.test.mjs` |
| Worker notice suite | `node --test worker/test/notice*.test.mjs` |
| Architecture reconciliation | `node --test test/reconcile_architecture.test.mjs` |
| Architecture reconciliation, live tree | `node tools/reconcile_architecture.mjs --check --no-write` |
| Evidence shards | `node tools/architecture_evidence_shards.mjs --check` |
| Resident-read fitness function | `node tools/no_live_external_reads.mjs --check` |
| Repository pre-push gate | `make prepush` |
