# Cloudflare release and infrastructure reference

This document is the owned reference for two things: how a merge reaches
production, and what runtime resources the Worker is configured with. Other
architecture summaries link here instead of restating a schedule or a binding
list, so a trigger or a binding has exactly one place to drift from.

Every fact below is derived from a committed configuration file — the deploy
workflows, [`worker/wrangler.toml`](../../worker/wrangler.toml), and the
machine-readable contract in
[`cloudflare-native-builds.json`](./cloudflare-native-builds.json).
`node tools/release_infrastructure_facts.mjs --check` re-derives them and fails
if this page disagrees with any of those files.

## Two registers, kept apart

- **Repository-configured.** A trigger, schedule, or binding declared in a file
  in this repository. It is verifiable here, and it is what the tables below
  record.
- **Externally observed.** A setting that lives only in a Cloudflare account —
  a Workers Builds Git connection, a Pages Git integration, a dashboard-set
  variable. Nothing in this repository can read one. Such a setting stays
  **unverified** until a read-only configuration read or a deployment receipt
  is committed as evidence; documentation is never evidence for it.

## Release pipelines

| Pipeline | Automatic trigger | Manual trigger | Boundary |
|---|---|---|---|
| `deploy-cloudflare-pages` | `push` to `main`, plus a daily `schedule` | `workflow_dispatch` | `cloudflare-pages` |
| `deploy-worker` | `push` to `main`, filtered by the workflow's `paths` list | `workflow_dispatch` | `cloudflare-worker` |

GitHub Actions is the release control plane for both production boundaries. The
Worker workflow is not a recovery path: an ordinary merge that touches any path
in its filter deploys the Worker, and `workflow_dispatch` exists on top of that
for a re-run without a new commit and for the two D1 publication inputs
(`force_d1_publication`, `disable_incremental_publication`).

The Worker path filter is wide — `worker/**`, `capabilities/**`,
`entity_resolution/**`, `ontology/**`, `site/**`, `tools/**`, `warehouse/**`,
the shared Following renderer and its data, several named builders, and the
workflow file itself. `node tools/worker_trigger_coverage.mjs --check` proves the
filter still covers every path the Worker bundle imports;
`node tools/audit_deploy_control_plane.mjs --check` proves both workflows still
deploy on a `main` push and keep a manual trigger.

Each production pipeline writes its own deployment-health receipt
(`cloudflare-pages` or `cloudflare-worker`). Cross-boundary health is 2/2 only
when both independently verifiable receipts match the merged source SHA; runtime
digest or scheduler receipts are not substitutes.

## Configured Worker cron triggers

Wrangler rewrites cron configuration on every deploy, so these three schedules
are part of the release surface rather than a separate operational setting.

Every window also starts the receipt-only public search-use refresh through
`ctx.waitUntil()` before dispatching its other jobs. Publication does not wait
for delivery or publisher acquisition, and cannot be skipped by an early return.
Repeated windows leave an already stored daily aggregate unchanged.

| UTC schedule | Responsibility |
|---|---|
| `0 8 * * *` | Refreshes the sell-facing ZAP project lookup, Land upcoming hearings, and staffing exams into `ALERT_STATE`, so those lists do not wait behind the digest chain. |
| `0 10 * * *` | Delivery-free digest shadow rehearsal. It renders and validates without sending; three calendar days without a `READY` rehearsal holds delivery. |
| `0 13 * * *` | The delivery chain: Socrata to D1 ingest refresh, prior-cycle pre-warm, hearings, Property and vendor projection rebuilds, payroll title mart refresh, then digest fan-out under the send caps. |

**UTC is authoritative.** These are the expressions Cloudflare schedules, and
they do not shift with New York's daylight-saving changes; the local clock a
subscriber sees a `0 13 * * *` digest arrive on moves by an hour twice a year.
Treat any fixed local-time rendering elsewhere in the tree as an approximation
of one part of the year, not as configuration.

## Configured Worker bindings

"Active" means the declaration is present and uncommented in
`worker/wrangler.toml` and no `<BINDING>_ENABLED` variable turns it off. A
commented-out declaration is a reserved seam, not custody.

