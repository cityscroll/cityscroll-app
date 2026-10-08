#!/usr/bin/env python3
"""Browser regression: Near You location against the browser's own permissions.

Serves real Near You documents through the Near You capture server and answers
every location request with headless Chromium's real permission machinery:
a context granted geolocation with a fixed point, a context whose permission
is refused through the debugging protocol, and a fresh context still at the
prompt (which headless Chromium answers as a refusal without a prompt UI).

Use my location, pressed with navigator.geolocation left as the browser's own
object, opens the neighborhood at the fixed point, and when the browser
already blocks location the page says it is blocked and how to allow it,
keeps its alternatives beside the entry controls and re-enables the button.
The press is proved able to fail: with its handler kept from running, the
granted case never reaches the neighborhood.

As the site owner decided, a fresh Near You load with no chosen place asks for
location once per session: at the prompt it asks, while the browser reports a
block it does not ask and shows the blocked message, and with a place already
chosen it does not ask. After a refusal, pressing the button always asks the
browser again. Pages without JavaScript are unchanged.

Only the load-time cases count requests, through a counter that forwards
every call to the browser's own method. Every in-page checker is first run
against a state built to fail it. Nothing is written to the repository and no
screenshots are taken.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Browser, BrowserContext, Page, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
CLOCK = "2026-09-28T16:00:00.000Z"
VIEWPORTS = (("narrow_touch", 390, 844), ("desktop", 1440, 900))

ASTORIA = {"latitude": 40.7644, "longitude": -73.9235}
ASTORIA_GEO = "nta2020:QN0103"
SELECTED_GEO = "nta2020:MN0102"

BLOCKED = "Location is blocked."
BLOCKED_HOW = "set Location to Allow, then press Use my location"
DENIED = "Location permission was not granted. Choose an area from the list."
ALTERNATIVES = ["Enter an address", "Browse all NYC records"]

# The owner's decision for a press after a refusal, named where it is asserted.
AFTER_REFUSAL_DECISION = (
    "After a refusal, pressing Use my location always asks the browser again: "
    "a refusal at the prompt shows the not-granted recovery, and a remembered "
    "block shows how to allow location."
)

# Marks the session as one that already asked, so a load does not ask on its own.
LOCATION_ALREADY_ASKED = (
    "try { sessionStorage.setItem('near-you:location-asked', '1'); } catch {}"
)

# Counts calls and forwards each one to the browser's own method, so the real
# permission machinery still answers. Only the load-time cases install it.
FORWARDING_COUNTER = """
(() => {
  window.__locationAsks = 0;
  const native = Geolocation.prototype.getCurrentPosition;
  Geolocation.prototype.getCurrentPosition = function (...args) {
    window.__locationAsks += 1;
    return native.apply(this, args);
  };
})();
"""

# Keeps the button's own click handler from running (the positive control).
UNBOUND_BUTTON = """
addEventListener("click", (event) => {
  if (event.target?.closest?.("[data-use-location]")) event.stopImmediatePropagation();
}, true);
"""

NATIVE_GEOLOCATION_JS = """() => {
  const api = navigator.geolocation;
  const nativeSource = (fn) => typeof fn === 'function'
    && /\\{\\s*\\[native code\\]\\s*\\}/.test(Function.prototype.toString.call(fn));
  return {
    own_property: Object.getOwnPropertyDescriptor(navigator, 'geolocation') !== undefined,
    is_geolocation: typeof Geolocation === 'function' && api instanceof Geolocation,
    instance_override: Boolean(api) && Object.getOwnPropertyNames(api).length > 0,
    native_method: nativeSource(Geolocation.prototype.getCurrentPosition),
  };
}"""

ENTRY_STATE_JS = """() => {
  const button = document.querySelector('[data-use-location]');
  const group = document.querySelector('[data-near-entry-recovery]');
  const status = document.querySelector('[data-map-status]');
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  return {
    url: location.href,
    status: status?.textContent.trim() || '',
    status_visible: Boolean(status && visible(status)),
    button_disabled: button ? button.disabled : null,
    button_hidden: button ? button.hidden : null,
    group_after_status: Boolean(group && status && status.nextElementSibling === group),
    actions: group
      ? [...group.querySelectorAll('[data-near-entry-recovery-action]')].filter(visible).map((node) => node.textContent.trim())
      : [],
    asks: typeof window.__locationAsks === 'number' ? window.__locationAsks : null,
  };
}"""


def query(url: str) -> dict[str, list[str]]:
    return parse_qs(urlparse(url).query)


def start_server() -> tuple[subprocess.Popen, str]:
    env = {
        **os.environ,
        "NODE_OPTIONS": " ".join(filter(None, [
            os.environ.get("NODE_OPTIONS"),
            f"--import={ROOT / 'test' / 'helpers' / 'test_clock_preload.mjs'}",
        ])),
        "CITYSCROLL_TEST_TIME_PIN": CLOCK,
    }
    server = subprocess.Popen(
        ["node", "tools/serve_near_you_capture.mjs"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        text=True,
        env=env,
    )
    base = (server.stdout.readline() if server.stdout else "").strip().rstrip("/")
    if not base.startswith("http://127.0.0.1:"):
        server.kill()
        raise RuntimeError("Near You capture server did not announce a base URL")
    return server, base


class Visit:
    """One browser context whose location answers come from Chromium's permission state."""

    def __init__(self, browser: Browser, base: str, permission: str, *, width: int = 390, height: int = 844,
                 already_asked: bool = False, count_asks: bool = False, unbound: bool = False,
                 javascript: bool = True):
        options: dict = {
            "viewport": {"width": width, "height": height},
            "has_touch": width < 500,
            "java_script_enabled": javascript,
        }
        if permission == "granted":
            options.update(permissions=["geolocation"], geolocation=ASTORIA)
        self.touch = width < 500
        self.context: BrowserContext = browser.new_context(**options)
        if already_asked:
            self.context.add_init_script(LOCATION_ALREADY_ASKED)
        if count_asks:
            self.context.add_init_script(FORWARDING_COUNTER)
        if unbound:
            self.context.add_init_script(UNBOUND_BUTTON)
        self.page: Page = self.context.new_page()
        if permission == "denied":
            session = self.context.new_cdp_session(self.page)
            context_id = session.send("Target.getTargetInfo")["targetInfo"]["browserContextId"]
            browser.new_browser_cdp_session().send("Browser.setPermission", {
                "permission": {"name": "geolocation"},
                "setting": "denied",
                "origin": base,
                "browserContextId": context_id,
            })
        elif permission != "granted" and permission != "prompt":
            raise ValueError(permission)

    def close(self) -> None:
        self.context.close()

    def permission_state(self) -> str:
        return self.page.evaluate("navigator.permissions.query({ name: 'geolocation' }).then((r) => r.state)")

    def open(self, url: str) -> None:
        self.page.goto(url, wait_until="domcontentloaded")
        self.page.locator("[data-use-location]:not([hidden])").wait_for(state="attached", timeout=30_000)

    def state(self) -> dict:
        return self.page.evaluate(ENTRY_STATE_JS)

    def press(self) -> None:
        button = self.page.locator("[data-use-location]")
        if not button.is_visible():
            for summary in (".near-place-guide > summary", ".near-place-options > summary"):
                disclosure = self.page.locator(summary)
                if disclosure.count() and not disclosure.evaluate("node => node.parentElement.open"):
                    disclosure.click()
        if self.touch:
            button.tap()
        else:
            button.focus()
            button.press("Enter")

    def clear_status(self) -> None:
        """Empty the status so a new message can only come from a new answer."""
        self.page.evaluate("() => { document.querySelector('[data-map-status]').textContent = ''; }")

    def await_status(self, prefix: str, *, timeout: int = 20_000) -> dict:
        self.page.wait_for_function(
            "(prefix) => (document.querySelector('[data-map-status]')?.textContent || '').trim().startsWith(prefix)"
            " && !document.querySelector('[data-use-location]')?.disabled",
            arg=prefix,
            timeout=timeout,
        )
        return self.state()

    def await_place(self, geo: str, *, timeout: int = 30_000) -> None:
        self.page.wait_for_url(lambda url: query(url).get("geo") == [geo], timeout=timeout)


