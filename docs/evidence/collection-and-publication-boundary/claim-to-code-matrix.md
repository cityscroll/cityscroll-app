# Collection and publication: claim-to-code matrix

This is the audit behind the September 2026 reconciliation of CityScroll's technical
statements about what the product collects and what it publishes. It records, claim by
claim, what the documents said before, what they say now, and the exact source file each
corrected claim rests on.

The change is documentation, plus one deterministic checker and its tests. No analytics
was enabled, disabled, or reconfigured; no consent or retention policy was changed; no
private receipt was exposed; and no runtime serialization was altered.

## Revisions

| Role | Revision | Note |
|---|---|---|
| Audited revision | `81b0f6676c1a95436fbc3a9ee8503b7df842b59d` | The tip of the default branch when this reconciliation began. Every finding below was derived from the tree at this revision. |
| Implementation head | `81b0f6676c1a95436fbc3a9ee8503b7df842b59d` | The same revision. The previous documentation reconciliation in this series landed here, so no intervening commit could have closed, weakened, or superseded a finding. |

**Revalidation.** Every audited path was re-read at the default-branch tip before editing.
These are the blobs the findings were derived from:

| Audited path | Blob at the audited revision |
|---|---|
| `site/clarity.js` | `840d895a9bf45f2b7045c27a438043652edfd11b` |
| `worker/src/stats.mjs` | `8d4d333fd11c242bf791902a7ff96b89b7cb512f` |
| `worker/src/lib/public_search_usage.mjs` | `7ebe16cb30aa83ef7a3992bd6fdfc124d9ec9e1a` |
| `worker/src/lib/search_usage.mjs` | `ef626ee58e102d617534d1846eebac86e1ddf288` |
| `worker/src/lib/analytics.mjs` | `d93f4975374a6d629756f216d10423b6945f3204` |
| `capabilities/search_activity.mjs` | `fbfce5713456c5773983e7c6f01930834fbedb7e` |
| `capabilities/search_history.mjs` | `76ac6e0b30c8422c6480940eaaeb0b65d7ab0054` |
| `worker/src/lib/search_history.mjs` | `dffa146139f809a31efbbd877406118320a967a1` |
| `docs/analytics-event-taxonomy.md` | `9eeabe2953483bb6241e69d6c8472c16b78c4234` |
| `ARCHITECTURE.md` | `41b4cae056343de811cb703923185a7463d9d536` |
| `docs/architecture.md` | `81ab9d7ff790e17714003b26606e721ce385d65e` |
| `test/clarity.test.mjs` | `4c66d44e127edd69d4405a87f6d034d9cd143bb9` |
| `worker/test/stats.test.mjs` | `51e235bf770ca08d6c2280a874a5f8f9fecb9f3f` |
| `worker/test/search_usage.test.mjs` | `410b3af6d3868c07d28f1ef553d26917aa82bf3c` |

## Two registers

The corrected documents separate what this repository configures from what only a
third-party account or live traffic could show.

| Register | Meaning | Evidence |
|---|---|---|
| Repository-configured | A loader, dataset, retention period, or published field declared in a committed file | The file itself, re-derived by `node tools/collection_boundary_facts.mjs` |
| Not established here | A provider dashboard setting, an actual retention period at a provider, or whether collection ever succeeded | Nothing in this repository can read one. It stays unestablished until a configuration read or a receipt is committed. |

## Matrix

### C1 — The documented collection boundary omitted a configured third-party loader

