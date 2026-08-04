import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "warehouse/lib"))

from nycedc_projects import (  # noqa: E402
    extract_annual_spreadsheet,
    extract_board_minutes_text,
    extract_index_documents,
    extract_notice_projects,
    measurement_receipt,
    sha256_bytes,
)


def document(kind="board_minutes"):
    return {
        "authority": "nycida",
        "document_type": kind,
        "title": "March 24, 2026 NYCIDA Board Meeting Minutes",
        "source_url": "https://edc.nyc/sites/default/files/test.pdf",
        "index_url": "https://edc.nyc/nycida/financial-public-documents",
        "content_sha256": "a" * 64,
        "observed_at": "2026-08-04T00:00:00Z",
    }


class NycedcProjectsTest(unittest.TestCase):
    def test_index_discovery_allows_only_official_documents(self):
        rows = extract_index_documents(
            """
            <a href="/sites/default/files/fy25.xlsx">FY2025 Project Info Spreadsheet</a>
            <a href="https://edc.nyc/sites/default/files/minutes.pdf">Board Meeting Minutes</a>
            <a href="https://example.com/board-minutes.pdf">Board Meeting Minutes</a>
            """,
            "https://edc.nyc/about-nycedc/financial-public-documents-recordings",
            "nycedc",
        )
        self.assertEqual([row["document_type"] for row in rows], ["annual_project_spreadsheet", "board_minutes"])
        self.assertTrue(all(row["source_url"].startswith("https://edc.nyc/") for row in rows))

    def test_multisheet_xlsx_uses_data_headers_not_readme(self):
        workbook = """<?xml version="1.0"?>
        <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <sheets><sheet name="ReadMe" sheetId="1" r:id="rId1"/><sheet name="Project Data" sheetId="2" r:id="rId2"/></sheets>
        </workbook>"""
        rels = """<?xml version="1.0"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/>
          <Relationship Id="rId2" Target="worksheets/sheet2.xml" Type="worksheet"/>
        </Relationships>"""

        def sheet(rows):
            xml_rows = []
            for row_number, values in enumerate(rows, 1):
                cells = []
                for column, value in enumerate(values):
                    ref = f"{chr(65 + column)}{row_number}"
                    cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>')
                xml_rows.append(f'<row r="{row_number}">{"".join(cells)}</row>')
            return (
                '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                f'<sheetData>{"".join(xml_rows)}</sheetData></worksheet>'
            )

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "projects.xlsx"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("xl/workbook.xml", workbook)
                archive.writestr("xl/_rels/workbook.xml.rels", rels)
                archive.writestr("xl/worksheets/sheet1.xml", sheet([["Read this first"]]))
                archive.writestr(
                    "xl/worksheets/sheet2.xml",
                    sheet([["Project ID", "Project Name", "Street Address", "Total Project Amount"], ["11734", "F&amp;F Hardware", "1275 Oak Point Avenue", "25137585"]]),
                )
            source = {**document("annual_project_spreadsheet"), "content_sha256": sha256_bytes(path.read_bytes())}
            rows = extract_annual_spreadsheet(path, source)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["project_name"], "F&F Hardware")
        self.assertEqual(rows[0]["project_cost"], 25137585)
        self.assertEqual(rows[0]["provenance"]["source_locator"], "Project-Data!row-2")

    def test_outcome_requires_explicit_motion_and_vote(self):
        scheduled = """NEW YORK CITY INDUSTRIAL DEVELOPMENT AGENCY March 24, 2026
        5. Example Storage LLC
        The project was presented for a scheduled public hearing.
        6. Adjournment"""
        approved = scheduled.replace(
            "The project was presented for a scheduled public hearing.",
            "The project was presented. A motion to approve was made, seconded and unanimously approved.",
        )
        self.assertIsNone(extract_board_minutes_text(scheduled, document())[0]["milestones"]["board_decision"]["outcome"])
        self.assertEqual(extract_board_minutes_text(approved, document())[0]["milestones"]["board_decision"]["outcome"], "approved")

    def test_reviewed_bridge_accepts_and_below_threshold_kills(self):
        fixture = json.loads((ROOT / "warehouse/fixtures/nycedc-project-documents/sample.json").read_text())
        projects = []
        documents = []
        for raw in fixture["documents"]:
            source = {
                **document(),
                "authority": raw["authority"],
                "title": raw["title"],
                "source_url": raw["source_url"],
                "index_url": raw["index_url"],
                "content_sha256": sha256_bytes(raw["text"].encode()),
            }
            documents.append(source)
            projects.extend(extract_board_minutes_text(raw["text"], source))
        mentions = [mention for notice in fixture["notices"] for mention in extract_notice_projects(notice)]
        receipt, edges = measurement_receipt(
            notice_projects=mentions,
            source_projects=projects,
            reviews=fixture["reviews"],
            documents=documents,
            observed_at=fixture["observed_at"],
        )
        self.assertEqual(receipt["bridge_status"], "accepted")
        self.assertEqual(receipt["false_positive_review"]["false_positives"], 0)
        self.assertEqual(len(edges), 5)

        diluted = mentions + [
            {**mentions[0], "notice_project_key": f"absent:{i}", "project_name": f"Unmatched {i}"}
            for i in range(15)
        ]
        killed, killed_edges = measurement_receipt(
            notice_projects=diluted,
            source_projects=projects,
            reviews=fixture["reviews"],
            documents=documents,
            observed_at=fixture["observed_at"],
        )
        self.assertEqual(killed["bridge_status"], "killed")
        self.assertEqual(killed_edges, [])
        self.assertEqual(killed["honest_absent"], 15)


if __name__ == "__main__":
    unittest.main()
