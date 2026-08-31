# Shared worker dependency store

The Worker uses the exact pnpm version declared by `worker/package.json` and the authoritative
`worker/pnpm-lock.yaml`. Run `tools/install_worker_dependencies.sh`; it selects pnpm through
Corepack and materializes an isolated `worker/node_modules` view backed by pnpm's content-addressed
store outside the checkout.

Set `CITYSCROLL_PNPM_STORE_DIR` to choose an explicit external store. When it is unset, pnpm's
platform default store is used. The installer rejects a store nested inside the checkout and
always uses `--frozen-lockfile`. To prove cold/warm offline reuse and the physical footprint, run
`node tools/verify_shared_dependency_store.mjs --output <receipt.json>` from a clean commit.
