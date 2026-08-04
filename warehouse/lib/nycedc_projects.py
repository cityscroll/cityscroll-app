"""Pure extraction and evidence-gated joins for NYCIDA/Build NYC documents.

The host-side runner owns network and storage.  This module deliberately keeps
parsing and matching deterministic so fixture tests can exercise the same path
without fetching publisher pages.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
import unicodedata
import zipfile
from datetime import date, datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse
from xml.etree import ElementTree as ET


SCHEMA = "cityscroll.nycedc_project_feed.v1"
USEFULNESS_THRESHOLD = 0.30
MAX_BOARD_LAG_DAYS = 45


def clean_text(value: object) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"<[^>]+>", " ", text)
    text = text.replace("\x1a", "'").replace("\u00a0", " ")
    return re.sub(r"\s+", " ", text).strip()


def normalized_name(value: object) -> str:
    text = unicodedata.normalize("NFKD", clean_text(value)).encode("ascii", "ignore").decode()
    text = text.lower().replace("&", " and ")
    text = re.sub(r"\b(the|a|an)\b", " ", text)
    text = re.sub(
        r"\b(limited liability company|l\s*l\s*c|llc|ltd|incorporated|inc|corporation|corp|co)\b",
        " ",
        text,
    )
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def normalized_address(value: object) -> str:
    text = unicodedata.normalize("NFKD", clean_text(value)).encode("ascii", "ignore").decode()
    text = text.lower()
    replacements = {
        r"\bstreet\b": "st",
        r"\bavenue\b": "ave",
        r"\bboulevard\b": "blvd",
        r"\broad\b": "rd",
        r"\bplace\b": "pl",
        r"\bnew york\b": "ny",
    }
    for pattern, replacement in replacements.items():
        text = re.sub(pattern, replacement, text)
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def parse_date(value: object) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    iso = re.search(r"\b(20\d{2})-(\d{2})-(\d{2})(?:\b|T)", text)
    if iso:
        try:
            return date(int(iso[1]), int(iso[2]), int(iso[3])).isoformat()
        except ValueError:
            return None
    named = re.search(
        r"\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(20\d{2})\b",
        text,
        re.I,
    )
    if not named:
        return None
    try:
        return datetime.strptime(named.group(0), "%B %d, %Y").date().isoformat()
    except ValueError:
        return None


def parse_amount(value: object) -> int | float | None:
    match = re.search(r"\$?\s*([0-9][0-9,]*(?:\.\d+)?)", clean_text(value))
    if not match:
        return None
    number = float(match.group(1).replace(",", ""))
    return int(number) if number.is_integer() else number


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[tuple[str, str]] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a":
            return
        self._href = dict(attrs).get("href")
        self._text = []

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "a" and self._href is not None:
            self.links.append((self._href, clean_text(" ".join(self._text))))
            self._href = None
            self._text = []


def classify_document(title: str, url: str) -> str | None:
    value = f"{title} {url}".lower()
    if re.search(r"project info spreadsheet|\.xlsx?(?:\?|$)", value):
        return "annual_project_spreadsheet"
    if "board" in value and "minute" in value and ".pdf" in value:
        return "board_minutes"
    if "project-documents-archive" in value:
        return "project_document_index"
    if any(term in value for term in ("lease agreement", "authorizing resolution", "uniform project agreement")):
        return "project_document"
    return None


def extract_index_documents(index_html: str, index_url: str, authority: str) -> list[dict]:
    parser = _LinkParser()
    parser.feed(index_html)
    rows = []
    seen = set()
    for href, title in parser.links:
        url = urljoin(index_url, href)
        kind = classify_document(title, url)
        if not kind or url in seen:
            continue
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in {"edc.nyc", "www.edc.nyc"}:
            continue
        seen.add(url)
        rows.append(
            {
                "authority": authority,
                "document_type": kind,
                "title": title or Path(parsed.path).name,
                "source_url": url,
                "index_url": index_url,
            }
        )
    return rows


def _xlsx_sheets(path: Path) -> list[tuple[str, list[list[str]]]]:
    ns = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(path) as archive:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared = ["".join(t.text or "" for t in si.findall(".//x:t", ns)) for si in root]
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        rel_map = {r.attrib["Id"]: r.attrib["Target"] for r in rels}
        output: list[tuple[str, list[list[str]]]] = []
        for sheet in workbook.findall(".//x:sheets/x:sheet", ns):
            rel_id = sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]
            target = rel_map[rel_id].lstrip("/")
            if not target.startswith("xl/"):
                target = f"xl/{target}"
            root = ET.fromstring(archive.read(target))
            rows: list[list[str]] = []
            for row in root.findall(".//x:sheetData/x:row", ns):
                values: list[str] = []
                for cell in row.findall("x:c", ns):
                    ref = cell.attrib.get("r", "A1")
                    column = 0
                    for char in re.match(r"[A-Z]+", ref).group(0):  # type: ignore[union-attr]
                        column = column * 26 + ord(char) - 64
                    while len(values) < column:
                        values.append("")
                    value = cell.findtext("x:v", default="", namespaces=ns)
                    if cell.attrib.get("t") == "s" and value.isdigit():
                        value = shared[int(value)]
                    elif cell.attrib.get("t") == "inlineStr":
                        value = "".join(t.text or "" for t in cell.findall(".//x:t", ns))
                    values[column - 1] = clean_text(value)
                rows.append(values)
            output.append((clean_text(sheet.attrib.get("name")) or "Sheet", rows))
        return output


def _xlsx_rows(path: Path) -> list[list[str]]:
    """Compatibility helper returning the workbook's first sheet."""
    sheets = _xlsx_sheets(path)
    return sheets[0][1] if sheets else []


