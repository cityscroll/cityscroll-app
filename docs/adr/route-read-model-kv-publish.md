# ADR: Worker route read-model KV publishing

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-24 |
| Scope | Worker Near You and meeting route read-model deploy publishing |
| Supersedes | — |
| Related | `.github/workflows/deploy-worker.yml`, `worker/wrangler.toml`, `tools/build_worker_route_read_models.mjs`, `architecture/generated/watermark.json` |

## Context

Near You and meeting route read models are built as immutable KV slices with
small manifests published last. The deploy workflow runs from the repository
root, while the Worker KV namespace declarations live in
`worker/wrangler.toml`. Wrangler therefore cannot resolve a binding when a KV
command omits the Worker configuration path, even though the namespace is
configured for the Worker.

## Decision

Publish every route read-model slice and manifest with the Worker Wrangler
configuration explicitly selected:

- Use the `ALERT_STATE` binding declared in the production `kv_namespaces`
  entries in `worker/wrangler.toml`.
- Pass `--config worker/wrangler.toml` to each `kv bulk put` and `kv key put`
  command in the deploy workflow.
- Preserve slice-first, manifest-last publication so readers never follow a
  partially published version.

Do not hardcode a namespace ID in the workflow. The Worker configuration is the
authoritative binding-to-namespace mapping.

## Consequences

- The route read-model publish step resolves the same KV namespace used by the
  Worker at runtime.
- A deploy still fails closed on Cloudflare authentication or a real publish
  error; it no longer fails because the command started outside the config
  directory.
- The workflow regression test checks both the binding name and the explicit
  configuration path against the committed Worker configuration.

## Evidence

- `.github/workflows/deploy-worker.yml` — three config-qualified KV publishes.
- `worker/wrangler.toml` — production `ALERT_STATE` KV namespace declaration.
- `test/worker_deploy_safety.test.mjs` — deploy wiring regression coverage.
- `tools/build_worker_route_read_models.mjs` — slice and manifest build input.