def native_problems(report: dict) -> list[str]:
    problems = []
    if report["own_property"]:
        problems.append("navigator.geolocation is redefined on navigator")
    if not report["is_geolocation"]:
        problems.append("navigator.geolocation is not the browser's Geolocation")
    if report["instance_override"]:
        problems.append("the Geolocation object carries its own properties")
    if not report["native_method"]:
        problems.append("getCurrentPosition is not the browser's own method")
    return problems


def assert_native(visit: Visit, *, label: str) -> None:
    """The case itself proves no stub stands between the page and the browser."""
    problems = native_problems(visit.page.evaluate(NATIVE_GEOLOCATION_JS))
    assert not problems, f"{label}: {problems}"


def blocked_problems(state: dict) -> list[str]:
    problems = []
    if not state["status"].startswith(BLOCKED) or BLOCKED_HOW not in state["status"]:
        problems.append(f"status {state['status']!r}")
    if not state["status_visible"]:
        problems.append("status not visible")
    if state["actions"] != ALTERNATIVES:
        problems.append(f"actions {state['actions']}")
    if not state["group_after_status"]:
        problems.append("alternatives not beside the status")
    if state["button_disabled"] is not False or state["button_hidden"] is not False:
        problems.append("button not usable")
    return problems


def assert_checkers_can_fail(browser: Browser, base: str) -> None:
    denied_state = {
        "status": DENIED, "status_visible": True, "actions": ALTERNATIVES,
        "group_after_status": True, "button_disabled": False, "button_hidden": False,
    }
    assert blocked_problems(denied_state), "blocked checker accepted the not-granted message"
    assert blocked_problems({**denied_state, "status": BLOCKED + " " + BLOCKED_HOW, "button_disabled": True}), \
        "blocked checker accepted a disabled button"
    assert not blocked_problems({**denied_state, "status": BLOCKED + " " + BLOCKED_HOW})
    # The native check must see a counter or a replaced API.
    visit = Visit(browser, base, "prompt", already_asked=True, count_asks=True)
    try:
        visit.open(base + "/near-you/")
        assert native_problems(visit.page.evaluate(NATIVE_GEOLOCATION_JS)), "native checker missed the counter"
    finally:
        visit.close()
    visit = Visit(browser, base, "prompt", already_asked=True)
    try:
        visit.context.add_init_script(
            "Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition() {} } });"
        )
        visit.open(base + "/near-you/")
        assert native_problems(visit.page.evaluate(NATIVE_GEOLOCATION_JS)), "native checker missed a replaced API"
    finally:
        visit.close()


