"""Following saved-watch management stays on /following/#your-following.

Covers a recognized Transportation/Queens watch plus unrecognized, empty,
unavailable, error, action-success, and action-failure recovery. Session
controls stay off until the personal island is recognized.
"""

from __future__ import annotations

import json
import os
from urllib.parse import urlsplit

from playwright.sync_api import Page, Route, sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")

WATCH_HTML = """
<div data-session-recognized="true" data-personal-state="recognized">
  <article class="following-watch" data-watch-key="sub:meetings-queens" data-watch-lens="meetings"
    data-watch-filter="{&quot;agency&quot;:&quot;Transportation&quot;,&quot;borough&quot;:&quot;Queens&quot;}">
    <div class="following-watch-heading">
      <h3>Notify me when new hearings and meetings from Transportation are published in Queens</h3>
      <p class="watch-meta">Active · Weekly digest</p>
    </div>
    <div class="following-watch-controls">
      <form method="post" action="https://cityscroll.org/prefs" data-watch-action>
        <input type="hidden" name="token" value="prefs-purpose-credential">
        <input type="hidden" name="key" value="sub:meetings-queens">
        <input type="hidden" name="action" value="update">
        <label>Cadence<select name="freq"><option value="daily">Daily</option><option value="weekly" selected>Weekly</option></select></label>
        <button type="submit">Save cadence</button>
      </form>
      <form method="post" action="https://cityscroll.org/prefs" data-watch-action>
        <input type="hidden" name="token" value="prefs-purpose-credential">
        <input type="hidden" name="key" value="sub:meetings-queens">
        <input type="hidden" name="action" value="pause">
        <button type="submit">Pause</button>
      </form>
      <form method="post" action="https://cityscroll.org/prefs" data-watch-action data-confirm="Stop this watch?">
        <input type="hidden" name="token" value="prefs-purpose-credential">
        <input type="hidden" name="key" value="sub:meetings-queens">
        <input type="hidden" name="action" value="delete">
        <button type="submit">Unsubscribe</button>
      </form>
    </div>
  </article>
</div>
"""

EMPTY_HTML = """
<div data-session-recognized="true" data-personal-state="empty">
  <p>No saved watches yet. Create one to get updates on matching City Record rows.</p>
  <p class="following-personal-recovery"><a href="#create" data-following-create-recovery>Create a watch</a></p>
</div>
"""

UNRECOGNIZED_HTML = """
<div data-session-recognized="false" data-personal-state="unrecognized">
  <p>Open a CityScroll email to see your watches.</p>
  <p class="following-personal-recovery"><a href="#create" data-following-create-recovery>Create a watch</a></p>
</div>
"""


def personal_for(state: str) -> tuple[int, str] | str:
    if state == "unavailable":
        return 503, "<p>unavailable</p>"
    if state == "error":
        return "abort"
    if state == "empty":
        return 200, EMPTY_HTML
    if state == "unrecognized":
        return 200, UNRECOGNIZED_HTML
    return 200, WATCH_HTML


def cors_headers(route: Route, content_type: str) -> dict[str, str]:
    origin = route.request.headers.get("origin") or "http://127.0.0.1"
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "Accept, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Content-Type": content_type,
    }


def install_routes(page: Page, *, personal: str, prefs_ok: bool = True) -> list[dict]:
    posts: list[dict] = []

    def api(route: Route) -> None:
        if route.request.method == "OPTIONS":
            route.fulfill(status=204, headers=cors_headers(route, "text/plain"))
            return
        path = urlsplit(route.request.url).path
        if path == "/session":
            recognized = personal in {"recognized", "empty"}
            route.fulfill(
                status=200,
                headers=cors_headers(route, "application/json"),
                body=json.dumps({"ok": True, "recognized": recognized}),
            )
            return
        if path == "/following/personal":
            payload = personal_for(personal)
            if payload == "abort":
                route.abort()
                return
            status, body = payload
            route.fulfill(status=status, headers=cors_headers(route, "text/html; charset=utf-8"), body=body)
            return
        route.fulfill(status=404, headers=cors_headers(route, "application/json"), body="{}")

    def canonical(route: Route) -> None:
        path = urlsplit(route.request.url).path
        if path == "/prefs":
            if route.request.method == "OPTIONS":
                route.fulfill(status=204, headers=cors_headers(route, "text/plain"))
                return
            if route.request.method == "POST":
                posts.append({"ok": prefs_ok})
                if not prefs_ok:
                    route.fulfill(
                        status=400,
                        headers=cors_headers(route, "application/json"),
                        body=json.dumps({"ok": False, "flash": {"error": "Could not save."}}),
                    )
                    return
                route.fulfill(
                    status=200,
                    headers=cors_headers(route, "application/json"),
                    body=json.dumps({"ok": True, "flash": {"message": "Updated: weekly."}}),
                )
                return
        route.continue_()

    page.route("https://api.cityscroll.org/**", api)
    page.route("https://crol-worker.crol-worker.workers.dev/**", api)
    page.route("https://cityscroll.org/**", canonical)
    page.route("https://data.cityofnewyork.us/**", lambda route: route.abort())
    return posts


