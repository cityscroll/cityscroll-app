"""Browser journey proof for the static consultation collection and detail pages."""

from __future__ import annotations

import argparse
import functools
import hashlib
import http.server
import json
import pathlib
import sys
import threading

ROOT = pathlib.Path(__file__).parents[2]
MANIFEST = ROOT / "docs/evidence/consultation-pages/browser-journey-manifest.json"
sys.path.insert(0, str(ROOT))
VIEWPORTS = {
    "desktop": {"width": 1200, "height": 900},
    "narrow-touch": {"width": 390, "height": 844},
}


def start_server() -> tuple[http.server.ThreadingHTTPServer, str]:
    from tools.local_site_server import QuietHandler, _RobustThreadingHTTPServer

    handler = functools.partial(QuietHandler, directory=str(ROOT / "site"))
    server = _RobustThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/"


def capture(page, base: str, case: str, route: str, assertion: str, expected_status: int = 200) -> dict[str, object]:
    response = page.goto(f"{base}{route.lstrip('/')}", wait_until="domcontentloaded")
    assert response and response.status == expected_status, f"{case}: status {response.status if response else 'none'}"
    content = page.locator("body").inner_text()
    return {
        "case": case,
        "route": route,
        "viewport": page.viewport_size,
        "assertion": assertion,
        "render_sha256": hashlib.sha256(content.encode()).hexdigest(),
    }


def healthy_journey(browser, base: str, viewport_name: str) -> dict[str, object]:
    context = browser.new_context(viewport=VIEWPORTS[viewport_name], has_touch=viewport_name == "narrow-touch")
    page = context.new_page()
    route = "/consultations/"
    result = capture(page, base, f"consultations-{viewport_name}-journey", route,
                     "Healthy served collection supports scope selection, inspection, dismissal, detail navigation, and Back.")
    assert page.locator('[data-consultation-count="6"]').count() == 1
    category = page.locator('select[name="category"]')
    category.focus()
    category.select_option("Community budget")
    assert page.evaluate("el => document.activeElement === el", category.element_handle())
    assert category.input_value() == "Community budget"
    page.keyboard.press("Tab")
    summary = page.locator("summary").first
    summary.focus()
    page.keyboard.press("Enter")
    details = summary.locator("xpath=..")
    assert details.get_attribute("open") is not None
    page.keyboard.press("Enter")
    assert details.get_attribute("open") is None
    page.locator('a[href^="/consultations/dot-coney-island-transportation-study/"]').first.click()
    assert page.url.endswith("/consultations/dot-coney-island-transportation-study/")
    page.go_back(wait_until="domcontentloaded")
    assert page.url.endswith(route)
    assert page.locator('[data-consultation-count="6"]').count() == 1
    context.close()
    return result


def no_javascript(browser, base: str, viewport_name: str) -> dict[str, object]:
    context = browser.new_context(viewport=VIEWPORTS[viewport_name], java_script_enabled=False)
    page = context.new_page()
    route = "/consultations/"
    result = capture(page, base, f"consultations-{viewport_name}-no-javascript", route,
                     "No-JavaScript collection remains inspectable and navigable through native links and disclosures.")
    assert page.locator("details").count() == 6
    page.locator('a[href^="/consultations/dot-coney-island-transportation-study/"]').first.click()
    page.go_back(wait_until="domcontentloaded")
    assert page.url.endswith(route)
    context.close()
    return result


def failed_enhancement(browser, base: str, viewport_name: str) -> dict[str, object]:
    context = browser.new_context(viewport=VIEWPORTS[viewport_name])
    page = context.new_page()
    page.route("**/*.mjs", lambda route: route.abort("failed"))
    route = "/consultations/"
    result = capture(page, base, f"consultations-{viewport_name}-failed-enhancement", route,
                     "Blocking enhancement resources leaves the served consultation journey usable with native document behavior.")
    assert page.locator('[data-consultation-count="6"]').count() == 1
    assert page.locator("details").count() == 6
    context.close()
    return result


def failed_detail(browser, base: str, viewport_name: str) -> dict[str, object]:
    context = browser.new_context(viewport=VIEWPORTS[viewport_name])
    page = context.new_page()
    route = "/consultations/missing-fixture/"
    result = capture(page, base, f"consultations-{viewport_name}-failed-detail", route,
                     "A missing consultation detail is bounded as a failed route response.", expected_status=404)
    assert "File not found" in page.locator("body").inner_text()
    context.close()
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--emit-json", action="store_true")
    args = parser.parse_args()
    from playwright.sync_api import sync_playwright

    server, base = start_server()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            captures = []
            for viewport_name in VIEWPORTS:
                captures.extend([
                    healthy_journey(browser, base, viewport_name),
                    no_javascript(browser, base, viewport_name),
                    failed_enhancement(browser, base, viewport_name),
                    failed_detail(browser, base, viewport_name),
                ])
            browser.close()
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        expected = {capture["case"]: capture for capture in manifest["captures"]}
        if args.emit_json:
            print(json.dumps(captures, indent=2))
            return
        assert len(expected) == len(captures)
        for capture_result in captures:
            recorded = expected[capture_result["case"]]
            assert recorded["route"] == capture_result["route"]
            assert recorded["render_sha256"] == capture_result["render_sha256"], capture_result["case"]
        print(f"OK consultation journey: {len(captures)} browser captures; 0 failures", flush=True)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
