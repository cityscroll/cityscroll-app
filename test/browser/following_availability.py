"""Rendered browser journeys for the resident meeting-availability controls."""

from __future__ import annotations

import functools
import json
import os
import subprocess
import sys
import threading
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Page, Route, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "test" / "functional" / "assets"))
sys.path.insert(0, str(ROOT))

from fixture_clock import fixture_today, pin_fixture_clock  # noqa: E402
from tools.local_site_server import QuietHandler, _RobustThreadingHTTPServer  # noqa: E402


NODE_RENDERER = r'''
import { buildFollowingViewModel, renderFollowingDocument, watchFromFollowingParams } from "./site/following_view.mjs";

const params = new URLSearchParams(process.argv[1] || "");
const parsed = watchFromFollowingParams(params);
const availabilityCounts = parsed.filter?.availability ? { unknown_start: 2 } : null;
const view = buildFollowingViewModel({
  ...parsed,
  requested: true,
  previewItems: [{ id: "fixture-meeting", title: "Fixture meeting", url: "/notices/fixture-meeting/" }],
  matchCount: 1,
  availabilityCounts,
});
process.stdout.write(renderFollowingDocument(view));
'''


def render_document(query: str) -> str:
    return subprocess.check_output(
        ["node", "--input-type=module", "-e", NODE_RENDERER, query],
        cwd=ROOT,
        text=True,
    )


class FollowingFixtureHandler(QuietHandler):
    def do_GET(self) -> None:
        path, _, query = self.path.partition("?")
        if path.rstrip("/") == "/following":
            html = render_document(query).replace(
                "https://cityscroll.org/following",
                f"http://{self.headers['Host']}/following",
            )
            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def serve_site() -> tuple[_RobustThreadingHTTPServer, str]:
    handler = functools.partial(FollowingFixtureHandler, directory=str(ROOT / "site"))
    server = _RobustThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_port}"


def install_routes(page: Page) -> None:
    def api(route: Route) -> None:
        path = urlsplit(route.request.url).path
        if path == "/following/personal":
            route.fulfill(
                status=200,
                headers={"Content-Type": "text/html; charset=utf-8"},
                body='<div data-session-recognized="true" data-personal-state="empty"></div>',
            )
            return
        if path == "/subscribe" and route.request.method == "POST":
            route.fulfill(
                status=200,
                headers={"Content-Type": "application/json"},
                body=json.dumps({"ok": True}),
            )
            return
        route.fulfill(status=404, body="{}")

    page.route("https://api.cityscroll.org/**", api)
    page.route("https://data.cityofnewyork.us/**", lambda route: route.abort())


def open_following(page: Page, base: str, query: str = "lens=meetings") -> None:
    page.goto(f"{base}/following/?{query}", wait_until="domcontentloaded", timeout=30_000)
    page.locator("[data-following-availability]").wait_for(state="visible", timeout=30_000)


def assert_accessible_controls(page: Page) -> None:
    field = page.locator("[data-following-availability]")
    assert field.locator("legend").first.inner_text() == "Meeting availability"
    assert field.locator("input[type=radio]").count() == 3
    assert page.locator("p[data-following-preview-status]").get_attribute("role") == "status"
    assert page.get_by_label("Timezone").count() == 1
    assert page.get_by_label("Meetings without a start time").count() == 1


def assert_touch_targets(page: Page) -> None:
    heights = page.locator(".following-availability-option").evaluate_all(
        "els => els.map(el => Math.round(el.getBoundingClientRect().height))"
    )
    assert heights and min(heights) >= 44, heights


def wait_for_preview(page: Page) -> None:
    page.locator("p[data-following-preview-status]").wait_for(state="visible", timeout=30_000)
    page.wait_for_function(
        "() => document.querySelector('p[data-following-preview-status]')?.textContent.includes('Preview updated.')",
        timeout=30_000,
    )