| Binding | Resource | State |
|---|---|---|
| `DB` | D1 database `crol-notices` | active |
| `NL_METER` | KV namespace | active |
| `ALERT_STATE` | KV namespace | active |
| `SUBS` | KV namespace | active |
| `FEEDBACK` | KV namespace | active |
| `USAGE_ANALYTICS` | Analytics Engine dataset `crol_usage_events_v1` | active |
| `RUM_ANALYTICS` | Analytics Engine dataset `crol_rum_observations_v1` | active |
| `DIGEST_QUEUE` | Queue producer for `crol-digests` | active |
| `queues.consumers:crol-digests` | Queue consumer for `crol-digests` | active |
| `queues.consumers:crol-digests-dlq` | Queue consumer for the dead-letter queue | active |
| `SOURCE_VAULT` | R2 bucket | inactive — the `[[r2_buckets]]` declaration is commented out and `SOURCE_VAULT_ENABLED` is `"false"` |

No R2 bucket is bound. The source-vault code path in
`worker/src/source_vault.mjs` exists and is covered by tests, but no source
document is retained in object storage by this configuration, and the presence
of that code is not evidence of custody. The accepted decision and its
conditions are [`docs/adr/source-vault.md`](../adr/source-vault.md).

## Externally observed settings

| Setting | Repository declaration | Verification state |
|---|---|---|
| Workers Builds Git connection for `cityscroll-worker` | `worker.native_builds_connection`, `worker.root_directory`, `worker.build_command`, `worker.deploy_command`, `worker.preview_deploy_command`, `worker.path_includes` in the JSON contract | **unverified** — no read-only configuration read or Workers Builds deployment receipt is committed. The Worker deploy workflow records its `worker_release` stage as `UNKNOWN` for exactly this reason. |
| Cloudflare Pages Git integration | `pages.native_git_integration_required: false` | Not required. If it is connected, disable its production-branch builds so a merge does not deploy twice. |

Because the Workers Builds connection is unverified, the observable production
Worker deploy path is the Actions workflow above. The JSON contract's Worker
commands remain the declared configuration for that dashboard integration; they
say what should be set there, not what is set there.

## Activation checklist

The repository must retain the `CLOUDFLARE_API_TOKEN` Actions secret. Prefer a
least-privilege token limited to Workers and Pages deploys on this account;
`worker/wrangler.toml` sets no `account_id`, so Wrangler resolves the account
from the token. `LEGISTAR_API_TOKEN` is a separately managed repository secret
that the Worker workflow re-syncs, non-fatally, to one Wrangler secret.

The `Deploy Cloudflare Pages` workflow resolves its single authorized account,
builds `_site`, deploys branch `main`, and smokes the immutable deployment before
checking route parity.

To connect Workers Builds, set the project root directory to `worker` and use the
production and preview commands from the JSON contract. Those commands stamp
`GIT_COMMIT_SHA` and `WRANGLER_ENV` onto `GET /health` from
`WORKERS_CI_COMMIT_SHA`, the same identity the Actions deploy stamps from
`github.sha`, so a route-parity probe can tell which deployment answered. Run one
preview build and compare its version with the current public release before
enabling a production branch, then capture a configuration or deployment receipt
so the row above can move off **unverified**.

## Legacy hosting retirement

The independent GitHub Pages copy is retired. Cloudflare Pages is the production
static origin and the Worker keeps its existing two-tier failover: the stamped
`cityscroll.pages.dev` artifact covers the full site, while the raw repository is
used only for `/docs/*` and `/README.md`. The raw-repository tier is not a full-site
disaster-recovery substitute because it can contain unsubstituted build tokens.

## Verification

| Check | Command |
|---|---|
| This page against the workflows, Wrangler config and JSON contract | `node tools/release_infrastructure_facts.mjs --check` |
| Deploy control plane | `node tools/audit_deploy_control_plane.mjs --check` |
| Worker trigger coverage | `node tools/worker_trigger_coverage.mjs --check` |
| Release and infrastructure reconciliation tests | `node --test test/release_infrastructure_facts.test.mjs` |
| Architecture reconciliation | `node --test test/reconcile_architecture.test.mjs` |