def press_granted(browser: Browser, base: str, viewport: tuple[str, int, int], *, unbound: bool = False,
                  timeout: int = 30_000) -> dict:
    name, width, height = viewport
    visit = Visit(browser, base, "granted", width=width, height=height, already_asked=True, unbound=unbound)
    try:
        visit.open(base + "/near-you/")
        assert_native(visit, label=f"{name} granted press")
        assert visit.permission_state() == "granted"
        visit.press()
        visit.await_place(ASTORIA_GEO, timeout=timeout)
        assert query(visit.page.url).get("surface") == ["map"], visit.page.url
        return {"case": "press-granted-real-permission", "viewport": name, "geo": ASTORIA_GEO}
    finally:
        visit.close()


def check_press_positive_control(browser: Browser, base: str) -> dict:
    try:
        press_granted(browser, base, VIEWPORTS[0], unbound=True, timeout=6_000)
    except Exception:  # noqa: BLE001 - any failure is the expected outcome here
        return {"case": "press-granted-fails-without-handler"}
    raise AssertionError("the granted press case passed with the button's handler kept from running")


def check_press_blocked(browser: Browser, base: str, viewport: tuple[str, int, int]) -> dict:
    name, width, height = viewport
    visit = Visit(browser, base, "denied", width=width, height=height, already_asked=True)
    try:
        visit.open(base + "/near-you/")
        assert_native(visit, label=f"{name} blocked press")
        assert visit.permission_state() == "denied"
        assert visit.state()["status"] == "", "a session that already asked showed a status on load"
        visit.press()
        state = visit.await_status(BLOCKED)
        problems = blocked_problems(state)
        assert not problems, f"{name} blocked press: {problems}"
        # Repeat press, per the owner's decision: the browser is asked again,
        # and only its answer can put the message back.
        visit.clear_status()
        visit.press()
        again = visit.await_status(BLOCKED)
        assert not blocked_problems(again), f"{name} blocked repeat press: {blocked_problems(again)}"
        assert query(visit.page.url).get("geo") is None, visit.page.url
        return {"case": "press-blocked-real-permission", "viewport": name, "status": state["status"],
                "actions": state["actions"], "decision": AFTER_REFUSAL_DECISION}
    finally:
        visit.close()


