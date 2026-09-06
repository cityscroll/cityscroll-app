# Public guide planning evidence

The planning artifacts behind a public `/guide/` — a set of articles covering
guided practice, doing your own task, understanding a concept, and looking
something up. This directory bounds the first release: which articles exist,
which example each is taught with and how that example was verified, where guide
review joins the review cadence that already exists, and what About and the
entry points looked like before any of it shipped.

No product surface changes here. Everything in this directory is a reviewed
assertion or a reproducible receipt.

| File | What it settles |
| --- | --- |
| [`article-map.md`](article-map.md) | The eighteen articles: id, proposed URL, single primary type, the one reader question, product entry point, the existing content owner, and example ids. Ends with a short later list. |
| [`example-selection-records.md`](example-selection-records.md) | Per-example canonical route, evidence class, observable result, and selection note, plus the check-harness limitation found on the topic-search example. |
| [`worked-example-verification.md`](worked-example-verification.md) | What a reader sees today on the five advanced journeys, and every step that is limited, unavailable, or exercised with a stand-in response instead of a real mutation. |
| [`review-cadence-handoff.md`](review-cadence-handoff.md) | What runs in this repository and how often, why the weekly review is not reachable from here, and the exact interface a guide-review lane needs on each side. |
| [`source-checks.md`](source-checks.md) | Every official publisher and every product claim behind the explanation and reference pages, how each was checked, and the two corrections the check produced. |
| [`ownership-map.md`](ownership-map.md) | For the explanation and reference articles: the owner each one defers to, what it is allowed to say, and what it must never restate. |
| [`capture-manifest.json`](capture-manifest.json) | Baseline of About and five entry points at 390px and 1440px, as hashes and assertions. No image is committed. |
| [`guide-release/capture-manifest.json`](guide-release/capture-manifest.json) | Every published guide document: the reader's journey through the guide, with accessibility, reflow, keyboard, link and no-JavaScript checks at both widths. |

## Reproducing the evidence

```sh
python3 test/standards/demo_links.py
python3 tools/capture_guide_baseline.py
```

The published guide has its own reproduction, which needs no network:

```sh
node tools/build_guide_documents.mjs --check
node --test test/guide_documents.test.mjs
python3 test/standards/guide_content.py
python3 tools/capture_guide_release.py
```

The live example checks and the isolation of the harness limitation are recorded
with their exact commands in
[`example-selection-records.md`](example-selection-records.md#reproduction), and
the live checks behind the advanced journeys in
[`worked-example-verification.md`](worked-example-verification.md#reproduction).

## The capture manifest

`tools/capture_guide_baseline.py` loads each route against the public deploy at
both review widths, asserts one observable per route, and writes the manifest.
Rendered images stay under the ignored `.artifacts/` path; only their `sha256`
is retained here, per `docs/capture-manifest-guard.md`.

Two hashes are recorded per capture because they answer different questions.
`render_structure_sha256` hashes the element skeleton of the main landmark and
is stable across an ordinary civic-data refresh, so a later difference means the
page shell changed. `content_sha256` hashes its rendered markup and is a
point-in-time observation of live records, not a regression baseline.

Two facts in that baseline were load-bearing for the articles that follow: the
homepage carried no guide link, and the calendar subscription control on the
deadlines surface is present but hidden until a scope offers a supported dated
occurrence.

The first of those has since been answered — the homepage now carries a Guide
entry, recorded in
[`guide-release/capture-manifest.json`](guide-release/capture-manifest.json).
The baseline above is left as it was taken; a baseline that is edited to match
what shipped stops being one.
