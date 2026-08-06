# Independent enacted-law mandate pipeline

This pipeline uses the authenticated NYC Council Legistar Web API as its only
law source.

The seams are deliberately independent:

- `fetch_enacted_laws.mjs` enumerates enacted Introductions from 2014 onward,
  reads the Legistar `MatterText*` fields and attachment metadata, and caches
  law text with source URL, fetch time, and SHA-256 provenance. The cache is
  gitignored.
- `extract_mandates.mjs` exposes a pinned prompt and an injected
  `invokeModel` adapter. Any provider can implement that adapter. Dates are
  computed by `schema.mjs`, not by the model.
- `quote_verify.mjs` makes a row `verified` only when its contiguous quote is
  found in the fetched text after whitespace normalization. Failed rows remain
  `candidate` records.
- `compare_mandates.mjs` accepts a private reference path only outside the
  repository and emits a clerk-review-shaped queue. Differences are resolved
  by re-reading the fetched statute, never by preferring either extractor.
- `smoke.mjs` runs five deterministic fixture laws and prints quote receipts.

Example commands:

```sh
node tools/law_mandates/smoke.mjs
node tools/law_mandates/compare_mandates.mjs \
  --our tools/law_mandates/output/our.json \
  --reference /private/path/reference.json \
  --out tools/law_mandates/output/review_queue.json \
  --repo-root .
```

Production acquisition requires `LEGISTAR_API_TOKEN`; the token is passed only
to the existing authenticated client and is never written to cache or logs.
This launch scope does not run the historic batch, monthly increment, UI, or
entity materialization.
