#!/usr/bin/env python3
"""Capability discovery browser journeys against public pages.

Covers:
- Follow/calendar discovery on Browse and Now (landed sibling surface).
- Assistant introduction and shared Ask-with-AI entry at desktop and phone
  viewports, with keyboard, translated query, no-JS, and failed-enhancement
  paths.

Research and contextual-handoff selectors are asserted when those sibling
surfaces are present and skipped when absent.

Environment:
  CROL_BASE  Base URL (default http://localhost:8000/). Production runs set
             https://cityscroll.org/.
"""

from __future__ import annotations

import os
import re
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("CROL_BASE", "http://localhost:8000/")
if not BASE.endswith("/"):
    BASE += "/"

DESKTOP = {"width": 1440, "height": 1000}
PHONE = {"width": 390, "height": 844}
_ARGS = (
    ["--host-resolver-rules=MAP api.cityscroll.org " + os.environ["CROL_DNS_IP"]]
    if os.environ.get("CROL_DNS_IP")
    else []
)

results: list[tuple[str, str]] = []


def step(tag: str, name: str, detail: str = "") -> None:
    results.append((tag, name))
    print(f"{tag} {name}" + (f" -> {detail}" if detail else ""), flush=True)


def open_page(browser, viewport, java_script_enabled=True):
    context = browser.new_context(viewport=viewport, java_script_enabled=java_script_enabled)
    page = context.new_page()
    return context, page


def assert_follow_calendar_journeys(browser) -> None:
    page = browser.new_context(viewport=DESKTOP).new_page()
    page.goto(BASE + "browse/meetings/?agency=City%20Planning", timeout=30000)
    page.wait_for_selector("[data-follow-discovery='1'], .calendar-subscribe-btn, .browse-build-view", timeout=20000)
    html = page.content()
    has_group = 'data-follow-discovery="1"' in html
    has_follow = "Get email updates" in html
    has_calendar = "Subscribe to calendar" in html
    has_feeds = "Feed reader links" in html
    calendar_buttons = len(re.findall(r'class="calendar-subscribe-btn"', html))
    step(
        "OK" if has_group and has_follow and has_calendar and has_feeds else "FAIL",
        "browse follow discovery group",
        f"group={has_group} follow={has_follow} calendar={has_calendar} feeds={has_feeds} calendar_btns={calendar_buttons}",
    )
    step("OK" if calendar_buttons == 1 else "FAIL", "single calendar subscribe control", str(calendar_buttons))

    phone = browser.new_context(viewport=PHONE).new_page()
    phone.goto(BASE + "browse/meetings/?agency=City%20Planning", timeout=30000)
    phone.wait_for_selector("[data-follow-discovery='1'], .browse-build-view", timeout=20000)
    phone_html = phone.content()
    step(
        "OK" if 'data-follow-discovery="1"' in phone_html and "Get email updates" in phone_html else "FAIL",
        "phone browse follow discovery",
    )

    now = browser.new_context(viewport=DESKTOP).new_page()
    now.goto(BASE + "now/", timeout=30000)
    now.wait_for_selector("[data-follow-discovery-surface='now'], .now-surface", timeout=20000)
    now_html = now.content()
    step("OK" if 'data-follow-discovery-surface="now"' in now_html else "FAIL", "now follow discovery")


def assert_introduction_journey(page, label: str) -> None:
    page.goto(BASE + "use-with-ai/", timeout=30000)
    page.wait_for_selector("#mcp-endpoint, main#main", timeout=20000)
    html = page.content()
    endpoint = page.locator("#mcp-endpoint")
    copy_btn = page.locator("[data-copy-endpoint]")
    has_endpoint = endpoint.count() == 1 and "api.cityscroll.org/mcp" in (endpoint.input_value() if endpoint.count() else "")
    has_copy = copy_btn.count() == 1
    has_examples = "CT107120258801626" in html and "2024Q0356" in html
    has_recovery = "/api.html#mcp" in html and ("no account" in html.lower() or "no key" in html.lower())
    step(
        "OK" if has_endpoint and has_copy and has_examples and has_recovery else "FAIL",
        f"{label} introduction route-to-task",
        f"endpoint={has_endpoint} copy={has_copy} examples={has_examples} recovery={has_recovery}",
    )


def assert_home_ask_link(page, label: str) -> None:
    page.goto(BASE, timeout=30000)
    page.wait_for_selector("body", timeout=20000)
    link = page.locator('a[href*="use-with-ai"]')
    step("OK" if link.count() >= 1 else "FAIL", f"{label} home Ask with AI entry", str(link.count()))
    if link.count() >= 1:
        href = link.first.get_attribute("href") or ""
        step("OK" if "use-with-ai" in href else "FAIL", f"{label} home Ask href", href)


