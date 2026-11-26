"""SEQRA-04: per-page PDF text extraction for CEQR Access & procurement documents.

Sibling to warehouse/lib/attachment_text_extract.py, not a fork of it: that
module flattens a PDF to one text blob for the T1 attachment-search tier and
explicitly puts OCR out of scope. This module emits page-level text so every
technical or procurement citation points to an exact 1-based page number.

Extraction order:
1. Prefer `pdftotext -layout` (poppler) when installed — ~9x faster than pure
   Python, eliminates mid-word kerning splits ("Comm ercial", "Novem ber"),
   and preserves table columns and real statute/compound hyphens ("6-129").
2. Fall back to `pypdf` when `pdftotext` is unavailable; return an honest
   `status: "skipped", reason: "pdf_lib_unavailable"` when neither is present.
3. Inspect embedded `/XObject` `/Image` entries via `pypdf` (when available)
   so image-only attachment pages that carry only a short text header (e.g.
   "Attachment A" + full-page raster image) are flagged `ocr_required: true`.
"""

from __future__ import annotations

import importlib.metadata
import io
import json
import re
import shutil
import subprocess
from typing import Any

MAX_CHARS_PER_PAGE = 50_000

PUA_GLYPH_MAP = str.maketrans({
    "\uf0b7": "•",
    "\uf0a7": "•",
    "\uf06c": "•",
    "\uf075": "•",
    "\uf0b0": "•",
    "\uf0d8": "▸",
    "\uf0fc": "✓",
    "\uf0a8": "☐",
    "\uf0fe": "☒",
    "\u2010": "-",
    "\u2011": "-",
    "\u2212": "-",
    "\u00a0": " ",
    "\u2007": " ",
    "\u2009": " ",
    "\u202f": " ",
})

STRIP_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u00ad\ufeff\u200b-\u200d]")


def _clean(text: str, max_chars: int = MAX_CHARS_PER_PAGE) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.translate(PUA_GLYPH_MAP)
    text = STRIP_CONTROL_RE.sub("", text)
    lines = [re.sub(r"[^\S\n]+", " ", line).strip() for line in text.split("\n")]
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "…"