def check_load_prompt(browser: Browser, base: str) -> dict:
    visit = Visit(browser, base, "prompt", count_asks=True)
    try:
        visit.open(base + "/near-you/")
        assert visit.permission_state() == "prompt"
        # Headless Chromium answers the prompt as a refusal; only an ask can produce it.
        state = visit.await_status(DENIED)
        assert state["asks"] == 1, state
        assert state["actions"] == ALTERNATIVES, state
        assert visit.permission_state() == "prompt", "a refusal at the prompt must not become a block"
        # After that refusal a press asks again.
        visit.clear_status()
        visit.press()
        pressed = visit.await_status(DENIED)
        assert pressed["asks"] == 2, pressed
        # A later load in the same session does not ask on its own.
        visit.open(base + "/near-you/")
        visit.page.wait_for_load_state("networkidle")
        repeat = visit.state()
        assert repeat["asks"] == 0 and repeat["status"] == "", repeat
        return {"case": "load-prompt-asks-once-per-session", "decision": AFTER_REFUSAL_DECISION}
    finally:
        visit.close()


def check_load_blocked(browser: Browser, base: str) -> dict:
    visit = Visit(browser, base, "denied", count_asks=True)
    try:
        visit.open(base + "/near-you/")
        assert visit.permission_state() == "denied"
        state = visit.await_status(BLOCKED)
        assert state["asks"] == 0, f"the load called the location API while the browser blocks it: {state}"
        problems = blocked_problems(state)
        assert not problems, f"load blocked: {problems}"
        # The button stays the retry, and asks the browser.
        visit.clear_status()
        visit.press()
        pressed = visit.await_status(BLOCKED)
        assert pressed["asks"] == 1, pressed
        return {"case": "load-blocked-does-not-ask", "status": state["status"]}
    finally:
        visit.close()


def check_load_granted(browser: Browser, base: str) -> dict:
    visit = Visit(browser, base, "granted", count_asks=True)
    try:
        visit.open(base + "/near-you/")
        visit.await_place(ASTORIA_GEO)
        assert visit.state()["asks"] == 1
        return {"case": "load-granted-opens-place", "geo": ASTORIA_GEO}
    finally:
        visit.close()


def check_load_selected_place(browser: Browser, base: str) -> dict:
    visit = Visit(browser, base, "granted", count_asks=True)
    try:
        url = f"{base}/near-you/?geo={SELECTED_GEO.replace(':', '%3A')}&surface=records&lens=meetings"
        visit.open(url)
        visit.page.wait_for_load_state("networkidle")
        visit.page.wait_for_timeout(500)
        state = visit.state()
        assert state["asks"] == 0, f"a chosen place asked for location on load: {state}"
        assert query(visit.page.url).get("geo") == [SELECTED_GEO], visit.page.url
        assert state["status"] == "", state
        return {"case": "load-selected-place-does-not-ask", "geo": SELECTED_GEO}
    finally:
        visit.close()


def check_load_counter_can_fail(browser: Browser, base: str) -> None:
    """The zero-ask checks above would see an ask: a fresh place-free load in the same state does."""
    visit = Visit(browser, base, "granted", count_asks=True)
    try:
        visit.open(base + "/near-you/")
        visit.await_place(ASTORIA_GEO)
        assert visit.state()["asks"] >= 1, "the counter did not see the load-time ask"
    finally:
        visit.close()


def check_without_javascript(browser: Browser, base: str) -> dict:
    visit = Visit(browser, base, "prompt", javascript=False)
    try:
        visit.page.goto(base + "/near-you/", wait_until="domcontentloaded")
        assert visit.page.locator("[data-use-location]").count() == 1
        assert not visit.page.locator("[data-use-location]").is_visible()
        assert visit.page.locator("form.near-geo-search").is_visible()
        assert visit.page.locator("[data-near-entry-recovery]").count() == 0
        return {"case": "no-javascript-unchanged"}
    finally:
        visit.close()


def main() -> None:
    server, base = start_server()
    results: list[dict] = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, channel=os.environ.get("PLAYWRIGHT_CHANNEL") or None)
            assert_checkers_can_fail(browser, base)
            results.append(check_press_positive_control(browser, base))
            for viewport in VIEWPORTS:
                results.append(press_granted(browser, base, viewport))
                results.append(check_press_blocked(browser, base, viewport))
            check_load_counter_can_fail(browser, base)
            results.append(check_load_prompt(browser, base))
            results.append(check_load_blocked(browser, base))
            results.append(check_load_granted(browser, base))
            results.append(check_load_selected_place(browser, base))
            results.append(check_without_javascript(browser, base))
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)
    print(json.dumps({"near_you_location_permission": results}, indent=2))


if __name__ == "__main__":
    main()