def run_journeys(base: str) -> None:
    offset = int(os.environ.get("CITYSCROLL_TEST_DAY_OFFSET", "0"))
    pinned_day = (date.fromisoformat(fixture_today()) + timedelta(days=offset)).isoformat()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True)
        pin_fixture_clock(context, pinned_day)
        page = context.new_page()
        install_routes(page)
        open_following(page, base)

        # A3: the artifact renders the actual view and exposes keyboard/a11y controls.
        assert page.locator("[data-following-root]").is_visible()
        assert_accessible_controls(page)
        assert_touch_targets(page)
        preset = page.get_by_label("Evenings and weekends")
        preset.focus()
        page.keyboard.press("Space")
        assert preset.is_checked(), "keyboard activation did not select the preset"
        page.locator("[data-following-availability-summary]").wait_for(state="visible")
        assert "Weekdays from 17:00" in page.locator("[data-following-availability-summary]").inner_text()
        wait_for_preview(page)
        assert "2 meetings without a start time excluded" in page.locator(
            "[data-following-availability-result]"
        ).inner_text()

        # A3: save, reload, and edit keep the canonical availability expression.
        page.get_by_label("Email address").fill("resident@example.test")
        page.get_by_role("button", name="Create watch").click()
        page.get_by_text("You're subscribed — we'll email you.").wait_for(state="visible", timeout=30_000)
        page.reload(wait_until="domcontentloaded", timeout=30_000)
        page.locator("[data-following-availability]").wait_for(state="visible", timeout=30_000)
        assert page.get_by_label("Evenings and weekends").is_checked()

        page.get_by_label("Custom weekly schedule").check()
        page.get_by_label("Monday").check()
        page.locator('input[data-following-availability-day][value="6"]').check()
        for day in ("0", "2", "3", "4", "5"):
            page.locator(f'input[data-following-availability-day][value="{day}"]').uncheck()
        page.get_by_label("Starts at").fill("18:00")
        page.get_by_label("Ends before").fill("21:00")
        page.get_by_label("Timezone").select_option("America/Chicago")
        page.get_by_label("Meetings without a start time").select_option("include")
        wait_for_preview(page)
        assert page.get_by_label("Custom weekly schedule").is_checked()
        assert page.get_by_label("Monday").is_checked()
        assert page.locator('input[data-following-availability-day][value="6"]').is_checked()
        assert page.get_by_label("Starts at").input_value() == "18:00"
        assert page.get_by_label("Ends before").input_value() == "21:00"
        assert page.get_by_label("Timezone").input_value() == "America/Chicago"
        assert page.get_by_label("Meetings without a start time").input_value() == "include"

        # A2: Back restores the entered form, rather than silently returning to a blank state.
        page.locator('[data-following-tab="watches"]').click()
        page.wait_for_function("() => location.hash === '#your-following'", timeout=30_000)
        page.go_back(wait_until="domcontentloaded", timeout=30_000)
        page.locator("[data-following-availability]").wait_for(state="visible", timeout=30_000)
        assert page.get_by_label("Custom weekly schedule").is_checked()
        assert page.get_by_label("Monday").is_checked()
        assert page.locator('input[data-following-availability-day][value="6"]').is_checked()
        assert page.get_by_label("Timezone").input_value() == "America/Chicago"
        assert page.evaluate("() => document.activeElement?.id") == "following-tab-watches"

        # A2: a failed preview leaves the entered state and does not claim success.
        failing = context.new_page()
        install_routes(failing)
        open_following(failing, base, "lens=meetings&availability_preset=evenings_weekends")
        failing.route(f"{base}/following**", lambda route: route.fulfill(status=503, body="preview unavailable"))
        failing.locator("[data-following-preview-form] button[type=submit]").click()
        failing.get_by_text("The quick preview is not ready.").wait_for(state="visible", timeout=30_000)
        assert failing.get_by_label("Evenings and weekends").is_checked()
        assert failing.locator("[data-following-preview-state='ready']").count() == 0
        assert "No matches now" not in failing.locator("body").inner_text()
        failing.close()

        # A2: server-rendered query state remains available with JavaScript disabled.
        no_js = browser.new_context(viewport={"width": 390, "height": 844}, java_script_enabled=False)
        pin_fixture_clock(no_js, pinned_day)
        no_js_page = no_js.new_page()
        open_following(
            no_js_page,
            base,
            "lens=meetings&availability_preset=custom&availability_day=1&availability_day=6"
            "&availability_start=18%3A00&availability_end=21%3A00"
            "&availability_timezone=America%2FChicago&availability_unknown_start=include",
        )
        assert no_js_page.get_by_label("Custom weekly schedule").is_checked()
        assert no_js_page.get_by_label("Monday").is_checked()
        assert no_js_page.locator('input[data-following-availability-day][value="6"]').is_checked()
        assert no_js_page.get_by_label("Starts at").input_value() == "18:00"
        assert no_js_page.get_by_label("Timezone").input_value() == "America/Chicago"
        assert no_js_page.get_by_label("Meetings without a start time").input_value() == "include"
        no_js.close()
        context.close()
        browser.close()


def main() -> None:
    server, base = serve_site()
    try:
        run_journeys(base)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
