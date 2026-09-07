# Collection and publication boundary

This is the owned technical reference for two questions that used to be answered by
sweeping sentences in the architecture narrative: what CityScroll is configured to
collect, and what CityScroll deliberately publishes. It describes each path at the
code boundary that decides it, and it states where the evidence for a claim stops.

The architecture summaries link here rather than restating the list.
`node tools/collection_boundary_facts.mjs` re-derives every fact below from the
committed loader source, the documents that include it, and the exported constants of
the analytics, receipt, account-history and public-projection contracts. `--check`
fails if this document and those files disagree.

## Two registers

| Register | Meaning | Evidence |
|---|---|---|
| Repository-configured | A loader, dataset, retention period or published field declared in a committed file | The file itself, re-derived by `node tools/collection_boundary_facts.mjs` |
| Not established here | A fact that exists only in a provider account or in live traffic | Nothing in this repository can read one. It stays unestablished until a configuration read or a receipt is committed. |

The second register is not a softer version of the first. A statement about a provider
dashboard, an actual retention period at a provider, or whether any collection ever
succeeded is outside this tree, and this document says so rather than asserting either
direction.

## Collection paths

Four distinct paths observe something about product use. They have different owners,
different storage, and different retention; the only thing they share is that none of
them is described by a single sentence about the whole product.

| Path | Where it runs | Configured here | Retention configured here |
|---|---|---|---|
| Third-party session-analytics loader | Browser | [`site/clarity.js`](../site/clarity.js) | Not declared in this repository |
| First-party aggregate events | Browser and Worker | [`docs/analytics-event-taxonomy.md`](analytics-event-taxonomy.md), `worker/src/lib/analytics.mjs` | 90 days |
| Private search-execution receipts | Worker | [`capabilities/search_activity.mjs`](../capabilities/search_activity.mjs) | 30 days |
| Recognized-account search history | Worker | [`capabilities/search_history.mjs`](../capabilities/search_history.mjs) | 90 days, at most 25 entries |

### 1. The configured third-party loader

[`site/clarity.js`](../site/clarity.js) is a loader for Microsoft Clarity, a third-party
session-analytics service. It is **configured**, not dormant: `CONFIGURED_PROJECT_ID`
carries a non-empty project id, which is the condition the loader itself uses to decide
whether to run at all.

It is included by every top-level site document and by the search shell:

- `site/about.html`
- `site/api.html`
- `site/changelog.html`
- `site/data.html`
- `site/index.html`
- `site/standards.html`
- `site/stats.html`
- `site/search/index.html`

Documents rendered by the Worker and by the Pages edge handler do not include it; the
loader is a static-site inclusion only.

**When it skips.** The loader returns without injecting anything when the browser
signals an opt-out on `navigator.doNotTrack` (`"1"` or `"yes"`), on
`navigator.msDoNotTrack` (`"1"`), or on `navigator.globalPrivacyControl` (`true`). It
also returns without injecting when no project id resolves.

**What masking means here.** Before the provider script is appended, the loader sets
`data-clarity-mask="true"` on every `input, textarea, select` present in the document at
that moment, and on the two named email-capture fields `adest` and `fbemail`. Those two
fields additionally ship the attribute in committed markup, so they carry it whether or
not the loader's pass reaches them. This is a code-level instruction to the provider
tag over the controls that exist when the loader runs; a control added to the page after
that pass is not covered by it.

**What the loader does not observe.** It appends the provider script from
`https://www.clarity.ms/tag/` asynchronously with a no-op error handler. A blocked
request, a network failure, or a rejected project leaves the page fully usable — and
leaves nothing in this repository that records whether any collection took place.

**Evidence boundaries.** Three facts a reader may want are not established here:

| Fact | State | Why |
|---|---|---|
| dashboard masking mode | Not established here | The loader source instructs an operator to set the project's masking mode to Strict in the provider dashboard. Nothing in this repository reads that setting, so the mode in force is unknown here. |
| provider-side retention | Not established here | No retention period for the third-party service is declared in this repository. |
| live collection success | Not established here | The loader never inspects the outcome of the injected request, and no collection receipt is committed anywhere in the tree. |

Each stays a boundary until a configuration read or a receipt is committed. None of them
may be filled in from the loader's own comments, which state an intention rather than an
observation.

### 2. First-party aggregate events

