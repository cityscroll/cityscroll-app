#!/usr/bin/env python3
"""Build per-section extracted text shards for a published procurement document shard.

Deterministic, zero-LLM extraction:
- Verifies input PDF bytes match the document row's recorded SHA-256.
- Extracts page-level UTF-8 text via `pdftotext` (poppler) when available,
  falling back to `pypdf`, and records the exact extractor used.
- Reads embedded PDF outline bookmarks via `pypdf` when present (for large
  reference schedules such as the Comptroller's Prevailing Wage Schedule).
- Emits one compact index (`procurement_documents/rfx-<id>/sections.json`)
  and one lazy-fetchable shard per section
  (`procurement_documents/rfx-<id>/sections/<section-id>.json`).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

INDEX_SCHEMA = "cityscroll.procurement_document_section_text_index.v1"
SHARD_SCHEMA = "cityscroll.procurement_document_section_text.v1"
MAX_CHARS_PER_PAGE = 50_000

SECTION_SCOPE_BY_ID = {
    "cover": "bid_specific",
    "schedule-a-reference": "bid_specific",
    "schedule-a-insurance": "bid_specific",
    "insurance-certificates": "standard_form",
    "notice-vendex-fee": "standard_notice",
    "notice-subcontractor-reporting": "standard_notice",
    "mwbe-notice": "standard_notice",
    "notices-whistleblower-doi": "standard_notice",
    "essta-rider": "standard_rider",
    "bid-book": "mixed_bid_and_terms",
    "general-specifications": "bid_specific",
    "agreement": "standard_contract",
    "prevailing-wage-schedule": "reference_schedule",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def clean_page_text(text: str, *, collapse_inline_spaces: bool = False) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    if collapse_inline_spaces:
        text = re.sub(r"[^\S\n]+", " ", text)
    text = text.strip()
    if len(text) > MAX_CHARS_PER_PAGE:
        text = text[:MAX_CHARS_PER_PAGE].rstrip() + "…"
    return text


def extract_pages_pdftotext(pdf_path: Path) -> tuple[str, list[dict[str, Any]]]:
    raw = subprocess.check_output(
        ["pdftotext", str(pdf_path), "-"],
        text=True,
        errors="replace",
    )
    parts = raw.split("\x0c")
    if parts and parts[-1].strip() == "":
        parts = parts[:-1]
    pages = []
    for idx, part in enumerate(parts, 1):
        txt = clean_page_text(part, collapse_inline_spaces=False)
        pages.append({"pdf_page": idx, "text": txt, "chars": len(txt)})
    return "pdftotext (poppler)", pages


def extract_pages_pypdf(pdf_path: Path) -> tuple[str, list[dict[str, Any]]]:
    from pypdf import PdfReader  # type: ignore
    import importlib.metadata

    try:
        ver = importlib.metadata.version("pypdf")
    except importlib.metadata.PackageNotFoundError:
        ver = "unknown"
    reader = PdfReader(str(pdf_path))
    pages = []
    for idx, page in enumerate(reader.pages, 1):
        txt = clean_page_text(page.extract_text() or "", collapse_inline_spaces=True)
        pages.append({"pdf_page": idx, "text": txt, "chars": len(txt)})
    return f"pypdf {ver}", pages


def extract_outline_bookmarks(pdf_path: Path) -> list[dict[str, Any]]:
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        return []
    reader = PdfReader(str(pdf_path))
    bookmarks: list[dict[str, Any]] = []

    def walk(items: Any) -> None:
        for item in items:
            if isinstance(item, list):
                walk(item)
            else:
                title = re.sub(r"\s+", " ", str(getattr(item, "title", item))).strip()
                try:
                    page_num = reader.get_destination_page_number(item) + 1
                except Exception:  # noqa: BLE001
                    page_num = None
                if title and page_num is not None:
                    bookmarks.append({"title": title, "pdf_page": page_num})

    try:
        walk(reader.outline)
    except Exception:  # noqa: BLE001
        return []
    return bookmarks


def build_section_jumps(
    section: dict[str, Any],
    sec_pages: list[dict[str, Any]],
    bookmarks: list[dict[str, Any]],
    anticipated_trades: list[str],
) -> list[dict[str, Any]]:
    p0, p1 = section["pdf_pages"]
    sec_bookmarks = [b for b in bookmarks if p0 <= b["pdf_page"] <= p1]
    jumps: list[dict[str, Any]] = []
    seen: set[tuple[int, str]] = set()

    if sec_bookmarks:
        # Promote bookmarks matching anticipated trades extracted from Schedule A.
        normalized_trades = [t.lower().strip() for t in anticipated_trades if t.strip()]
        highlighted = []
        rest = []
        for bm in sec_bookmarks:
            title_l = bm["title"].lower()
            is_trade_match = any(
                (t == "field engineer" and "engineer - field" in title_l and "building" in title_l)
                or (t != "field engineer" and title_l == t)
                for t in normalized_trades
            )
            entry = {
                "label": bm["title"].title(),
                "pdf_page": bm["pdf_page"],
                "highlight": is_trade_match,
            }
            key = (entry["pdf_page"], entry["label"].lower())
            if key in seen:
                continue
            seen.add(key)
            if is_trade_match:
                highlighted.append(entry)
            else:
                rest.append(entry)
        return (highlighted + rest)[:90]

    for pg in sec_pages:
        pno = pg["pdf_page"]
        lines = [line.strip() for line in pg["text"].splitlines() if line.strip()]
        for i, line in enumerate(lines):
            if (
                len(line) > 58
                or line.endswith(",")
                or " of the " in line
                or " sets forth " in line
                or " below," in line
            ):
                continue
            is_heading = bool(
                re.match(
                    r"^(ARTICLE\s+[IVX\d]+\.?|PART\s+[IVX]+(?:\s*[-–]\s*[A-Z])?|PART\s+[A-C]\b|SECTION\s+\d+\.?|APPENDIX\s+[A-Z]\b)\s*$",
                    line,
                    re.I,
                )
                or re.match(
                    r"^(ARTICLE\s+[IVX\d]+\.?|PART\s+[IVX]+(?:\s*[-–]\s*[A-Z])?|SECTION\s+\d+\.?)\s+[A-Z0-9\s\-\/&(),]+$",
                    line,
                )
            )
            if not is_heading:
                continue
            lbl = line
            if len(lbl) < 16 and i + 1 < len(lines) and len(lines[i + 1]) < 56 and lines[i + 1].isupper():
                lbl = f"{lbl} — {lines[i + 1]}"
            lbl = re.sub(r"\s+", " ", lbl)[:60]
            key = (pno, lbl.lower())
            if key not in seen:
                seen.add(key)
                jumps.append({"label": lbl, "pdf_page": pno, "highlight": False})

    return jumps[:40]


def scope_class_for(section: dict[str, Any]) -> str:
    sid = str(section.get("id") or "")
    if sid in SECTION_SCOPE_BY_ID:
        return SECTION_SCOPE_BY_ID[sid]
    p0, p1 = section["pdf_pages"]
    if p1 - p0 + 1 >= 40:
        return "reference_schedule"
    if section.get("standing") == "proposed":
        return "standard_contract"
    return "solicitation_section"


def build_section_text_publication(
    *,
    shard_path: Path,
    pdf_path: Path,
    document_id: str | None,
    out_dir: Path,
    generated_at: str | None = None,
    prefer_pypdf: bool = False,
) -> dict[str, Any]:
    shard = json.loads(shard_path.read_text(encoding="utf-8"))
    rfp_id = str(shard["subject"]["rfp_id"])
    rows = shard.get("rows") or []
    candidates = [r for r in rows if (r.get("sections") or [])]
    if document_id:
        candidates = [r for r in rows if str(r.get("document_id")) == str(document_id)]
    if len(candidates) != 1:
        raise ValueError(f"Expected 1 sectioned document row, found {len(candidates)}")
    doc = candidates[0]

    pdf_bytes = pdf_path.read_bytes()
    actual_sha = sha256_bytes(pdf_bytes)
    expected_sha = str(doc.get("sha256") or "")
    if expected_sha and actual_sha != expected_sha:
        raise ValueError(
            f"PDF sha256 mismatch for document {doc['document_id']}: expected {expected_sha}, got {actual_sha}"
        )

    if not prefer_pypdf and shutil.which("pdftotext"):
        extractor_name, all_pages = extract_pages_pdftotext(pdf_path)
    else:
        extractor_name, all_pages = extract_pages_pypdf(pdf_path)

    expected_pages = int(doc.get("page_count") or len(all_pages))
    if len(all_pages) != expected_pages:
        raise ValueError(f"Extracted {len(all_pages)} pages, expected {expected_pages}")

    bookmarks = extract_outline_bookmarks(pdf_path)
    anticipated_trades: list[str] = []
    for fact in doc.get("facts") or []:
        for trade in fact.get("anticipated_trades") or []:
            if isinstance(trade, str) and trade.strip():
                anticipated_trades.append(trade.strip())

    rfx_rel = Path("procurement_documents") / f"rfx-{rfp_id}"
    sections_dir = out_dir / rfx_rel / "sections"
    sections_dir.mkdir(parents=True, exist_ok=True)

    index_entries = []
    for idx, sec in enumerate(doc["sections"], 1):
        sec_id = str(sec["id"])
        if not re.match(r"^[a-z0-9][a-z0-9-]{0,63}$", sec_id):
            raise ValueError(f"Invalid section id: {sec_id!r}")
        p0, p1 = int(sec["pdf_pages"][0]), int(sec["pdf_pages"][1])
        if p0 < 1 or p1 < p0 or p1 > len(all_pages):
            raise ValueError(f"Section {sec_id} page range {[p0, p1]} out of bounds 1..{len(all_pages)}")
        sec_pages = all_pages[p0 - 1 : p1]
        scope_cls = scope_class_for(sec)
        jumps = build_section_jumps(sec, sec_pages, bookmarks, anticipated_trades)

        shard_obj = {
            "schema": SHARD_SCHEMA,
            "rfp_id": rfp_id,
            "document_id": str(doc["document_id"]),
            "document_label": str(doc["label"]),
            "document_sha256": actual_sha,
            "official_url": str(doc["official_url"]),
            "extractor": extractor_name,
            "section": {
                "id": sec_id,
                "index": idx,
                "label": str(sec["label"]),
                "roles": list(sec.get("roles") or []),
                "standing": str(sec.get("standing") or "solicitation"),
                "scope_class": scope_cls,
                "pdf_pages": [p0, p1],
                "anchor": str(sec.get("anchor") or ""),
            },
            "jumps": jumps,
            "pages": [
                {
                    "pdf_page": pg["pdf_page"],
                    "text": pg["text"],
                    "chars": pg["chars"],
                    "sha256": sha256_bytes(pg["text"].encode("utf-8")),
                    "ocr_required": pg["chars"] == 0,
                }
                for pg in sec_pages
            ],
        }
        shard_bytes = (json.dumps(shard_obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        rel_path = f"procurement_documents/rfx-{rfp_id}/sections/{sec_id}.json"
        dest_file = out_dir / rel_path
        dest_file.write_bytes(shard_bytes)

        index_entries.append(
            {
                "id": sec_id,
                "index": idx,
                "label": str(sec["label"]),
                "scope_class": scope_cls,
                "pdf_pages": [p0, p1],
                "page_count": p1 - p0 + 1,
                "path": rel_path,
                "bytes": len(shard_bytes),
                "sha256": sha256_bytes(shard_bytes),
            }
        )

    stamp = generated_at or str(shard["subject"].get("observed_at") or "").replace("+00:00", "Z")
    index_obj = {
        "schema": INDEX_SCHEMA,
        "version": 1,
        "generated_at": stamp,
        "rfp_id": rfp_id,
        "document_id": str(doc["document_id"]),
        "document_label": str(doc["label"]),
        "document_sha256": actual_sha,
        "official_url": str(doc["official_url"]),
        "extractor": extractor_name,
        "sections": index_entries,
    }
    index_bytes = (json.dumps(index_obj, ensure_ascii=False, indent=1) + "\n").encode("utf-8")
    index_path = out_dir / rfx_rel / "sections.json"
    index_path.write_bytes(index_bytes)
    return {
        "index_path": str(index_path),
        "sections_count": len(index_entries),
        "total_bytes": sum(e["bytes"] for e in index_entries),
        "extractor": extractor_name,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Build per-section extracted text shards for a procurement document.")
    parser.add_argument("--shard", required=True, type=Path, help="Path to rfx-<id>.json shard")
    parser.add_argument("--pdf", required=True, type=Path, help="Path to source PDF")
    parser.add_argument("--document-id", default=None, help="Document ID within the shard")
    parser.add_argument("--out-dir", required=True, type=Path, help="Output site/data directory")
    parser.add_argument("--generated-at", default=None, help="Optional ISO-8601 UTC timestamp")
    parser.add_argument("--prefer-pypdf", action="store_true", help="Force pypdf instead of pdftotext")
    args = parser.parse_args(argv)

    result = build_section_text_publication(
        shard_path=args.shard,
        pdf_path=args.pdf,
        document_id=args.document_id,
        out_dir=args.out_dir,
        generated_at=args.generated_at,
        prefer_pypdf=args.prefer_pypdf,
    )
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
