#!/usr/bin/env python3
"""Capture and verify Rules status-chip behavior at review viewport widths.

The current checkout is the "after" state. The parent revision is archived as "before":

    python3 test/functional/capture_rules_status_chips.py
"""

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

from playwright.sync_api import Browser, Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "docs" / "screenshots" / "rules-status-chips"
VIEWPORTS = ((390, 844), (1440, 900))
RULES_NOTICE = {
    "request_id": "2026RTEST001",
    "start_date": "2026-07-31T12:00:00.000",
    "agency_name": "Department of Buildings",
    "type_of_notice_description": "Notice of Rule Changes",
    "section_name": "Agency Rules",
    "short_title": "Sidewalk Café permit rule amendment",
    "event_date": "2026-08-12T00:00:00.000",
    "additional_description_1": "A proposal to amend an agency rule for sidewalk café operations.",
}
RULES_VIEW = {
    "rules": [
        {
            "request_id": "2026RTEST001",
            "stage": "comment-open",
            "nyc_rules": {
                "comment_url": "https://rules.example/comment",
                "comment_by_date": "2026-08-10T12:00:00.000",
                "url": "https://rules.example/record",
            },
        },
        {
            "request_id": "2026RTEST002",
            "stage": "garbage",
            "nyc_rules": {
                "url": "https://rules.example/unknown",
            },
        },
    ],
}
REMOTE_RULES = {
    "https://rules.example/comment": "<!doctype html><h1>Comment page</h1>",
    "https://rules.example/record": "<!doctype html><h1>Rule record</h1>",
    "https://rules.example/unknown": "<!doctype html><h1>Unknown record</h1>",
}
ROUTE_HITS = {"rules": 0, "city": 0, "comment": 0}


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
    result = subprocess.run(
        ["git", "archive", "--format=tar", revision],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    )
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:") as archive:
        archive.extractall(destination)


def json_response(route: Route, body: object) -> None:
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))


def html_response(route: Route, body: str) -> None:
    route.fulfill(status=200, content_type="text/html", body=body)


def install_routes(page: Page) -> None:
    page.route("https://fonts.googleapis.com/**", lambda route: route.abort())
    page.route("https://fonts.gstatic.com/**", lambda route: route.abort())
    page.route("https://static.cloudflareinsights.com/**", lambda route: route.abort())

    def city_data(route: Route) -> None:
        ROUTE_HITS["city"] += 1
        query = parse_qs(urlparse(route.request.url).query)
        if "section_name" in query and "Agency Rules" in (query["section_name"][0] or ""):
            json_response(route, [RULES_NOTICE])
        elif "$where" in query and "Agency Rules" in (query["$where"][0] or ""):
            json_response(route, [RULES_NOTICE])
        else:
            json_response(route, [])

    def worker_data(route: Route) -> None:
        parsed = urlparse(route.request.url)
        if parsed.path.endswith("/rules"):
            ROUTE_HITS["rules"] += 1
            if route.request.url.startswith("https://api.cityscroll.org"):
                return json_response(route, RULES_VIEW)
            if route.request.url.startswith("https://crol-worker.crol-worker.workers.dev"):
                return json_response(route, RULES_VIEW)
        if route.request.url in REMOTE_RULES:
            ROUTE_HITS["comment"] += 1
            return html_response(route, REMOTE_RULES[route.request.url])
        return route.continue_()

    def local_comments(route: Route) -> None:
        if route.request.url in REMOTE_RULES:
            html_response(route, REMOTE_RULES[route.request.url])
        else:
            route.continue_()

    page.route("https://data.cityofnewyork.us/**", city_data)
    page.route("https://api.cityscroll.org/**", worker_data)
    page.route("https://crol-worker.crol-worker.workers.dev/**", worker_data)
    page.route("https://rules.example/**", local_comments)


def annotate(page: Page, selector: str, label_text: str) -> None:
    page.evaluate(
        """
        ({selector, labelText}) => {
          const target=document.querySelector(selector);
          if(!target) return;
          const rect=target.getBoundingClientRect();
          const left=Math.max(5, rect.left - 7);
          const top=Math.max(52, rect.top - 7);
          const width=Math.min(innerWidth - left - 5, rect.width + 14);
          const height=Math.min(innerHeight - top - 5, rect.height + 14);

          const mark=document.createElement("div");
          mark.className="review-annotation";
          Object.assign(mark.style, {
            position:"fixed", left:`${left}px`, top:`${top}px`,
            width:`${width}px`, height:`${height}px`,
            border:"4px solid #d60000", borderRadius:"10px",
            boxSizing:"border-box", zIndex:"99998", pointerEvents:"none"
          });
          const label=document.createElement("div");
          label.className="review-annotation";
          label.textContent=labelText;
          Object.assign(label.style, {
            position:"fixed", left:`${left}px`, top:`${Math.max(5, top - 43)}px`,
            maxWidth:`${Math.min(width, innerWidth - left - 5)}px`,
            background:"#d60000", color:"#fff", padding:"7px 10px",
            borderRadius:"5px", font:"800 12px/1.25 system-ui,sans-serif",
            zIndex:"99999", pointerEvents:"none"
          });
          document.body.append(mark, label);
        }
        """,
        {"selector": selector, "labelText": label_text},
    )