_HEADER_ALIASES = {
    "project_id": ("project number", "project id", "projectid", "ll48 id", "ll62 id"),
    "project_name": ("project name", "company/project name"),
    "company": ("company name", "company", "borrower name", "borrower"),
    "address": ("project address", "address", "location"),
    "request_id": ("request id", "city record request id", "notice id"),
    "requested_benefit": ("requested benefit", "financial assistance", "benefits"),
    "estimated_public_cost": ("estimated public cost", "overall total cost to nyc and nys", "total savings total"),
    "project_cost": ("total project cost", "project cost", "total development cost", "total project amount"),
    "application_date": ("application date", "applied date"),
    "closing_date": ("closing date", "closed date"),
    "compliance_date": ("compliance date", "report date"),
}


def extract_annual_spreadsheet(path: Path, document: dict) -> list[dict]:
    output = []
    for sheet_name, rows in _xlsx_sheets(path):
        if not rows:
            continue
        candidates = []
        for index, row in enumerate(rows[:30]):
            headers = [clean_text(value).lower() for value in row]
            alias_hits = sum(
                any(alias == header for alias in aliases)
                for aliases in _HEADER_ALIASES.values()
                for header in headers
            )
            candidates.append((alias_hits, sum(bool(value) for value in row), index, headers))
        _, _, header_index, headers = max(candidates)
        columns: dict[str, int] = {}
        for field, aliases in _HEADER_ALIASES.items():
            exact = next((i for i, header in enumerate(headers) if header in aliases), None)
            if exact is not None:
                columns[field] = exact
                continue
            contained = next(
                (
                    i
                    for i, header in enumerate(headers)
                    if any(len(alias) >= 5 and alias in header for alias in aliases)
                ),
                None,
            )
            if contained is not None:
                columns[field] = contained
        if "project_name" not in columns and "company" not in columns:
            continue

        def get(row: list[str], field: str) -> str:
            column = columns.get(field)
            return row[column] if column is not None and column < len(row) else ""

        safe_sheet = re.sub(r"[^A-Za-z0-9_-]+", "-", sheet_name).strip("-") or "Sheet"
        for row_number, row in enumerate(rows[header_index + 1 :], start=header_index + 2):
            name = get(row, "project_name") or get(row, "company")
            if not name:
                continue
            output.append(
                project_record(
                    authority=document["authority"],
                    project_id=get(row, "project_id") or f"spreadsheet:{document['content_sha256'][:12]}:{safe_sheet}:{row_number}",
                    project_name=name,
                    company=get(row, "company") or name,
                    address=get(row, "address") or None,
                    request_id=get(row, "request_id") or None,
                    requested_benefit=parse_amount(get(row, "requested_benefit")),
                    estimated_public_cost=parse_amount(get(row, "estimated_public_cost")),
                    project_cost=parse_amount(get(row, "project_cost")),
                    application_date=parse_date(get(row, "application_date")),
                    closing_date=parse_date(get(row, "closing_date")),
                    compliance_date=parse_date(get(row, "compliance_date")),
                    source=document,
                    source_locator=f"{safe_sheet}!row-{row_number}",
                )
            )
    return output


