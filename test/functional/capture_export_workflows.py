#!/usr/bin/env python3
"""Capture and verify export controls and print-media output at review widths."""

from __future__ import annotations

import argparse
import functools
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "docs" / "screenshots" / "export-workflows"
VIEWPORTS = ((390, 844), (1440, 900))
NOTICES = [
    {
        "request_id": "001234",
        "start_date": "2026-07-27T00:00:00.000",
        "due_date": "2026-08-10T12:00:00.000",
        "agency_name": "Department of Community Affairs",
        "type_of_notice_description": "Solicitation",
        "category_description": "Goods and Services",
        "short_title": "社区中心翻新服务",
        "pin": "000077",
        "selection_method_description": "Competitive Sealed Bidding",
        "additional_description_1": "Renovation services for a neighborhood community center.",
        "contract_amount": "1250.50",
        "vendor_name": "Acme LLC",
    },
    {
        "request_id": "AR-7",
        "start_date": "2026-07-26T00:00:00.000",
        "due_date": "2026-08-12T12:00:00.000",
        "agency_name": "Public Engagement Office",
        "type_of_notice_description": "Solicitation",
        "category_description": "Human Services",
        "short_title": "اجتماع عام وخدمات الترجمة",
        "pin": "AR0007",
        "selection_method_description": "Request for Proposals",
        "additional_description_1": "Interpretation services for public meetings.",
        "contract_amount": "900.25",
        "vendor_name": "مؤسسة أكمي",
    },
]


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        pass


