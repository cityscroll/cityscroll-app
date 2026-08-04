"""Binary → structured table extractors for T2 attachment tables.

docx: native Word table XML (w:tbl / w:tr / w:tc) via stdlib zipfile.
pdf:  text-layer row recovery only (pypdf when installed). No OCR, no layout
      model. PDF "tables" are recovered only when consecutive lines share a
      multi-column whitespace pattern; otherwise stamp an honest miss.
doc:  legacy OLE unsupported (same as T1).
"""

from __future__ import annotations

import io
import re
import zipfile
from typing import Any
from xml.etree import ElementTree as ET

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
MAX_TABLES = 25
MAX_ROWS = 200
MAX_COLS = 40
MAX_CELL_CHARS = 500
MAX_BYTES = 5_000_000


def _cell_text(node: ET.Element) -> str:
    parts = [t.text or "" for t in node.iter(f"{{{W_NS}}}t")]
    text = re.sub(r"\s+", " ", "".join(parts)).strip()
    if len(text) > MAX_CELL_CHARS:
        return text[: MAX_CELL_CHARS - 1].rstrip() + "…"
    return text


def extract_docx_tables(data: bytes) -> dict[str, Any]:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            try:
                xml = archive.read("word/document.xml")
            except KeyError:
                return {
                    "status": "extract_failed",
                    "reason": "docx_missing_document_xml",
                    "tables": [],
                    "method": None,
                }
    except zipfile.BadZipFile:
        return {
            "status": "extract_failed",
            "reason": "docx_not_zip",
            "tables": [],
            "method": None,
        }

    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return {
            "status": "extract_failed",
            "reason": "docx_xml_parse_error",
            "tables": [],
            "method": None,
        }

    tables: list[dict[str, Any]] = []
    for index, tbl in enumerate(root.iter(f"{{{W_NS}}}tbl")):
        if index >= MAX_TABLES:
            break
        rows: list[list[str]] = []
        for tr in tbl.findall(f"{{{W_NS}}}tr"):
            cells = [_cell_text(tc) for tc in tr.findall(f"{{{W_NS}}}tc")]
            if not cells:
                continue
            if len(cells) > MAX_COLS:
                cells = cells[:MAX_COLS]
            rows.append(cells)
            if len(rows) >= MAX_ROWS:
                break
        if not rows:
            continue
        # Normalize ragged rows to the modal column count (header-led).
        col_count = max(len(row) for row in rows)
        if col_count < 2:
            # Single-column "tables" are almost always layout noise.
            continue
        normalized = [row + [""] * (col_count - len(row)) for row in rows]
        header = normalized[0]
        body = normalized[1:] if len(normalized) > 1 else []
        # Require at least one non-empty header cell or body row with content.
        if not any(header) and not any(any(cell) for cell in body):
            continue
        tables.append(
            {
                "index": len(tables),
                "caption": None,
                "headers": header,
                "rows": body,
                "n_rows": len(body),
                "n_cols": col_count,
                "method": "docx_tbl",
            }
        )

    if not tables:
        return {
            "status": "ok",
            "reason": "no_tables",
            "tables": [],
            "method": "docx_tbl",
        }
    return {
        "status": "ok",
        "reason": None,
        "tables": tables,
        "method": "docx_tbl",
    }


def _split_columns(line: str) -> list[str] | None:
    """Split a text-layer line into columns when a multi-column pattern is present.

    Accepts tab-separated cells or runs of 2+ spaces. Rejects single-column prose.
    """
    raw = line.rstrip()
    if not raw or len(raw) < 3:
        return None
    if "\t" in raw:
        cells = [re.sub(r"\s+", " ", part).strip() for part in raw.split("\t")]
    else:
        cells = [part.strip() for part in re.split(r" {2,}", raw) if part.strip()]
    if len(cells) < 2:
        return None
    if len(cells) > MAX_COLS:
        cells = cells[:MAX_COLS]
    return [c[:MAX_CELL_CHARS] for c in cells]