def _authority_from_text(text: str, fallback: str | None = None) -> str:
    if fallback in {"nycida", "build_nyc", "nycedc"}:
        return fallback
    upper = text.upper()
    if "BUILD NYC RESOURCE CORPORATION" in upper:
        return "build_nyc"
    if "NEW YORK CITY INDUSTRIAL DEVELOPMENT AGENCY" in upper:
        return "nycida"
    return fallback or "unknown"


def _agenda_items(text: str) -> list[tuple[int, str, str]]:
    lines = []
    for line in str(text).splitlines():
        cleaned = clean_text(line)
        cleaned = re.sub(r"^(?:Page\s+)?\d+\s+of\s+\d+\s+", "", cleaned, flags=re.I)
        lines.append(cleaned)
    normalized_lines = "\n".join(lines)
    before_adjournment = re.split(
        r"^\s*\d{1,2}\.\s+Adjournment\b",
        normalized_lines,
        maxsplit=1,
        flags=re.I | re.M,
    )[0]
    matches = list(re.finditer(r"^\s*(\d{1,2})\.\s+([^\n]{3,180})$", before_adjournment, re.M))
    rows = []
    exclusions = re.compile(
        r"minutes|financial statements|appointment|meeting schedule|budget|policy|self-evaluation|service contract|annual contract|performance measurement|mission statement",
        re.I,
    )
    for index, match in enumerate(matches):
        title = clean_text(match.group(2))
        segment_end = matches[index + 1].start() if index + 1 < len(matches) else len(before_adjournment)
        segment = before_adjournment[match.start() : segment_end]
        if exclusions.search(title):
            continue
        entity_title = re.search(r"\b(?:LLC|L\.L\.C\.|Inc\.|Corp\.|Corporation|School|Foundation|Center)\b", title, re.I)
        if not entity_title and not re.search(r"project|transaction|bond|financ|inducement|post-closing", segment, re.I):
            continue
        rows.append((int(match.group(1)), title, segment))
    return rows


