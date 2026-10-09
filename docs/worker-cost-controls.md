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
Every retained sample keeps its own revision, source field, provider condition,
operation counts, and error count. Release-level CPU, KV, D1, stored-byte, and
error totals must equal the sums of those samples; an independent top-level
meter cannot override contradictory provider evidence.
The profile also retains and hashes a structured Cloudflare deployment-binding
receipt. The validator requires that receipt to identify the Cloudflare Versions
API and production health as its sources, recomputes its digest from canonical
contents, and requires every sample to match its declared provider version and
revision. Pure evaluator calls prove matching and internal consistency only;
they do not authenticate a caller-supplied receipt. Authentication belongs to
the command boundary that acquires provider state and health itself.

HTTP and collector-overhead cohorts require the exact owned probe header, URL,
and method. Native scheduled cohorts instead require the provider event type,
configured cron, exact scheduled timestamp, provider request ID, and structured
instrumentation metadata matching an independently supplied run marker and
workload digest. Native queue cohorts require the provider queue trigger,
request ID, run marker, workload digest, and a bounded fingerprint derived from
the actual provider message IDs, timestamps, attempts, and body structure. The
Worker emits only that one-way fingerprint, never the message IDs or bodies,
and accepts it only when it was independently allowlisted for the measurement
run. Native binding operations are counted in memory and emitted in the same
final structured receipt after the handler and its `waitUntil` work finish;
acquisition callers cannot supply replacement operation totals. An HTTP
rehearsal, arbitrary log text, cross-run fingerprint, wrong trigger, or
mismatched provider version is rejected. No resident-delivering cron or queue
job is run merely to complete a profile; absent native evidence remains
unknown.

Collection is capped at 24 hours and 10,000 events. Each scheduled cohort has
its own exact timestamp and at-most-30-minute acceptance window within that
day, allowing one immutable version to observe the existing 08:00, 10:00, and
13:00 UTC triggers without firing them artificially. The retained shape omits
URLs, query strings, headers, bodies, credentials, account
identifiers, and resident identifiers. Missing cohorts remain `unknown`; they
never become zero-valued samples. Attempted and confirmed operations are kept
separate, and collector overhead is a required cohort.

The fixed profile covers cold and warm health, unknown-route, events, full RUM,
search, Near You, Browse, ZAP BBL, ZAP project, and Doing Business requests;
all three configured cron windows; the queue; and collector overhead. Each cold
or warm label requires provider condition evidence rather than inferring
isolate state from request order.

## Warehouse experiment and release gate

The fixed warehouse experiment compares the current static ZAP BBL, ZAP
project, and Doing Business lookups with the route-scoped candidate under the
same inputs and workload. Each valid lookup plus the unrelated health and
browse controls uses exactly 100 cold and 100 warm provider-observed samples.
Joins, provenance, miss behavior, freshness, and cohort sizes must match. The
candidate is retained only when no CPU, KV, D1,
storage, collector, or error meter regresses and at least one meter improves;
otherwise the baseline stays active. The experiment records an operational
retention recommendation, never a financial-savings claim.
Both warehouse runs must also match independently acquired deployment bindings;
the receipts embedded in the runs cannot authenticate themselves. The warehouse
command reads authenticated deployment status and version metadata itself, then
queries production health with exact version overrides for the untagged rollback
baseline and tagged candidate in the bounded split. Caller-supplied trusted
deployment JSON is rejected.

The all-meter gate applies the same tariff-free, per-meter ratchet to an
equivalent numeric workload, including D1 reads and writes as independent
meters. The pre-control baseline may retain the old publication and RUM write
counts; the candidate must demonstrate zero-write unchanged route publication
and at most three KV puts for a sixteen-observation RUM batch. Both sides require
ordered actual-production windows, distinct deployed revisions, complete
provider-native profiles, and the existing D1 delta control under its own
authority. Provider prices and account bills are not CI inputs.
Normalization is population-bound: native CPU uses the non-collector samples,
collector CPU uses the collector cohort, and operation and error meters use
every sample carrying their explicit evidence. Baseline and candidate
populations must match for each meter. Each receipt's `workload_count` must also
equal the full number of retained provider samples, so an independently
supplied divisor cannot make a regressed total look neutral.

The Worker release workflow has an explicit phased-activation boundary. While
the `WORKER_COST_ENFORCEMENT` repository variable is absent or differs from the
literal `enabled`, ordinary main and manual Worker deployments retain their
direct deploy behavior and report all-meter protection as incomplete. This
inactive state does not claim the pending CPU optimization is measured or
protected. Current production observation records 17 KV reads and 18 KV writes
for each sixteen-observation RUM batch; that baseline does not relax the
candidate's three-put release threshold. Once deliberately enabled, missing or
mismatched evidence fails closed and the workflow uses the two-phase promotion
path below.

An explicit
`workflow_dispatch` `stage` request uploads the exact revision as a tagged
Worker Version and assigns it 5 percent of HTTP traffic while retaining the
current version at 95 percent as the rollback identity. Staging never runs the
D1 or KV publication path, trigger updates, or scheduled and queue sampling.
Pushes and ordinary manual promotions never stage a revision automatically.
Immediately before either traffic mutation, the workflow re-reads authenticated
deployment status and version metadata and compares candidate and rollback IDs
with the initial plan. An intervening provider change fails closed; an exact
already-staged or already-promoted state is the only no-op retry.

The activated promotion path fails closed before it mutates production by
evaluating the sanitized JSON receipts in the `WORKER_COST_BASELINE_EVIDENCE`
and `WORKER_COST_CANDIDATE_EVIDENCE` repository variables. The workflow obtains
the active deployment and tagged versions through authenticated Wrangler JSON,
rejects any unrelated or ambiguous split, and targets both the live 95 percent
rollback version and staged candidate with provider version overrides. The
configured baseline must match the rollback's exact provider version and
production-health revision, so historical unrelated evidence cannot authorize
replacing the current baseline. The ordinary production health response is not
required to select either cohort.
The evidence-embedded bindings must byte-match those independently supplied
receipts and their canonical SHA-256 digests. Candidate health must name the
exact commit, every retained cohort sample must name the exact staged provider
version, and every meter must pass. Promotion moves that same immutable version
to 100 percent, with an already-promoted exact version accepted only as a safe
retry. A caller-authored checksum, an untagged version, or a mixed unrelated
rollout cannot authorize release.

The current provider references are the [Workers Observability telemetry query
API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/),
[real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/),
and [Workers KV consistency model](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