Bounded page, lens, search, deep-link, export, alert, feed, investigation and
post-action-prompt events are written to the Analytics Engine dataset
`crol_usage_events_v1`. The versioned column-by-column inventory, its allowed
enumerations, and its 90-day retention are owned by
[`docs/analytics-event-taxonomy.md`](analytics-event-taxonomy.md); the write path and the
`ANALYTICS_RETENTION_DAYS` constant are in `worker/src/lib/analytics.mjs`. The dataset
carries no visitor or device identifier, no cookie, no fingerprint, and no query text.
Aggregates over it are read through authenticated `/admin/stats`.

### 3. Private search-execution receipts

One completed Universal Search leaves one receipt in KV under the `search:exec:` /
`search:exec-dev:` prefixes, keyed by the first-party `cs_visitor` cookie, retained for
30 days. The receipt contract — every field, every Worker-owned field a client may not
submit, and the size and row ceilings — is
[`capabilities/search_activity.mjs`](../capabilities/search_activity.mjs). Receipts are
private operational evidence and are read back only through the keyed
`/admin/search-activity` route.

### 4. Recognized-account search history

A Search run while an existing email session recognizes the reader also appends to that
account's own recent-search list: at most 25 entries, retained 90 days, stored under a
key derived from the session's subscriber id. Only that account can read it, through the
credentialed `/search-history` route. The contract is
[`capabilities/search_history.mjs`](../capabilities/search_history.mjs) and the
Worker-owned key derivation is `worker/src/lib/search_history.mjs`. A browser
`visitor_id` is never imported into an account history.

## What the public response publishes

Public `GET /stats` (`worker/src/stats.mjs`) publishes served-product coverage
aggregates and a **narrow, deliberate** search-usage summary. The summary is not an
accident of a broader telemetry surface: it is a closed projection built field by field
from an allowlist in
[`worker/src/lib/public_search_usage.mjs`](../worker/src/lib/public_search_usage.mjs) and
re-checked against that allowlist before it is served.

Exactly two counts are published, under the schema `cityscroll.public_search_usage.v1`:

| Published metric | What one unit means |
|---|---|
| `searches_run` | One accepted production search-execution receipt: one finished search, not one person |
| `searches_returning_records` | The subset of those searches that returned records |

They are published for two explicitly named periods, `last7d` and `last30d`, each
carrying the days it actually covers. The two counts are never added together.

**What the projection excludes.** No query text, no result contents or row trace, no
account label, browser identity, subscriber identity or receipt id, no recognized-account
count, no private route, and no scan diagnostics. Only whole counts, the days they cover,
and the state of the measurement itself can appear; a string that is not a declared
constant fails the structural gate and the snapshot is refused rather than published.

**Honest unavailable states are part of the contract.** A period is published only when
the measurement behind it is established for that period. Otherwise the response carries
an explicit unavailable state and a reason from a closed set, never a zero that reads as
"nobody searched". A public read serves a stored snapshot refreshed on the daily
schedule, so it never scans the receipt store; a failed refresh leaves the last verified
snapshot standing with its failure recorded beside it, and a snapshot older than the
receipts behind it stops being published at all.

## What stays private

Everything else about product use, delivery and subscribers is read through
authenticated `/admin/stats` and the keyed operator routes. The canonical owners are the
contracts above rather than a second inventory here:

| Subject | Canonical owner |
|---|---|
| Aggregate event columns, enumerations and retention | [`docs/analytics-event-taxonomy.md`](analytics-event-taxonomy.md) |
| Search-execution receipt fields and retention | [`capabilities/search_activity.mjs`](../capabilities/search_activity.mjs) |
| Account search-history entries and retention | [`capabilities/search_history.mjs`](../capabilities/search_history.mjs) |
| The published projection and its allowlist | [`worker/src/lib/public_search_usage.mjs`](../worker/src/lib/public_search_usage.mjs) |
| KV prefix semantics for all of the above | `worker/ops-contract.v1.json` |

## Verification

| Check | Command |
|---|---|
| Collection and publication reconciliation | `node tools/collection_boundary_facts.mjs --check` |
| Collection boundary tests | `node --test test/collection_boundary_facts.test.mjs` |
| Loader configuration, skip conditions and inclusion | `node --test test/clarity.test.mjs` |
| Published projection and its privacy exclusions | `node --test worker/test/search_usage.test.mjs` |
| Public stats response shape and private-field exclusion | `node --test worker/test/stats.test.mjs` |