| | |
|---|---|
| **Before** | `docs/architecture.md` §"TL;DR": "under one hard rule: no required accounts, no fingerprinting, **no third-party trackers**, and no visitor profiles beyond the first-party `cs_visitor` cookie's private, 30-day-bounded search-execution receipts". |
| **After** | The same sentence keeps the three claims the code supports and drops the fourth, then routes to the owned reference for the loader, the first-party dataset, and the published counts. |
| **Configuration owner** | `site/clarity.js`: `const CONFIGURED_PROJECT_ID = "xusuca7gsv";` — the loader's own gate is a non-empty project id, and `boot()` returns `{loaded: false, reason: "unconfigured"}` only when that resolves empty. The tag is requested from `https://www.clarity.ms/tag/`. |
| **Inclusion** | Every top-level site document carries `<script defer src="clarity.js?v=1.0.0"></script>`: `site/about.html`, `site/api.html`, `site/changelog.html`, `site/data.html`, `site/index.html`, `site/standards.html`, `site/stats.html`, and `site/search/index.html`, which resolves it through its own `<base href="/">`. Worker-rendered and Pages-edge-rendered documents do not include it. |
| **Already-existing corroboration** | `test/clarity.test.mjs` already asserted the live project id twice ("CONFIGURED_PROJECT_ID is the live Clarity project"), and already asserted that all seven top-level documents load the runtime. The repository's tests and its prose disagreed; the prose was wrong. |
| **Why the old text misled** | The claim was written on 2026-09-02, more than a month after the live project id landed on 2026-07-30. A maintainer answering "does CityScroll load a third-party tracker?" from the canonical technical documentation would have said no, and would have been wrong about a script that runs on every page a reader lands on. |

### C2 — A product-wide absolute about cross-site tracking

| | |
|---|---|
| **Before** | `docs/architecture.md` §"What & why": "The constraint is no required accounts, no fingerprinting, and **no cross-site tracking**; per-visitor state is limited to opt-in email identity, the first-party `cs_visitor` cookie, and private, 30-day-bounded search-execution receipts." |
| **After** | The claim is scoped to what the repository can hold itself to: "CityScroll itself sets no cross-site identifier, and the per-visitor state it owns is limited to …". The sentence then states that a third-party session-analytics loader is separately configured on the static site documents and skips on a browser opt-out signal, and routes to the owned reference. |
| **Configuration owner** | Same as C1. The correction does not replace one absolute with its opposite: nothing in this repository establishes what the provider does with a request, so the document asserts neither direction. |
| **What is preserved** | The three claims the code does support — no required accounts, no fingerprinting, and the exact list of first-party per-visitor state — are unchanged. |

### C3 — The architecture denied the search counts the product deliberately publishes

| | |
|---|---|
| **Before** | `docs/architecture.md` §"Data stores & schemas": "Authenticated `/admin/stats` reads sampling-aware 7/30-day aggregates through Cloudflare's SQL API; **public `/stats` never reads or returns product-use telemetry**." §"System map" route list: "`/stats` public corpus and coverage aggregates". |
| **After** | The dataset sentence now says public `/stats` reads nothing from the Analytics Engine dataset — which remains true — and states that the only product-use figures it publishes are two period-bounded counts projected from search-execution receipts through a closed allowlist. The route list names those two counts. |
| **Serializer owner** | `worker/src/lib/public_search_usage.mjs`: `PUBLIC_SEARCH_USAGE_METRICS` is exactly `searches_run` and `searches_returning_records`; `SEARCH_USAGE_WINDOW_DAYS` in `worker/src/lib/search_usage.mjs` is `[7, 30]`, published as the periods `last7d` and `last30d`; the schema is `cityscroll.public_search_usage.v1`. |
| **Route owner** | `worker/src/stats.mjs` `buildPublicStatsBody` places the projection at `search_usage`, and its `scope` string already read "verified counts of searches run and searches returning records for named periods". The route's own scope statement and the architecture summary contradicted each other. |
| **Exclusions, unchanged** | `publicSearchUsageViolations` gates the finished artifact against a closed key and string allowlist: only whole counts, ISO instants, and declared constants may appear. No query text, result contents, account label, browser identity, subscriber identity, receipt id, recognized-account count, private route, or scan diagnostic can cross it. |
| **Already-existing corroboration** | `worker/test/search_usage.test.mjs` already asserted "the public scope statement says what is published and what stays private" and "family appearances stay private"; `worker/test/stats.test.mjs` already asserted that nine usage-class keys must remain absent from the public body. |
| **Why the old text misled** | A maintainer reading the absolute would have treated any published search figure as a defect, and would have looked for a leak instead of finding a reviewed, allowlisted projection with its own tests. |