def assert_no_overflow(page: Page) -> None:
    overflow = page.evaluate("document.documentElement.scrollWidth - innerWidth")
    assert overflow <= 1, overflow


def open_management(page: Page, width: int) -> None:
    page.set_viewport_size({"width": width, "height": 844 if width < 800 else 900})
    page.goto(f"{BASE}/following/#your-following", wait_until="domcontentloaded", timeout=30_000)


def test_recognized_and_actions(browser) -> None:
    page = browser.new_page()
    posts = install_routes(page, personal="recognized", prefs_ok=True)
    open_management(page, 390)
    page.locator("[data-watch-key='sub:meetings-queens']").wait_for(state="visible")
    assert page.locator("#your-following").is_visible()
    assert page.get_by_text("Notify me when new hearings and meetings from Transportation are published in Queens").is_visible()
    assert page.locator("[data-watch-action]").count() == 3
    assert "#your-following" in page.url
    assert_no_overflow(page)

    page.get_by_role("button", name="Save cadence").click()
    page.get_by_text("Updated: weekly.").wait_for(state="visible")
    assert page.locator("[data-watch-key='sub:meetings-queens']").is_visible()
    assert "#your-following" in page.url
    assert posts, "cadence save never reached the existing prefs seam"

    page.set_viewport_size({"width": 1440, "height": 900})
    assert page.locator("[data-watch-key='sub:meetings-queens']").is_visible()
    assert_no_overflow(page)
    page.close()


def test_action_failure_keeps_card(browser) -> None:
    page = browser.new_page()
    install_routes(page, personal="recognized", prefs_ok=False)
    open_management(page, 1440)
    page.locator("[data-watch-key='sub:meetings-queens']").wait_for(state="visible")
    page.get_by_role("button", name="Save cadence").click()
    page.get_by_text("Could not save that change. Try again.").wait_for(state="visible")
    assert page.locator("[data-watch-key='sub:meetings-queens']").is_visible()
    assert page.locator("[data-personal-retry]").count() >= 1
    assert "#your-following" in page.url
    page.close()


def test_missing_states(browser) -> None:
    for state, copy, controls in (
        ("unrecognized", "Open a CityScroll email to see your watches.", 0),
        ("empty", "No saved watches yet", 0),
        ("unavailable", "Saved watches are not available right now.", 0),
        ("error", "Could not load saved watches.", 0),
    ):
        page = browser.new_page()
        install_routes(page, personal=state)
        open_management(page, 390)
        page.get_by_text(copy).wait_for(state="visible")
        assert page.locator("#your-following").is_visible()
        assert page.locator("[data-watch-action]").count() == controls
        assert page.locator("[data-watch-key]").count() == 0
        if state in {"unrecognized", "empty"}:
            page.locator("[data-following-create-recovery]").click()
            page.locator("#create").wait_for(state="visible")
            assert not page.locator("#your-following").is_visible()
        else:
            page.locator("[data-personal-retry]").first.wait_for(state="visible")
        assert_no_overflow(page)
        page.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        test_recognized_and_actions(browser)
        test_action_failure_keeps_card(browser)
        test_missing_states(browser)
        browser.close()
    print("OK following management recovery")


if __name__ == "__main__":
    main()