def extract_pdf_tables(data: bytes) -> dict[str, Any]:
    """Recover table-like row groups from the PDF text layer only.

    Limits (honest):
    - Scanned / image-only PDFs yield empty text → no tables (no OCR at T2).
    - Floating layouts, merged cells, and multi-line cells often fail.
    - Recovery requires consecutive lines that share the same column count.
    """
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        return {
            "status": "skipped",
            "reason": "pdf_lib_unavailable",
            "tables": [],
            "method": None,
        }

    try:
        reader = PdfReader(io.BytesIO(data))
        lines: list[str] = []
        for page in reader.pages:
            try:
                text = page.extract_text() or ""
            except Exception:
                continue
            for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
                stripped = line.strip()
                if stripped:
                    lines.append(stripped)
    except Exception as exc:  # noqa: BLE001 — bounded extractor
        return {
            "status": "extract_failed",
            "reason": f"pdf_error:{type(exc).__name__}",
            "tables": [],
            "method": None,
        }

    if not lines:
        return {
            "status": "ok",
            "reason": "pdf_empty_text_or_image_only",
            "tables": [],
            "method": "pdf_text_layer_rows",
        }

    # Group consecutive multi-column lines that share a column count into tables.
    tables: list[dict[str, Any]] = []
    current: list[list[str]] = []
    current_cols = 0

    def flush() -> None:
        nonlocal current, current_cols
        if len(current) >= 2 and current_cols >= 2 and len(tables) < MAX_TABLES:
            header = current[0]
            body = current[1:MAX_ROWS]
            tables.append(
                {
                    "index": len(tables),
                    "caption": None,
                    "headers": header,
                    "rows": body,
                    "n_rows": len(body),
                    "n_cols": current_cols,
                    "method": "pdf_text_layer_rows",
                }
            )
        current = []
        current_cols = 0

    for line in lines:
        cells = _split_columns(line)
        if not cells:
            flush()
            continue
        if current and len(cells) != current_cols:
            flush()
        if not current:
            current_cols = len(cells)
        current.append(cells)
        if len(current) >= MAX_ROWS:
            flush()
    flush()

    if not tables:
        return {
            "status": "ok",
            "reason": "pdf_table_structure_unrecoverable",
            "tables": [],
            "method": "pdf_text_layer_rows",
        }
    return {
        "status": "ok",
        "reason": None,
        "tables": tables,
        "method": "pdf_text_layer_rows",
    }


def extract_tables_bytes(data: bytes, kind: str | None) -> dict[str, Any]:
    """kind: docx | pdf | doc | unknown_high_value | None"""
    if not data:
        return {
            "status": "extract_failed",
            "reason": "empty_body",
            "tables": [],
            "method": None,
        }
    if len(data) > MAX_BYTES:
        return {
            "status": "skipped",
            "reason": "too_large",
            "tables": [],
            "method": None,
        }

    kind = (kind or "").lower()
    if kind in ("", "unknown_high_value", None):
        if data[:2] == b"PK":
            kind = "docx"
        elif data[:4] == b"%PDF":
            kind = "pdf"
        elif data[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":
            kind = "doc"

    if kind == "docx":
        return extract_docx_tables(data)
    if kind == "pdf":
        return extract_pdf_tables(data)
    if kind == "doc":
        return {
            "status": "skipped",
            "reason": "legacy_doc_unsupported",
            "tables": [],
            "method": None,
        }
    return {
        "status": "skipped",
        "reason": "not_text_class",
        "tables": [],
        "method": None,
    }


if __name__ == "__main__":
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(description="Extract tables from one office attachment")
    parser.add_argument("path", nargs="?", help="Path to binary; reads stdin when omitted")
    parser.add_argument("--kind", default="", help="docx|pdf|doc|unknown_high_value")
    args = parser.parse_args()
    if args.path:
        with open(args.path, "rb") as handle:
            payload = handle.read()
    else:
        payload = sys.stdin.buffer.read()
    print(json.dumps(extract_tables_bytes(payload, args.kind or None)))
