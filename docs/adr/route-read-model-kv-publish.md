# ADR: Worker route read-model KV publishing

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-24 |
| Scope | Worker Near You and meeting route read-model deploy publishing |
| Supersedes | — |
| Related | `docs/worker-cost-controls.md`, `tools/worker_route_publication.mjs`, `worker/wrangler.toml` |

## Context

Near You and meeting route read models are built as immutable KV slices with
small manifests published last. The deploy workflow runs from the repository
root, while the Worker KV namespace declarations live in
`worker/wrangler.toml`. Wrangler therefore cannot resolve a binding when a KV
command omits the Worker configuration path, even though the namespace is
configured for the Worker.

## Decision

Publish route read models through `tools/worker_route_publication.mjs`, with the
Worker Wrangler configuration explicitly selected:

- Use the `ALERT_STATE` binding declared in the production `kv_namespaces`
  entries in `worker/wrangler.toml`.
- Pass `--config worker/wrangler.toml` to every Wrangler KV operation.
- Keep the detailed content-addressing, write ordering, retry, and completed-state
  contract in `docs/worker-cost-controls.md` and its owning publisher module.

Do not hardcode a namespace ID in the workflow. The Worker configuration is the
authoritative binding-to-namespace mapping.

## Consequences

- The route read-model publish step resolves the same KV namespace used by the
  Worker at runtime.
- A deploy still reports Cloudflare authentication or a real publication error;
  it no longer fails because the command started outside the config directory.
- Publication tests check the observable Wrangler arguments against the
  committed Worker configuration.

## Evidence

- `tools/worker_route_publication.mjs` — publication command entry point.
- `tools/lib/worker_route_publication.mjs` — config-qualified KV operations and
  publication transaction boundary.
- `worker/wrangler.toml` — production `ALERT_STATE` KV namespace declaration.
- `test/worker_deploy_safety.test.mjs` — deploy wiring regression coverage.
- `tools/test_worker_route_publication_noop.mjs` — publication behavior and
  Wrangler argument coverage.
