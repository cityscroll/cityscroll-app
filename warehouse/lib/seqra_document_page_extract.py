"""SEQRA-04: per-page PDF text extraction for CEQR Access review documents.

Sibling to warehouse/lib/attachment_text_extract.py, not a fork of it: that
module flattens a PDF to one text blob for the T1 attachment-search tier and
explicitly puts OCR out of scope. SEQRA-04 needs page-level text (card
acceptance A2 -- "every parsed page resolves to immutable stored source
bytes") because a technical-topic citation has to point at one page, not "the
document." This module keeps the same pypdf-when-available / honest-skip
convention rather than introducing a second PDF dependency choice.

Real OCR (an image-only/scanned page with no text layer) is not wired in this
card: no OCR engine (tesseract or otherwise) exists anywhere in this
repository's dependency set yet. A page whose text layer is empty is reported
`ocr_required: true, ocr_attempted: false` -- a later card can wire an engine
without changing this module's page contract.
"""

from __future__ import annotations

import io
import json
import re
from typing import Any

MAX_CHARS_PER_PAGE = 50_000


def _clean(text: str, max_chars: int = MAX_CHARS_PER_PAGE) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[^\S\n]+", " ", text).strip()
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "…"


def extract_pdf_pages(data: bytes) -> dict[str, Any]:
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        return {"status": "skipped", "reason": "pdf_lib_unavailable", "pages": []}

    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001 — bounded extractor; stamp failure
        return {"status": "extract_failed", "reason": f"pdf_open_error:{type(exc).__name__}", "pages": []}

    pages: list[dict[str, Any]] = []
    for index, page in enumerate(reader.pages):
        page_number = index + 1
        try:
            raw_text = page.extract_text() or ""
        except Exception as exc:  # noqa: BLE001
            pages.append({
                "page_number": page_number,
                "status": "extract_failed",
                "reason": f"page_error:{type(exc).__name__}",
                "text": "",
                "ocr_required": True,
                "ocr_attempted": False,
            })
            continue
        text = _clean(raw_text)
        has_text_layer = bool(text)
        pages.append({
            "page_number": page_number,
            "status": "ok" if has_text_layer else "extract_failed",
            "reason": None if has_text_layer else "empty_text_layer",
            "text": text,
            "ocr_required": not has_text_layer,
            "ocr_attempted": False,
        })

    if not pages:
        return {"status": "extract_failed", "reason": "pdf_no_pages", "pages": []}
    return {"status": "ok", "reason": None, "pages": pages, "method": "pdf_text_layer_per_page"}


if __name__ == "__main__":
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="Extract per-page plain text from one CEQR Access PDF")
    parser.add_argument("path", nargs="?", help="Path to a PDF file; reads stdin when omitted")
    args = parser.parse_args()
    if args.path:
        with open(args.path, "rb") as handle:
            payload = handle.read()
    else:
        payload = sys.stdin.buffer.read()
    print(json.dumps(extract_pdf_pages(payload)))
