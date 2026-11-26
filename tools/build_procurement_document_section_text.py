#!/usr/bin/env python3
"""Build per-section extracted text shards for a published procurement document shard.

Deterministic, zero-LLM extraction:
- Verifies input PDF bytes match the document row's recorded SHA-256.
- Extracts page-level UTF-8 text via `pdftotext -layout` (poppler) when available,
  falling back to `pypdf`, so table columns, single-line headings, and legal
  statute/compound hyphens (`Section 6-129`, `minority-owned`, `NON-RESPONSIVE`)
  are preserved accurately.
- Detects scanned/image-only pages (e.g. Attachment A/B pages containing an
  embedded raster image with minimal header text) and flags `ocr_required: true`.
- Strips repeated running headers/footers (hoisted once to shard metadata),
  normalizes legacy Word PUA glyphs, preserves tabular column layout on
  Schedule A & Prevailing Wage schedules, and reflows narrative prose cleanly.
- Indexes clean structural headings and non-root PDF outline bookmarks.
"""

from __future__ import annotations

import argparse
from collections import Counter
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

# Map legacy Word Symbol / Wingdings Private-Use-Area glyphs and non-standard
# punctuation to clean standard Unicode so browsers never render tofu boxes.
PUA_GLYPH_MAP = str.maketrans({
    "\uf0b7": "•",
    "\uf0a7": "•",
    "\uf06c": "•",
    "\uf075": "•",
    "\uf0b0": "•",
    "\uf0d8": "▸",
    "\uf0de": "▸",
    "\uf0e0": "▸",
    "\uf0fc": "✓",
    "\uf050": "✓",
    "\uf0a8": "☐",
    "\uf06f": "☐",
    "\uf0fe": "☒",
    "\uf0fd": "☒",
    "\u2010": "-",
    "\u2011": "-",
    "\u2212": "-",
    "\u00a0": " ",
    "\u2007": " ",
    "\u2009": " ",
    "\u202f": " ",
    "\u25aa": "•",
})

STRIP_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u00ad\ufeff\u200b-\u200d]")
UNMAPPED_PUA_RE = re.compile(r"[\ue000-\uf8ff\ufffd]")
DOT_LEADER_RE = re.compile(r"(?:\s*\.){5,}\s*")
LIST_OR_HEADING_START_RE = re.compile(
    r"^(?:[•▪▸✓☐☒\-]|(?:\(?[0-9]{1,3}|[A-Za-z]|[ivxlcdmIVXLCDM]{1,5})[.)]\s|"
    r"(?:ARTICLE|SECTION|PART|SCHEDULE|APPENDIX|ITEM|NOTE|PIN\s*#)\b)"
)

# Prefixes that form real hyphenated compounds in NYC legal/procurement prose;
# never drop their hyphens when unwrapping a line break.
KEEP_HYPHEN_PREFIXES = frozenset({
    "anti", "auto", "by", "city", "co", "cross", "day", "e", "ex", "first",
    "five", "follow", "four", "full", "high", "in", "inter", "long", "low",
    "mid", "minority", "multi", "non", "off", "on", "one", "out", "over",
    "part", "post", "pre", "re", "record", "second", "self", "semi", "short",
    "six", "state", "sub", "ten", "third", "three", "time", "two", "under",
    "up", "well", "women", "work", "year",
})

TABULAR_SECTION_IDS = frozenset({
    "schedule-a-reference",
    "schedule-a-insurance",
    "prevailing-wage-schedule",
})

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


