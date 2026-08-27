#!/usr/bin/env python3
"""Create the small committed XLSX fixtures used by the IBO ingestion tests."""

from __future__ import annotations

import hashlib
import html
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent
YEARS = [2022, 2021]
COLS = ["B", "C"]


def _cell(ref: str, value: object) -> str:
    if value is None:
        return ""
    value = html.escape(str(value), quote=False)
    return f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>'


def _sheet_xml(rows: dict[int, dict[str, object]]) -> str:
    rendered = []
    for row_number in sorted(rows):
        cells = "".join(_cell(f"{column}{row_number}", value) for column, value in rows[row_number].items())
        rendered.append(f'<row r="{row_number}">{cells}</row>')
    max_row = max(rows)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<dimension ref="A1:C{max_row}"/><sheetData>{"".join(rendered)}</sheetData></worksheet>'
    )


def _xlsx(path: Path, sheets: list[tuple[str, dict[int, dict[str, object]]]]) -> None:
    workbook_sheets = []
    relationships = []
    content_types = [
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
        '<Default Extension="xml" ContentType="application/xml"/>',
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    ]
    for index, (name, rows) in enumerate(sheets, start=1):
        workbook_sheets.append(f'<sheet name="{html.escape(name, quote=True)}" sheetId="{index}" r:id="rId{index}"/>')
        relationships.append(
            f'<Relationship Id="rId{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index}.xml"/>'
        )
        content_types.append(
            f'<Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheets>{"".join(workbook_sheets)}</sheets></workbook>'
    )
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">{"".join(content_types)}</Types>',
        )
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>',
        )
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{"".join(relationships)}</Relationships>',
        )
        for index, (_, rows) in enumerate(sheets, start=1):
            archive.writestr(f"xl/worksheets/sheet{index}.xml", _sheet_xml(rows))


def _expenditure_rows(sheet_name: str) -> dict[int, dict[str, object]]:
    rows: dict[int, dict[str, object]] = {
        1: {"A": "AGENCY EXPENDITURES"},
        2: {"A": "Source: Fixture source note"},
        4: {"B": YEARS[0], "C": YEARS[1]},
    }
    blocks = [
        (6, "DEPARTMENT OF PARKS AND RECREATION", ["$1,234.500*", "2,345.000", "100.000", "(5.000)", "3,474.500"], ["1,100.000", "2,000.000", "80.000", "0", "3,020.000"]),
        (13, "Parks and Recreation", ["100.000", "200.000", "10.000", "0", "290.000"], ["90.000", "180.000", "5.000", "0", "265.000"]),
        (20, "Fixture Unresolved Agency", [None, "1,000.000", "—", "n/a", "1,000.000"], ["50.000", "900.000", "0", "0", "950.000"]),
    ]
    for row, agency, values_2022, values_2021 in blocks:
        rows[row] = {"A": agency}
        labels = ["Personal Services", "Other Than Personal Services", "less: intra-city", "prior year adjustments", "TOTAL DEPT."]
        for offset, (label, v22, v21) in enumerate(zip(labels, values_2022, values_2021), start=1):
            rows[row + offset] = {"A": label, "B": v22, "C": v21}
    rows[27] = {"A": "Citywide"}
    citywide = [
        ("Personal Services", "1,484.500", "1,240.000"),
        ("Other Than Personal Services", "3,545.000", "3,080.000"),
        ("less: intra-city", "110.000", "85.000"),
        ("prior year adjustments", "(5.000)", "0"),
        ("Total Citywide Expenditures", "4,764.500", "4,235.000"),
        ("Interfund Agreements", "4.500", "5.000"),
        ("Total Citywide Expenditures, less Interfund Agreements", "4,760.000", "4,230.000"),
    ]
    for offset, (label, v22, v21) in enumerate(citywide, start=1):
        rows[27 + offset] = {"A": label, "B": v22, "C": v21}
    if sheet_name != "In $000's":
        # The drift fixture changes only the selected-sheet name while keeping
        # its contents plausible; the manifest still requires In $000's.
        rows[2] = {"A": "Source: Fixture source note"}
    return rows


