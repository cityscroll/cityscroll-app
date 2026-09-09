# Guide hardening acceptance

Record: `ccf422a8ff4de`.

Grounded at `05d86cedbd23cb43bb448e1eee4d97fd098b0c60`. The release under review
contains the four merged guide improvements below, the merged award-trail
repair, and this candidate's direct journey evidence and corrections. Candidate
source hashes in the [manifest](capture-manifest.json) identify the tested
changes beyond that revision. This records candidate acceptance, not deployment.

| Required improvement | Merged revision or candidate evidence | Direct journey connection |
| --- | --- | --- |
| Language parity across all 19 articles | [3266851e3](https://github.com/cityscroll/cityscroll-app/commit/3266851e3), checked by the [current coverage receipt](../../guide-language/coverage.json) | Board, calendar, date and collection instructions followed in Spanish, Simplified Chinese and Arabic at both widths. |
| Instructional illustrations | [3f8cfff67](https://github.com/cityscroll/cityscroll-app/commit/3f8cfff67), with per-article source, caption, alt text and capture receipts under `site/media/guide/` | The eight journeys start with the illustrated articles; the builder checks their image dimensions and hashes. |
| Shorter procedures | [aa079631d](https://github.com/cityscroll/cityscroll-app/commit/aa079631d), documented in [compact articles](../compact-articles.md) | Each action is tied to the rendered instructions in the journey receipt. Corrections address missing navigation or mismatched control wording. |
| Concise About | [05d86cedb](https://github.com/cityscroll/cityscroll-app/commit/05d86cedb) | [Product-access checks](product-access.json) retain identity, independence, Guide access and historical anchors at both widths. |
| Direct task evidence | This candidate: [40 journeys and two default-language regressions](capture-manifest.json), [outcomes and findings](journeys.md) | Task state, selected language and guide return position are checked at each journey's end. The named award chain also exercises the repair merged in [6166a32a6](https://github.com/cityscroll/cityscroll-app/commit/6166a32a6). |

A4 passes for the stated matrix: all eight journeys in English at 390 × 844 and
1440 × 900, plus board, calendar, as-of and collection in Spanish, Simplified
Chinese and Arabic at both widths. The two extra browser regressions preserve
the no-language default through As-of Apply, copied-address replay and Clear.
The [92 capture entries](capture-manifest.json) retain route, viewport, revision,
data vintage, assertion and SHA-256; image binaries are not committed.

A7's five required improvements are present together in this candidate. Closing
this increment rests on those improvements and the direct evidence, rather than
on whether a weekly review has run. The independent award-chain evidence remains
in the merged [two-chain receipt](../award-trail/capture-manifest.json).

## Validation

The same existing `CROL_BUILD_DAY` value was used for the primary-document
rebuild, its focused test and prepush. The module inventory and clock policy were
not changed. The generated contracts browse document is ignored; the tracked
guide documents and coverage receipt are regenerated through their owner.

```sh
export CROL_BUILD_DAY=2026-09-08T23:40:59.000Z
node tools/build_primary_documents.mjs
node --test test/primary_document_routes.test.mjs
node --test test/guide_documents.test.mjs test/guide_contextual_access.test.mjs test/route_migration.test.mjs
node --test test/civic_time_ledger_runtime.test.mjs
node tools/build_guide_documents.mjs --check
python3 test/standards/guide_content.py
python3 tools/capture_guide_journeys.py --resume
python3 tools/capture_guide_release.py --site-dir .artifacts/guide-preview --record ccf422a8ff4de --manifest docs/evidence/public-user-guide/literal-journeys/guide-release.json --output-dir .artifacts/guide-journeys/release --note 'Guide document checks supporting the literal journey observations.'
python3 tools/capture_guide_product_access.py --site-dir .artifacts/guide-preview --record ccf422a8ff4de --manifest docs/evidence/public-user-guide/literal-journeys/product-access.json --output-dir .artifacts/guide-journeys/product-access
node tools/build_guide_review.mjs --check
make prepush
```

Validation results are recorded in [validation.json](validation.json).
The resumed capture retained passing scenarios only after verifying the same
candidate product hashes; each row identifies its capture implementation hash.
A fresh run omits `--resume`. [Reproduction inputs](journeys.md#reproduction) name
the retained public responses required by the browser rehearsal.

## Bounded limitations and upkeep

Machine-drafted translation disclosure still awaits native review. English
product labels are quoted where the product itself uses English. Calendar-app
import and refresh, watch email delivery and management links are external to
these rehearsals; no watch, email or public share was created. The Arabic phone
calendar panel clips some explanatory content even though copying its URL
succeeds. The independent URL builders and the non-reproduced directory-search
observation are listed precisely in [journey findings](journeys.md).

The existing guide-review input now includes dependencies on the changed date,
collection, calendar and connection owners. A successful housing demonstration
result and the changed paths were supplied to the existing report builder and
weekly-review section renderer. The [input receipt](review-input.json) records
those inputs and output hashes. It carries the evidence for continued wording,
translation and example upkeep without adding a scheduler, claiming external
consumption, or making that consumption a closing condition.

## Default-language footer compatibility

The footer retains exactly `#investigation` when no language or English is
selected, including after switching back from Spanish, Simplified Chinese or
Arabic. Non-default languages still receive a URL carrying the selected
language. This preserves the existing in-page link contract; the external-link
functional test remains unchanged.

The original journey captures retain their recorded source hashes. This bounded
compatibility correction is covered by the expanded runtime regression and the
complete routes-focus shard, with source hashes and command results recorded in
[validation.json](validation.json).