class StaticServer:
    def __init__(self, directory: Path):
        handler = functools.partial(QuietHandler, directory=str(directory))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_port}/"

    def __exit__(self, *_exc: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()


def revision_snapshot(revision: str, destination: Path) -> None:
    archive = subprocess.run(
        ["git", "archive", "--format=tar", revision],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    ).stdout
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as tar:
        tar.extractall(destination)


def json_response(route: Route, body: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def install_routes(page: Page) -> None:
    page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("https://fonts.gstatic.com/**", lambda route: route.abort())
    page.route("https://static.cloudflareinsights.com/**", lambda route: route.abort())
    page.route("https://challenges.cloudflare.com/**", lambda route: route.abort())

    def city_data(route: Route) -> None:
        query = {
            key: values[0]
            for key, values in parse_qs(urlparse(route.request.url).query).items()
        }
        select = query.get("$select", "")
        where = query.get("$where", "")
        if "min(start_date) as a" in select:
            json_response(route, [{"a": "2003-01-01T00:00:00.000", "b": "2026-07-27T00:00:00.000"}])
        elif select == "agency_name":
            json_response(route, [{"agency_name": row["agency_name"]} for row in NOTICES])
        elif select.startswith("request_id,start_date,agency_name"):
            rows = NOTICES
            if "request_id=" in where:
                rows = [row for row in rows if row["request_id"] in where]
            json_response(route, rows)
        else:
            json_response(route, [])

    page.route("https://data.cityofnewyork.us/**", city_data)
    page.route("https://api.cityscroll.org/**", lambda route: json_response(route, {}))
    page.route("https://crol-worker.crol-worker.workers.dev/**", lambda route: json_response(route, {}))


def annotate(page: Page, selector: str, label: str) -> None:
    page.evaluate(
        """
        ({selector,label}) => {
          const target=document.querySelector(selector);
          const rect=target.getBoundingClientRect();
          const left=Math.max(5,rect.left-6), top=Math.max(48,rect.top-6);
          const width=Math.min(innerWidth-left-5,rect.width+12);
          const mark=document.createElement("div");
          Object.assign(mark.style,{position:"fixed",left:`${left}px`,top:`${top}px`,
            width:`${width}px`,height:`${rect.height+12}px`,border:"4px solid #d60000",
            borderRadius:"8px",boxSizing:"border-box",zIndex:"99998",pointerEvents:"none"});
          const note=document.createElement("div");
          note.textContent=label;
          Object.assign(note.style,{position:"fixed",left:`${left}px`,top:`${Math.max(5,top-43)}px`,
            maxWidth:`${width}px`,background:"#d60000",color:"#fff",padding:"7px 10px",
            borderRadius:"5px",font:"800 12px/1.25 system-ui,sans-serif",zIndex:"99999",
            pointerEvents:"none"});
          document.body.append(mark,note);
        }
        """,
        {"selector": selector, "label": label},
    )


def ready_money(page: Page, base_url: str) -> None:
    install_routes(page)
    page.goto(base_url + "#money?mode=open&q=community", wait_until="domcontentloaded")
    page.locator("#list .row").first.wait_for(state="visible")


def capture_state(browser, tree: Path, state: str, width: int, height: int) -> None:
    with StaticServer(tree) as base_url:
        page = browser.new_page(viewport={"width": width, "height": height})
        ready_money(page, base_url)
        selector = "#tab-money .panelbar .export-actions" if state == "after" else "#export"
        page.locator(selector).scroll_into_view_if_needed()
        page.evaluate("window.scrollBy(0,-120)")
        page.screenshot(path=str(OUTPUT / f"{state}-{width}.png"), animations="disabled")
        annotate(
            page,
            selector,
            "AFTER · CSV, EXCEL, AND PRINT/PDF" if state == "after"
            else "BEFORE · CSV ONLY ON CONTRACTS",
        )
        page.screenshot(path=str(OUTPUT / f"{state}-{width}-annotated.png"), animations="disabled")
        page.close()


def verify_after(browser, base_url: str, width: int, height: int) -> None:
    page = browser.new_page(viewport={"width": width, "height": height})
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    ready_money(page, base_url)

    for control in page.locator(
        '[data-export-csv="money"], [data-export-xlsx="money"], [data-print-view="money"]'
    ).all():
        box = control.bounding_box()
        assert box and box["width"] >= 44 and box["height"] >= 44, box

    with page.expect_download() as download_info:
        page.locator('[data-export-csv="money"]').click()
    csv = Path(download_info.value.path()).read_bytes()
    assert csv.startswith(b"\xef\xbb\xbf")
    assert b"\r\n" in csv and b"\n" not in csv.replace(b"\r\n", b"")
    text = csv.decode("utf-8-sig")
    assert "001234" in text and "社区中心" in text and "اجتماع عام" in text

    with page.expect_download() as download_info:
        page.locator('[data-export-xlsx="money"]').click()
    list_xlsx = Path(download_info.value.path()).read_bytes()
    assert list_xlsx.startswith(b"PK\x03\x04")
    assert "社区中心".encode() in list_xlsx

    page.wait_for_function("!document.querySelector('#dxlsx').disabled")
    with page.expect_download() as download_info:
        page.locator("#dxlsx").click()
    assert Path(download_info.value.path()).read_bytes().startswith(b"PK\x03\x04")

    page.evaluate(
        "window.__printCalls=0;"
        "Object.defineProperty(window,'print',{value:()=>window.__printCalls++,configurable:true})"
    )
    page.locator('[data-print-view="money"]').click()
    assert page.evaluate("window.__printCalls") == 1
    meta = page.get_attribute("body", "data-print-meta") or ""
    assert "#money?mode=open&q=community" in meta and "2026" in meta

    page.emulate_media(media="print")
    assert page.locator("header.masthead").evaluate("el=>getComputedStyle(el).display") == "none"
    assert page.locator("#tab-money .export-actions").evaluate("el=>getComputedStyle(el).display") == "none"
    assert page.locator("#tab-people").evaluate("el=>getComputedStyle(el).display") == "none"
    assert page.locator("#list").evaluate("el=>getComputedStyle(el).maxHeight") == "none"
    page.evaluate("scrollTo(0,0)")
    print_path = OUTPUT / f"print-{width}.png"
    page.screenshot(path=str(print_path), full_page=True, animations="disabled")
    annotate(page, "body", "PRINT · PERMALINK + AS-OF DATE, NO SITE CHROME")
    page.screenshot(path=str(OUTPUT / f"print-{width}-annotated.png"), full_page=True, animations="disabled")
    assert not errors, errors
    page.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", default="HEAD", help="revision before export controls")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="crol-export-workflows-") as temp:
        before = Path(temp) / "before"
        before.mkdir()
        revision_snapshot(args.before, before)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for width, height in VIEWPORTS:
                    capture_state(browser, before, "before", width, height)
                    capture_state(browser, ROOT, "after", width, height)
                with StaticServer(ROOT) as base_url:
                    for width, height in VIEWPORTS:
                        verify_after(browser, base_url, width, height)
            finally:
                browser.close()
    for asset in sorted(OUTPUT.glob("*.png")):
        assert asset.stat().st_size > 8_000, asset
        print(f"{asset.relative_to(ROOT)}  {asset.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