def _staffing_rows() -> dict[int, dict[str, object]]:
    rows: dict[int, dict[str, object]] = {
        1: {"A": "Actual Full-Time Positions"},
        2: {"A": "(reported as of June 30th for each year)"},
        3: {"A": "Source: Office of Management and Budget"},
        5: {"B": YEARS[0], "C": YEARS[1]},
        7: {"A": "DEPARTMENT OF PARKS AND RECREATION", "B": "1,000", "C": "1,100"},
        8: {"A": "Parks and Recreation", "B": "50", "C": "60"},
        9: {"A": "Fixture Unresolved Agency", "B": "10"},
        10: {"A": "   Total", "B": "1,060", "C": "1,160"},
    }
    return rows


def _manifest(expenditure_name: str, expenditure_hash: str) -> dict[str, object]:
    return {
        "schema": "cityscroll.ibo_fiscal_history_source_manifest.v1",
        "publisher": "Fixture IBO",
        "source_page_url": "https://example.invalid/ibo-fiscal-history",
        "retrieval_timestamp": "2026-01-02T03:04:05Z",
        "publisher_vintage": "fixture-v1",
        "workbooks": [
            {
                "id": "ibo_agency_expenditures",
                "title": "Agency Expenditures fixture",
                "path": expenditure_name,
                "sha256": expenditure_hash,
                "publisher_vintage": "fixture-v1",
                "sheets": ["DETAIL", "In $000's"],
                "sheet": "In $000's",
                "unit": "USD_thousands",
                "unit_label": "In $000's",
                "title_cell": "A1",
                "title": "AGENCY EXPENDITURES",
                "source_note_cell": "A2",
                "source_note_prefix": "Source:",
                "header_row": 4,
                "first_data_row": 6,
                "fiscal_years": YEARS,
            },
            {
                "id": "ibo_full_time_positions",
                "title": "Actual Full-Time Positions fixture",
                "path": "FullTimePositions.xlsx",
                "sha256": "PLACEHOLDER",
                "publisher_vintage": "fixture-v1",
                "sheets": ["ALL FUNDS"],
                "sheet": "ALL FUNDS",
                "unit": "positions",
                "unit_label": "positions",
                "title_cell": "A1",
                "title": "Actual Full-Time Positions",
                "source_note_cell": "A3",
                "source_note_prefix": "Source:",
                "definition_cell": "A2",
                "definition": "(reported as of June 30th for each year)",
                "header_row": 5,
                "first_data_row": 7,
                "fiscal_years": YEARS,
            },
        ],
    }


def main() -> None:
    normal = ROOT / "AgencyExpenditures.xlsx"
    drift = ROOT / "AgencyExpenditures.structural-drift.xlsx"
    staffing = ROOT / "FullTimePositions.xlsx"
    _xlsx(normal, [("DETAIL", {1: {"A": "AGENCY EXPENDITURES"}}), ("In $000's", _expenditure_rows("In $000's"))])
    _xlsx(drift, [("DETAIL", {1: {"A": "AGENCY EXPENDITURES"}}), ("In thousands", _expenditure_rows("In thousands"))])
    _xlsx(staffing, [("ALL FUNDS", _staffing_rows())])

    def sha(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    base = _manifest(normal.name, sha(normal))
    base["workbooks"][1]["sha256"] = sha(staffing)
    (ROOT / "manifest.json").write_text(json.dumps(base, indent=2) + "\n", encoding="utf-8")
    drift_manifest = _manifest(drift.name, sha(drift))
    drift_manifest["workbooks"][1]["sha256"] = sha(staffing)
    (ROOT / "manifest-structural-drift.json").write_text(json.dumps(drift_manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