def _project_details(text: str, title: str) -> dict:
    compact = clean_text(text)
    name_key = normalized_name(title)
    tokens = [t for t in name_key.split() if len(t) > 3]
    positions = []
    if title:
        positions = [m.start() for m in re.finditer(re.escape(clean_text(title)), compact, re.I)]
    if not positions and tokens:
        hit = re.search(r"\b" + r"\W+".join(map(re.escape, tokens[:3])) + r"\b", compact, re.I)
        positions = [hit.start()] if hit else [0]
    scored = []
    for position in positions:
        start = max(0, position - 300)
        title_offset = position - start
        candidate = compact[start : position + 12000]
        lead = candidate[:900].lower()
        score = sum(
            marker.lower() in candidate.lower()
            for marker in ("Project Number", "Project Location", "Total Project Cost", "Actions Requested")
        )
        summary_positions = [match.start() for match in re.finditer("project summary", lead)]
        summary_distance = min((abs(summary - title_offset) for summary in summary_positions), default=None)
        if summary_distance is not None:
            score += max(100, 1000 - summary_distance)
        scored.append((score, candidate, title_offset, summary_distance))
    if scored:
        _, segment, title_offset, summary_distance = max(scored, key=lambda item: item[0])
    else:
        segment, title_offset, summary_distance = compact[:7000], 0, None
    if summary_distance is None or summary_distance > 300:
        return {
            "project_id": None,
            "address": None,
            "project_cost": None,
            "requested_benefit": None,
            "estimated_public_cost": None,
        }
    after_title = segment[title_offset:]
    summary_hits = list(re.finditer(r"project summary", after_title, re.I))
    if len(summary_hits) > 1:
        after_title = after_title[: summary_hits[1].start()]
    project_number = re.search(r"Project Number(?:s)?\s*[-:]\s*([0-9, ]+)", segment, re.I)
    address = re.search(
        r"(?:Project Location|Address(?:es)?\s*:|located (?:within|on|at)|street address of)\s*([0-9][^.]{5,180}?)(?:\.| Type of Benefits| Action\s*s?\s+Requested|\(the )",
        after_title,
        re.I,
    )
    cost = re.search(r"Total (?:Project|Development) Cost\s*:?\s*(\$\s*[0-9,]+(?:\.\d+)?)", after_title, re.I)
    assistance = re.search(
        r"(?:Financing Amount|Financial Assistance|\bis seeking|\bare seeking)\s*:?\s*(?:approximately\s*)?(\$\s*[0-9,]+(?:\.\d+)?)",
        after_title,
        re.I,
    )
    public_cost = re.search(r"Overall Total Cost to NYC and NYS\s*(\$\s*[0-9,]+(?:\.\d+)?)", after_title, re.I)
    return {
        "project_id": clean_text(project_number.group(1)).replace(" ", "") if project_number else None,
        "address": clean_text(address.group(1)) if address else None,
        "project_cost": parse_amount(cost.group(1)) if cost else None,
        "requested_benefit": parse_amount(assistance.group(1)) if assistance else None,
        "estimated_public_cost": parse_amount(public_cost.group(1)) if public_cost else None,
    }


def extract_board_minutes_text(text: str, document: dict) -> list[dict]:
    authority = _authority_from_text(text, document.get("authority"))
    meeting_date = parse_date(document.get("title")) or parse_date(text)
    output = []
    agenda = _agenda_items(text)
    for index, (item_number, title, segment) in enumerate(agenda):
        details = _project_details(text, title)
        outcome_segment = segment
        # Some minutes list two project titles consecutively and present/vote on
        # them together beneath the second heading.  Borrow only the explicit
        # vote evidence, never project facts, from that immediately following item.
        if not re.search(r"motion to approve", outcome_segment, re.I) and index + 1 < len(agenda):
            title_only = clean_text(segment)
            if len(title_only) <= len(clean_text(title)) + 12:
                outcome_segment = f"{segment}\n{agenda[index + 1][2]}"
        approved = bool(
            re.search(r"motion to approve", outcome_segment, re.I)
            and re.search(r"(?:unanimously )?approved", outcome_segment, re.I)
        )
        output.append(
            project_record(
                authority=authority,
                project_id=details["project_id"] or f"minutes:{document['content_sha256'][:12]}:{item_number}",
                project_name=title,
                company=title,
                address=details["address"],
                request_id=None,
                requested_benefit=details["requested_benefit"],
                estimated_public_cost=details["estimated_public_cost"],
                project_cost=details["project_cost"],
                board_date=meeting_date,
                board_outcome="approved" if approved else None,
                source=document,
                source_locator=f"agenda-item-{item_number}",
            )
        )
    return output


def extract_board_minutes(path: Path, document: dict) -> list[dict]:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    return extract_board_minutes_text(text, document)


