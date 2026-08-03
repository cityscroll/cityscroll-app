"""Binary → plain text extractors for T1 attachment inline text.

docx: stdlib zipfile + XML (no third-party dependency).
pdf:  pypdf when installed (warehouse requirements); honest skip otherwise.
doc:  legacy OLE — not extracted at T1 (no antiword); caller stamps skip.
Images / OCR are out of scope for this tier.
"""

from __future__ import annotations

import io
import re
import zipfile
from typing import Any
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
MAX_CHARS = 50_000


def _clean(text: str, max_chars: int = MAX_CHARS) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[^\S\n]+", " ", text).strip()
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "…"


def extract_docx_bytes(data: bytes) -> dict[str, Any]:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            try:
                xml = archive.read("word/document.xml")
            except KeyError:
                return {"status": "extract_failed", "reason": "docx_missing_document_xml", "text": ""}
    except zipfile.BadZipFile:
        return {"status": "extract_failed", "reason": "docx_not_zip", "text": ""}

    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return {"status": "extract_failed", "reason": "docx_xml_parse_error", "text": ""}

    paragraphs: list[str] = []
    for para in root.iter(f"{{{W_NS}}}p"):
        parts = [node.text or "" for node in para.iter(f"{{{W_NS}}}t")]
        line = "".join(parts).strip()
        if line:
            paragraphs.append(line)
    text = _clean("\n".join(paragraphs))
    if not text:
        return {"status": "extract_failed", "reason": "docx_empty_text", "text": ""}
    return {"status": "ok", "reason": None, "text": text, "method": "docx_xml"}


def extract_pdf_bytes(data: bytes) -> dict[str, Any]:
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        return {"status": "skipped", "reason": "pdf_lib_unavailable", "text": ""}

    try:
        reader = PdfReader(io.BytesIO(data))
        pages: list[str] = []
        for page in reader.pages:
            try:
                pages.append(page.extract_text() or "")
            except Exception:
                continue
        text = _clean("\n".join(pages))
    except Exception as exc:  # noqa: BLE001 — bounded extractor; stamp failure
        return {"status": "extract_failed", "reason": f"pdf_error:{type(exc).__name__}", "text": ""}

    if not text:
        return {"status": "extract_failed", "reason": "pdf_empty_text", "text": ""}
    return {"status": "ok", "reason": None, "text": text, "method": "pdf_text"}


def extract_bytes(data: bytes, kind: str | None) -> dict[str, Any]:
    """kind: docx | pdf | doc | unknown_high_value | None"""
    if not data:
        return {"status": "extract_failed", "reason": "empty_body", "text": ""}
    if len(data) > 5_000_000:
        return {"status": "skipped", "reason": "too_large", "text": ""}

    kind = (kind or "").lower()
    # Sniff OOXML / PDF magic when class is unknown.
    if kind in ("", "unknown_high_value", None):
        if data[:2] == b"PK":
            kind = "docx"
        elif data[:4] == b"%PDF":
            kind = "pdf"
        elif data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
            kind = "doc"

    if kind == "docx":
        return extract_docx_bytes(data)
    if kind == "pdf":
        return extract_pdf_bytes(data)
    if kind == "doc":
        return {"status": "skipped", "reason": "legacy_doc_unsupported", "text": ""}
    return {"status": "skipped", "reason": "not_text_class", "text": ""}


if __name__ == "__main__":
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(description="Extract plain text from one office attachment")
    parser.add_argument("path", nargs="?", help="Path to binary; reads stdin when omitted")
    parser.add_argument("--kind", default="", help="docx|pdf|doc|unknown_high_value")
    args = parser.parse_args()
    if args.path:
        with open(args.path, "rb") as handle:
            payload = handle.read()
    else:
        payload = sys.stdin.buffer.read()
    print(json.dumps(extract_bytes(payload, args.kind or None)))
