#!/usr/bin/env python3
"""Staffing same-except-name collapse, per-person reachability, and export census."""
from __future__ import annotations

import functools
import http.server
import json
import pathlib
import re
import sys
import threading
from urllib.parse import unquote_plus
import zipfile

ROOT = pathlib.Path(__file__).parents[2]
sys.path.insert(0, str(pathlib.Path(__file__).parent / "assets"))
from i18n_fixtures import install_routes  # noqa: E402


def personnel(request_id: str, name: str, **overrides):
    values = {
        "request_id": request_id,
        "start_date": "2026-01-02T00:00:00.000",
        "agency_name": "BOARD OF ELECTION POLL WORKERS",
        "short_title": "APPOINTED",
        "effective_date": "01/01/2026",
        "provisional": "No",
        "title_code": "9POLL",
        "salary": "1.00",
        "name": name,
    }
    values.update(overrides)
    values["additional_description_1"] = (
        f"Effective Date: {values['effective_date']}; "
        f"Provisional Status: {values['provisional']}; "
        f"Title Code: {values['title_code']}; "
        "Reason For Change: APPOINTED; "
        f"Salary: {values['salary']}; Employee Name: {values['name']}"
    )
    return {key: value for key, value in values.items() if key not in {
        "effective_date", "provisional", "title_code", "salary", "name"
    }}


POLL_ROWS = [
    personnel(str(990000 + index), f"WORKER,{index:02d}")
    for index in range(1, 63)
]
DISTINCT_ROWS = [
    personnel("991001", "ANALYST,A", agency_name="CITY COUNCIL", title_code="10026", salary="77744.00"),
    personnel("991002", "SPECIALIST,B", agency_name="YOUTH AND COMMUNITY DEVELOPMENT", title_code="52287", salary="55075.00"),
    personnel("991003", "OFFICER,C", agency_name="POLICE DEPARTMENT", title_code="70210", salary="55942.00"),
]
ROWS = POLL_ROWS + DISTINCT_ROWS
TITLE_CROSSWALK = [
    {"title_code": "9POLL", "official_title": "BOARD OF ELECTION POLL WORKERS"},
    {"title_code": "10026", "official_title": "ADMINISTRATIVE STAFF ANALYST"},
    {"title_code": "52287", "official_title": "YOUTH DEVELOPMENT SPECIALIST"},
    {"title_code": "70210", "official_title": "POLICE OFFICER"},
]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        route = self.path.split("?", 1)[0].rstrip("/")
        if route == "/browse" or route.startswith("/browse/"):
            self.path = "/index.html"
        super().do_GET()


def fixed(body):
    return lambda route: route.fulfill(
        status=200, content_type="application/json", body=json.dumps(body)
    )


def install_staffing_routes(page):
    install_routes(page)
    page.route("**/data/staffing_default_hires.json", fixed({"count": len(ROWS), "notices": ROWS}))
    page.route("**/data/title_crosswalk.json", fixed(TITLE_CROSSWALK))

    def staffing_soda(route):
        if "Changes in Personnel" in unquote_plus(route.request.url):
            route.fulfill(status=200, content_type="application/json", body=json.dumps(ROWS))
        else:
            route.fallback()

    page.route("https://data.cityofnewyork.us/resource/dg92-zbpx.json*", staffing_soda)


def run(page, downloads: pathlib.Path):
    page.goto(page.url.split("#", 1)[0] + "#people?view=guide", wait_until="load")
    page.locator("#staffing-ledger").evaluate("el => { el.open = true; }")
    group = page.locator("#staffing-notice-list .staffing-hire-group")
    group.wait_for(state="visible")

    assert page.locator("#staffing-result-count").inner_text() == "65 appointments shown"
    assert group.count() == 1
    assert group.get_attribute("data-group-count") == "62"
    assert page.locator("#staffing-notice-list .staffing-hire-row").count() == 3
    assert "BOARD OF ELECTION POLL WORKERS — 62 appointed" in group.inner_text()
    assert "Effective January 1, 2026" in group.inner_text()
    assert "$1 stipend" in group.inner_text()
    assert "Title code 9POLL" in group.inner_text()

    group.locator("summary").click()
    names = group.locator(".staffing-hire-group-names li")
    assert names.count() == 62
    first_link = names.first.locator("a")
    assert "WORKER,01" in first_link.inner_text()
    assert first_link.get_attribute("href") == "https://a856-cityrecord.nyc.gov/RequestDetail/990001"

    with page.expect_download() as csv_info:
        page.locator('[data-export-csv="people"]').first.click()
    csv_path = downloads / "appointments.csv"
    csv_info.value.save_as(csv_path)
    csv_lines = csv_path.read_text(encoding="utf-8-sig").splitlines()
    assert len(csv_lines) == 66, "CSV must retain one header plus all 65 appointments"

    with page.expect_download() as xlsx_info:
        page.locator('[data-export-xlsx="people"]').first.click()
    xlsx_path = downloads / "appointments.xlsx"
    xlsx_info.value.save_as(xlsx_path)
    with zipfile.ZipFile(xlsx_path) as workbook:
        sheet = workbook.read("xl/worksheets/sheet1.xml").decode("utf-8")
    assert len(re.findall(r"<row\b", sheet)) == 66, "Excel must retain one header plus all 65 appointments"

    page.locator("#staffing-query").fill("WORKER,01")
    page.locator("#staffing-query").dispatch_event("input")
    page.wait_for_function(
        "document.querySelectorAll('#staffing-notice-list .staffing-hire-row').length === 1"
    )
    assert page.locator("#staffing-notice-list .staffing-hire-group").count() == 0
    row = page.locator("#staffing-notice-list .staffing-hire-row")
    rendered_text = row.inner_text()
    glued_boundaries = (
        r"\b\d{5}(?=[A-Z][A-Z,' .-]{2,})",
        r"\$\d[\d,]*(?:\.\d{2})?(?=\d{4}-\d{2}-\d{2}\b)",
    )
    assert not any(re.search(pattern, rendered_text) for pattern in glued_boundaries), (
        f"appointment fields are concatenated in rendered text: {rendered_text!r}"
    )
    assert row.locator(".staffing-hire-field").count() == 6
    labels = row.locator("dt").all_inner_texts()
    assert labels == [
        "NAME", "TITLE CODE", "AGENCY", "EFFECTIVE", "SALARY", "POSTED",
    ], labels
    assert row.locator("a").count() == 1, "the record link must not wrap the whole row"
    assert row.locator(".staffing-hire-person-field a").get_attribute("href") == (
        "https://a856-cityrecord.nyc.gov/RequestDetail/990001"
    )


def main():
    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(accept_downloads=True)
            page = context.new_page()
            install_staffing_routes(page)
            page.goto(base, wait_until="load")
            run(page, ROOT / ".tmp-same-consolidation")
            browser.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    temp = ROOT / ".tmp-same-consolidation"
    temp.mkdir(exist_ok=True)
    try:
        main()
    finally:
        for path in temp.glob("*"):
            path.unlink()
        temp.rmdir()
