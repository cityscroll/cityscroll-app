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
  repository and emits automated differential self-checks. Differences are
  diagnostics, not accept/reject tasks or publication gates; source-grounded
  fidelity comes from the fetched statute text.
- `retained_retry.mjs` derives laws with zero comparison-corpus obligations,
  fetches their enacted text from public Legistar detail pages, retries the
  normal extractor, and runs a second source-grounded fidelity check. Clear
  defects receive one automated repair pass; genuinely ambiguous text remains
  labeled and inspectable. Every result carries the source URL, text SHA-256,
  prompt versions, evidence quotes, and mechanical quote receipts.
- `smoke.mjs` runs five deterministic fixture laws and prints quote receipts.

### Optional upstream comparison corpus

The comparator accepts Tal Roded's `obligations.json` envelope as a private
upstream compilation source. That filename and its `obligations` key remain
supported input vocabulary; CityScroll's entity name, URLs, facets, and reader
copy use **Mandates**. Comparison differences are resolved against the linked
[NYC Council Legistar record](https://nyc.legistar.com/Legislation.aspx), not by
treating either compilation as authoritative.

Example commands:

```sh
node tools/law_mandates/smoke.mjs
node tools/law_mandates/compare_mandates.mjs \
  --our tools/law_mandates/output/our.json \
  --reference "$REFERENCE_CORPUS" \
  --out tools/law_mandates/output/differential_self_check.json \
  --repo-root .
node tools/law_mandates/retained_retry.mjs \
  --reference "$REFERENCE_CORPUS" \
  --output-dir tools/law_mandates/output/retained_retry \
  --repo-root .
node tools/law_mandates/build_retained_retry_evidence.mjs
```

The evidence builder fails unless all 188 retained laws completed, all emitted
mandates have verified enacted-text quotes, no extractor bug remains, and the
self-check is explicitly non-gating. The public artifact retains per-law source
URLs, content hashes, mandates, fidelity labels, and automated repair receipts;
it omits private reference locations and execution-transport details.

Full-corpus acquisition requires `LEGISTAR_API_TOKEN`; the token is passed only
to the existing authenticated client and is never written to cache or logs.
The retained-law retry needs no API credential because it uses the public,
source-linked Legistar detail pages already named by the comparison snapshot.
