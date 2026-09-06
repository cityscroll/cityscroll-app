#!/usr/bin/env python3
"""Run the site's own content gates against the published guide pages.

The page-metadata, descriptive-link-text and heading-punctuation gates ship as a
reusable package whose default page list is the seven long-standing top-level
documents. The guide adds public reader pages that are generated rather than
hand-written, so this points the same three checks at whatever
tools/build_guide_documents.mjs currently writes instead of maintaining a second
set of rules for them.
"""
from __future__ import annotations

import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_PKG = _REPO / "civic-content-gates"
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

from civic_content_gates import heading_punctuation, link_text, page_metadata  # noqa: E402

SITE = _REPO / "site"
GUIDE = SITE / "guide"


def guide_pages() -> list[str]:
    return sorted(str(path.relative_to(SITE)) for path in GUIDE.rglob("index.html"))


def main() -> int:
    pages = guide_pages()
    if not pages:
        print("FAIL guide content: no guide documents found — run node tools/build_guide_documents.mjs")
        return 1

    failures: list[str] = []
    failures += page_metadata.check(SITE, pages=pages)
    failures += [f"{page}: generic link text {text!r}" for page, text in link_text.check(SITE, pages=pages)]
    failures += heading_punctuation.check(SITE, pages=pages)

    for failure in failures:
        print(f"FAIL {failure}")
    if failures:
        return 1
    print(f"OK guide content: metadata, link text and headings on {len(pages)} guide pages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
