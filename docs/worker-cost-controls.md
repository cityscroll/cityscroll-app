# Worker cost controls

CityScroll treats infrastructure cost as a vector of independently measured
meters. A release cannot call a D1 reduction a saving when the equivalent
workload increases Worker invocation CPU, KV reads or writes, stored bytes, or
the cost of collecting the evidence.

## Route read-model publication

`tools/worker_route_publication.mjs` owns route-data publication. Route slices
are immutable and addressed by a hash of their own payload. The publisher reads
one completed-state record, omits keys already referenced by the active or
rollback manifests, publishes every new payload, publishes the Near You and
meeting manifests independently, and advances state last. An identical build
therefore performs no route-key or manifest puts.

Workers KV is eventually consistent and does not provide a multi-key manifest
transaction. A delayed slice remains an explicit unavailable section in the
reader while other valid sections continue to load. A failed publication leaves
the completed-state record unchanged and can be retried with the same immutable
keys. The deployment workflow still attempts the independent Worker code
deployment before reporting a route-data publication failure.

## Provider-native invocation profiles

`tools/lib/worker_cost_control.mjs` defines the bounded, sanitized profile.
Retained CPU must come from the native Wrangler-tail `cpuTime` field or the
Workers Observability telemetry `$workers.cpuTimeMs` field. Wall time, startup
time, and JavaScript elapsed timers are not accepted as invocation CPU.

Collection is capped at 30 minutes and 10,000 events. Before persistence, an
event must match the probe's literal header value and exact URL and method. The
retained shape omits URLs, query strings, headers, bodies, credentials, account
identifiers, and resident identifiers. Missing cohorts remain `unknown`; they
never become zero-valued samples. Attempted and confirmed operations are kept
separate, and collector overhead is a required cohort.

The fixed profile covers cold and warm health, unknown-route, events, full RUM,
search, and Near You requests; all three configured cron windows; the digest
queue; and collector overhead. Each cold or warm label requires explicit
condition evidence rather than inferring isolate state from request order.

## Warehouse experiment and release gate

The fixed warehouse experiment compares the current static ZAP BBL, ZAP
project, and Doing Business lookups with the route-scoped candidate under the
same inputs and workload. Joins, provenance, miss behavior, freshness, and
cohort sizes must match. The candidate is retained only when no CPU, KV,
storage, collector, or error meter regresses and at least one meter improves;
otherwise the baseline stays active and the result records no shipped saving.

The all-meter gate applies the same tariff-free, per-meter ratchet to an
equivalent workload. It separately requires zero-write unchanged route
publication, at most three KV puts for a sixteen-observation RUM batch, complete
provider-native profiles, and the existing D1 delta control under its own
authority. Provider prices and account bills are not CI inputs.

The current provider references are the [Workers Observability telemetry query
API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/),
[real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/),
and [Workers KV consistency model](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