### C4 — One privacy sentence stood for four different collection paths

| | |
|---|---|
| **Before** | `ARCHITECTURE.md` §"Cross-cutting concepts": "**Privacy and spend limits.** Stateful features are rate-limited and capped. Analytics uses enumerated dimensions and no visitor identifier. LLM and email paths fail closed or degrade when their required configuration is absent." |
| **After** | The bullet names the four paths separately — the configured third-party loader and its opt-out skip, the first-party aggregate dataset with enumerated dimensions and no visitor identifier, private search-execution receipts, and a recognized account's own search history — then states what public `GET /stats` publishes from them and routes to the owned reference. |
| **Why one sentence could not hold** | The four paths have different owners, different storage, and different retention: none in this repository for the third-party service, 90 days for the aggregate dataset (`ANALYTICS_RETENTION_DAYS`), 30 days for receipts (`SEARCH_ACTIVITY_RETENTION_DAYS`), and 90 days with a 25-entry ceiling for account history (`SEARCH_HISTORY_RETENTION_DAYS`, `SEARCH_HISTORY_MAX_ENTRIES`). A sentence describing "analytics" as one policy is wrong about three of them. |
| **Not copied** | The retention and field inventories stay with their existing owners. The reference links `docs/analytics-event-taxonomy.md`, `capabilities/search_activity.mjs`, and `capabilities/search_history.mjs` rather than restating them. |

### C5 — Facts about a third-party provider that this repository cannot establish

| | |
|---|---|
| **Before** | The loader's source comment reads "Operator must set project Masking mode to Strict in the Clarity dashboard". No document distinguished that instruction from an observation, and no document said what happens to data at the provider. |
| **After** | `docs/collection-and-publication-boundary.md` records three facts as **Not established here**, each with the reason: **dashboard masking mode** (the loader instructs an operator; nothing here reads the setting), **provider-side retention** (no period for the third-party service is declared in this repository), and **live collection success** (the loader appends the script with a no-op error handler and never inspects the outcome; no collection receipt is committed anywhere in the tree). |
| **What is asserted instead** | Only the code-level masking that is committed: before the provider script is appended, `applyInputMasking` sets `data-clarity-mask="true"` on every `input, textarea, select` present at that moment and on the named fields `adest` and `fbemail`; those two also ship the attribute in committed markup. The document states that a control added after that pass is not covered by it. |
| **How it can move** | Commit a configuration read or a collection receipt, then convert the row. The loader's own comments are an intention, and the reference says so; they are explicitly not evidence for any of the three. |

### C6 — Where a collection or publication fact is allowed to be written down

| | |
|---|---|
| **Before** | Statements about collection appeared in `ARCHITECTURE.md` §"Cross-cutting concepts", `docs/architecture.md` §"What & why", §"System map", §"Data stores & schemas", and §"TL;DR". Four of the five disagreed with the code, in two different directions. |
| **After** | `docs/collection-and-publication-boundary.md` owns the inventory. The summaries keep only the facts their own narrative needs and link the owner. `node tools/collection_boundary_facts.mjs --check` fails if either summary stops linking it, if the owned reference stops matching the loader source or the exported contract constants, or if any checked document reasserts one of the retired absolutes. |

## Derived facts at the implementation head

Produced by `node tools/collection_boundary_facts.mjs`.

| Path | Configured here | Retention configured here | Read back through |
|---|---|---|---|
| Third-party session-analytics loader (`site/clarity.js`) | Project id present; loaded by 8 committed documents; skips on `navigator.doNotTrack`, `navigator.msDoNotTrack`, `navigator.globalPrivacyControl` | Not declared in this repository | Not readable here |
| First-party aggregate events (`crol_usage_events_v1`) | Enumerated dimensions, no visitor identifier | 90 days | Authenticated `/admin/stats` |
| Search-execution receipts | First-party `cs_visitor` cookie, one receipt per finished search | 30 days | Keyed `/admin/search-activity` |
| Account search history | Keyed by derived subscriber id from an existing session | 90 days, at most 25 entries | Credentialed `/search-history` |
| Public search-usage summary | `searches_run` and `searches_returning_records`, periods `last7d` and `last30d` | Snapshot expires 7 days after its last verification | Public `GET /stats` |

