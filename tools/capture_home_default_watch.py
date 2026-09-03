#!/usr/bin/env python3
"""Capture deterministic evidence for the restored homepage default watch (FS-15).

Serves the tracked static site, mocks the worker's /subscribe and /session
responses (no live backend is exercised), and captures the anonymous default
form, a validation-failure state, the no-JavaScript confirmation route, and the
recognized "Open your watches" state — each at 390px and 1440px.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
from pathlib import Path

from playwright.sync_api import Page, Route, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "docs" / "screenshots" / "home-default-watch"
VIEWPORTS = ((1440, 1000), (390, 844))


def captured_revision() -> str:
    """The revision the captured tree is at. Stamping a literal goes stale silently."""
    result = subprocess.run(
        ["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def load_performance_helpers():
    path = ROOT / "test" / "performance" / "verify.py"
    spec = importlib.util.spec_from_file_location("performance_verify", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fulfill_json(route: Route, status: int, body: dict) -> None:
    origin = route.request.headers.get("origin", "*")
    route.fulfill(
        status=status,
        content_type="application/json",
        headers={"access-control-allow-origin": origin, "access-control-allow-credentials": "true"},
        body=json.dumps(body),
    )


def mock_subscribe_rate_limited(route: Route) -> None:
    fulfill_json(route, 429, {"ok": False, "reason": "rate-limited"})


# A stand-in for the worker's own reply() output, so this capture stays hermetic and needs
# no Worker runtime. It is NOT evidence that the worker replies this way: the real
# form-encoded reply is asserted in worker/test/home_cta_subscribe.test.mjs, and every
# receipt entry below says so rather than presenting the screenshot as a live confirmation.
NO_JS_CONFIRMATION_STANDIN_HTML = (
    "<!doctype html><html><head><meta charset=utf-8>"
    "<title>You're subscribed</title></head><body>"
    "<h1>You're subscribed</h1>"
    "<p>We'll email you. Manage or unsubscribe anytime."
    "<br><br>You are subscribed to the weekly NYC contracts digest. "
    '<a href="https://cityscroll.org/following/">Manage or choose another topic in Following</a>.'
    "<br><br><a href=\"https://cityscroll.org/following/\">Return to Following</a></p>"
    "</body></html>"
)


def mock_subscribe_no_js(route: Route) -> None:
    route.fulfill(status=200, content_type="text/html; charset=utf-8", body=NO_JS_CONFIRMATION_STANDIN_HTML)


def mock_unrecognized_session(route: Route) -> None:
    fulfill_json(route, 200, {"recognized": False})


def hermetic_context(browser, **kwargs):
    """A browser context that never reaches real production infrastructure:
    every request stays on the local static server unless explicitly mocked below."""
    context = browser.new_context(**kwargs)
    context.route("https://cloudflareinsights.com/**", lambda route: route.abort())
    context.route("https://api.cityscroll.org/**", lambda route: route.abort())
    return context


def capture_home_cta(page: Page, output: Path) -> None:
    box = page.locator("#homeCta").bounding_box()
    if not box:
        raise RuntimeError("#homeCta did not render")
    width = page.viewport_size["width"]
    page.screenshot(
        path=output,
        animations="disabled",
        clip={
            "x": 0,
            "y": max(box["y"] - 12, 0),
            "width": width,
            "height": min(box["height"] + 24, page.viewport_size["height"]),
        },
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    verify = load_performance_helpers()
    revision = captured_revision()
    captures: list[dict] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        with verify.StaticServer(ROOT / "site") as base_url:
            for width, height in VIEWPORTS:
                suffix = "desktop" if width > 800 else "mobile"

                # 1) Anonymous default form — unrecognized session, no interaction yet.
                context = hermetic_context(browser, viewport={"width": width, "height": height})
                page = context.new_page()
                page.route("**/session", mock_unrecognized_session)
                page.goto(base_url, wait_until="load")
                page.wait_for_selector("#homeCtaForm")
                name = f"anonymous-form-{suffix}.png"
                capture_home_cta(page, out / name)
                captures.append({
                    "name": name, "route": "/", "viewport": width, "revision": revision,
                    "session": "unrecognized", "mode": "js-enabled",
                    "assertion": "discloses the exact weekly Contracts/RFP promise before the email field, "
                                 "with a primary Get weekly updates action and secondary Choose what to follow link",
                })
                context.close()

                # 2) Failure state — a rejected /subscribe request (rate-limited) reports
                # inline without navigating away or claiming enrollment.
                context = hermetic_context(browser, viewport={"width": width, "height": height})
                page = context.new_page()
                page.route("**/session", mock_unrecognized_session)
                page.route("**/subscribe", mock_subscribe_rate_limited)
                page.goto(base_url, wait_until="load")
                page.wait_for_selector("#homeCtaForm")
                page.fill("#homeCtaEmail", "reader@example.com")
                page.click("#homeCtaSubmit")
                page.wait_for_selector("#homeCtaMsg:not(:empty)")
                name = f"validation-failure-{suffix}.png"
                capture_home_cta(page, out / name)
                captures.append({
                    "name": name, "route": "/", "viewport": width, "revision": revision,
                    "session": "unrecognized", "mode": "js-enabled",
                    "assertion": "a rejected /subscribe request (rate-limited) is reported inline, "
                                 "never claimed as a successful enrollment",
                })
                context.close()

                # 3) Recognized session — "Open your watches" replaces the form.
                context = hermetic_context(browser, viewport={"width": width, "height": height})
                page = context.new_page()
                page.goto(base_url, wait_until="load")
                page.wait_for_selector("#homeCtaForm")
                # The static-first homepage defers the full app graph (which owns
                # sessionShowBanner()) behind a hash-route or interaction, and that graph's
                # non-homepage lens modules are not present in this sparse evidence checkout.
                # Apply sessionShowBanner()'s own documented DOM contract directly (boot.mjs:
                # toggle #homeCta[data-session-open], show/label #homeCtaManage) instead of
                # depending on the full lazy app bundle.
                page.evaluate(
                    """() => {
                        const homeCta = document.getElementById("homeCta");
                        const manage = document.getElementById("homeCtaManage");
                        homeCta.dataset.sessionOpen = "true";
                        manage.hidden = false;
                        manage.href = "https://cityscroll.org/prefs?token=evidence";
                        manage.textContent = window.t ? window.t("home_cta_open_watches") : "Open your watches";
                    }"""
                )
                page.wait_for_selector('#homeCta[data-session-open="true"]')
                name = f"recognized-open-watches-{suffix}.png"
                capture_home_cta(page, out / name)
                captures.append({
                    "name": name, "route": "/", "viewport": width, "revision": revision,
                    "session": "recognized (simulated via sessionShowBanner's documented DOM contract; "
                               "the full lazy app bundle is outside this sparse evidence checkout)",
                    "mode": "js-enabled",
                    "assertion": "recognized homepage sessions see Open your watches instead of another generic form",
                })
                context.close()

                # 4) No-JavaScript confirmation — real <form> POST navigation, JS disabled.
                context = hermetic_context(browser, viewport={"width": width, "height": height}, java_script_enabled=False)
                page = context.new_page()
                page.route("**/subscribe", mock_subscribe_no_js)
                page.goto(base_url, wait_until="domcontentloaded")
                page.fill("#homeCtaEmail", "reader@example.com")
                with page.expect_navigation():
                    page.click("#homeCtaSubmit")
                name = f"no-js-confirmation-{suffix}.png"
                page.screenshot(path=out / name, animations="disabled", full_page=False)
                captures.append({
                    "name": name, "route": "/subscribe (no-JS form POST)", "viewport": width,
                    "revision": revision, "session": "unrecognized",
                    "mode": "js-disabled (the /subscribe reply is a stand-in for the worker's own reply() "
                            "output; the real form-encoded reply is asserted in "
                            "worker/test/home_cta_subscribe.test.mjs)",
                    "assertion": "with JavaScript off the form really posts to /subscribe and renders the "
                                 "returned confirmation, which discloses the weekly Contracts subscription "
                                 "and links to Following",
                })
                context.close()

        browser.close()

    receipt = {
        "schema": "cityscroll.fs15-home-default-watch-evidence.v1",
        "viewports": [width for width, _height in VIEWPORTS],
        "captures": captures,
    }
    (out / "capture-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    shown = out.relative_to(ROOT) if out.is_relative_to(ROOT) else out
    print(f"Captured FS-15 home-default-watch evidence under {shown}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
