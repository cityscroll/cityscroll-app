"""Recognized-session state agrees across Home, Following, and preferences.

The Worker unit contracts prove cookie scope and credential minting. This browser
contract proves that the static-first clients consume that one truth consistently:
signed-in readers never see a signup CTA or token-link management path, while
signed-out readers get the public creation flow without account controls.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Browser, Page, Route, sync_playwright


BASE = os.environ.get("CROL_BASE", "http://127.0.0.1:8000/").rstrip("/")
ROOT = Path(__file__).parents[2]
TEST_EMAIL = "@".join(("reader", "example.test"))


def session_payload(recognized: bool) -> dict[str, object]:
    if not recognized:
        return {"ok": True, "recognized": False}
    return {
        "ok": True,
        "recognized": True,
        "email": TEST_EMAIL,
        "prefsUrl": "https://cityscroll.org/prefs",
        "manageUrl": "https://cityscroll.org/following/#your-following",
    }


def personal_html(recognized: bool) -> str:
    if not recognized:
        return (
            '<div data-session-recognized="false">'
            "<p>Open a CityScroll email to see your watches.</p>"
            "</div>"
        )
    return """
      <div data-session-recognized="true">
        <article class="following-watch" data-watch-key="sub:fixture" data-watch-lens="meetings"
          data-watch-filter="{&quot;borough&quot;:&quot;Queens&quot;}">
          <div class="following-watch-heading"><h3>Queens public meetings</h3><p class="watch-meta">Active</p></div>
          <div class="following-watch-controls">
            <form method="post" action="https://cityscroll.org/prefs" data-watch-action>
              <input type="hidden" name="token" value="prefs-purpose-credential">
              <input type="hidden" name="key" value="sub:fixture">
              <input type="hidden" name="action" value="update">
              <label>Cadence<select name="freq"><option selected>Weekly</option></select></label>
              <button type="submit">Save cadence</button>
            </form>
            <form method="post" action="https://cityscroll.org/prefs" data-watch-action>
              <input type="hidden" name="token" value="prefs-purpose-credential">
              <input type="hidden" name="key" value="sub:fixture">
              <input type="hidden" name="action" value="pause">
              <button type="submit">Pause</button>
            </form>
            <form method="post" action="https://cityscroll.org/prefs" data-watch-action>
              <input type="hidden" name="token" value="prefs-purpose-credential">
              <input type="hidden" name="key" value="sub:fixture">
              <input type="hidden" name="action" value="delete">
              <button type="submit">Unsubscribe</button>
            </form>
          </div>
        </article>
      </div>
    """


def prefs_html(recognized: bool) -> tuple[int, str]:
    if not recognized:
        return 400, "<!doctype html><html><body><main><h1>Link not valid</h1></main></body></html>"
    return 200, """<!doctype html><html><body><main>
      <h1>Manage your watches</h1>
      <p>Account: re***@example.test</p>
      <label>Frequency<select name="freq"><option>daily</option><option selected>weekly</option></select></label>
      <button>Pause</button><button>Delete watch</button>
    </main></body></html>"""


def install_routes(page: Page, recognized: bool) -> None:
    def api(route: Route) -> None:
        path = urlsplit(route.request.url).path
        if path == "/session":
            route.fulfill(status=200, content_type="application/json", body=json.dumps(session_payload(recognized)))
        elif path == "/following/personal":
            route.fulfill(status=200, content_type="text/html", body=personal_html(recognized))
        elif path == "/pins":
            route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"ok": True, "recognized": recognized, "pins": None}),
            )
        else:
            route.fulfill(status=404, content_type="application/json", body="{}")

    def canonical(route: Route) -> None:
        path = urlsplit(route.request.url).path
        if path == "/prefs":
            status, body = prefs_html(recognized)
            route.fulfill(status=status, content_type="text/html", body=body)
        else:
            route.continue_()

    page.route("https://api.cityscroll.org/**", api)
    page.route("https://crol-worker.crol-worker.workers.dev/**", api)
    page.route("https://cityscroll.org/**", canonical)
    page.route("https://data.cityofnewyork.us/**", lambda route: route.abort())


def assert_manage_url_is_session_native(href: str) -> None:
    parsed = urlsplit(href)
    assert parsed.path in {"/following/", "/prefs"}, href
    assert "token=" not in parsed.query and "token=" not in parsed.fragment, href


def check_home(browser: Browser, recognized: bool) -> None:
    page = browser.new_page()
    install_routes(page, recognized)
    page.goto(f"{BASE}/", wait_until="domcontentloaded", timeout=30_000)
    if recognized:
        page.locator('#sessionBanner[data-open="true"]').wait_for(state="visible")
        assert TEST_EMAIL in page.locator("#sessionBannerText").inner_text()
        assert not page.locator("#homeCtaForm").is_visible(), "signed-in Home still asks for an email"
        manage = page.locator("#homeCtaManage")
        assert manage.is_visible(), "signed-in Home did not expose watch management"
        assert_manage_url_is_session_native(manage.get_attribute("href") or "")
        assert_manage_url_is_session_native(page.locator("#sessionManage").get_attribute("href") or "")
        page.locator("#sessionDismiss").click()
        assert not page.locator("#sessionBanner").is_visible()
        assert manage.is_visible(), "dismissing recognition copy incorrectly restored signup"
        assert not page.locator("#homeCtaForm").is_visible()
    else:
        page.wait_for_function("document.querySelector('#sessionBanner').dataset.open === 'false'")
        assert page.locator("#homeCtaForm").is_visible(), "signed-out Home lost watch signup"
        assert not page.locator("#homeCtaManage").is_visible(), "signed-out Home exposed account management"
        assert not page.locator("#sessionBanner").is_visible(), "signed-out Home rendered recognition"
    page.close()


def check_following(browser: Browser, recognized: bool) -> None:
    page = browser.new_page()
    install_routes(page, recognized)
    page.goto(f"{BASE}/following/", wait_until="domcontentloaded", timeout=30_000)
    state = "true" if recognized else "false"
    page.locator(f'[data-personal-watch-list] [data-session-recognized="{state}"]').wait_for(state="attached")
    order = page.eval_on_selector_all(
        "#your-following, #create, #packs",
        "nodes => nodes.map(node => node.id)",
    )
    assert order == ["your-following", "create", "packs"], order
    assert page.locator("#create").is_visible(), "public creation flow must remain available"
    if recognized:
        assert page.locator("[data-watch-action]").count() == 3
        assert page.locator('[data-watch-action] select[name="freq"]').count() == 1
        for form in page.locator("[data-watch-action]").all():
            action = form.get_attribute("action") or ""
            assert action == "https://cityscroll.org/prefs", action
            assert "token=" not in action
    else:
        assert page.locator("[data-watch-action]").count() == 0
    page.close()


def check_prefs(browser: Browser, recognized: bool) -> None:
    page = browser.new_page()
    install_routes(page, recognized)
    response = page.goto("https://cityscroll.org/prefs", wait_until="domcontentloaded", timeout=30_000)
    assert response is not None
    if recognized:
        assert response.status == 200
        assert page.get_by_role("heading", name="Manage your watches").is_visible()
        assert page.locator('select[name="freq"]').is_visible()
        assert "token=" not in page.url
    else:
        assert response.status == 400
        assert page.get_by_role("heading", name="Link not valid").is_visible()
    page.close()


def main() -> None:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for recognized in (False, True):
            check_home(browser, recognized)
            check_following(browser, recognized)
            check_prefs(browser, recognized)
        browser.close()
    print("OK session coherence across Home, Following, preferences, and live manage links")


if __name__ == "__main__":
    main()