def _detect_pdftotext_library() -> str | None:
    if not shutil.which("pdftotext"):
        return None
    try:
        proc = subprocess.run(
            ["pdftotext", "-v"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=5,
        )
        banner = (proc.stderr or proc.stdout or b"").decode("utf-8", errors="replace")
        match = re.search(r"version\s+([0-9][0-9.\-a-zA-Z]*)", banner)
        if match:
            return f"pdftotext {match.group(1)}"
    except Exception:  # noqa: BLE001
        pass
    return "pdftotext"


def detect_pdf_library() -> str:
    """Return the exact library identifier used by extract_pdf_pages."""
    pft = _detect_pdftotext_library()
    if pft:
        return pft
    try:
        import pypdf  # noqa: F401
    except ImportError:
        return "unavailable"
    try:
        return f"pypdf {importlib.metadata.version('pypdf')}"
    except importlib.metadata.PackageNotFoundError:
        return "pypdf unknown"


def _inspect_image_pages(data: bytes) -> dict[int, int]:
    """Count significant raster XObject images (>=50x50px) per 1-based page."""
    try:
        import logging
        from pypdf import PdfReader  # type: ignore
        logging.getLogger("pypdf").setLevel(logging.ERROR)
    except ImportError:
        return _inspect_image_pages_via_pdfimages(data)
    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception:  # noqa: BLE001
        return {}
    counts: dict[int, int] = {}
    for pno, page in enumerate(reader.pages, 1):
        img_count = 0
        try:
            res = page.get("/Resources")
            xobjs = res.get_object().get("/XObject") if res else None
            if xobjs:
                for obj in xobjs.get_object().values():
                    resolved = obj.get_object()
                    if resolved.get("/Subtype") == "/Image":
                        w = int(resolved.get("/Width", 0) or 0)
                        h = int(resolved.get("/Height", 0) or 0)
                        if w >= 50 and h >= 50:
                            img_count += 1
        except Exception:  # noqa: BLE001
            img_count = 0
        if img_count > 0:
            counts[pno] = img_count
    return counts


def _inspect_image_pages_via_pdfimages(data: bytes) -> dict[int, int]:
    if not shutil.which("pdfimages"):
        return {}
    import tempfile
    import os
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tf:
            tf.write(data)
            tmp_path = tf.name
        proc = subprocess.run(
            ["pdfimages", "-list", tmp_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=15,
        )
        if proc.returncode != 0:
            return {}
        counts: dict[int, int] = {}
        for line in proc.stdout.decode("utf-8", errors="replace").splitlines()[2:]:
            parts = line.split()
            if len(parts) >= 5 and parts[0].isdigit() and parts[2] == "image":
                pno = int(parts[0])
                w = int(parts[3]) if parts[3].isdigit() else 0
                h = int(parts[4]) if parts[4].isdigit() else 0
                if w >= 50 and h >= 50:
                    counts[pno] = counts.get(pno, 0) + 1
        return counts
    except Exception:  # noqa: BLE001
        return {}
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _extract_via_pdftotext(data: bytes) -> tuple[str, list[str]] | None:
    pdf_library = _detect_pdftotext_library()
    if not pdf_library:
        return None
    try:
        proc = subprocess.run(
            ["pdftotext", "-layout", "-", "-"],
            input=data,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=30,
        )
    except Exception:  # noqa: BLE001
        return None
    if proc.returncode != 0:
        return None
    raw = proc.stdout.decode("utf-8", errors="replace")
    parts = raw.split("\x0c")
    if parts and parts[-1].strip() == "":
        parts = parts[:-1]
    if not parts:
        return None
    return pdf_library, parts


def _build_page_entry(page_number: int, text: str, image_count: int) -> dict[str, Any]:
    has_text = bool(text)
    image_only_header = image_count > 0 and len(text) < 100
    ocr_required = (not has_text) or image_only_header
    reason = None
    if not has_text:
        reason = "empty_text_layer"
    elif image_only_header:
        reason = "image_attachment_with_header_only"
    return {
        "page_number": page_number,
        "status": "ok" if has_text else "extract_failed",
        "reason": reason,
        "text": text,
        "ocr_required": ocr_required,
        "ocr_attempted": False,
    }


def extract_pdf_pages(data: bytes) -> dict[str, Any]:
    images_by_page = _inspect_image_pages(data)

    pft = _extract_via_pdftotext(data)
    if pft is not None:
        pdf_library, raw_pages = pft
        pages = [
            _build_page_entry(idx, _clean(raw_text), images_by_page.get(idx, 0))
            for idx, raw_text in enumerate(raw_pages, 1)
        ]
        return {
            "status": "ok",
            "reason": None,
            "pages": pages,
            "method": "pdf_text_layer_per_page",
            "pdf_library": pdf_library,
        }

    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        return {"status": "skipped", "reason": "pdf_lib_unavailable", "pages": [], "pdf_library": "unavailable"}

    try:
        pdf_library = f"pypdf {importlib.metadata.version('pypdf')}"
    except importlib.metadata.PackageNotFoundError:
        pdf_library = "pypdf unknown"

    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001 — bounded extractor; stamp failure
        return {"status": "extract_failed", "reason": f"pdf_open_error:{type(exc).__name__}", "pages": [], "pdf_library": pdf_library}

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
        pages.append(_build_page_entry(page_number, text, images_by_page.get(page_number, 0)))

    if not pages:
        return {"status": "extract_failed", "reason": "pdf_no_pages", "pages": [], "pdf_library": pdf_library}
    return {"status": "ok", "reason": None, "pages": pages, "method": "pdf_text_layer_per_page", "pdf_library": pdf_library}


if __name__ == "__main__":
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="Extract per-page plain text from one PDF")
    parser.add_argument("--version", action="store_true", help="Print the active PDF extraction library identifier")
    parser.add_argument("path", nargs="?", help="Path to a PDF file; reads stdin when omitted")
    args = parser.parse_args()
    if args.version:
        print(detect_pdf_library())
        sys.exit(0)
    if args.path:
        with open(args.path, "rb") as handle:
            payload = handle.read()
    else:
        payload = sys.stdin.buffer.read()
    print(json.dumps(extract_pdf_pages(payload)))