def assert_keyboard_copy_fallback(page, label: str) -> None:
    page.goto(BASE + "use-with-ai/", timeout=30000)
    page.wait_for_selector("#mcp-endpoint", timeout=20000)
    page.locator("#mcp-endpoint").focus()
    page.keyboard.press("Tab")
    focused = page.evaluate("() => document.activeElement && document.activeElement.getAttribute('data-copy-endpoint')")
    page.locator("[data-copy-endpoint]").click()
    selected = page.evaluate(
        """() => {
          const input = document.querySelector('#mcp-endpoint');
          if (!input) return false;
          return input.selectionStart === 0 && input.selectionEnd === input.value.length
            || document.activeElement === input;
        }"""
    )
    step(
        "OK" if focused is not None or selected else "FAIL",
        f"{label} keyboard and copy recovery",
        f"focused_copy={focused} selected_or_focused={selected}",
    )


def assert_translated_layout(page, label: str) -> None:
    page.goto(BASE + "use-with-ai/?lang=es", timeout=30000)
    page.wait_for_selector("#mcp-endpoint, main#main", timeout=20000)
    html = page.content()
    ok = "api.cityscroll.org/mcp" in html and ('href="/"' in html or "CityScroll home" in html or "href='/'" in html)
    step("OK" if ok else "FAIL", f"{label} translated introduction keeps endpoint and home recovery")


def assert_no_js(browser, label: str) -> None:
    context, page = open_page(browser, DESKTOP, java_script_enabled=False)
    try:
        page.goto(BASE + "use-with-ai/", timeout=30000)
        html = page.content()
        ok = "api.cityscroll.org/mcp" in html and "CT107120258801626" in html and "data-copy-endpoint" in html
        step("OK" if ok else "FAIL", f"{label} no-JS introduction still shows endpoint and examples")
        page.goto(BASE + "about.html", timeout=30000)
        about = page.content()
        step("OK" if "use-with-ai" in about else "FAIL", f"{label} no-JS about still links to introduction")
    finally:
        context.close()


def assert_failed_enhancement(browser, label: str) -> None:
    context = browser.new_context(viewport=DESKTOP)
    context.add_init_script(
        "Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {"
        " writeText: () => Promise.reject(new Error('denied')) } });"
    )
    page = context.new_page()
    try:
        page.goto(BASE + "use-with-ai/", timeout=30000)
        page.wait_for_selector("#mcp-endpoint", timeout=20000)
        page.locator("[data-copy-endpoint]").click()
        value = page.locator("#mcp-endpoint").input_value()
        selected = page.evaluate(
            """() => {
              const input = document.querySelector('#mcp-endpoint');
              return Boolean(input) && input.selectionStart === 0 && input.selectionEnd === input.value.length;
            }"""
        )
        step(
            "OK" if value.endswith("/mcp") and selected else "FAIL",
            f"{label} failed enhancement keeps endpoint recoverable",
            f"value={value} selected={selected}",
        )
    finally:
        context.close()


def maybe_sibling_surface(page, route: str, selector: str, name: str, required_text: str | None = None) -> None:
    """Bind when a sibling surface is present; skip plainly when it is not."""
    page.goto(BASE + route, timeout=30000)
    page.wait_for_selector("body", timeout=20000)
    count = page.locator(selector).count()
    if count == 0:
        step("SKIP", name, "sibling surface not on this tree; soft-depend")
        return
    html = page.content()
    text_ok = required_text is None or required_text in html
    step("OK" if text_ok else "FAIL", name, f"count={count} text_ok={text_ok}")


with sync_playwright() as pw:
    browser = pw.chromium.launch(args=_ARGS)

    assert_follow_calendar_journeys(browser)

    desktop_ctx, desktop = open_page(browser, DESKTOP)
    assert_introduction_journey(desktop, "desktop")
    assert_home_ask_link(desktop, "desktop")
    assert_keyboard_copy_fallback(desktop, "desktop")
    assert_translated_layout(desktop, "desktop")
    desktop_ctx.close()

    assert_failed_enhancement(browser, "desktop")

    desktop_ctx, desktop = open_page(browser, DESKTOP)
    maybe_sibling_surface(
        desktop,
        "browse/meetings/?agency=City%20Planning",
        "[data-more-tools-region], [data-research-tools], #research-task-entrances",
        "research tools region",
        required_text="More tools",
    )
    maybe_sibling_surface(
        desktop,
        "browse/meetings/?agency=City%20Planning",
        "[data-ai-context-handoff], a[href*='use-with-ai'][data-ai-context]",
        "contextual AI handoff control",
    )
    desktop_ctx.close()

    phone_ctx, phone = open_page(browser, PHONE)
    assert_introduction_journey(phone, "phone")
    assert_home_ask_link(phone, "phone")
    phone_ctx.close()

    assert_no_js(browser, "desktop")

    browser.close()

failed = [name for tag, name in results if tag == "FAIL"]
skipped = [name for tag, name in results if tag == "SKIP"]
print(f"summary pass={sum(1 for tag, _ in results if tag == 'OK')} fail={len(failed)} skip={len(skipped)}", flush=True)
sys.exit(1 if failed else 0)