def project_record(
    *,
    authority: str,
    project_id: str,
    project_name: str,
    company: str,
    address: str | None,
    request_id: str | None,
    requested_benefit: int | float | None,
    project_cost: int | float | None,
    source: dict,
    source_locator: str,
    application_date: str | None = None,
    board_date: str | None = None,
    board_outcome: str | None = None,
    closing_date: str | None = None,
    compliance_date: str | None = None,
    estimated_public_cost: int | float | None = None,
) -> dict:
    return {
        "schema": SCHEMA,
        "authority": authority,
        "project_id": project_id,
        "project_name": clean_text(project_name),
        "company": clean_text(company),
        "address": clean_text(address) or None,
        "request_id": clean_text(request_id) or None,
        "requested_benefit": requested_benefit,
        "estimated_public_cost": estimated_public_cost,
        "project_cost": project_cost,
        "milestones": {
            "application": {"date": application_date, "status": "published" if application_date else None},
            "board_decision": {"date": board_date, "outcome": board_outcome},
            "closing": {"date": closing_date, "status": "published" if closing_date else None},
            "compliance": {"date": compliance_date, "status": "published" if compliance_date else None},
        },
        "provenance": {
            "source_url": source["source_url"],
            "document_type": source["document_type"],
            "content_sha256": source["content_sha256"],
            "observed_at": source["observed_at"],
            "source_locator": source_locator,
        },
    }


def extract_notice_projects(notice: dict) -> list[dict]:
    body = clean_text(
        " ".join(
            str(notice.get(key, ""))
            for key in (
                "additional_description_1",
                "additional_description_2",
                "additional_description_3",
                "other_info_1",
                "other_info_2",
                "other_info_3",
            )
        )
    )
    label = re.compile(r"\b(Company Name|Borrower Name)\s*:?[ ]*", re.I)
    matches = list(label.finditer(body))
    output = []
    authority = "build_nyc" if "build nyc" in clean_text(notice.get("agency_name")).lower() else "nycida"
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        segment = body[match.end() : end]
        stop = re.search(r"\b(?:Project Description|Financing Amount)\s*:", segment, re.I)
        intro = clean_text(segment[: stop.start()] if stop else segment[:500])
        name = re.split(
            r"\s+(?:is|are)\s+(?:a|an|both)\b|,\s+(?:a|an)\s+(?:New York|Delaware)\b|\s+\((?:the|collectively)",
            intro,
            maxsplit=1,
            flags=re.I,
        )[0].strip(" ,.;")
        if not name:
            continue
        address = re.search(
            r"(?:Address(?:es)?\s*:|located (?:within|on|at)|street address of)\s*([0-9][^.]{5,180}?)(?:\.| Type of Benefits|\(the )",
            segment,
            re.I,
        )
        cost = re.search(r"Total (?:Project|Development) Cost\s*:?[ ]*(\$[0-9,]+(?:\.\d+)?)", segment, re.I)
        output.append(
            {
                "notice_project_key": f"{notice.get('request_id')}:{index + 1}",
                "request_id": clean_text(notice.get("request_id")),
                "authority": authority,
                "hearing_date": parse_date(notice.get("event_date") or notice.get("start_date")),
                "project_name": name,
                "address": clean_text(address.group(1)) if address else None,
                "project_cost": parse_amount(cost.group(1)) if cost else None,
                "source_url": f"https://a856-cityrecord.nyc.gov/RequestDetail/{clean_text(notice.get('request_id'))}",
            }
        )
    return output


def _date_delta_days(left: str | None, right: str | None) -> int | None:
    if not left or not right:
        return None
    try:
        return (date.fromisoformat(right) - date.fromisoformat(left)).days
    except ValueError:
        return None


def candidate_edges(notice_projects: list[dict], source_projects: list[dict]) -> list[dict]:
    output = []
    for notice in notice_projects:
        candidates = []
        for project in source_projects:
            if notice["authority"] != project["authority"]:
                continue
            if project.get("request_id") and project["request_id"] == notice["request_id"]:
                candidates.append(("request_id", project, None))
                continue
            notice_name = normalized_name(notice.get("project_name"))
            source_name = normalized_name(project.get("company") or project.get("project_name"))
            name_match = notice_name == source_name or (
                min(len(notice_name), len(source_name)) >= 8
                and (notice_name in source_name or source_name in notice_name)
            )
            if not name_match:
                continue
            notice_address = normalized_address(notice.get("address"))
            source_address = normalized_address(project.get("address"))
            if not notice_address or not source_address:
                continue
            number = notice_address.split()[0] if notice_address else ""
            address_match = notice_address == source_address or (
                number.isdigit() and number == source_address.split()[0]
            )
            if not address_match:
                continue
            board_date = project.get("milestones", {}).get("board_decision", {}).get("date")
            delta = _date_delta_days(notice.get("hearing_date"), board_date)
            if delta is None or not 0 <= delta <= MAX_BOARD_LAG_DAYS:
                continue
            candidates.append(("name_address_date", project, delta))
        if len(candidates) != 1:
            continue
        method, project, delta = candidates[0]
        output.append(
            {
                "notice_project_key": notice["notice_project_key"],
                "request_id": notice["request_id"],
                "project_id": project["project_id"],
                "project_name": project["project_name"],
                "method": method,
                "confidence": 1.0,
                "evidence": {
                    "normalized_name": normalized_name(notice["project_name"]),
                    "normalized_address": normalized_address(notice.get("address")),
                    "date_delta_days": delta,
                },
                "source_url": project["provenance"]["source_url"],
            }
        )
    return output