## Read-back: four cases from the documents alone

**1. A maintainer is asked whether the site loads a third-party analytics script.**
Yes. `site/clarity.js` carries a project id and is included by all seven top-level
documents and the search shell. It skips entirely when the browser signals Do Not Track
or Global Privacy Control. — §"Collection paths" → "The configured third-party loader".

**2. Someone asks whether form input is protected from that script.**
The loader sets a masking attribute on every input, textarea and select present when it
runs, and on the two named email fields, before the provider script is appended. Whether
the provider project is additionally set to Strict masking is not established here. —
same section, and its evidence-boundary table.

**3. A reviewer sees search counts on the public statistics response and suspects a leak.**
They are published on purpose: two counts, for two named periods, from an allowlisted
serializer that refuses any string that is not a declared constant. Query text, result
contents, identities, receipt ids and private routes cannot appear. — §"What the public
response publishes".

**4. A public period shows an unavailable state instead of a number.**
That is the contract, not an outage of the page. A period publishes only when the
measurement behind it is established for that period; otherwise it carries an explicit
reason from a closed set rather than a zero that reads as "nobody searched". — same
section.

## What this reconciliation did not do

No analytics was enabled, disabled, or reconfigured: `CONFIGURED_PROJECT_ID`, the tag
origin, the skip conditions, and the masking pass in `site/clarity.js` are untouched, and
no document was added to or removed from the set that includes the loader. No consent or
retention policy was changed: `ANALYTICS_RETENTION_DAYS`, `SEARCH_ACTIVITY_RETENTION_DAYS`,
`SEARCH_HISTORY_RETENTION_DAYS`, and the snapshot staleness and expiry constants are the
same values. No private receipt was exposed and no runtime serialization was changed:
`buildPublicStatsBody`, `projectPublicSearchUsage`, and `publicSearchUsageViolations` are
byte-identical, and the existing public-response tests pass unmodified. The Stats page,
the About page, and the Guide are owned by other work and were not edited.

Two residuals are recorded rather than fixed:

- `docs/precompute-first-inventory-2026-07-29.md` describes `stats.html` as carrying "no
  product-use telemetry". That is a dated audit, and the statement was true on its date:
  the public search-usage projection landed on 2026-09-06. It is a historical record of a
  point in time, not a current claim, so it is left as written and superseded by the owned
  reference.
- Whether a third-party session-analytics service should be configured on the public site
  at all is a collection-policy question. This reconciliation states the configuration
  accurately and changes nothing about it; the decision belongs to whoever owns the
  collection policy.

`site/clarity.js` was deliberately not added to the `sources:` list of
`docs/architecture.md`. That document no longer restates loader detail — it routes to the
owned reference — so the loader is not provenance for its own text, and adding it would
move the architecture observation watermark for no documentation gain.

## Verification

| Check | Command |
|---|---|
| Collection and publication reconciliation | `node tools/collection_boundary_facts.mjs --check` |
| Collection boundary tests | `node --test test/collection_boundary_facts.test.mjs` |
| Loader configuration, skip conditions and inclusion | `node --test test/clarity.test.mjs` |
| Published projection and its privacy exclusions | `node --test worker/test/search_usage.test.mjs` |
| Public stats response shape and private-field exclusion | `node --test worker/test/stats.test.mjs` |
| Architecture reconciliation, live tree | `node tools/reconcile_architecture.mjs --check --no-write` |
| Evidence shards | `node tools/architecture_evidence_shards.mjs --check` |
| Semantic-owner receipt | `node tools/governance_semantic_owner_receipt.mjs --check` |
| Resident-read fitness function | `node tools/no_live_external_reads.mjs --check` |
| Repository pre-push gate | `make prepush` |
