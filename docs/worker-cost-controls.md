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
reader while other valid sections continue to load. Failures before the state
write is issued leave the completed-state record unchanged. If the state write
was issued but unacknowledged, its final state is unknown; a safe retry
re-reads completed state before deciding whether publication is still needed.
Publication receipts keep planned operations separate from operations actually
attempted and confirmed, including provider calls that fail.
Confirmed counts are provider-acknowledged lower bounds, not provider or billed
totals. The deployment workflow still attempts the independent Worker code deployment
before reporting a route-data publication failure.

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
within the configured at-most-30-minute queue window. Acquisition independently
recomputes that fingerprint from authenticated provider batch evidence before
accepting the Worker receipt. Native binding operations are counted in memory and emitted in the same
final structured receipt after the handler and its `waitUntil` work finish;
acquisition callers cannot supply replacement operation totals. An HTTP
rehearsal, arbitrary log text, cross-run fingerprint, wrong trigger, or
mismatched provider version is rejected. No resident-delivering cron or queue
job is run merely to complete a profile; absent native evidence remains
unknown.

Account and cron aggregate profiles may use a distinct measurement period of up
to 24 hours and 10,000 events. Each live collector and live-tail session is
limited to 30 minutes (1,800 seconds). Each scheduled cohort has its own exact
timestamp and at-most-30-minute acceptance window within that day, allowing one
immutable version to observe the existing 08:00, 10:00, and 13:00 UTC triggers
without firing them artificially. The retained shape omits URLs, query strings,
headers, bodies, credentials, account identifiers, and resident identifiers.
Missing cohorts remain `unknown`; they never become zero-valued samples.
Attempted and confirmed operations are kept separate, and collector overhead is
a required cohort. Every retained profile carries an explicit `traffic_mix`
label.

`tools/worker_cost_acquisition.mjs profile` owns live acquisition. It reads
credentials only from the environment or a mode-0600 file, authenticates
deployment/version state and version-specific health, executes the fixed owned
HTTP workloads with an exact Worker-version override, and opens a short-lived
Workers Observability live tail before the workload begins. The telemetry token
is separate from the existing authenticated Wrangler deployment session and is
never reused for deployment reads. Retained Logs and Traces remain disabled.
Each live-tail session sends an authenticated heartbeat for the exact Worker
before acquisition and every 15 seconds while open; heartbeat or socket failure
aborts the collection, and shutdown cancels the heartbeat. This maintains
session eligibility only. Missing live events leave the affected evidence
incomplete. Missing cold-start metadata leaves isolate state unknown without
blocking route-level attribution cohorts.
Multiple collection windows may cover the natural cron schedule, but every
future live tail opens at its declared window start rather than spending its
collection timeout waiting. Every individual live tail is limited to 30 minutes
and the combined collectors accept at most 10,000 events. Aggregate profile
`max_seconds` remains 86,400 so multi-window cron provenance is not weakened;
the live enabled observability settings window separately hard-caps at 1,800
seconds. Raw provider events stay in memory; only sanitized samples are
returned. Missing access, native events, or provider batch messages yields a
partial result rather than a zero or complete profile. Missing cold-start
metadata does not invent warm or cold classes. When `$metadata.coldStart` is
present as 0 or 1 it stays `unverified-raw` and never becomes cold/warm
acceptance by itself.

The fixed attribution profile covers health, unknown-route, events, full RUM,
search, Near You, Browse, ZAP BBL, ZAP project, and Doing Business requests;
all three configured cron windows; the queue; and collector overhead. Provider
`$metadata.coldStart` is an optional numeric field whose 0/1 meaning is
unverified on this account. Missing values stay unknown and never become warm,
cold, or zero CPU. Optional isolate-labeled cohorts remain available for matched
warehouse experiments only when a live 0/1 flag is actually present; request
order, wall time, and startup time never invent isolate class.

