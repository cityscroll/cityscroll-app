# Evidence tip migration

This repository keeps deterministic test inputs and public documentation captures in Git, while
owner-only proof captures live in the content-addressed evidence store. The migration is
tip-only: deleting these files from the current tree does not rewrite historical Git objects.

## Population split

| Population | Current policy |
| --- | --- |
| Raster captures under `docs/screenshots/`, `docs/performance/`, and `docs/evidence/` | Migrated to content-addressed WebP objects outside the public repository. The committed [`evidence-tip-migration.json`](evidence-tip-migration.json) records the source digest, private-reference count, set digest, and registered maintainer disposition without publishing private locators. |
| Four paths listed in `docs/public-capture-allowlist.json` | Retained as intentional public documentation captures. |
| `artifacts/content-parity-r3/` and the checksum-pinned capture sets under `docs/screenshots/` | Retained as functional visual golden and acceptance corpora used by CI comparison/checksum tests. These are test inputs, not owner-proof captures. The retained sets are recorded explicitly in the manifest. |
| `test/**` visual fixtures and `docs/readme/` images | Retained as test or public documentation inputs; they are outside the migration roots. |
| SVG capture under `docs/evidence/` | Migrated as a WebP rendering; the original vector source is included in the manifest's source hash and is not retained in the public tip. |

Run the migration from the repository root with:

```sh
python3 tools/migrate_evidence_tip.py execute
```

The command converts each tracked raster capture with the same quality-82 WebP pipeline as the
content-parity harness, records original and content-addressed hashes plus Git provenance, rewrites
exact references in `docs/`, verifies the store, and removes only the migrated source files.
It is safe to inspect the result with:

```sh
python3 tools/migrate_evidence_tip.py check
node tools/verify_evidence_store.mjs --check --root .artifacts/evidence-store --require-rows
```

The store is host-side and intentionally ignored by Git. A legitimate CI or hosted artifact URL
may be provided to the store pipeline for newly captured evidence. Until one exists, the registered
RCP-03 disposition is the maintainer resolution path; this document does not invent a public URL.
