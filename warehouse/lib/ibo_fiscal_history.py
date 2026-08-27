"""Read and materialize the NYC IBO Fiscal History XLSX workbooks.

The workbooks are the source artifact.  This module deliberately uses only the
XLSX zip/XML format from the Python standard library so that an ingestion run
does not depend on a spreadsheet application's guesses about headers, merged
cells, or number formats.

The parser is intentionally strict at the structural boundary and conservative
at the identity boundary:

* expected sheets, anchors, year columns, and row labels must be present;
* labels not resolved by the shared agency identity module stay unresolved;
* source values and units remain alongside any explicitly derived USD value.
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
import subprocess
import sys
import zipfile
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Iterable
from xml.etree import ElementTree as ET


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"m": MAIN_NS, "r": REL_NS}
YEAR_COLUMNS = tuple(
    # Excel columns B through AR, the 43 fiscal years in the current IBO files.
    [
        "B",
        "C",
        "D",
        "E",
        "F",
        "G",
        "H",
        "I",
        "J",
        "K",
        "L",
        "M",
        "N",
        "O",
        "P",
        "Q",
        "R",
        "S",
        "T",
        "U",
        "V",
        "W",
        "X",
        "Y",
        "Z",
        "AA",
        "AB",
        "AC",
        "AD",
        "AE",
        "AF",
        "AG",
        "AH",
        "AI",
        "AJ",
        "AK",
        "AL",
        "AM",
        "AN",
        "AO",
        "AP",
        "AQ",
        "AR",
    ]
)


class WorkbookStructureError(ValueError):
    """Raised when a publisher workbook no longer matches its source contract."""


@dataclass(frozen=True)
class Cell:
    ref: str
    raw_value: str | None
    has_value: bool
    comment: str | None = None


def _text(node: ET.Element | None) -> str:
    if node is None:
        return ""
    return "".join(node.itertext())


def _xml_unescape(value: str) -> str:
    # ElementTree already decodes XML entities.  This helper is used only for
    # text coming from the small relationship/metadata attribute parser.
    return value.replace("&apos;", "'").replace("&quot;", '"').replace("&amp;", "&")


def _normal_label(value: str | None) -> str:
    return " ".join(str(value or "").split()).strip()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _decimal_number(raw: str, *, coordinate: str) -> tuple[float | None, str, list[str]]:
    """Parse a displayed numeric value without losing the publisher spelling."""

    source = raw.replace("\u00a0", " ").strip()
    if not source:
        return None, "blank", []

    lowered = source.casefold()
    if lowered in {"-", "–", "—", "n/a", "na", "not available", "suppressed"}:
        return None, "publisher_missing_or_suppressed", []

    markers: list[str] = []
    # Footnote marks appended to an otherwise numeric cell are retained as
    # metadata rather than making the value disappear.
    while source and source[-1] in "*†‡§":
        markers.insert(0, source[-1])
        source = source[:-1].rstrip()

    negative = source.startswith("(") and source.endswith(")")
    if negative:
        source = source[1:-1].strip()
    source = source.replace(",", "")
    source = re.sub(r"^[\$£€]\s*", "", source)
    source = source.replace("\u2212", "-").strip()
    try:
        value = Decimal(source)
    except (InvalidOperation, ValueError) as exc:
        raise WorkbookStructureError(
            f"unparseable non-empty numeric cell {coordinate}: {raw!r}"
        ) from exc
    if negative:
        value = -value
    # Excel stores computed values with binary-floating residue.  IBO's
    # thousand-dollar sheet is displayed to three decimal places, so this
    # removes only that storage residue and leaves the publisher unit intact.
    value = value.quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)
    return float(value), "value", markers


class Workbook:
    """Small, deterministic reader for the workbook subset used by IBO."""

    def __init__(self, path: Path):
        self.path = path
        try:
            self.archive = zipfile.ZipFile(path)
        except (OSError, zipfile.BadZipFile) as exc:
            raise WorkbookStructureError(f"cannot read XLSX {path}: {exc}") from exc
        self.shared_strings = self._read_shared_strings()
        self.comments = self._read_comments()
        self.sheet_paths = self._read_sheet_paths()
        self.sheets = {name: self._read_sheet(name, target) for name, target in self.sheet_paths.items()}

    def close(self) -> None:
        self.archive.close()

    def __enter__(self) -> "Workbook":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _read_shared_strings(self) -> list[str]:
        if "xl/sharedStrings.xml" not in self.archive.namelist():
            return []
        root = ET.fromstring(self.archive.read("xl/sharedStrings.xml"))
        return [_text(item) for item in root.findall("m:si", NS)]

    def _read_comments(self) -> dict[str, str]:
        comments: dict[str, str] = {}
        for name in self.archive.namelist():
            if not name.startswith("xl/comments") or not name.endswith(".xml"):
                continue
            root = ET.fromstring(self.archive.read(name))
            for comment in root.findall(".//m:comment", NS):
                ref = comment.attrib.get("ref")
                if ref:
                    comments[ref] = _text(comment.find("m:text", NS)).strip()
        return comments

    def _read_sheet_paths(self) -> dict[str, str]:
        workbook = ET.fromstring(self.archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(self.archive.read("xl/_rels/workbook.xml.rels"))
        relation_targets = {
            item.attrib["Id"]: item.attrib["Target"] for item in relationships.findall(
                "{" + PKG_REL_NS + "}Relationship"
            )
        }
        paths: dict[str, str] = {}
        for sheet in workbook.findall("m:sheets/m:sheet", NS):
            name = sheet.attrib.get("name", "")
            relation_id = sheet.attrib.get("{" + REL_NS + "}id")
            target = relation_targets.get(relation_id or "")
            if not name or not target:
                raise WorkbookStructureError(f"invalid sheet relationship in {self.path}")
            target = target.lstrip("/")
            if not target.startswith("xl/"):
                target = "xl/" + target
            paths[name] = target
        return paths

    def _read_sheet(self, name: str, target: str) -> dict[int, dict[str, Cell]]:
        try:
            root = ET.fromstring(self.archive.read(target))
        except KeyError as exc:
            raise WorkbookStructureError(f"sheet {name!r} target missing: {target}") from exc
        rows: dict[int, dict[str, Cell]] = {}
        for row in root.findall(".//m:row", NS):
            row_number = int(row.attrib.get("r", "0"))
            if row_number <= 0:
                raise WorkbookStructureError(f"invalid row number in sheet {name!r}")
            parsed: dict[str, Cell] = {}
            for cell in row.findall("m:c", NS):
                ref = cell.attrib.get("r", "")
                if not ref:
                    raise WorkbookStructureError(f"cell without reference in sheet {name!r} row {row_number}")
                value_node = cell.find("m:v", NS)
                cell_type = cell.attrib.get("t")
                if cell_type == "s" and value_node is not None and value_node.text:
                    index = int(value_node.text)
                    if index < 0 or index >= len(self.shared_strings):
                        raise WorkbookStructureError(f"shared string index out of range at {name}!{ref}")
                    raw_value: str | None = self.shared_strings[index]
                    has_value = True
                elif cell_type == "inlineStr":
                    raw_value = _text(cell.find("m:is", NS))
                    has_value = True
                elif value_node is not None and value_node.text is not None:
                    raw_value = value_node.text
                    has_value = True
                else:
                    raw_value = None
                    has_value = False
                parsed[ref] = Cell(ref, raw_value, has_value, self.comments.get(ref))
            rows[row_number] = parsed
        return rows

    def sheet(self, name: str) -> dict[int, dict[str, Cell]]:
        if name not in self.sheets:
            raise WorkbookStructureError(
                f"expected sheet {name!r} missing from {self.path.name}; found {sorted(self.sheets)}"
            )
        return self.sheets[name]

    def cell(self, sheet_name: str, ref: str) -> Cell:
        return self.sheet(sheet_name).get(int(re.search(r"\d+", ref).group(0)), {}).get(
            ref, Cell(ref, None, False)
        )


def _cell_label(sheet: dict[int, dict[str, Cell]], row: int, column: str = "A") -> str:
    cell = sheet.get(row, {}).get(f"{column}{row}")
    return _normal_label(cell.raw_value if cell and cell.has_value else "")


def _validate_anchor(workbook: Workbook, spec: dict[str, Any], sheet_name: str) -> None:
    title_cell = spec["title_cell"]
    title = workbook.cell(sheet_name, title_cell).raw_value or ""
    if _normal_label(title) != _normal_label(spec["title"]):
        raise WorkbookStructureError(
            f"{workbook.path.name}!{sheet_name}!{title_cell} expected {spec['title']!r}, got {title!r}"
        )
    note_cell = spec.get("source_note_cell")
    if note_cell:
        note = workbook.cell(sheet_name, note_cell).raw_value or ""
        if not _normal_label(note).casefold().startswith(_normal_label(spec["source_note_prefix"]).casefold()):
            raise WorkbookStructureError(
                f"{workbook.path.name}!{sheet_name}!{note_cell} lost source-note anchor: {note!r}"
            )


def _validate_unit_contract(source: dict[str, Any], sheet_name: str, expected_unit: str) -> None:
    """Require the selected publisher surface and manifest to agree on units."""

    declared_unit = source.get("unit")
    if declared_unit != expected_unit:
        raise WorkbookStructureError(
            f"{source.get('id', 'IBO source')} declares unit {declared_unit!r}; expected {expected_unit!r}"
        )
    declared_label = _normal_label(source.get("unit_label"))
    if expected_unit == "USD_thousands":
        # The IBO workbook deliberately names this sheet by its unit.  Keep that
        # label as a structural anchor so a future dollars-in-millions sheet is
        # never parsed as thousands by accident.
        if not declared_label or declared_label.casefold() != _normal_label(sheet_name).casefold():
            raise WorkbookStructureError(
                f"{source.get('id', 'IBO source')} unit label {declared_label!r} does not match selected sheet {sheet_name!r}"
            )
    elif declared_label and declared_label.casefold() != expected_unit.casefold():
        raise WorkbookStructureError(
            f"{source.get('id', 'IBO source')} unit label {declared_label!r} does not match {expected_unit!r}"
        )


def _validate_year_header(
    workbook: Workbook, sheet_name: str, header_row: int, expected_years: list[int]
) -> list[tuple[int, str]]:
    sheet = workbook.sheet(sheet_name)
    years: list[tuple[int, str]] = []
    for index, expected in enumerate(expected_years):
        column = YEAR_COLUMNS[index]
        ref = f"{column}{header_row}"
        raw = sheet.get(header_row, {}).get(ref)
        if raw is None or not raw.has_value or not (raw.raw_value or "").strip():
            raise WorkbookStructureError(f"missing fiscal-year header at {workbook.path.name}!{sheet_name}!{ref}")
        try:
            value = int(str(raw.raw_value).strip())
        except ValueError as exc:
            raise WorkbookStructureError(
                f"non-year fiscal header at {workbook.path.name}!{sheet_name}!{ref}: {raw.raw_value!r}"
            ) from exc
        if value != expected:
            raise WorkbookStructureError(
                f"unexpected fiscal-year header at {workbook.path.name}!{sheet_name}!{ref}: "
                f"expected {expected}, got {value}"
            )
        years.append((value, column))

    expected_columns = set(YEAR_COLUMNS[: len(expected_years)])
    for column, cells in sheet.get(header_row, {}).items():
        match = re.match(r"([A-Z]+)\d+$", column)
        if not match or not cells.has_value or not (cells.raw_value or "").strip():
            continue
        letters = match.group(1)
        raw_header = (cells.raw_value or "").strip()
        if raw_header.isdigit() and len(raw_header) == 4 and (
            letters not in expected_columns or int(raw_header) not in expected_years
        ):
            raise WorkbookStructureError(
                f"unexpected fiscal-year header {letters}{header_row}={raw_header} in "
                f"{workbook.path.name}!{sheet_name}"
            )
    return years


def _record_value(
    cell: Cell,
    *,
    unit: str,
    unit_label: str,
    conversion_factor: float | None = None,
) -> dict[str, Any]:
    raw = cell.raw_value if cell.has_value and cell.raw_value is not None else ""
    value, status, markers = _decimal_number(raw, coordinate=cell.ref)
    record: dict[str, Any] = {
        "value": value,
        "unit": unit,
        "unit_label": unit_label,
        "value_status": status,
        "source_raw_value": cell.raw_value if cell.has_value else None,
        "source_footnote_markers": markers,
    }
    if cell.comment:
        record["source_comment"] = cell.comment
    if conversion_factor is not None:
        record["value_in_usd"] = None if value is None else round(value * conversion_factor, 3)
        record["value_in_usd_status"] = (
            "derived_explicit_conversion" if value is not None else "not_derived_from_null"
        )
        record["conversion"] = {
            "status": "explicit",
            "from_unit": unit,
            "to_unit": "USD",
            "factor": conversion_factor,
        }
    return record


def _observation(
    *,
    source: dict[str, Any],
    workbook: Path,
    sheet_name: str,
    source_agency_name: str,
    mapping: dict[str, Any],
    fiscal_year: int,
    source_cell: str,
    measure: str,
    publisher_measure: str,
    value: dict[str, Any],
    record_type: str = "agency_measure",
) -> dict[str, Any]:
    record = {
        "record_type": record_type,
        "source_workbook_id": source["id"],
        "source_workbook": workbook.name,
        "source_sheet": sheet_name,
        "source_vintage": source["publisher_vintage"],
        "source_agency_name": source_agency_name,
        "agency_identity_status": mapping["status"],
        "canonical_agency_id": mapping.get("canonical_agency_id"),
        "canonical_agency_name": mapping.get("canonical_agency_name"),
        "identity_mapping_basis": mapping.get("basis"),
        "fiscal_year": fiscal_year,
        "measure": measure,
        "publisher_measure": publisher_measure,
        "source_cell": source_cell,
        **value,
    }
    return record


EXPENDITURE_MEASURES = (
    ("Personal Services", "personal_services"),
    ("Other Than Personal Services", "other_than_personal_services"),
    ("less: intra-city", "less_intra_city"),
    ("prior year adjustments", "prior_year_adjustments"),
    ("TOTAL DEPT.", "total_department_expenditures"),
)
CITYWIDE_MEASURES = (
    ("Personal Services", "personal_services"),
    ("Other Than Personal Services", "other_than_personal_services"),
    ("less: intra-city", "less_intra_city"),
    ("prior year adjustments", "prior_year_adjustments"),
    ("Total Citywide Expenditures", "total_citywide_expenditures"),
    ("Interfund Agreements", "interfund_agreements"),
    ("Total Citywide Expenditures, less Interfund Agreements", "total_citywide_expenditures_less_interfund"),
)


def parse_expenditures(
    workbook: Workbook, source: dict[str, Any], mappings: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    sheet_name = source["sheet"]
    sheet = workbook.sheet(sheet_name)
    _validate_anchor(workbook, source, sheet_name)
    _validate_unit_contract(source, sheet_name, "USD_thousands")
    years = _validate_year_header(workbook, sheet_name, source["header_row"], source["fiscal_years"])
    records: list[dict[str, Any]] = []
    row = source["first_data_row"]
    ordinary_labels: list[str] = []
    citywide_seen = False
    while row in sheet:
        agency = _cell_label(sheet, row)
        if not agency:
            row += 1
            continue
        if agency.casefold() == "citywide":
            citywide_seen = True
            for offset, (expected_label, measure) in enumerate(CITYWIDE_MEASURES, start=1):
                actual = _cell_label(sheet, row + offset)
                if actual.casefold() != expected_label.casefold():
                    raise WorkbookStructureError(
                        f"{workbook.path.name}!{sheet_name}!A{row + offset} expected {expected_label!r}, got {actual!r}"
                    )
                for fiscal_year, column in years:
                    cell = sheet.get(row + offset, {}).get(f"{column}{row + offset}", Cell(f"{column}{row + offset}", None, False))
                    value = _record_value(cell, unit="USD_thousands", unit_label="In $000's", conversion_factor=1000)
                    records.append(
                        _observation(
                            source=source,
                            workbook=workbook.path,
                            sheet_name=sheet_name,
                            source_agency_name=agency,
                            mapping={"status": "aggregate", "basis": "publisher_citywide_reconciliation"},
                            fiscal_year=fiscal_year,
                            source_cell=cell.ref,
                            measure=measure,
                            publisher_measure=expected_label,
                            value=value,
                            record_type="citywide_reconciliation",
                        )
                    )
            break

        ordinary_labels.append(agency)
        block_labels = [_cell_label(sheet, row + offset) for offset in range(1, 6)]
        expected_labels = [label for label, _ in EXPENDITURE_MEASURES]
        if [label.casefold() for label in block_labels] != [label.casefold() for label in expected_labels]:
            raise WorkbookStructureError(
                f"{workbook.path.name}!{sheet_name}!A{row + 1}:A{row + 5} expected expenditure measure block "
                f"{expected_labels!r}, got {block_labels!r}"
            )
        mapping = mappings.get(agency)
        if mapping is None:
            raise WorkbookStructureError(f"missing identity decision for source agency label {agency!r}")
        for offset, (publisher_measure, measure) in enumerate(EXPENDITURE_MEASURES, start=1):
            source_row = row + offset
            for fiscal_year, column in years:
                cell = sheet.get(source_row, {}).get(f"{column}{source_row}", Cell(f"{column}{source_row}", None, False))
                value = _record_value(cell, unit="USD_thousands", unit_label="In $000's", conversion_factor=1000)
                records.append(
                    _observation(
                        source=source,
                        workbook=workbook.path,
                        sheet_name=sheet_name,
                        source_agency_name=agency,
                        mapping=mapping,
                        fiscal_year=fiscal_year,
                        source_cell=cell.ref,
                        measure=measure,
                        publisher_measure=publisher_measure,
                        value=value,
                    )
                )
        separator = sheet.get(row + 6, {})
        if any(cell.has_value and (cell.raw_value or "").strip() for cell in separator.values()):
            raise WorkbookStructureError(
                f"expected blank separator after {workbook.path.name}!{sheet_name}!A{row + 5}"
            )
        row += 7

    if not citywide_seen:
        raise WorkbookStructureError(f"citywide reconciliation block missing from {workbook.path.name}!{sheet_name}")
    if not ordinary_labels:
        raise WorkbookStructureError(f"no agency blocks found in {workbook.path.name}!{sheet_name}")
    return records


def parse_staffing(
    workbook: Workbook, source: dict[str, Any], mappings: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    sheet_name = source["sheet"]
    sheet = workbook.sheet(sheet_name)
    _validate_anchor(workbook, source, sheet_name)
    _validate_unit_contract(source, sheet_name, "positions")
    convention = workbook.cell(sheet_name, source["definition_cell"]).raw_value or ""
    if _normal_label(convention).casefold() != _normal_label(source["definition"]).casefold():
        raise WorkbookStructureError(
            f"{workbook.path.name}!{sheet_name}!{source['definition_cell']} lost staffing definition anchor"
        )
    years = _validate_year_header(workbook, sheet_name, source["header_row"], source["fiscal_years"])
    records: list[dict[str, Any]] = []
    row = source["first_data_row"]
    total_seen = False
    while row in sheet:
        agency = _cell_label(sheet, row)
        if not agency:
            row += 1
            continue
        if agency.casefold() == "total":
            total_seen = True
            mapping = {"status": "aggregate", "basis": "publisher_staffing_total"}
            measure = "total_full_time_positions"
            record_type = "citywide_reconciliation"
        else:
            if total_seen:
                raise WorkbookStructureError(
                    f"non-empty staffing row after total at {workbook.path.name}!{sheet_name}!A{row}"
                )
            mapping = mappings.get(agency)
            if mapping is None:
                raise WorkbookStructureError(f"missing identity decision for source agency label {agency!r}")
            measure = "full_time_positions"
            record_type = "agency_measure"
        for fiscal_year, column in years:
            cell = sheet.get(row, {}).get(f"{column}{row}", Cell(f"{column}{row}", None, False))
            value = _record_value(cell, unit="positions", unit_label="positions")
            records.append(
                _observation(
                    source=source,
                    workbook=workbook.path,
                    sheet_name=sheet_name,
                    source_agency_name=agency,
                    mapping=mapping,
                    fiscal_year=fiscal_year,
                    source_cell=cell.ref,
                    measure=measure,
                    publisher_measure="Actual Full-Time Positions",
                    value=value,
                    record_type=record_type,
                )
            )
        row += 1
    if not total_seen:
        raise WorkbookStructureError(f"staffing total row missing from {workbook.path.name}!{sheet_name}")
    return records


def _resolve_agencies(root: Path, labels: Iterable[str]) -> dict[str, dict[str, Any]]:
    resolver = root / "warehouse" / "scripts" / "resolve_ibo_agencies.mjs"
    if not resolver.is_file():
        raise WorkbookStructureError(f"shared agency resolver missing: {resolver}")
    payload = json.dumps(sorted(set(labels)), ensure_ascii=False).encode("utf-8")
    try:
        result = subprocess.run(
            ["node", str(resolver)],
            input=payload,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=root,
            check=False,
        )
    except OSError as exc:
        raise WorkbookStructureError(f"cannot run shared agency resolver: {exc}") from exc
    if result.returncode != 0:
        raise WorkbookStructureError(
            f"shared agency resolver failed: {result.stderr.decode('utf-8', 'replace').strip()}"
        )
    try:
        rows = json.loads(result.stdout.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise WorkbookStructureError("shared agency resolver returned invalid JSON") from exc
    return {row["source_agency_name"]: row for row in rows}


def _round_number(value: float | None) -> float | None:
    return None if value is None else float(Decimal(str(value)).quantize(Decimal("0.001")))


def _coverage_receipt(
    observations: list[dict[str, Any]],
    mappings: dict[str, dict[str, Any]],
    sources: list[dict[str, Any]],
) -> dict[str, Any]:
    labels = sorted(mappings)
    statuses = {status: sum(1 for row in mappings.values() if row["status"] == status) for status in ("exact", "alias", "unresolved")}
    measures: dict[str, dict[str, int]] = {}
    for row in observations:
        entry = measures.setdefault(row["measure"], {"row_count": 0, "null_count": 0})
        entry["row_count"] += 1
        if row.get("value") is None:
            entry["null_count"] += 1
    null_rates = {
        measure: {
            **counts,
            "null_rate": round(counts["null_count"] / counts["row_count"], 6) if counts["row_count"] else 0,
        }
        for measure, counts in sorted(measures.items())
    }
    fiscal_years = sorted({row["fiscal_year"] for row in observations})
    return {
        "source_label_count": len(labels),
        "exact_matched_label_count": statuses["exact"],
        "alias_matched_label_count": statuses["alias"],
        "unresolved_label_count": statuses["unresolved"],
        "source_labels": labels,
        "mapping_decisions": [mappings[label] for label in labels],
        "fiscal_years": fiscal_years,
        "row_count": len(observations),
        "row_count_by_workbook": {
            source["id"]: sum(1 for row in observations if row["source_workbook_id"] == source["id"])
            for source in sources
        },
        "null_rates_by_measure": null_rates,
    }


def _reconciliation(observations: list[dict[str, Any]], fiscal_years: list[int]) -> dict[str, Any]:
    def values(measure: str, source_agency: str | None = None) -> dict[str, float | None]:
        result: dict[str, float | None] = {}
        for year in fiscal_years:
            rows = [
                row
                for row in observations
                if row["fiscal_year"] == year
                and row["measure"] == measure
                and (source_agency is None or row["source_agency_name"] == source_agency)
            ]
            result[str(year)] = _round_number(rows[0]["value"]) if rows and rows[0]["value"] is not None else None
        return result

    sum_agency_totals: dict[str, float | None] = {}
    for year in fiscal_years:
        total = Decimal("0")
        count = 0
        for row in observations:
            if (
                row["source_workbook_id"] == "ibo_agency_expenditures"
                and row["fiscal_year"] == year
                and row["measure"] == "total_department_expenditures"
                and row["value"] is not None
            ):
                total += Decimal(str(row["value"]))
                count += 1
        sum_agency_totals[str(year)] = _round_number(float(total)) if count else None

    citywide_total = values("total_citywide_expenditures", "Citywide")
    citywide_less_interfund = values("total_citywide_expenditures_less_interfund", "Citywide")
    differences: dict[str, float | None] = {}
    for year in fiscal_years:
        left = sum_agency_totals[str(year)]
        right = citywide_total[str(year)]
        differences[str(year)] = None if left is None or right is None else _round_number(left - right)
    return {
        "expenditures": {
            "unit": "USD_thousands",
            "sum_source_agency_total": sum_agency_totals,
            "publisher_citywide_total": citywide_total,
            "publisher_citywide_less_interfund": citywide_less_interfund,
            "sum_minus_publisher_total": differences,
            "meaning": "sum of source agency TOTAL DEPT. rows should equal publisher Total Citywide Expenditures; the less-interfund line is a separate publisher measure",
        },
        "staffing": {
            "unit": "positions",
            "publisher_total_positions": values("total_full_time_positions", "Total"),
            "meaning": "publisher total retained; component rows are not summed because the workbook publishes overlapping staffing components",
        },
    }


CSV_FIELDS = (
    "record_type",
    "source_workbook_id",
    "source_workbook",
    "source_sheet",
    "source_vintage",
    "source_agency_name",
    "agency_identity_status",
    "canonical_agency_id",
    "canonical_agency_name",
    "identity_mapping_basis",
    "fiscal_year",
    "measure",
    "publisher_measure",
    "source_cell",
    "value",
    "unit",
    "unit_label",
    "value_status",
    "source_raw_value",
    "source_footnote_markers",
    "source_comment",
    "value_in_usd",
    "value_in_usd_status",
    "conversion_factor",
)


def _write_jsonl(path: Path, observations: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for row in observations:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")


def _write_csv(path: Path, observations: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=CSV_FIELDS,
            extrasaction="ignore",
            lineterminator="\n",
        )
        writer.writeheader()
        for row in observations:
            output = dict(row)
            output["source_footnote_markers"] = "".join(row.get("source_footnote_markers") or [])
            output["conversion_factor"] = (row.get("conversion") or {}).get("factor")
            writer.writerow(output)


def _materialize_duckdb(csv_path: Path, db_path: Path) -> dict[str, Any]:
    try:
        import duckdb  # type: ignore
    except ImportError:
        return {"status": "unavailable", "reason": "duckdb_python_package_missing"}
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect(str(db_path))
    try:
        connection.execute("PRAGMA threads=1")
        csv_sql = str(csv_path).replace("'", "''")
        # Do not let a numeric-looking early source_raw_value sample decide the
        # type of the audit column: later publisher cells may legitimately say
        # n/a, —, or carry a footnote marker.  Analytic columns stay numeric.
        columns = {
            "record_type": "VARCHAR",
            "source_workbook_id": "VARCHAR",
            "source_workbook": "VARCHAR",
            "source_sheet": "VARCHAR",
            "source_vintage": "VARCHAR",
            "source_agency_name": "VARCHAR",
            "agency_identity_status": "VARCHAR",
            "canonical_agency_id": "VARCHAR",
            "canonical_agency_name": "VARCHAR",
            "identity_mapping_basis": "VARCHAR",
            "fiscal_year": "INTEGER",
            "measure": "VARCHAR",
            "publisher_measure": "VARCHAR",
            "source_cell": "VARCHAR",
            "value": "DOUBLE",
            "unit": "VARCHAR",
            "unit_label": "VARCHAR",
            "value_status": "VARCHAR",
            "source_raw_value": "VARCHAR",
            "source_footnote_markers": "VARCHAR",
            "source_comment": "VARCHAR",
            "value_in_usd": "DOUBLE",
            "value_in_usd_status": "VARCHAR",
            "conversion_factor": "DOUBLE",
        }
        type_sql = "{" + ",".join(f"'{key}':'{value}'" for key, value in columns.items()) + "}"
        connection.execute(
            "CREATE OR REPLACE TABLE ibo_fiscal_history AS "
            f"SELECT * FROM read_csv('{csv_sql}', header=true, nullstr='', columns={type_sql})"
        )
        count = connection.execute("SELECT COUNT(*) FROM ibo_fiscal_history").fetchone()[0]
        columns = [row[0] for row in connection.execute("DESCRIBE ibo_fiscal_history").fetchall()]
    finally:
        connection.close()
    return {
        "status": "materialized",
        "catalog": str(db_path),
        "table": "ibo_fiscal_history",
        "row_count": int(count),
        "columns": columns,
    }


def ingest(
    *,
    root: Path,
    manifest_path: Path,
    output_dir: Path,
    duckdb_path: Path | None = None,
) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schema") != "cityscroll.ibo_fiscal_history_source_manifest.v1":
        raise WorkbookStructureError(f"unsupported source manifest schema: {manifest.get('schema')!r}")
    source_specs = manifest.get("workbooks")
    if not isinstance(source_specs, list) or len(source_specs) != 2:
        raise WorkbookStructureError("source manifest must declare exactly two IBO workbooks")

    workbooks: dict[str, tuple[dict[str, Any], Workbook]] = {}
    labels: list[str] = []
    try:
        for source in source_specs:
            path = (manifest_path.parent / source["path"]).resolve()
            if not path.is_file():
                raise WorkbookStructureError(f"source workbook missing: {path}")
            observed_hash = _sha256(path)
            if observed_hash != source["sha256"]:
                raise WorkbookStructureError(
                    f"source workbook hash mismatch for {path.name}: expected {source['sha256']}, got {observed_hash}"
                )
            book = Workbook(path)
            workbooks[source["id"]] = (source, book)
            expected_sheets = source.get("sheets") or [source["sheet"]]
            missing_sheets = sorted(set(expected_sheets) - set(book.sheet_paths))
            if missing_sheets:
                raise WorkbookStructureError(
                    f"expected sheet(s) missing from {path.name}: {missing_sheets!r}; "
                    f"found {sorted(book.sheet_paths)}"
                )
            sheet = book.sheet(source["sheet"])
            if source["id"] == "ibo_agency_expenditures":
                row = source["first_data_row"]
                while row in sheet:
                    label = _cell_label(sheet, row)
                    if label.casefold() == "citywide":
                        break
                    if label:
                        labels.append(label)
                    row += 7
            else:
                row = source["first_data_row"]
                while row in sheet:
                    label = _cell_label(sheet, row)
                    if not label or label.casefold() == "total":
                        break
                    labels.append(label)
                    row += 1
        mappings = _resolve_agencies(root, labels)
        if set(mappings) != set(labels):
            missing = sorted(set(labels) - set(mappings))
            raise WorkbookStructureError(f"shared resolver omitted source labels: {missing!r}")

        observations: list[dict[str, Any]] = []
        expenditure_source, expenditure_book = workbooks["ibo_agency_expenditures"]
        staffing_source, staffing_book = workbooks["ibo_full_time_positions"]
        observations.extend(parse_expenditures(expenditure_book, expenditure_source, mappings))
        observations.extend(parse_staffing(staffing_book, staffing_source, mappings))
    finally:
        for _, book in workbooks.values():
            book.close()

    observations.sort(
        key=lambda row: (
            row["source_workbook_id"],
            row["source_agency_name"],
            row["fiscal_year"],
            row["measure"],
            row["source_cell"],
        )
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    jsonl_path = output_dir / "observations.jsonl"
    csv_path = output_dir / "observations.csv"
    _write_jsonl(jsonl_path, observations)
    _write_csv(csv_path, observations)
    coverage = _coverage_receipt(observations, mappings, source_specs)
    receipt: dict[str, Any] = {
        "schema": "cityscroll.ibo_fiscal_history_receipt.v1",
        "generated_from": {
            "source_manifest": str(manifest_path.relative_to(root)) if manifest_path.is_relative_to(root) else str(manifest_path),
            "source_hashes": {source["id"]: source["sha256"] for source in source_specs},
        },
        "retrieval_timestamp": manifest["retrieval_timestamp"],
        "publisher_vintage": manifest["publisher_vintage"],
        "coverage": coverage,
        "reconciliation": _reconciliation(observations, coverage["fiscal_years"]),
        "materialization": {
            "observations_jsonl": str(jsonl_path.relative_to(root)) if jsonl_path.is_relative_to(root) else str(jsonl_path),
            "observations_csv": str(csv_path.relative_to(root)) if csv_path.is_relative_to(root) else str(csv_path),
        },
    }
    if duckdb_path is not None:
        duckdb_receipt = _materialize_duckdb(csv_path, duckdb_path)
        if duckdb_receipt.get("catalog"):
            catalog_path = Path(str(duckdb_receipt["catalog"]))
            duckdb_receipt["catalog"] = (
                str(catalog_path.relative_to(root))
                if catalog_path.is_relative_to(root)
                else str(catalog_path)
            )
        receipt["materialization"]["duckdb"] = duckdb_receipt
    receipt_path = output_dir / "receipt.json"
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return receipt


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Ingest authoritative NYC IBO fiscal-history XLSX workbooks")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--duckdb", type=Path, default=None, help="Optional DuckDB catalog path for inspection")
    args = parser.parse_args(argv)
    try:
        receipt = ingest(
            root=args.root.resolve(),
            manifest_path=args.manifest.resolve(),
            output_dir=args.output_dir.resolve(),
            duckdb_path=args.duckdb.resolve() if args.duckdb else None,
        )
    except (OSError, WorkbookStructureError, KeyError, ValueError) as exc:
        print(f"ibo fiscal-history ingest failed: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