def normalize_pdf_glyphs(text: str, *, preserve_layout: bool = False) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.translate(PUA_GLYPH_MAP)
    text = STRIP_CONTROL_RE.sub("", text)
    text = UNMAPPED_PUA_RE.sub("", text)
    text = re.sub(r"([☒☐])(?=[A-Za-z0-9_])", r"\1 ", text)
    text = DOT_LEADER_RE.sub(" — ", text)
    text = re.sub(r"\(\s*\n+\s*([■□☒☐])\)", r"(\1)", text)
    if not preserve_layout:
        text = re.sub(r"(?m)^[ \t]*([•▸])\s*\n+[ \t]*(?=\S)", r"\1 ", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip("\n")


def dedent_layout_page(text: str) -> str:
    """Trim uniform left margin from a -layout page while keeping table columns aligned."""
    lines = text.splitlines()
    non_empty = [line for line in lines if line.strip()]
    if not non_empty:
        return ""
    min_indent = min(len(line) - len(line.lstrip(" ")) for line in non_empty)
    if min_indent > 0:
        lines = [line[min_indent:] if len(line) >= min_indent else line.lstrip(" ") for line in lines]
    # Trim excessive blank-line gaps common in -layout tables
    cleaned = "\n".join(line.rstrip() for line in lines)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def should_keep_hyphen(left_word: str, right_word: str) -> bool:
    if not left_word or not right_word:
        return True
    if any(ch.isdigit() for ch in left_word) or any(ch.isdigit() for ch in right_word):
        return True
    if left_word.isupper() or right_word[0].isupper():
        return True
    if left_word.lower() in KEEP_HYPHEN_PREFIXES:
        return True
    # Conservative default: keep hyphen when left fragment is very short or right looks like a full compound stem
    if len(left_word) <= 2:
        return True
    return True


def reflow_prose_page(text: str) -> str:
    """Unwrap soft mid-sentence PDF line wraps while preserving headings, lists, and hyphens."""
    # Collapse -layout horizontal padding within prose lines
    raw_lines = [re.sub(r"[ \t]{2,}", " ", line.strip()) for line in text.splitlines()]
    normalized = re.sub(r"\n{3,}", "\n\n", "\n".join(raw_lines)).strip()
    blocks = normalized.split("\n\n")
    out_blocks: list[str] = []
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if len(lines) <= 1:
            if lines:
                out_blocks.append(lines[0])
            continue
        merged: list[str] = [lines[0]]
        for nxt in lines[1:]:
            prev = merged[-1]
            prev_is_heading = prev.isupper() and len(prev) <= 85
            nxt_is_heading = nxt.isupper() and len(nxt) <= 85
            can_join = (
                len(prev) >= 38
                and not prev.endswith(":")
                and not prev_is_heading
                and not nxt_is_heading
                and not LIST_OR_HEADING_START_RE.match(nxt)
            )
            if can_join:
                if prev.endswith("-") and not prev.endswith(" -"):
                    left_m = re.search(r"([A-Za-z0-9]+)-$", prev)
                    right_m = re.match(r"^([A-Za-z0-9]+)", nxt)
                    if left_m and right_m and not should_keep_hyphen(left_m.group(1), right_m.group(1)):
                        merged[-1] = prev[:-1] + nxt
                    else:
                        merged[-1] = prev + nxt
                else:
                    merged[-1] = f"{prev} {nxt}"
            else:
                merged.append(nxt)
        out_blocks.append("\n".join(merged))
    return "\n\n".join(out_blocks)


def clean_page_text(text: str, *, preserve_layout: bool = False, reflow: bool = False) -> str:
    text = normalize_pdf_glyphs(text, preserve_layout=preserve_layout)
    if preserve_layout:
        text = dedent_layout_page(text)
    elif reflow:
        text = reflow_prose_page(text)
    else:
        text = re.sub(r"[ \t]{2,}", " ", text).strip()
    if len(text) > MAX_CHARS_PER_PAGE:
        text = text[:MAX_CHARS_PER_PAGE].rstrip() + "…"
    return text


def extract_pages_pdftotext(pdf_path: Path) -> tuple[str, list[dict[str, Any]]]:
    # Use -layout so Poppler preserves columns, single-line headings, and real hyphens.
    raw = subprocess.check_output(
        ["pdftotext", "-layout", str(pdf_path), "-"],
        text=True,
        errors="replace",
    )
    parts = raw.split("\x0c")
    if parts and parts[-1].strip() == "":
        parts = parts[:-1]
    pages = []
    for idx, part in enumerate(parts, 1):
        txt = normalize_pdf_glyphs(part, preserve_layout=True)
        pages.append({"pdf_page": idx, "raw_layout": txt, "chars": len(txt.strip())})
    return "pdftotext -layout (poppler)", pages


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
        txt = normalize_pdf_glyphs(page.extract_text() or "", preserve_layout=False)
        pages.append({"pdf_page": idx, "raw_layout": txt, "chars": len(txt.strip())})
    return f"pypdf {ver}", pages


def inspect_pdf_structure(pdf_path: Path) -> tuple[list[dict[str, Any]], dict[int, int]]:
    """Return (non-root outline bookmarks, {pdf_page: embedded_image_count})."""
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        return [], {}
    reader = PdfReader(str(pdf_path))

    # Count XObject /Image entries per page to detect scanned-image attachments.
    images_by_page: dict[int, int] = {}
    for pno, page in enumerate(reader.pages, 1):
        img_count = 0
        try:
            res = page.get("/Resources")
            xobjs = res.get_object().get("/XObject") if res else None
            if xobjs:
                for obj in xobjs.get_object().values():
                    resolved = obj.get_object()
                    if resolved.get("/Subtype") == "/Image":
                        # Ignore tiny 1x1 or 2x2 mask artifacts
                        w = int(resolved.get("/Width", 0) or 0)
                        h = int(resolved.get("/Height", 0) or 0)
                        if w >= 50 and h >= 50:
                            img_count += 1
        except Exception:  # noqa: BLE001
            img_count = 0
        if img_count > 0:
            images_by_page[pno] = img_count

    bookmarks: list[dict[str, Any]] = []

    def walk(items: Any, depth: int = 0) -> None:
        for item in items:
            if isinstance(item, list):
                walk(item, depth + 1)
            else:
                title = re.sub(r"\s+", " ", str(getattr(item, "title", item))).strip()
                # Ignore merged-PDF filename root nodes (e.g. "Prevailing Wage 26-27 Construction.pdf")
                if not title or title.lower().endswith(".pdf"):
                    continue
                try:
                    page_num = reader.get_destination_page_number(item) + 1
                except Exception:  # noqa: BLE001
                    page_num = None
                if page_num is not None:
                    bookmarks.append({"title": title, "pdf_page": page_num, "depth": depth})

    try:
        walk(reader.outline, 0)
    except Exception:  # noqa: BLE001
        bookmarks = []

    return bookmarks, images_by_page


def canonical_chrome_line(line: str) -> str:
    return re.sub(r"[\s_]+", " ", line.strip()).rstrip(" _").strip()


def detect_running_chrome(pages: list[dict[str, Any]]) -> tuple[set[str], set[str]]:
    """Detect repeated top/bottom lines (appearing on >= 40% of pages, min 3)."""
    if len(pages) < 3:
        return set(), set()
    first_counts: Counter[str] = Counter()
    last_counts: Counter[str] = Counter()
    for pg in pages:
        lines = [line.strip() for line in pg["raw_layout"].splitlines() if line.strip()]
        if not lines:
            continue
        first_counts[canonical_chrome_line(lines[0])] += 1
        last_counts[canonical_chrome_line(lines[-1])] += 1
    threshold = max(3, int(len(pages) * 0.4))
    headers = {line for line, count in first_counts.items() if count >= threshold and len(line) <= 80}
    footers = {line for line, count in last_counts.items() if count >= threshold and len(line) <= 80}
    return headers, footers


def strip_page_chrome(
    raw_text: str,
    running_headers: set[str],
    running_footers: set[str],
) -> tuple[str, list[str], list[str]]:
    lines = raw_text.splitlines()
    stripped_headers: list[str] = []
    stripped_footers: list[str] = []

    while lines and not lines[0].strip():
        lines.pop(0)
    if lines:
        top = canonical_chrome_line(lines[0])
        if top in running_headers:
            stripped_headers.append(top)
            lines.pop(0)

    while lines and not lines[-1].strip():
        lines.pop()
    if lines:
        bot = canonical_chrome_line(lines[-1])
        if bot in running_footers or re.match(r"^(?:page\s+)?\d{1,3}(?:\s+of\s+\d{1,3})?$", bot, re.I):
            if bot in running_footers:
                stripped_footers.append(bot)
            lines.pop()

    return "\n".join(lines).strip("\n"), stripped_headers, stripped_footers


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

    if section.get("id") in ("schedule-a-reference", "schedule-a-insurance", "cover"):
        return []

    for pg in sec_pages:
        pno = pg["pdf_page"]
        lines = [re.sub(r"[ \t]{2,}", " ", line.strip()) for line in pg["body_layout"].splitlines() if line.strip()]
        for i, line in enumerate(lines):
            if (
                len(line) > 85
                or line.endswith(",")
                or " of the " in line
                or " sets forth " in line
                or " below," in line
            ):
                continue

            # Pattern 1: ARTICLE / PART / SECTION / APPENDIX headings (often single-line in -layout)
            m_art = re.match(
                r"^(ARTICLE\s+[IVX\d]+\.?|PART\s+[IVX]+(?:\s*[-–]\s*[A-Z]\b)?|PART\s+[A-C]\b|SECTION\s+\d+(?!-)\.?|APPENDIX\s+[A-Z]\b)(?:\s*[-–:]?\s*(.*))?$",
                line,
                re.I,
            )
            # Pattern 2: Numbered ALL-CAPS bid-book section headings ("1. DESCRIPTION OF PROCUREMENT")
            m_num = re.match(r"^(\d{1,2})\.\s+([A-Z][A-Z0-9\s,&/\-]{3,65})$", line)

            lbl = ""
            if m_art:
                head = m_art.group(1).strip()
                rest_title = (m_art.group(2) or "").strip()
                # Reject prose sentences or table references following "Section 22 of ..."
                if rest_title and (
                    rest_title.startswith("of ")
                    or any(tok in rest_title for tok in (". ", " shall ", " means ", " is ", " are ", " and Part "))
                ):
                    continue
                if rest_title and not re.match(r"^[A-Z0-9]\.$", rest_title):
                    lbl = f"{head} — {rest_title}"
                elif i + 1 < len(lines):
                    nxt = lines[i + 1]
                    if (
                        len(nxt) >= 4
                        and len(nxt) <= 65
                        and nxt.isupper()
                        and not re.match(r"^[A-ZIVX]+\.$", nxt)
                    ):
                        lbl = f"{head} — {nxt}"
                    elif len(head) >= 6 and not head.lower().startswith("section "):
                        lbl = head
            elif m_num and section.get("id") in ("bid-book", "general-specifications", "essta-rider"):
                lbl = f"{m_num.group(1)}. {m_num.group(2).strip()}"

            if not lbl:
                continue
            lbl = re.sub(r"\s+", " ", lbl)[:68]
            key = (pno, lbl.lower())
            if key not in seen:
                seen.add(key)
                jumps.append({"label": lbl, "pdf_page": pno, "highlight": False})

    return jumps[:80]


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

    bookmarks, images_by_page = inspect_pdf_structure(pdf_path)
    doc_headers, doc_footers = detect_running_chrome(all_pages)

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

        sec_raw_pages = all_pages[p0 - 1 : p1]
        sec_headers, sec_footers = detect_running_chrome(sec_raw_pages)
        active_headers = doc_headers | sec_headers
        active_footers = doc_footers | sec_footers

        scope_cls = scope_class_for(sec)
        is_tabular = sec_id in TABULAR_SECTION_IDS or scope_cls == "reference_schedule"

        stripped_sec_pages = []
        observed_headers: set[str] = set()
        observed_footers: set[str] = set()
        for pg in sec_raw_pages:
            body_layout, sh, sf = strip_page_chrome(pg["raw_layout"], active_headers, active_footers)
            observed_headers.update(sh)
            observed_footers.update(sf)
            stripped_sec_pages.append({"pdf_page": pg["pdf_page"], "body_layout": body_layout})

        jumps = build_section_jumps(sec, stripped_sec_pages, bookmarks, anticipated_trades)

        rendered_pages = []
        for pg in stripped_sec_pages:
            pno = pg["pdf_page"]
            txt = clean_page_text(
                pg["body_layout"],
                preserve_layout=is_tabular,
                reflow=not is_tabular,
            )
            img_count = images_by_page.get(pno, 0)
            ocr_needed = len(txt) == 0 or (img_count > 0 and len(txt) < 100)
            page_entry: dict[str, Any] = {
                "pdf_page": pno,
                "text": txt,
                "chars": len(txt),
                "sha256": sha256_bytes(txt.encode("utf-8")),
                "ocr_required": ocr_needed,
            }
            if ocr_needed and img_count > 0 and len(txt) > 0:
                page_entry["ocr_reason"] = "image_attachment_with_header_only"
            rendered_pages.append(page_entry)

        shard_obj: dict[str, Any] = {
            "schema": SHARD_SCHEMA,
            "rfp_id": rfp_id,
            "document_id": str(doc["document_id"]),
            "document_label": str(doc["label"]),
            "document_sha256": actual_sha,
            "official_url": str(doc["official_url"]),
            "extractor": extractor_name,
            "layout_mode": "tabular" if is_tabular else "prose",
            "running_headers": sorted(observed_headers),
            "running_footers": sorted(observed_footers),
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
            "pages": rendered_pages,
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
