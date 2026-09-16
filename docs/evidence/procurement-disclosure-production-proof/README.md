# Procurement disclosure production proof

Evidence for tracking alias `c755c57ebdc96`.

## Surfaces

| File | Role |
| --- | --- |
| `manifest.json` | Offline fixture render hashes from the real edge worker and committed read model. Twelve entries: six named contracts at desktop and 390px. |
| `production-readback.json` | Separate deployment read-back against live `https://cityscroll.org` and `https://api.cityscroll.org`. Records the live URL, served build vintage, assertions, and results. |

Both surfaces keep textual assertions and sha256 hashes only. Image binaries are never committed.

## Regenerate

Never hand-edit hashes or revision fields.

```bash
node tools/capture_procurement_disclosure_production_proof.mjs --fixture-manifest
node tools/capture_procurement_disclosure_production_proof.mjs --production
node tools/capture_procurement_disclosure_production_proof.mjs --check
```

`--fixture-manifest` pins the capture clock, serves each route through the edge worker, recomputes every hash, and writes the producing git revision onto every entry so revision and hash stay paired.

`--production` issues read-only public GETs. It does not submit forms, write state, or take account actions. The resident search shell for `ACEDCA215` is client-rendered; the production search assertion uses the public search API that feeds it.

## Covering tests

`test/procurement_disclosure_production_proof.test.mjs` plus the card `verify:` suites:

```bash
node --test test/field_performance_evidence.test.mjs test/procurement_official_source.test.mjs test/primary_document_routes.test.mjs
```