def measurement_receipt(
    *,
    notice_projects: list[dict],
    source_projects: list[dict],
    reviews: list[dict],
    documents: list[dict],
    observed_at: str,
) -> tuple[dict, list[dict]]:
    candidates = candidate_edges(notice_projects, source_projects)
    review_by_key = {row["notice_project_key"]: row for row in reviews}
    accepted = []
    false_positives = []
    unreviewed = []
    for edge in candidates:
        review = review_by_key.get(edge["notice_project_key"])
        if review is None:
            unreviewed.append(edge)
        elif (
            review.get("accept") is True
            and (
                review.get("expected_project_id") == edge["project_id"]
                or normalized_name(review.get("expected_project_name")) == normalized_name(edge["project_name"])
            )
        ):
            accepted.append(edge)
        else:
            false_positives.append({**edge, "review": review})
    denominator = len(notice_projects)
    rate = len(accepted) / denominator if denominator else 0
    bridge_status = "accepted" if rate >= USEFULNESS_THRESHOLD and not false_positives and not unreviewed else "killed"
    if bridge_status == "killed":
        accepted = []
    receipt = {
        "schema": "cityscroll.nycedc_project_join_receipt.v1",
        "observed_at": observed_at,
        "sample": {
            "kind": "fixed_notice_project_mentions",
            "numerator": len(candidates) - len(false_positives) - len(unreviewed),
            "denominator": denominator,
            "join_rate": round(rate, 4),
            "notice_request_ids": sorted({row["request_id"] for row in notice_projects}),
        },
        "strategies": {
            "request_id": {
                "candidates": sum(edge["method"] == "request_id" for edge in candidates),
                "rule": "exact publisher request ID only",
            },
            "name_address_date": {
                "candidates": sum(edge["method"] == "name_address_date" for edge in candidates),
                "rule": f"unique normalized name plus address plus board date 0..{MAX_BOARD_LAG_DAYS} days after hearing",
            },
        },
        "false_positive_review": {
            "reviewed": len(candidates) - len(unreviewed),
            "false_positives": len(false_positives),
            "unreviewed_candidates": len(unreviewed),
            "review_keys": sorted(review_by_key),
            "decisions": [
                {
                    "notice_project_key": row["notice_project_key"],
                    "accept": row.get("accept") is True,
                    "expected_project_id": row.get("expected_project_id"),
                    "expected_project_name": row.get("expected_project_name"),
                    "review_note": row.get("review_note"),
                }
                for row in sorted(reviews, key=lambda item: item["notice_project_key"])
            ],
        },
        "threshold": USEFULNESS_THRESHOLD,
        "bridge_status": bridge_status,
        "kill_reason": None if bridge_status == "accepted" else "below 30% usefulness, a reviewed false positive, or an unreviewed candidate",
        "honest_absent": denominator - len(candidates),
        "documents": [
            {
                "source_url": row["source_url"],
                "document_type": row["document_type"],
                "content_sha256": row["content_sha256"],
            }
            for row in documents
        ],
        "outcome_policy": "board outcome is emitted only from explicit motion/vote language; a scheduled hearing is never approval",
    }
    return receipt, accepted


def dump_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