def capture(browser: Browser, tree: Path, state: str, width: int, height: int) -> None:
    with StaticServer(tree) as base_url:
        page = browser.new_page(viewport={"width": width, "height": height})
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page)
        page.goto(base_url + "#rules", wait_until="domcontentloaded")
        page.locator("#rulesfeed .fcard").first.wait_for(state="visible")
        if state == "before":
            selector = "#rulesfeed .fcard"
            label = "BEFORE — Rules feed shows lifecycle metadata after pre-existing rendering"
        else:
            selector = "#rulesfeed .tag.asset, #rulesfeed .tag.urgency, #rulesfeed .tag.soon, #rulesfeed .tag.hot, #rulesfeed .tag.closed"
            label = "AFTER — Status chip + comment CTA appear in Rules feed row"
            row = page.locator("#rulesfeed .fcard").first
            act = row.locator('.factions .act[href*="rules.example/comment"]')
            act_count = act.count()
            if act_count < 1:
                html = row.inner_html()
                print("ASSERT_FAIL_AFTER_NO_COMMENT_ACTION", html[:2000])
                print("route hits", ROUTE_HITS)
                all_acts = row.locator(".factions .act").all_text_contents()
                print("acts", all_acts)
                raise AssertionError(f"expected comment action, got {act_count}")

        # Ensure no blank/unhandled JS errors in either state.
        assert not errors, errors
        if selector:
            page.locator(selector).first.wait_for(state="visible")
            # For before, selector can be the card itself to keep annotation deterministic.
            annotate(page, selector, label)
        raw = OUTPUT / f"{state}-{width}.png"
        page.screenshot(path=str(raw), animations="disabled")
        page.locator(selector).first.screenshot(path=str(OUTPUT / f"{state}-{width}-focus.png"), animations="disabled")
        annotated = OUTPUT / f"{state}-{width}-annotated.png"
        page.screenshot(path=str(annotated), animations="disabled")
        assert raw.stat().st_size > 10_000
        assert annotated.stat().st_size > 10_000
        page.close()


def verify_interactions(browser: Browser) -> None:
    with StaticServer(ROOT) as base_url:
        context = browser.new_context(viewport={"width": 390, "height": 844})
        context.route("https://rules.example/**", lambda route: html_response(route, "<!doctype html><h1>Rule detail</h1>"))
        page = context.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        install_routes(page)
        page.goto(base_url + "#rules", wait_until="domcontentloaded")
        page.locator("#rulesfeed .fcard").first.wait_for(state="visible")

        card = page.locator("#rulesfeed .fcard").first
        chip = card.locator("a.tag[href*='rules.example']").first
        act = card.locator('.factions .act[href*="rules.example/comment"]').first
        assert chip.count() == 1
        assert act.count() == 1

        with page.expect_popup() as popup_info:
            chip.click()
        popup = popup_info.value
        popup.wait_for_load_state("domcontentloaded")
        assert (
            popup.url == "about:blank" or popup.url == "https://rules.example/comment"
            or popup.url.startswith("https://rules.example/comment")
        )
        popup.close()

        with page.expect_popup() as action_popup_info:
            act.click()
        action_popup = action_popup_info.value
        action_popup.wait_for_load_state("domcontentloaded")
        assert (
            action_popup.url == "about:blank" or action_popup.url == "https://rules.example/comment"
            or action_popup.url.startswith("https://rules.example/comment")
        )
        action_popup.close()
        assert not errors, errors
        context.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--before",
        default="HEAD",
        help="Git revision to snapshot for the before state.",
    )
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="crol-rules-status-") as temp:
        before_tree = Path(temp) / "before"
        before_tree.mkdir()
        revision_snapshot(args.before, before_tree)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for width, height in VIEWPORTS:
                    capture(browser, before_tree, "before", width, height)
                    capture(browser, ROOT, "after", width, height)
                verify_interactions(browser)
            finally:
                browser.close()

    print("Rules status-chip browser checks passed.")
    print(f"route hits: city={ROUTE_HITS['city']} rules={ROUTE_HITS['rules']} comment={ROUTE_HITS['comment']}")
    for asset in sorted(OUTPUT.glob("*.png")):
        print(f"  {asset.relative_to(ROOT)}  {asset.stat().st_size / 1024:.1f} KiB")


if __name__ == "__main__":
    main()