A bounded observability settings window uses the beta Worker settings API. The
harness captures the effective baseline first, then starts a supervised
restorer process from durable copies under
`~/.local/state/cityscroll-cost-control/observability-restorer/` (so controller
death and disposal of the source checkout cannot strand an armed window). Before any PATCH the
mutator requires an fsynced readiness handshake with that live restorer
(matching `window_id`, `restorer_id`, pid, and fresh heartbeat). Write-ahead
intended before/after digests are fsynced under the shared window lock before
PATCH; the mutator and restorer serialize lifecycle updates through the same
lock and reject stale or closed window identities. Privacy arming keeps
observability, logs, and traces disabled (`persist=false`,
`redact_query_string=true`, empty destinations) and proves every privacy field
by an explicit typed acknowledgement of the RAW provider GET before any enable
(normalized omit-defaults are never accepted as proof). Expired captured windows
refuse arm/enable before any PATCH; restore of already owned expired state
remains allowed. Ownership is confirmed only after the RAW GET matches the
write-ahead after-digest. The issued flag is fsynced into the window store
before `patchObservability` is dispatched so a hang or crash during PATCH cannot
leave `dispatched=true` with `issued=false`. Mutation control is window-owned
read-modify-write: the Cloudflare beta Worker PATCH has no documented
conditional update for observability settings, so this path never claims
immunity to foreign concurrent writers. A healthy owned privacy-armed or
enabled window stays active until its deadline, an explicit cancel, or a
controller-death receipt bound to that window_id and restorer_id (stale death
receipts from older windows are ignored); ownership alone does not trigger
restore. Pending intents are reconciled by GET: pending-after confirms
ownership; pending-before wins over owned when digests coincide so a confirmed
privacy-arm can take the next enable transition; an issued-but-unacknowledged
intent whose GET still shows the prestate is retained as UNKNOWN (a prestate
GET does not prove the PATCH never applied); unissued or explicitly rejected
intents may clear.
The restorer restores the captured baseline on expiry, bound controller death,
or cancel (including unacknowledged applied mutations after the deadline), and
refuses if settings changed outside the owned window. Install with
`tools/install_observability_settings_restorer.sh`; the kill switch is
`observability-restorer.off` beside the durable state root. Settings CLI
statuses `ok` / `captured` / `privacy-armed` / `enabled` / `restored` /
`already-restored` exit 0; blocked or unknown exit nonzero so a failure never
triggers a blind PATCH retry.

## Warehouse experiment and release gate

The fixed warehouse experiment compares the current static ZAP BBL, ZAP
project, and Doing Business lookups with the route-scoped candidate under the
same inputs and workload. Each valid lookup plus the unrelated health and
browse controls uses exactly 100 cold and 100 warm provider-observed samples.
Joins, provenance, miss behavior, freshness, and cohort sizes must match. The
candidate is retained only when no CPU, KV, D1, storage, Queue, Analytics
Engine, collector, or error meter regresses and at least one meter improves;
otherwise the baseline stays active. The experiment records an operational
retention recommendation, never a financial-savings claim.
`tools/worker_cost_acquisition.mjs warehouse` owns the matched live run and
calls the evaluator only after both authenticated versions have the fixed
100-sample cold and warm cohorts, correctness/freshness/miss digests, and the
complete CPU, collector, KV, D1, storage, Queue, and Analytics Engine vector.
The runner uses bounded concurrent attempts within the same 30-minute and
10,000-event ceiling, then retains exactly 100 invocations whose provider
metadata proves cold execution and 100 whose metadata proves warm execution for
each identical input digest. If either population is unavailable, the run is
incomplete; it never relabels an invocation or forces a deployment to create a
cold sample. Cancellation reaches every in-flight workload request and prevents
new attempts from being scheduled.
Correctness, join, provenance, miss, and freshness digests are derived from each
version's observed child responses and structured receipts; measurement-plan
assertions cannot substitute for observed results.
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
