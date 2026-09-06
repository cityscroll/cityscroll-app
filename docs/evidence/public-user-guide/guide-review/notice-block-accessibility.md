# Accessibility proof for the correction and dated-example block

`capture-manifest.json` in this directory records every published guide document
as it ships with this change: unchanged, byte for byte, at both review widths.

That leaves one thing it cannot cover. The change also adds a notice block — the
`Correction:` and `About this example:` lines an editor uses to answer a finding
in place, rather than pulling an article or deleting a useful dated example. No
published article carries either field yet, so the block renders on no page in
the shipped manifest and could not be exercised there.

It was exercised separately. A local render added both fields to the published
tutorial, rebuilt the guide documents, and ran the same capture. The rendered
state was then discarded; nothing about it is committed. The point of recording
it here is that the markup and styling this change introduces have been through
the accessibility checks before an editor can reach for them.

## What ran

The full `tools/capture_guide_release.py` pass at repository revision
`8bf1a28c9c863c68841a63190faf6a5d898517ed`, with a `correction` and a
`historical_note` on the tutorial: 42 captures and 8 journeys, all assertions
holding.

## The tutorial page with both notices rendered

| Viewport | Width | axe critical or serious | Horizontal overflow | Overflow at 200% zoom | Targets below 24px | Links reached by keyboard | Links without a focus indicator |
| --- | --- | --- | --- | --- | --- | --- | --- |
| mobile | 390 | 0 | 0px | 0px | 0 | 9 of 9 | 0 |
| desktop | 1440 | 0 | 0px | 0px | 0 | 9 of 9 | 0 |

Rendered content was identical at both widths
(`content_sha256` `756d4f08a6c854342328517aa02e45bd5f77900202f5b4fe05fea17b4c989a17`),
and both scripted and JavaScript-disabled journeys held, including browser Back.

Per `docs/capture-manifest-guard.md` no image is committed. The screenshots
stayed under the ignored `.artifacts/guide-review-notice/` path; their sha256 is
the retained proof:

| Capture | sha256 |
| --- | --- |
| tutorial with notices, 390 | `3fe6fae019d4a7fe057f17198dd4c245e889c748030c759a425da2cc289331d5` |
| tutorial with notices, 1440 | `90da981fef1846fd774f0d15c300843206c277603b87acfdd17e90ccda1278b1` |

## Reproducing it

Add a `correction:` and a matching `historical_note:` with `historical_demos:`
to a guide article source, then:

```sh
node tools/build_guide_documents.mjs
python3 tools/capture_guide_release.py \
  --record cityscroll-engineering/guide-review-lane \
  --manifest <a path outside the tracked evidence tree> \
  --output-dir .artifacts/guide-review-notice
```

Then restore the article source and rebuild, so the tracked documents match
their sources again.

## What this does not claim

The notice block has not been read by a person using a screen reader, and no
editor has yet written a real correction. This records that the markup is a
labelled `aside` that survives the automated checks at both widths — not that
the wording of a future correction will be clear.
