# Reviewed architecture watermark shards

Each JSON file owns exactly one semantic baseline key. The filename is derived
from that key: core keys use `<key>.json`; canary keys use
`canary--<canary-id>.json`. The document `owner` must equal `id`, so two
candidates for one key fail validation instead of resolving by filename order.

`node tools/reconcile_architecture.mjs --check --output-dir <dir>` validates
the shard set and writes the derived compact `watermark.json` to `<dir>`.
Checks never write source shards. A reviewed advancement names every intended
key explicitly, for example:

```sh
node tools/reconcile_architecture.mjs --write-watermark \
  --watermark-key canary:production-search
```

The compatibility projection under `architecture/generated/` is ignored and
rejected as baseline input; it must not be committed.
